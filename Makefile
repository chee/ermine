# newcore's C: every library's harness, and their conformance runs against the reference suites.
#   make              every harness
#   make check        every harness-check: address and undefined-behaviour sanitizers
#   make test         the TypeScript tests (the references)
#   make test-c       each conformance suite against its C harness
#   make test-check   the same against the harness-checks
#   make clean
# <group>/<lib>/c/build.sh builds that topic's libraries alone (CHECK=1: the harness-checks).

CC ?= cc
CFLAGS = -std=c11 -O2 -Wall -Wextra -Wpedantic
CHECKFLAGS = -std=c11 -g -O1 -Wall -Wextra -Wpedantic -fsanitize=address,undefined -fno-omit-frame-pointer
DENO = deno test --quiet --allow-run --allow-read --allow-env

tracker_src = core/scheduler/c/tracker.c core/scheduler/c/tracker_harness.c
table_src = core/graph/c/table.c core/graph/c/table_harness.c
node_src = core/node/c/node.c core/node/c/shown.c core/node/c/node_harness.c core/op/c/value.c core/op/c/apply.c core/op/c/invert.c
pack_src = core/node/c/node.c core/node/c/shown.c ermine/encoding/c/pack.c ermine/encoding/c/pack_harness.c ermine/encoding/c/json.c ermine/encoding/c/cbor.c
cbor_src = ermine/encoding/c/cbor_test.c ermine/encoding/c/cbor.c ermine/encoding/c/json.c
blop_src = ermine/encoding/c/blop.c ermine/encoding/c/blop_harness.c ermine/encoding/c/json.c ermine/encoding/c/cbor.c $(blake3_src)
id_src = extensions/subduction/c/id.c extensions/subduction/c/id_harness.c ermine/encoding/c/json.c ermine/encoding/c/cbor.c $(blake3_src)
seal_src = extensions/subduction/c/seal.c extensions/subduction/c/seal_harness.c ermine/encoding/c/blop.c ermine/encoding/c/json.c ermine/encoding/c/cbor.c $(blake3_src) extensions/subduction/c/ed25519/ed25519.c extensions/subduction/c/ed25519/sha2.c
history_src = extensions/subduction/c/history.c extensions/subduction/c/apply.c extensions/subduction/c/history_harness.c ermine/encoding/c/blop.c ermine/encoding/c/json.c ermine/encoding/c/cbor.c $(blake3_src) \
	core/op/c/value.c core/op/c/apply.c core/node/c/update.c core/scheduler/c/notify.c core/node/c/node.c
apply_src = extensions/subduction/c/history.c extensions/subduction/c/apply.c extensions/subduction/c/apply_harness.c ermine/encoding/c/blop.c ermine/encoding/c/json.c ermine/encoding/c/cbor.c $(blake3_src) \
	core/op/c/value.c core/op/c/apply.c core/node/c/update.c core/scheduler/c/notify.c core/node/c/node.c
commit_src = extensions/subduction/c/history.c extensions/subduction/c/apply.c extensions/subduction/c/commit.c extensions/subduction/c/commit_harness.c ermine/encoding/c/blop.c ermine/encoding/c/json.c ermine/encoding/c/cbor.c $(blake3_src) \
	core/op/c/value.c core/op/c/apply.c core/node/c/update.c core/scheduler/c/notify.c core/node/c/node.c
# Subduction's own BLAKE3 exports the same symbols as ermine/encoding/c/blake3: the C ones are renamed, in every file of the harness
subduction_rename = $(foreach s,compress_in_place compress_in_place_portable compress_subtree_wide compress_xof compress_xof_portable hash_many hash_many_portable hasher_finalize hasher_finalize_seek hasher_init hasher_init_derive_key hasher_init_derive_key_raw hasher_reset hasher_update simd_degree version xof_many,-Dblake3_$(s)=ermc_blake3_$(s))
subduction_lib = extensions/subduction/c/subduction/lib/libsubduction_c.a
transport_flags = -Ic/subduction $(subduction_rename)
transport_libs = $(subduction_lib) $(filter-out -lm,$(shell tr -d '\033' < extensions/subduction/c/subduction/lib/link.txt | sed 's/\[[0-9;]*m//g'))
transport_src = extensions/subduction/c/transport.c extensions/subduction/c/transport_harness.c extensions/subduction/c/id.c extensions/subduction/c/seal.c extensions/subduction/c/history.c extensions/subduction/c/apply.c extensions/subduction/c/commit.c extensions/subduction/c/fragment.c \
	ermine/encoding/c/blop.c ermine/encoding/c/json.c ermine/encoding/c/cbor.c $(blake3_src) extensions/subduction/c/ed25519/ed25519.c extensions/subduction/c/ed25519/sha2.c \
	core/op/c/value.c core/op/c/apply.c core/node/c/update.c core/scheduler/c/notify.c core/node/c/node.c \
	extensions/subduction/c/subduction/store_memory.c extensions/subduction/c/subduction/platform_posix.c $(subduction_lib)
# the wiring: the transport's, with the scheduler (and the graph under it) it is wired to
wiring_flags = $(transport_flags)
wiring_libs = $(transport_libs)
wiring_src = extensions/subduction/c/wiring.c extensions/subduction/c/wiring_harness.c $(filter-out extensions/subduction/c/transport_harness.c,$(transport_src)) \
	core/scheduler/c/scheduler.c core/graph/c/main.c core/places/c/places.c core/scheduler/c/tracker.c core/protect/c/protect.c
fragment_src = extensions/subduction/c/fragment.c extensions/subduction/c/fragment_harness.c ermine/encoding/c/json.c
squish_src = core/op/c/squish.c core/op/c/squish_harness.c
op-apply_src = core/op/c/apply_harness.c core/op/c/apply.c core/op/c/invert.c core/op/c/value.c ermine/encoding/c/json.c
notify_src = core/scheduler/c/notify.c core/scheduler/c/notify_harness.c core/op/c/value.c
paths_src = core/scheduler/c/paths.c core/scheduler/c/paths_harness.c core/op/c/value.c ermine/encoding/c/json.c
places_src = core/places/c/places.c core/places/c/places_harness.c core/places/c/trie.c core/graph/c/table.c core/node/c/node.c core/node/c/update.c core/node/c/shown.c core/op/c/value.c core/op/c/apply.c core/op/c/invert.c
trie_src = core/places/c/trie.c core/places/c/trie_harness.c
protect_src = core/protect/c/protect.c core/protect/c/harness.c
update_src = core/node/c/update.c core/node/c/update_harness.c core/node/c/node.c core/node/c/shown.c core/op/c/apply.c core/op/c/invert.c core/op/c/value.c
graph_src = core/graph/c/main.c core/graph/c/main_harness.c \
	core/places/c/places.c core/scheduler/c/notify.c core/scheduler/c/tracker.c core/protect/c/protect.c core/op/c/value.c core/op/c/apply.c core/node/c/update.c core/node/c/node.c
scheduler_src = core/scheduler/c/scheduler.c core/scheduler/c/order.c core/scheduler/c/rank.c core/scheduler/c/causes.c core/scheduler/c/ptrmap.c core/scheduler/c/tracker.c core/scheduler/c/scheduler_harness.c ermine/encoding/c/json.c
names_src = playground/files/c/names.c playground/files/c/names_harness.c ermine/encoding/c/json.c
diag_src = playground/files/c/diag.c playground/files/c/diag_harness.c ermine/encoding/c/json.c
layout_src = playground/files/c/layout.c playground/files/c/layout_harness.c playground/files/c/names.c ermine/encoding/c/json.c
store_src = playground/files/c/store.c playground/files/c/store_harness.c playground/files/c/sys.c playground/files/c/manifest.c playground/files/c/layout.c playground/files/c/names.c playground/files/c/diag.c \
	playground/files/c/external.c playground/files/c/foundation.c \
	core/node/c/node.c core/node/c/shown.c ermine/encoding/c/pack.c ermine/encoding/c/cbor.c ermine/encoding/c/json.c $(blake3_src)
# the files program: its watcher and harness, on the C store and the C scheduler (and the graph under it)
# sys.c's Trash against homes of its own, no suite
sys_src = playground/files/c/sys.c playground/files/c/foundation.c playground/files/c/sys_harness.c
program_src = playground/files/c/program.c playground/files/c/watch.c playground/files/c/program_harness.c $(filter-out playground/files/c/store_harness.c,$(store_src)) \
	core/scheduler/c/scheduler.c core/graph/c/main.c core/places/c/places.c core/scheduler/c/notify.c core/scheduler/c/tracker.c core/protect/c/protect.c core/op/c/value.c core/op/c/apply.c core/node/c/update.c
program_libs = $(if $(filter Darwin,$(shell uname -s)),-framework CoreServices -framework CoreFoundation,) -lpthread
manifest_src = playground/files/c/manifest.c playground/files/c/manifest_harness.c playground/files/c/diag.c core/node/c/node.c core/node/c/shown.c \
	ermine/encoding/c/pack.c ermine/encoding/c/cbor.c ermine/encoding/c/json.c $(blake3_src)

# BLAKE3 portable only: no SIMD dispatch, no NEON (ermine/encoding/c/blake3 has no such files)
blake3_src = ermine/encoding/c/blake3/blake3.c ermine/encoding/c/blake3/blake3_dispatch.c ermine/encoding/c/blake3/blake3_portable.c
BLAKE3FLAGS = -DBLAKE3_NO_SSE2 -DBLAKE3_NO_SSE41 -DBLAKE3_NO_AVX2 -DBLAKE3_NO_AVX512 -DBLAKE3_USE_NEON=0

# name: binary, sources, the suite, its env var, and what C skips
tracker = core/scheduler/c/tracker-harness
table = core/graph/c/table-harness
node = core/node/c/node-harness
pack = ermine/encoding/c/pack-harness
cbor = ermine/encoding/c/cbor-test
blop = ermine/encoding/c/blop-harness
id = extensions/subduction/c/id-harness
seal = extensions/subduction/c/seal-harness
fragment = extensions/subduction/c/fragment-harness
transport = extensions/subduction/c/transport-harness
wiring = extensions/subduction/c/wiring-harness
history = extensions/subduction/c/history-harness
apply = extensions/subduction/c/apply-harness
commit = extensions/subduction/c/commit-harness
squish = core/op/c/squish-harness
op-apply = core/op/c/apply-harness
notify = core/scheduler/c/notify-harness
paths = core/scheduler/c/paths-harness
places = core/places/c/places-harness
trie = core/places/c/trie-harness
protect = core/protect/c/protect-harness
update = core/node/c/update-harness
graph = core/graph/c/main-harness
scheduler = core/scheduler/c/scheduler-harness
names = playground/files/c/names-harness
diag = playground/files/c/diag-harness
layout = playground/files/c/layout-harness
manifest = playground/files/c/manifest-harness
store = playground/files/c/store-harness
program = playground/files/c/program-harness
sys = playground/files/c/sys-harness

LIBS = tracker table node pack cbor blop id seal fragment history apply commit transport wiring squish op-apply notify paths places trie protect update graph scheduler names diag layout manifest store program sys
HARNESSES = $(foreach l,$(LIBS),$($(l)))
CHECKS = $(addsuffix -check,$(HARNESSES))

all: $(HARNESSES)
check: $(CHECKS)

define harness
$($(1)): $($(1)_src)
	$$(CC) $$(CFLAGS) $$(BLAKE3FLAGS) $$($(1)_flags) -Isync/c -o $$@ $$(filter %.c,$$^) $$($(1)_libs) -lm
$($(1))-check: $($(1)_src)
	$$(CC) $$(CHECKFLAGS) $$(BLAKE3FLAGS) $$($(1)_flags) -Isync/c -o $$@ $$(filter %.c,$$^) $$($(1)_libs) -lm
endef
$(foreach l,$(LIBS),$(eval $(call harness,$(l))))

# headers: any change rebuilds what includes them
$(HARNESSES) $(CHECKS): $(wildcard */*/c/*.h)

# env var, then the suites (in conformance/<lib>/; their scenarios next to the code, <topic>/conformance/)
tracker_test = TRACKER_HARNESS conformance/tracker/
table_test = TABLE_HARNESS conformance/table/
node_test = NODE_HARNESS conformance/node/
pack_test = PACK_HARNESS conformance/pack/ conformance/cbor/
blop_test = BLOP_HARNESS conformance/blop/
id_test = ID_HARNESS conformance/id/
seal_test = SEAL_HARNESS conformance/seal/
fragment_test = FRAGMENT_HARNESS conformance/fragment/
history_test = HISTORY_HARNESS conformance/history/
apply_test = APPLY_HARNESS conformance/apply/
commit_test = COMMIT_HARNESS conformance/commit/
transport_test = TRANSPORT_HARNESS conformance/transport/
wiring_test = WIRING_HARNESS conformance/wiring/
squish_test = SQUISH_HARNESS conformance/squish/
op-apply_test = OP_APPLY_HARNESS conformance/op-apply/ conformance/op-invert/
notify_test = NOTIFY_HARNESS conformance/notify/
paths_test = PATHS_HARNESS conformance/paths/
places_test = PLACES_HARNESS conformance/places/
trie_test = TRIE_HARNESS conformance/trie/
protect_test = PROTECT_HARNESS conformance/protect/
update_test = UPDATE_HARNESS conformance/update/
graph_test = GRAPH_HARNESS conformance/graph/
scheduler_test = SCHEDULER_HARNESS conformance/scheduler/
# the store's suite works on real folders with extended attributes (macOS), and runs the harness
store_test = STORE_HARNESS conformance/store/
names_test = NAMES_HARNESS conformance/names/
diag_test = DIAG_HARNESS conformance/diag/
layout_test = LAYOUT_HARNESS conformance/layout/
manifest_test = MANIFEST_HARNESS conformance/manifest/
# the manifest's suite writes to folders it makes, and skips them without --allow-write
manifest_deno = --allow-write
store_deno = --allow-write --allow-ffi
# the program's suite runs the harness on real folders, and calls the system
program_test = PROGRAM_HARNESS conformance/program/
program_deno = --allow-write --allow-ffi
skips = COMMIT_SKIP=30-live-stand-in.json,31-live-actor-cause.json

# per library: test-c-<lib> against its harness, test-check-<lib> against its harness-check,
# test-leaks-<lib> its harness under leaks
define run
test-c-$(1): $($(1))
	@echo "== $(1)"
	@$(if $($(1)_test),$(skips) $(firstword $($(1)_test))="$(CURDIR)/$($(1))" $(DENO) $($(1)_deno) $(wordlist 2,9,$($(1)_test)),$($(1)) $(CURDIR)/ermine/encoding/conformance/cbor/vectors.json)
test-check-$(1): $($(1))-check
	@echo "== $(1) (sanitizers)"
	@$(if $($(1)_test),$(skips) $(firstword $($(1)_test))="$(CURDIR)/$($(1))-check" $(DENO) $($(1)_deno) $(wordlist 2,9,$($(1)_test)),$($(1))-check $(CURDIR)/ermine/encoding/conformance/cbor/vectors.json)
test-leaks-$(1): $($(1))
	@echo "== $(1) (leaks)"
	@log=$$$$(mktemp); $(if $($(1)_test),LEAKS_LOG=$$$$log $(skips) $(firstword $($(1)_test))="sh $(CURDIR)/conformance/leaks.sh $(CURDIR)/$($(1))" $(DENO) $($(1)_deno) $(wordlist 2,9,$($(1)_test)),LEAKS_LOG=$$$$log sh $(CURDIR)/conformance/leaks.sh $(CURDIR)/$($(1)) $(CURDIR)/ermine/encoding/conformance/cbor/vectors.json); \
	if [ -s $$$$log ]; then cat $$$$log; rm -f $$$$log; echo "== $(1): leaked"; exit 1; fi; rm -f $$$$log
endef
$(foreach l,$(LIBS),$(eval $(call run,$(l))))
# invert's suite alone, on op-apply's harness (the same protocol)
op-invert = $(op-apply)
op-invert_test = OP_APPLY_HARNESS conformance/op-invert/
$(eval $(call run,op-invert))

test:
	$(DENO)

TESTED = $(LIBS)
test-c: $(addprefix test-c-,$(TESTED))
test-check: $(addprefix test-check-,$(TESTED))
# the harnesses under macOS's leaks (conformance/leaks.sh): the sanitizers find no leaks there
test-leaks: $(addprefix test-leaks-,$(TESTED))

# benches, -O2, not part of all
BENCHES = ermine/encoding/c/pack-bench core/scheduler/c/notify-bench core/scheduler/c/paths-bench core/op/c/squish-bench
bench: $(BENCHES)
ermine/encoding/c/pack-bench: core/node/c/node.c ermine/encoding/c/pack.c ermine/encoding/c/pack_bench.c ermine/encoding/c/json.c ermine/encoding/c/cbor.c
	$(CC) $(CFLAGS) -o $@ $^ -lm
core/scheduler/c/notify-bench: core/scheduler/c/notify.c core/op/c/value.c core/scheduler/c/bench.c
	$(CC) $(CFLAGS) -o $@ $^ -lm
core/scheduler/c/paths-bench: core/scheduler/c/paths.c core/op/c/value.c core/scheduler/c/paths_bench.c
	$(CC) $(CFLAGS) -o $@ $^ -lm
core/op/c/squish-bench: core/op/c/squish.c core/op/c/squish_bench.c
	$(CC) $(CFLAGS) -o $@ $^ -lm

# the files tool: a command line over the C store, and a shared document laid out in a folder and synced (playground/files/c/host.c):
# the files program and watcher, the scheduler, the wiring and transport, and Subduction over a WebSocket (OpenSSL for wss).
# No suite, not part of all; playground/files/c/test/sync.sh tries it. playground/files/c/files-check: the same with the sanitizers
OPENSSL ?= $(shell brew --prefix openssl@3 2>/dev/null || echo /usr)
files_src = $(sort playground/files/c/files.c playground/files/c/host.c playground/files/c/program.c playground/files/c/watch.c $(filter-out playground/files/c/store_harness.c,$(store_src)) \
	$(filter %.c,$(filter-out extensions/subduction/c/wiring_harness.c,$(wiring_src))) extensions/subduction/c/subduction/websocket.c extensions/subduction/c/subduction/transport_openssl.c)
files_flags = $(transport_flags) -I$(OPENSSL)/include
files_libs = $(transport_libs) $(program_libs) -L$(OPENSSL)/lib -lssl -lcrypto
playground/files/c/files: $(files_src) $(subduction_lib) $(wildcard */*/c/*.h)
	$(CC) $(CFLAGS) $(BLAKE3FLAGS) $(files_flags) -o $@ $(filter %.c,$^) $(files_libs) -lm
playground/files/c/files-check: $(files_src) $(subduction_lib) $(wildcard */*/c/*.h)
	$(CC) $(CHECKFLAGS) $(BLAKE3FLAGS) $(files_flags) -o $@ $(filter %.c,$^) $(files_libs) -lm

clean:
	rm -rf playground/files/c/files playground/files/c/files-check playground/files/c/files-check.dSYM
	rm -rf $(HARNESSES) $(CHECKS) $(BENCHES) $(addsuffix .dSYM,$(HARNESSES) $(CHECKS))

.PHONY: all bench check test test-c test-check clean $(addprefix test-c-,$(LIBS)) $(addprefix test-check-,$(LIBS))
