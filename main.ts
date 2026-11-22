// Sokoban solver: push-optimal A* over rooms.
//
// One program answers a set of 5 Sokoban levels (XSB) in a single run:
// it reads /input/<id>/level.txt and writes /output/<id>/solution.txt,
// the player's moves in u, d, l, r (lowercase; the replay decides which
// steps push). It is deterministic: every budget is a count of work, never
// the wall clock, and every tie breaks in a fixed order, so two runs
// write the same bytes.
//
// The idea. A level of this competition is a hallway with rooms off it,
// each room holding 3 or 4 boxes and as many goals, and a box pushed out
// of a room through its door can never be pushed back, so the rooms are
// independent problems joined only by the player's walk: the level's
// push-optimal count is the sum of its rooms'. The solver therefore
// cuts the hallway's dead squares out of the floor, takes each remaining
// part that holds boxes as a room, and solves each room on its own with
// an A* over pushes, the other rooms' boxes standing as walls. A level
// that is no set of rooms falls back to the same A* over the whole level.
//
// The room search. A state is the boxes' squares and the player's
// reachable region (named by its lowest square); a step costs one push.
// The estimate is the cheapest assignment of boxes to goals by grid
// distance, which no push can beat by more than one, so the first solved
// state the search pops is push-optimal. Three deadlocks are pruned, and
// none of them prunes a solvable state:
//   - a dead square: a box there can never reach a goal, found by pulling
//     boxes back from the goals over open floor;
//   - a frozen 2x2 block of walls and boxes with a box off its goal;
//   - a freeze along a wall: a box against a wall whose every slide
//     needs a target square that is a wall, a dead square or a frozen
//     box, or a standing square that is a wall or a frozen box.
// Node 22 runs this file as node /bot/main.ts: TypeScript source only,
// erasable syntax, built-in modules, nothing installed, no clock, no
// randomness, no network.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The most states one room search expands before it gives up. */
const MAX_ROOM_STATES = 250_000;
/** The most states the whole-level fallback expands. */
const MAX_WHOLE_STATES = 200_000;

/** The four steps: up, down, left, right, in a fixed order. */
const DIRS = [
  { dx: 0, dy: -1, ch: 'u' },
  { dx: 0, dy: 1, ch: 'd' },
  { dx: -1, dy: 0, ch: 'l' },
  { dx: 1, dy: 0, ch: 'r' },
] as const;

type Level = {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
};

type Room = {
  squares: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
};

/** A level in XSB text: # wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outer frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/** The squares from which a box alone can be pushed onto some goal. */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const { dx, dy } of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      const behind = y - d;
      if (y < 0 || behind < 0 || y >= wall.length || behind >= wall.length) continue;
      if (wall[y] === 0 && wall[behind] === 0 && live[y] === 0) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** The squares the player reaches from `from` with `occupied` in the way; returns the lowest. */
function reach(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and boxes with a box off its goal. */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (a < 0 || d >= wall.length) continue;
    if ((wall[a] || occupied[a]) === 0) continue;
    if ((wall[b] || occupied[b]) === 0) continue;
    if ((wall[c] || occupied[c]) === 0) continue;
    if ((wall[d] || occupied[d]) === 0) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the boxes hold a freeze deadlock: a box off its goal that can
 * never slide to a live square. A box against a wall slides only along
 * it; each slide needs a target square that is no wall, no dead square
 * and no frozen box, and a standing square that is no wall and no frozen
 * box. Frozen is a fixpoint: a box frozen this way never moves on any
 * road to a solution, so it blocks the next box just as a wall does.
 */
function freezeDeadlocked(level: Level, live: Uint8Array, goal: Uint8Array, boxes: number[]): boolean {
  const { w, wall } = level;
  const n = boxes.length;
  const at = new Map<number, number>();
  for (let i = 0; i < n; i++) at.set(boxes[i]!, i);
  const frozen = new Uint8Array(n);
  // A square blocks a slide's target when it is a wall, a dead square, or a frozen box;
  // it blocks a slide's standing square when it is a wall or a frozen box (the player
  // may stand on a dead square: only boxes are barred from it).
  const blocksTarget = (c: number): boolean =>
    wall[c] === 1 || live[c] === 0 || (at.has(c) && frozen[at.get(c)!] === 1);
  const blocksStand = (c: number): boolean =>
    wall[c] === 1 || (at.has(c) && frozen[at.get(c)!] === 1);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < n; i++) {
      if (frozen[i] === 1 || goal[boxes[i]!] === 1) continue;
      const b = boxes[i]!;
      let froze = false;
      if (wall[b - w] === 1 || wall[b + w] === 1) {
        // Against a horizontal wall: slides left or right only.
        if ((blocksTarget(b - 1) || blocksStand(b + 1)) && (blocksTarget(b + 1) || blocksStand(b - 1))) froze = true;
      }
      if (!froze && (wall[b - 1] === 1 || wall[b + 1] === 1)) {
        // Against a vertical wall: slides up or down only.
        if ((blocksTarget(b - w) || blocksStand(b + w)) && (blocksTarget(b + w) || blocksStand(b - w))) froze = true;
      }
      if (froze) {
        frozen[i] = 1;
        changed = true;
      }
    }
  }
  return frozen.some((f) => f === 1);
}

/** Grid distances from each goal over open floor, ignoring boxes. */
function goalDistances(level: Level): number[][] {
  const { w, wall, goals } = level;
  const out: number[][] = [];
  for (const g of goals) {
    const dist = new Array<number>(wall.length).fill(Infinity);
    dist[g] = 0;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi]!;
      for (const { dx, dy } of DIRS) {
        const q = p + dy * w + dx;
        if (wall[q] === 0 && dist[q] === Infinity) {
          dist[q] = dist[p]! + 1;
          queue.push(q);
        }
      }
    }
    out.push(dist);
  }
  return out;
}

/** Every ordering of 0..n-1, as index lists. */
function permutations(n: number): number[][] {
  const base = Array.from({ length: n }, (_, i) => i);
  const out: number[][] = [];
  const rec = (k: number): void => {
    if (k === n) {
      out.push(base.slice());
      return;
    }
    for (let i = k; i < n; i++) {
      [base[k], base[i]] = [base[i]!, base[k]!];
      rec(k + 1);
      [base[k], base[i]] = [base[i]!, base[k]!];
    }
  };
  rec(0);
  return out;
}

/** A binary heap on [f, h, sequence, state], smallest first. */
class Heap {
  private a: [number, number, number, number][] = [];
  get length(): number {
    return this.a.length;
  }
  push(e: [number, number, number, number]): void {
    const a = this.a;
    let i = a.length;
    a.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(a[i]!, a[p]!)) break;
      [a[i], a[p]] = [a[p]!, a[i]!];
      i = p;
    }
  }
  pop(): [number, number, number, number] {
    const a = this.a;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= a.length) break;
        if (c + 1 < a.length && less(a[c + 1]!, a[c]!)) c++;
        if (!less(a[c]!, a[i]!)) break;
        [a[i], a[c]] = [a[c]!, a[i]!];
        i = c;
      }
    }
    return top;
  }
}

function less(x: [number, number, number, number], y: [number, number, number, number]): boolean {
  return x[0] < y[0] || (x[0] === y[0] && (x[1] < y[1] || (x[1] === y[1] && x[2] < y[2])));
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters. */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const { dx, dy, ch } of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = ch;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after `moves` (lowercase LURD) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/**
 * The push-optimal solution of `level`: {pushes, moves}, or null when the
 * search gives up (or the level has no solution). A* over pushes: a state
 * is the boxes and the player's reachable region, the estimate is the
 * cheapest assignment of boxes to goals, and dead squares, frozen 2x2
 * blocks and wall freezes are pruned.
 */
function solvePushOptimal(level: Level, maxStates: number): { pushes: number; moves: string } | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b] === 1);
  if (level.boxes.some((b) => live[b] === 0)) return null;
  if (solved(level.boxes)) return { pushes: 0, moves: '' };

  const dist = goalDistances(level);
  const orders = permutations(goals.length);
  const estimate = (boxes: number[]): number => {
    let best = Infinity;
    for (const order of orders) {
      let sum = 0;
      for (let i = 0; i < boxes.length; i++) {
        const d = dist[order[i]!]![boxes[i]!]!;
        if (d === Infinity) {
          sum = Infinity;
          break;
        }
        sum += d;
      }
      if (sum < best) best = sum;
    }
    return best;
  };
  const h0 = estimate(level.boxes);
  if (h0 === Infinity) return null;

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const keyOf = (boxes: number[], low: number): string => low + ':' + boxes.join(',');

  // The states in the order found: their boxes, the player's square after
  // the push that made them, their parent, and the key they were stored by.
  const stateBoxes: number[][] = [level.boxes.slice()];
  const statePlayer: number[] = [level.player];
  const stateParent: number[] = [-1];
  const stateKey: string[] = [''];
  const stateG: number[] = [0];
  const closed = new Map<string, number>();
  for (const b of level.boxes) occupied[b] = 1;
  const low0 = reach(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  stateKey[0] = keyOf(level.boxes, low0);
  closed.set(stateKey[0], 0);
  const heap = new Heap();
  let seq = 0;
  heap.push([h0, h0, seq++, 0]);

  let expanded = 0;
  let found = -1;
  while (heap.length > 0) {
    const [, , , s] = heap.pop();
    const boxes = stateBoxes[s]!;
    const g = stateG[s]!;
    if (closed.get(stateKey[s]!) !== g) continue;
    if (solved(boxes)) {
      found = s;
      break;
    }
    if (expanded >= maxStates) return null;
    expanded++;
    for (const b of boxes) occupied[b] = 1;
    reach(level, occupied, statePlayer[s]!, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      for (const { dx, dy } of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] === 1 || occupied[t] === 1 || live[t] === 0) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let next: number[] | null = null;
        let key = '';
        let h = Infinity;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, b) => a - b);
          if (!freezeDeadlocked(level, live, goal, next)) {
            const low2 = reach(level, occupied, b, mark, ++stamp, stack);
            key = keyOf(next, low2);
            h = estimate(next);
          } else {
            next = null;
          }
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (next === null || h === Infinity) continue;
        const g2 = g + 1;
        const known = closed.get(key);
        if (known !== undefined && known <= g2) continue;
        closed.set(key, g2);
        const idx = stateBoxes.length;
        stateBoxes.push(next);
        statePlayer.push(b);
        stateParent.push(s);
        stateKey.push(key);
        stateG.push(g2);
        heap.push([g2 + h, h, seq++, idx]);
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = stateParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const nextBoxes = stateBoxes[s]!;
    const from = boxes.find((b) => !nextBoxes.includes(b))!;
    const to = nextBoxes.find((b) => !boxes.includes(b))!;
    const d = to - from;
    const dir = DIRS.find(({ dx, dy }) => dy * w + dx === d)!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir.ch;
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

/**
 * The level's rooms: cut the dead squares of the player's row (the
 * hallway: a box there reaches no goal) out of the floor, and each part
 * left that holds a box is a room. Null when some part holds more or
 * fewer boxes than goals, or a box starts in the hallway: then the level
 * is no set of rooms.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (wall[i] === 0 && live[i] === 0) cut[i] = 1;
  if (boxes.some((b) => cut[b] === 1)) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] === 1 || cut[s] === 1 || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const { dx, dy } of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (wall[q] === 0 && cut[q] === 0 && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The level solved room by room: each room's push-optimal solution in
 * turn, the other rooms' boxes standing as walls (on their goals once
 * their room is done), the player walking on from where the last room
 * left it. A box never leaves its room, so the rooms' optima add up to
 * the level's. Null when a room's search gives up; a level that is no
 * set of rooms is searched whole instead.
 */
function solveByRooms(level: Level): { pushes: number; moves: string } | null {
  const rooms = roomsOf(level);
  if (rooms === null) return solvePushOptimal(level, MAX_WHOLE_STATES);
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePushOptimal(sub, MAX_ROOM_STATES);
    if (solved === null) return solvePushOptimal(level, MAX_WHOLE_STATES);
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

/** The moves solving one level's text, or '' when the search gives up. */
function solveLevel(text: string): string {
  const level = parseLevel(text);
  if (level.boxes.length === 0) return '';
  const solved = solveByRooms(level);
  return solved === null ? '' : solved.moves;
}

for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
