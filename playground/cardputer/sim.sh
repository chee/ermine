#!/bin/sh
# the firmware's programs on the Mac, against the same ermine C: ./sim.sh < keys.txt
set -e
cd "$(dirname "$0")"
R=../..
srcs=$(sed -n '/SRCS/,/INCLUDE_DIRS/p' components/ermine/CMakeLists.txt | tr ' \t' '\n\n' | grep '^\${R}/.*\.c$' | sed "s|\${R}|$R|")
mkdir -p build-sim
cc -std=c11 -g -O1 -fsanitize=address,undefined -w -I$R -Imain -o build-sim/sim \
	main/sim.c main/host.c main/shell.c main/drivers.c $srcs
exec ./build-sim/sim
