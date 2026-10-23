#!/bin/sh
# the firmware's den on the Mac, against the same ermine C, in a room on galaxy.observer:
#   SIM_ROOM=KAYA ./sim.sh          (SIM_SERVER=none: alone; SIM_SHELL=1: the shell too)
set -e
cd "$(dirname "$0")"
R=../..
srcs=$(sed -n '/SRCS/,/INCLUDE_DIRS/p' components/ermine/CMakeLists.txt | tr ' \t' '\n\n' | grep '^\${\(R\|TIPPET\)}/.*\.c$' |
	sed "s|\${R}|$R|; s|\${TIPPET}|$R/experiments/tippet/c|")
mkdir -p build-sim
cc -std=c11 -g -O1 ${SAN--fsanitize=address,undefined} -w -I$R -Imain \
	-DBLAKE3_NO_SSE2 -DBLAKE3_NO_SSE41 -DBLAKE3_NO_AVX2 -DBLAKE3_NO_AVX512 -DBLAKE3_USE_NEON=0 -o build-sim/sim \
	main/sim.c main/host.c main/shell.c main/drivers.c main/fb.c main/den.c main/things.c main/menu.c main/poll.c $srcs -lcurl
exec ./build-sim/sim "$@"
