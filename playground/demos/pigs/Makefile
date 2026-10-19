# playground/demos/pigs: ermine-pigs, lab-pig's pigs in a terminal (c/pigs.c says how to use it), on the table
# and sync (extensions/together/c), as playground/term builds its programs. Quiet by default: V=1 shows each
# command. littlesync/ is the pigs on littlesync, a small-device stack: littlesync-pigs (its Makefile).
#   make            ermine-pigs (its looks: pixels, and --look nethack, c/hack.c) and walk-test
#   make test       walk-test against program.ts's own walking (deno), the formula the web page runs
#   make interop    ermine-pigs on a pty and lab-pig in headless Chrome, on galaxy.observer in a fresh (LOOK=nethack:
#                   the NetHack look) room, checked against each other (interop.ts; slaygrounds' dev server up:
#                   URL=http://localhost:8051/ by default)
#   make check      ermine-pigs-check: built with the address and undefined-behaviour sanitizers
#   make clean
CC ?= cc
R = ../../..
CFLAGS = -std=c11 -O2 -Wall -Wextra -Wpedantic
CHECKFLAGS = -std=c11 -g -O1 -Wall -Wextra -Wpedantic -fsanitize=address,undefined -fno-omit-frame-pointer
Q = $(if $(V),,@)

BLAKE3FLAGS = -DBLAKE3_NO_SSE2 -DBLAKE3_NO_SSE41 -DBLAKE3_NO_AVX2 -DBLAKE3_NO_AVX512 -DBLAKE3_USE_NEON=0
# Subduction's own BLAKE3 exports the same symbols as ermine/encoding/c/blake3: the C ones are renamed
rename = $(foreach s,compress_in_place compress_in_place_portable compress_subtree_wide compress_xof compress_xof_portable hash_many hash_many_portable hasher_finalize hasher_finalize_seek hasher_init hasher_init_derive_key hasher_init_derive_key_raw hasher_reset hasher_update simd_degree version xof_many,-Dblake3_$(s)=ermc_blake3_$(s))
subduction = $(R)/extensions/subduction/c/subduction/lib/libsubduction_c.a
OPENSSL ?= $(shell brew --prefix openssl@3 2>/dev/null || echo /usr)
LIBS = $(subduction) $(filter-out -lm,$(shell tr -d '\033' < $(R)/extensions/subduction/c/subduction/lib/link.txt | sed 's/\[[0-9;]*m//g')) \
	-L$(OPENSSL)/lib -lssl -lcrypto -lm
FLAGS = $(BLAKE3FLAGS) $(rename) -I$(OPENSSL)/include

# the table, entries and op; sync, the transport and what they stand on; Subduction's host side, its
# memory store and a WebSocket over OpenSSL; JSON for presence's messages
graph = core/table/c/table.c core/node/c/node.c core/node/c/update.c core/op/c/value.c core/op/c/apply.c core/op/c/invert.c
sync = extensions/together/c/sync.c extensions/together/c/transport.c extensions/together/c/mailroom.c extensions/together/stacks/subduction/c/subduction.c extensions/together/c/ids.c extensions/together/c/history.c \
	extensions/together/c/replay.c extensions/together/c/lists.c extensions/together/c/snapshot.c extensions/together/c/packer.c \
	extensions/together/c/seal.c extensions/together/c/ed25519/ed25519.c extensions/together/c/ed25519/sha2.c extensions/subduction/c/fragment.c \
	ermine/encoding/c/commit.c ermine/encoding/c/pack.c ermine/encoding/c/cbor.c ermine/encoding/c/json.c ermine/encoding/c/json_text.c \
	ermine/encoding/c/blake3/blake3.c ermine/encoding/c/blake3/blake3_dispatch.c ermine/encoding/c/blake3/blake3_portable.c \
	extensions/subduction/c/subduction/platform_posix.c extensions/subduction/c/subduction/store_memory.c \
	extensions/subduction/c/subduction/websocket.c extensions/subduction/c/subduction/transport_openssl.c
under = $(graph) $(sync)
objects = $(addprefix lib/o/,$(subst /,_,$(under:.c=.o)))
objects-check = $(addprefix lib/check/,$(subst /,_,$(under:.c=.o)))
headers = $(wildcard c/*.h) $(wildcard $(R)/core/*/c/*.h $(R)/extensions/together/c/*.h $(R)/extensions/together/stacks/subduction/c/*.h $(R)/ermine/encoding/c/*.h $(R)/extensions/subduction/c/*.h $(R)/extensions/subduction/c/subduction/*.h)
pigs = c/pigs.c c/device.c c/screen.c c/walk.c
# hack.c, the NetHack look, is part of pigs.c (included by it)
looks = c/hack.c

all: ermine-pigs walk-test

define object
lib/o/$(subst /,_,$(1:.c=.o)): $(R)/$(1) $(headers)
	@mkdir -p lib/o
	$$(Q)$$(CC) $$(CFLAGS) $$(FLAGS) -c $$< -o $$@
lib/check/$(subst /,_,$(1:.c=.o)): $(R)/$(1) $(headers)
	@mkdir -p lib/check
	$$(Q)$$(CC) $$(CHECKFLAGS) $$(FLAGS) -c $$< -o $$@
endef
$(foreach f,$(under),$(eval $(call object,$(f))))

lib/sync.a: $(objects)
	$(Q)rm -f $@ && ar rcs $@ $^
lib/sync-check.a: $(objects-check)
	$(Q)rm -f $@ && ar rcs $@ $^

ermine-pigs: $(pigs) $(looks) lib/sync.a $(headers)
	$(Q)$(CC) $(CFLAGS) $(FLAGS) -o $@ $(pigs) lib/sync.a $(LIBS)
ermine-pigs-check: $(pigs) $(looks) lib/sync-check.a $(headers)
	$(Q)$(CC) $(CHECKFLAGS) $(FLAGS) -o $@ $(pigs) lib/sync-check.a $(LIBS)
walk-test: c/walk_test.c c/walk.c c/walk.h
	$(Q)$(CC) $(CFLAGS) -o $@ c/walk_test.c c/walk.c -lm

test: walk-test
	$(Q)deno run --quiet --allow-read --allow-run --allow-write walk_check.ts

URL ?= http://localhost:8051/
interop: ermine-pigs
	$(Q)deno run -A interop.ts --url $(URL) $(if $(LOOK),--look $(LOOK))

check: ermine-pigs-check

clean:
	rm -rf ermine-pigs ermine-pigs-check walk-test lib *.dSYM

.PHONY: all test interop check clean
