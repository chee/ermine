#!/bin/sh
# the firmware's programs on the Mac, against the same ermine C: ./sim.sh < keys.txt
set -e
cd "$(dirname "$0")"
R=../..
srcs=$(sed -n '/SRCS/,/INCLUDE_DIRS/p' components/ermine/CMakeLists.txt | tr ' \t' '\n\n' | grep -E '^\$\{(R|MAIN)\}/.*\.c$' | sed "s|\${R}|$R|; s|\${MAIN}|../../../ermine|")
mkdir -p build-sim
cc -std=c11 -g -O1 -fsanitize=address,undefined -w -I$R -Imain \
	-DBLAKE3_NO_SSE2 -DBLAKE3_NO_SSE41 -DBLAKE3_NO_AVX2 -DBLAKE3_NO_AVX512 -DBLAKE3_USE_NEON=0 -o build-sim/sim \
	main/sim.c main/host.c main/shell.c main/drivers.c main/fb.c main/den.c main/things.c $srcs
exec ./build-sim/sim "$@"
