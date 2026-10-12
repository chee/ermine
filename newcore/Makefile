# newcore's C: every library's harness, and their conformance runs against the reference suites.
#   make              every harness
#   make check        every harness-check: address and undefined-behaviour sanitizers
#   make test         the TypeScript tests (the references)
#   make test-c       each conformance suite against its C harness
#   make test-check   the same against the harness-checks
#   make clean
# <topic>/c/build.sh builds that topic's libraries alone (CHECK=1: the harness-checks).

CC ?= cc
CFLAGS = -std=c11 -O2 -Wall -Wextra -Wpedantic
CHECKFLAGS = -std=c11 -g -O1 -Wall -Wextra -Wpedantic -fsanitize=address,undefined -fno-omit-frame-pointer
DENO = deno test --quiet --allow-run --allow-read --allow-env

trackgraph_src = trackgraph/c/trackgraph.c trackgraph/c/trackgraph_harness.c
node_src = nodes/c/node.c nodes/c/shown.c nodes/c/node_harness.c
pack_src = nodes/c/node.c nodes/c/shown.c encoding/c/pack.c encoding/c/pack_harness.c encoding/c/json.c encoding/c/cbor.c
cbor_src = encoding/c/cbor_test.c encoding/c/cbor.c encoding/c/json.c
blop_src = encoding/c/blop.c encoding/c/blop_harness.c encoding/c/json.c encoding/c/cbor.c $(blake3_src)
id_src = sync/c/id.c sync/c/id_harness.c encoding/c/json.c encoding/c/cbor.c $(blake3_src)
seal_src = sync/c/seal.c sync/c/seal_harness.c encoding/c/blop.c encoding/c/json.c encoding/c/cbor.c $(blake3_src) c/ed25519/ed25519.c c/ed25519/sha2.c
history_src = sync/c/history.c sync/c/apply.c sync/c/history_harness.c encoding/c/blop.c encoding/c/json.c encoding/c/cbor.c $(blake3_src) \
	opstreams/c/mutate.c notify/c/notify.c nodes/c/node.c nodes/c/change.c nodes/c/because.c
apply_src = sync/c/history.c sync/c/apply.c sync/c/apply_harness.c encoding/c/blop.c encoding/c/json.c encoding/c/cbor.c $(blake3_src) \
	opstreams/c/mutate.c notify/c/notify.c nodes/c/node.c nodes/c/change.c nodes/c/because.c
commit_src = sync/c/history.c sync/c/apply.c sync/c/commit.c sync/c/commit_harness.c encoding/c/blop.c encoding/c/json.c encoding/c/cbor.c $(blake3_src) \
	opstreams/c/mutate.c notify/c/notify.c nodes/c/node.c nodes/c/change.c nodes/c/because.c
change_src = nodes/c/change.c nodes/c/change_harness.c
# Subduction's own BLAKE3 exports the same symbols as c/blake3: the C ones are renamed, in every file of the harness
subduction_rename = $(foreach s,compress_in_place compress_in_place_portable compress_subtree_wide compress_xof compress_xof_portable hash_many hash_many_portable hasher_finalize hasher_finalize_seek hasher_init hasher_init_derive_key hasher_init_derive_key_raw hasher_reset hasher_update simd_degree version xof_many,-Dblake3_$(s)=ermc_blake3_$(s))
subduction_lib = c/subduction/lib/libsubduction_c.a
transport_flags = -Ic/subduction $(subduction_rename)
transport_libs = $(subduction_lib) $(filter-out -lm,$(shell tr -d '\033' < c/subduction/lib/link.txt | sed 's/\[[0-9;]*m//g'))
transport_src = sync/c/transport.c sync/c/transport_harness.c sync/c/id.c sync/c/seal.c sync/c/history.c sync/c/apply.c sync/c/commit.c sync/c/fragment.c \
	encoding/c/blop.c encoding/c/json.c encoding/c/cbor.c $(blake3_src) c/ed25519/ed25519.c c/ed25519/sha2.c \
	opstreams/c/mutate.c notify/c/notify.c nodes/c/node.c nodes/c/change.c nodes/c/because.c \
	c/subduction/store_memory.c c/subduction/platform_posix.c $(subduction_lib)
# the wiring: the transport's, with the scheduler (and the graph under it) it is wired to
wiring_flags = $(transport_flags)
wiring_libs = $(transport_libs)
wiring_src = sync/c/wiring.c sync/c/wiring_harness.c $(filter-out sync/c/transport_harness.c,$(transport_src)) \
	scheduler/c/scheduler.c graph/c/graph.c graph/c/places.c trackgraph/c/trackgraph.c protect/c/protect.c
fragment_src = sync/c/fragment.c sync/c/fragment_harness.c encoding/c/json.c
because_src = nodes/c/because.c nodes/c/because_harness.c
squish_src = opstreams/c/squish.c opstreams/c/squish_harness.c
notify_src = notify/c/notify.c notify/c/harness.c
places_src = graph/c/places.c graph/c/places_harness.c nodes/c/node.c opstreams/c/mutate.c notify/c/notify.c
protect_src = protect/c/protect.c protect/c/harness.c
mutate_src = opstreams/c/mutate.c opstreams/c/mutate_harness.c notify/c/notify.c nodes/c/node.c
graph_src = graph/c/graph.c graph/c/graph_harness.c \
	graph/c/places.c notify/c/notify.c trackgraph/c/trackgraph.c protect/c/protect.c opstreams/c/mutate.c nodes/c/node.c
scheduler_src = scheduler/c/scheduler.c scheduler/c/steps.c scheduler/c/harness.c graph/c/graph.c \
	graph/c/places.c notify/c/notify.c trackgraph/c/trackgraph.c protect/c/protect.c opstreams/c/mutate.c
names_src = files/c/names.c files/c/names_harness.c encoding/c/json.c
diag_src = files/c/diag.c files/c/diag_harness.c encoding/c/json.c
layout_src = files/c/layout.c files/c/layout_harness.c files/c/names.c encoding/c/json.c
store_src = files/c/store.c files/c/store_harness.c files/c/sys.c files/c/manifest.c files/c/layout.c files/c/names.c files/c/diag.c \
	files/c/external.c files/c/foundation.c \
	nodes/c/node.c nodes/c/shown.c encoding/c/pack.c encoding/c/cbor.c encoding/c/json.c $(blake3_src)
# the files program: its watcher and harness, on the C store and the C scheduler (and the graph under it)
# sys.c's Trash against homes of its own, no suite
sys_src = files/c/sys.c files/c/foundation.c files/c/sys_harness.c
program_src = files/c/program.c files/c/watch.c files/c/program_harness.c $(filter-out files/c/store_harness.c,$(store_src)) \
	scheduler/c/scheduler.c graph/c/graph.c graph/c/places.c notify/c/notify.c trackgraph/c/trackgraph.c protect/c/protect.c opstreams/c/mutate.c
program_libs = $(if $(filter Darwin,$(shell uname -s)),-framework CoreServices -framework CoreFoundation,) -lpthread
manifest_src = files/c/manifest.c files/c/manifest_harness.c files/c/diag.c nodes/c/node.c nodes/c/shown.c \
	encoding/c/pack.c encoding/c/cbor.c encoding/c/json.c $(blake3_src)

# BLAKE3 portable only: no SIMD dispatch, no NEON (c/blake3 has no such files)
blake3_src = c/blake3/blake3.c c/blake3/blake3_dispatch.c c/blake3/blake3_portable.c
BLAKE3FLAGS = -DBLAKE3_NO_SSE2 -DBLAKE3_NO_SSE41 -DBLAKE3_NO_AVX2 -DBLAKE3_NO_AVX512 -DBLAKE3_USE_NEON=0

# name: binary, sources, the suite, its env var, and what C skips
trackgraph = trackgraph/c/trackgraph-harness
node = nodes/c/node-harness
pack = encoding/c/pack-harness
cbor = encoding/c/cbor-test
blop = encoding/c/blop-harness
id = sync/c/id-harness
seal = sync/c/seal-harness
fragment = sync/c/fragment-harness
transport = sync/c/transport-harness
wiring = sync/c/wiring-harness
history = sync/c/history-harness
apply = sync/c/apply-harness
commit = sync/c/commit-harness
change = nodes/c/change-harness
because = nodes/c/because-harness
squish = opstreams/c/squish-harness
notify = notify/c/notify-harness
places = graph/c/places-harness
protect = protect/c/protect-harness
mutate = opstreams/c/mutate-harness
graph = graph/c/graph-harness
scheduler = scheduler/c/scheduler-harness
names = files/c/names-harness
diag = files/c/diag-harness
layout = files/c/layout-harness
manifest = files/c/manifest-harness
store = files/c/store-harness
program = files/c/program-harness
sys = files/c/sys-harness

LIBS = trackgraph node pack cbor blop id seal fragment history apply commit transport wiring change because squish notify places protect mutate graph scheduler names diag layout manifest store program sys
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
$(HARNESSES) $(CHECKS): $(wildcard */c/*.h)

# env var, then the suites (in conformance/<lib>/; their scenarios next to the code, <topic>/conformance/)
trackgraph_test = TRACKGRAPH_HARNESS conformance/trackgraph/
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
change_test = CHANGE_HARNESS conformance/change/
because_test = BECAUSE_HARNESS conformance/because/
squish_test = SQUISH_HARNESS conformance/squish/
notify_test = NOTIFY_HARNESS conformance/notify/
places_test = PLACES_HARNESS conformance/places/
protect_test = PROTECT_HARNESS conformance/protect/
mutate_test = MUTATE_HARNESS conformance/mutate/
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

# per library: test-c-<lib> against its harness, test-check-<lib> against its harness-check
define run
test-c-$(1): $($(1))
	@echo "== $(1)"
	@$(if $($(1)_test),$(skips) $(firstword $($(1)_test))="$(CURDIR)/$($(1))" $(DENO) $($(1)_deno) $(wordlist 2,9,$($(1)_test)),$($(1)) $(CURDIR)/encoding/conformance/cbor/vectors.json)
test-check-$(1): $($(1))-check
	@echo "== $(1) (sanitizers)"
	@$(if $($(1)_test),$(skips) $(firstword $($(1)_test))="$(CURDIR)/$($(1))-check" $(DENO) $($(1)_deno) $(wordlist 2,9,$($(1)_test)),$($(1))-check $(CURDIR)/encoding/conformance/cbor/vectors.json)
endef
$(foreach l,$(LIBS),$(eval $(call run,$(l))))

test:
	$(DENO)

test-c: $(addprefix test-c-,$(LIBS))
test-check: $(addprefix test-check-,$(LIBS))

# benches, -O2, not part of all
BENCHES = encoding/c/pack-bench notify/c/notify-bench opstreams/c/squish-bench
bench: $(BENCHES)
encoding/c/pack-bench: nodes/c/node.c encoding/c/pack.c encoding/c/pack_bench.c encoding/c/json.c encoding/c/cbor.c
	$(CC) $(CFLAGS) -o $@ $^ -lm
notify/c/notify-bench: notify/c/notify.c notify/c/bench.c
	$(CC) $(CFLAGS) -o $@ $^ -lm
opstreams/c/squish-bench: opstreams/c/squish.c opstreams/c/squish_bench.c
	$(CC) $(CFLAGS) -o $@ $^ -lm

# the files tool: a command line over the C store, and a shared document laid out in a folder and synced (files/c/host.c):
# the files program and watcher, the scheduler, the wiring and transport, and Subduction over a WebSocket (OpenSSL for wss).
# No suite, not part of all; files/c/test/sync.sh tries it. files/c/files-check: the same with the sanitizers
OPENSSL ?= $(shell brew --prefix openssl@3 2>/dev/null || echo /usr)
files_src = $(sort files/c/files.c files/c/host.c files/c/program.c files/c/watch.c $(filter-out files/c/store_harness.c,$(store_src)) \
	$(filter %.c,$(filter-out sync/c/wiring_harness.c,$(wiring_src))) c/subduction/websocket.c c/subduction/transport_openssl.c)
files_flags = $(transport_flags) -I$(OPENSSL)/include
files_libs = $(transport_libs) $(program_libs) -L$(OPENSSL)/lib -lssl -lcrypto
files/c/files: $(files_src) $(subduction_lib) $(wildcard */c/*.h)
	$(CC) $(CFLAGS) $(BLAKE3FLAGS) $(files_flags) -o $@ $(filter %.c,$^) $(files_libs) -lm
files/c/files-check: $(files_src) $(subduction_lib) $(wildcard */c/*.h)
	$(CC) $(CHECKFLAGS) $(BLAKE3FLAGS) $(files_flags) -o $@ $(filter %.c,$^) $(files_libs) -lm

clean:
	rm -rf files/c/files files/c/files-check files/c/files-check.dSYM
	rm -rf $(HARNESSES) $(CHECKS) $(BENCHES) $(addsuffix .dSYM,$(HARNESSES) $(CHECKS))

.PHONY: all bench check test test-c test-check clean $(addprefix test-c-,$(LIBS)) $(addprefix test-check-,$(LIBS))
