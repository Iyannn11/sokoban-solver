# Sokoban Solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/Iyannn11/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/Iyannn11/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver, built for the
[make.fun sokoban-solver-01-run-20261121 bounty](https://make.fun/bounty/sokoban-solver-01-run-20261121).
One program (`main.ts`, Node 22, standard library only) answers all 5
instances of a set in one run, in as few pushes as possible.

## How it works

A level of this competition is a hallway with rooms off it, and a box
pushed out of a room can never be pushed back, so the rooms are
independent problems joined only by the player's walk: the level's
push-optimal count is the sum of its rooms'. The solver cuts the
hallway's dead squares out of the floor, takes each remaining part that
holds boxes as a room, and solves each room on its own with an A* over
pushes (the other rooms' boxes standing as walls). A level that is no
set of rooms is searched whole instead.

The room search keeps a state as the boxes' squares plus the player's
reachable region, and estimates the pushes left by the cheapest
assignment of boxes to goals — no push can beat that estimate by more
than one, so the first solved state popped is push-optimal. It prunes
three deadlocks, none of which prunes a solvable state: dead squares
(found by pulling boxes back from the goals), frozen 2x2 blocks of
walls and boxes, and freezes along a wall (a box whose every slide
needs a target that is a wall, a dead square or a frozen box, or a
standing square that is a wall or a frozen box).

Everything is deterministic: every budget is a count of states, never
the wall clock, and every tie breaks in a fixed order, so two runs
write the same bytes.

## Practice results

On the kit's practice set the solver finds the push-optimal count on
all 5 instances (13, 16, 29, 47 and 60 pushes — the manifest's P*),
for 1,000 points each, in under a second for the whole set. The house
baseline plain-astar 1.0.0 scores 200,000 on the same set.

## Run it locally

    mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts

With the kit's practice set as input, the answers land in `out/<id>/solution.txt`.
