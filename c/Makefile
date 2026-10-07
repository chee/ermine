# c/: the ermine core in C, built as one executable, c/ermine: the
# conformance harness for the graph stack. From the repository root:
# make -C c. C11 and a libc with POSIX getdelim; json.c needs the C math
# library.
#
#   make            c/ermine
#   make asan       c/ermine-asan, with -fsanitize=address,undefined
#   make check      the json, cbor and graph unit tests (json_test.c, cbor_test.c, graph_test.c)
#   make clean

CC ?= cc
CFLAGS ?= -std=c11 -Wall -Wextra -Werror -O2
LDLIBS ?= -lm
SANITIZE = -std=c11 -Wall -Wextra -Werror -O1 -g -fno-omit-frame-pointer -fsanitize=address,undefined -fno-sanitize-recover=undefined

SOURCES = json.c ermine.c graph.c main.c
HEADERS = json.h ermine.h

ermine: $(SOURCES) $(HEADERS)
	$(CC) $(CFLAGS) -o $@ $(SOURCES) $(LDLIBS)

ermine-asan: $(SOURCES) $(HEADERS)
	$(CC) $(SANITIZE) -o $@ $(SOURCES) $(LDLIBS)

asan: ermine-asan

json_test: json_test.c json.c json.h
	$(CC) $(SANITIZE) -o $@ json_test.c json.c $(LDLIBS)

cbor_test: cbor_test.c cbor.c cbor.h json.c json.h
	$(CC) $(SANITIZE) -o $@ cbor_test.c cbor.c json.c $(LDLIBS)

graph_test: graph_test.c $(SOURCES) $(HEADERS)
	$(CC) $(SANITIZE) -o $@ graph_test.c json.c ermine.c graph.c $(LDLIBS)

check: json_test cbor_test graph_test
	./json_test
	./cbor_test
	./graph_test

clean:
	rm -rf ermine ermine-asan json_test cbor_test graph_test *.dSYM

.PHONY: asan check clean
