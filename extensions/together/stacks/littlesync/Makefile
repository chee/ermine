# extensions/together/stacks/littlesync: littlesync, a small-device sync stack (littlesync.h says what it is). Quiet by
# default: V=1 shows each command.
#   make test        host tests (test/test.c), their lists against lists.ts on the same commits (test/lists.ts,
#                    deno), then two littlesync-pigs over a pty pair (test/pty.sh), then
#                    three in a line, the middle one relaying (test/hop.sh), then two over HTTP to the gateway
#                    on a local port, no server (test/http.sh; sh test/http.sh build/littlesync-pigs
#                    wss://galaxy.observer: through galaxy). littlesync-pigs, lab-pig's pigs
#                    on littlesync, is a user of the library (playground/demos/pigs/littlesync), built into
#                    build/ here; the tests use its pigs.c and pigs.h too
#   make galaxy      two littlesync-pigs over https to the deployed gateway (https://galaxy.observer/littlesync/),
#                    a fresh room each run (test/galaxy.sh; URL=... another). The network: not in make test
#   make check       the host tests and the lists check under the address and undefined-behaviour sanitizers
#   make pigs        littlesync-pigs, the Mac peer (playground/demos/pigs/littlesync/peer.c), into build/
#   make esp-check   the library's .c files and the shared ones it uses, compiled for esp32s3 (xtensa),
#                    with the sizes of each object and the total
#   make clean
CC ?= cc
DENO ?= deno
R = ../../../..
Q = $(if $(V),,@)
CFLAGS = -std=c11 -O2 -g -Wall -Wextra -Wpedantic -Wno-unused-parameter
B3 = -DBLAKE3_NO_SSE2 -DBLAKE3_NO_SSE41 -DBLAKE3_NO_AVX2 -DBLAKE3_NO_AVX512 -DBLAKE3_USE_NEON=0
BUILD = build

# ours: the stack; and what it stands on, in its repo places. The first group (value, json, cbor, pack)
# is already in the Cardputer's ermine component; the second is what this adds
ours = littlesync.c frame.c store_file.c
base = $(R)/core/op/c/value.c $(R)/ermine/encoding/c/json.c $(R)/ermine/encoding/c/cbor.c $(R)/ermine/encoding/c/pack.c
shared = $(R)/ermine/encoding/c/commit.c $(R)/ermine/encoding/c/blake3/blake3.c $(R)/ermine/encoding/c/blake3/blake3_dispatch.c \
	$(R)/ermine/encoding/c/blake3/blake3_portable.c $(R)/extensions/together/c/ed25519/ed25519.c $(R)/extensions/together/c/ed25519/sha2.c
# pack.c reads whole nodes: the op json it uses, and node.c's entry maker
more = $(R)/core/op/c/json.c $(R)/core/node/c/node.c $(R)/core/op/c/apply.c $(R)/core/op/c/invert.c
seal_ref = $(R)/extensions/together/c/seal.c
# the tests' values: lab-pig's pigs (a user of the library)
PIGS = $(R)/playground/demos/pigs/littlesync
pigs_ref = $(PIGS)/pigs.c

all: pigs

$(BUILD):
	$(Q)mkdir -p $(BUILD)

pigs: $(BUILD)/littlesync-pigs

$(BUILD)/littlesync-pigs: FORCE | $(BUILD)
	$(Q)$(MAKE) --no-print-directory -C $(PIGS) BUILD=$(abspath $(BUILD))
FORCE:

$(BUILD)/test: test/test.c test/count.c test/count.h $(ours) $(base) $(shared) $(more) $(seal_ref) $(pigs_ref) $(PIGS)/pigs.h littlesync.h frame.h | $(BUILD)
	$(Q)echo cc $@
	$(Q)$(CC) $(CFLAGS) -c -o $(BUILD)/count.o test/count.c
	$(Q)$(CC) $(CFLAGS) $(B3) -include test/count.h -o $@ test/test.c $(BUILD)/count.o $(ours) $(base) $(shared) $(more) $(seal_ref) $(pigs_ref) -lm

# the same tests built with the address and undefined-behaviour sanitizers
SAN = -fsanitize=address,undefined -fno-omit-frame-pointer
check: test/test.c test/count.c test/count.h $(ours) $(base) $(shared) $(more) $(seal_ref) $(pigs_ref) | $(BUILD)
	$(Q)echo cc $(BUILD)/test-check
	$(Q)$(CC) $(CFLAGS) $(SAN) -c -o $(BUILD)/count-check.o test/count.c
	$(Q)$(CC) $(CFLAGS) $(SAN) $(B3) -include test/count.h -o $(BUILD)/test-check test/test.c $(BUILD)/count-check.o $(ours) $(base) $(shared) $(more) $(seal_ref) $(pigs_ref) -lm
	$(Q)$(BUILD)/test-check
	$(Q)$(DENO) run --allow-read test/lists.ts $(BUILD)/lists.jsonl

test: $(BUILD)/test $(BUILD)/littlesync-pigs
	$(Q)$(BUILD)/test
	$(Q)$(DENO) run --allow-read test/lists.ts $(BUILD)/lists.jsonl
	$(Q)sh test/pty.sh $(BUILD)/littlesync-pigs
	$(Q)sh test/hop.sh $(BUILD)/littlesync-pigs
	$(Q)sh test/http.sh $(BUILD)/littlesync-pigs

URL = https://galaxy.observer
galaxy: $(BUILD)/littlesync-pigs
	$(Q)sh test/galaxy.sh $(BUILD)/littlesync-pigs $(URL)

# the device build: -Os, the xtensa compiler of ESP-IDF's toolchain. Nothing is linked: each object's
# size, then the sum. text is code and read-only data, data and bss the static RAM
XT = $(firstword $(wildcard $(HOME)/.espressif/tools/xtensa-esp-elf/*/xtensa-esp-elf/bin))
XCC = $(XT)/xtensa-esp32s3-elf-gcc
XSIZE = $(XT)/xtensa-esp-elf-size
XFLAGS = -std=gnu11 -Os -mlongcalls -ffunction-sections -fdata-sections -Wall -Wno-format -Wno-unused-parameter $(B3) -DESP_PLATFORM \
	-DBLAKE3_NO_SSE2 -DBLAKE3_NO_SSE41 -DBLAKE3_NO_AVX2 -DBLAKE3_NO_AVX512 -DBLAKE3_USE_NEON=0
esp_ours = littlesync.c frame.c http.c
esp_all = $(esp_ours) $(shared) $(base) $(more)

esp-check:
	$(Q)test -x $(XCC) || { echo "no xtensa compiler under ~/.espressif/tools/xtensa-esp-elf"; exit 1; }
	$(Q)rm -rf $(BUILD)/esp && mkdir -p $(BUILD)/esp
	$(Q)for f in $(esp_all); do \
		o=$(BUILD)/esp/$$(echo $$f | sed 's,[./]*,,; s,/,_,g; s,\.c$$,.o,'); \
		$(XCC) $(XFLAGS) -c $$f -o $$o || exit 1; \
	done
	$(Q)echo "littlesync, per object (text includes read-only data):"; \
	for g in "ours:$(esp_ours)" "added to the app (commit, blake3, ed25519):$(shared)" "already in the app (ermine component):$(base)"; do \
		echo "-- $${g%%:*}"; \
		for f in $${g#*:}; do \
			o=$(BUILD)/esp/$$(echo $$f | sed 's,[./]*,,; s,/,_,g; s,\.c$$,.o,'); \
			$(XSIZE) $$o | tail -1 | awk -v n=$$(basename $$f) '{printf "  %-22s text %6d data %5d bss %6d\n", n, $$1, $$2, $$3}'; \
		done; \
	done
	$(Q)for g in "ours:$(esp_ours)" "added:$(esp_ours) $(shared)" "all:$(esp_all)"; do \
		for f in $${g#*:}; do echo $(BUILD)/esp/$$(echo $$f | sed 's,[./]*,,; s,/,_,g; s,\.c$$,.o,'); done | xargs $(XSIZE) | \
		awk -v n=$${g%%:*} 'NR>1 {t+=$$1; d+=$$2; b+=$$3} END {printf "total %-6s text %6d data %5d bss %6d  (flash %d, static RAM %d)\n", n, t, d, b, t+d, d+b}'; \
	done

clean:
	$(Q)rm -rf $(BUILD)

.PHONY: all pigs test galaxy check esp-check clean FORCE
