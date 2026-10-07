# c/term/: ermine-term, a toy OS over the C graph. From c/term: make.
#
#   make            ermine-term and erminex
#   make erminex    erminex: one program as one shared window (erminex.c)
#   make run        boots boot.json in this terminal (C-g q quits)
#   make check      the vt parser, start and kill, and an ermine program over pipes (vt_test.c, host_test.c), under ASan/UBSan
#   make clean

CC = clang
CFLAGS ?= -std=c11 -Wall -Wextra -Werror -O2 -I..
SANITIZE = -std=c11 -Wall -Wextra -Werror -O1 -g -fno-omit-frame-pointer -fsanitize=address,undefined -fno-sanitize-recover=undefined -I..
LDLIBS = -lm -lncurses -lutil

GRAPH = ../json.c ../ermine.c ../graph.c
HOST = host.c pty.c speak.c protocol.c vt.c collect.c
HEADERS = host.h protocol.h collect.h vt.h draw.h ../ermine.h ../json.h ../main.c
# erminex finds link.ts here unless ERMINEX_LINK says otherwise
LINK_TS = $(abspath ../../ts/deno/link.ts)

all: ermine-term erminex

ermine-term: wm.c draw.c $(HOST) $(GRAPH) $(HEADERS)
	$(CC) $(CFLAGS) -o $@ wm.c draw.c $(HOST) $(GRAPH) $(LDLIBS)

erminex: erminex.c draw.c $(HOST) $(GRAPH) $(HEADERS)
	$(CC) $(CFLAGS) -DLINK_TS='"$(LINK_TS)"' -o $@ erminex.c draw.c $(HOST) $(GRAPH) $(LDLIBS)

run: ermine-term
	./ermine-term boot.json

vt_test: vt_test.c vt.c vt.h
	$(CC) $(SANITIZE) -o $@ vt_test.c vt.c

host_test: host_test.c $(HOST) $(GRAPH) $(HEADERS)
	$(CC) $(SANITIZE) -o $@ host_test.c $(HOST) $(GRAPH) $(LDLIBS)

check: vt_test host_test
	./vt_test
	./host_test

clean:
	rm -rf ermine-term erminex vt_test host_test *.dSYM

.PHONY: all run check clean
