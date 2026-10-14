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

# the shared loop of every harness on the one runner: it and op's value and JSON
harness_src = conformance/c/harness.c core/op/c/value.c core/op/c/json.c

tracker_src = $(harness_src) core/scheduler/c/tracker_harness.c core/scheduler/c/tracker.c
table_src = $(harness_src) core/graph/c/table_harness.c core/graph/c/table.c
node_src = $(harness_src) conformance/c/protocol.c core/node/c/node_harness.c core/node/c/node.c core/op/c/apply.c core/op/c/invert.c
pack_src = core/node/c/node.c core/op/c/value.c core/op/c/apply.c core/op/c/invert.c ermine/encoding/c/pack.c ermine/encoding/c/pack_harness.c ermine/encoding/c/json.c ermine/encoding/c/cbor.c
cbor_src = ermine/encoding/c/cbor_test.c ermine/encoding/c/cbor.c ermine/encoding/c/json.c
blop_src = ermine/encoding/c/blop.c ermine/encoding/c/blop_harness.c ermine/encoding/c/json.c ermine/encoding/c/cbor.c $(blake3_src)
id_src = extensions/subduction/c/id.c extensions/subduction/c/id_harness.c ermine/encoding/c/json.c ermine/encoding/c/cbor.c $(blake3_src)
seal_src = extensions/subduction/c/seal.c extensions/subduction/c/seal_harness.c ermine/encoding/c/blop.c ermine/encoding/c/json.c ermine/encoding/c/cbor.c $(blake3_src) extensions/subduction/c/ed25519/ed25519.c extensions/subduction/c/ed25519/sha2.c
history_src = extensions/subduction/c/history.c extensions/subduction/c/apply.c extensions/subduction/c/history_harness.c ermine/encoding/c/blop.c ermine/encoding/c/json.c ermine/encoding/c/cbor.c $(blake3_src) \
	core/op/c/value.c core/op/c/apply.c core/node/c/update.c core/node/c/node.c
apply_src = extensions/subduction/c/history.c extensions/subduction/c/apply.c extensions/subduction/c/apply_harness.c ermine/encoding/c/blop.c ermine/encoding/c/json.c ermine/encoding/c/cbor.c $(blake3_src) \
	core/op/c/value.c core/op/c/apply.c core/node/c/update.c core/node/c/node.c
commit_src = extensions/subduction/c/history.c extensions/subduction/c/apply.c extensions/subduction/c/commit.c extensions/subduction/c/commit_harness.c ermine/encoding/c/blop.c ermine/encoding/c/json.c ermine/encoding/c/cbor.c $(blake3_src) \
	core/op/c/value.c core/op/c/apply.c core/node/c/update.c core/node/c/node.c
# Subduction's own BLAKE3 exports the same symbols as ermine/encoding/c/blake3: the C ones are renamed, in every file of the harness
subduction_rename = $(foreach s,compress_in_place compress_in_place_portable compress_subtree_wide compress_xof compress_xof_portable hash_many hash_many_portable hasher_finalize hasher_finalize_seek hasher_init hasher_init_derive_key hasher_init_derive_key_raw hasher_reset hasher_update simd_degree version xof_many,-Dblake3_$(s)=ermc_blake3_$(s))
subduction_lib = extensions/subduction/c/subduction/lib/libsubduction_c.a
transport_flags = -Ic/subduction $(subduction_rename)
transport_libs = $(subduction_lib) $(filter-out -lm,$(shell tr -d '\033' < extensions/subduction/c/subduction/lib/link.txt | sed 's/\[[0-9;]*m//g'))
transport_src = extensions/subduction/c/transport.c extensions/subduction/c/transport_harness.c extensions/subduction/c/id.c extensions/subduction/c/seal.c extensions/subduction/c/history.c extensions/subduction/c/apply.c extensions/subduction/c/commit.c extensions/subduction/c/fragment.c \
	ermine/encoding/c/blop.c ermine/encoding/c/json.c ermine/encoding/c/cbor.c $(blake3_src) extensions/subduction/c/ed25519/ed25519.c extensions/subduction/c/ed25519/sha2.c \
	core/op/c/value.c core/op/c/apply.c core/node/c/update.c core/node/c/node.c \
	extensions/subduction/c/subduction/store_memory.c extensions/subduction/c/subduction/platform_posix.c $(subduction_lib)
# the wiring: the transport's, with the scheduler (and the graph under it) it is wired to
wiring_flags = $(transport_flags)
wiring_libs = $(transport_libs)
wiring_src = extensions/subduction/c/wiring.c extensions/subduction/c/wiring_harness.c $(filter-out extensions/subduction/c/transport_harness.c,$(transport_src)) \
	core/scheduler/c/scheduler.c filesystem/places/c/places.c core/scheduler/c/tracker.c
fragment_src = extensions/subduction/c/fragment.c extensions/subduction/c/fragment_harness.c ermine/encoding/c/json.c
squish_src = $(harness_src) core/op/c/squish.c core/op/c/squish_harness.c
op-apply_src = $(harness_src) conformance/c/protocol.c core/op/c/apply_harness.c core/op/c/apply.c core/op/c/invert.c core/node/c/node.c
paths_src = $(harness_src) conformance/c/protocol.c core/scheduler/c/paths_harness.c core/scheduler/c/paths.c core/node/c/node.c core/op/c/apply.c core/op/c/invert.c
places_src = $(harness_src) filesystem/places/c/places_harness.c conformance/c/protocol.c filesystem/places/c/places.c filesystem/places/c/world.c core/graph/c/table.c core/node/c/node.c core/node/c/update.c core/op/c/value.c core/op/c/apply.c core/op/c/invert.c core/scheduler/c/paths.c core/scheduler/c/scheduler.c core/scheduler/c/order.c core/scheduler/c/rank.c core/scheduler/c/causes.c core/scheduler/c/ptrmap.c core/scheduler/c/tracker.c
protect_src = filesystem/protect/c/protect.c filesystem/protect/c/protect_harness.c $(harness_src)
update_src = $(harness_src) conformance/c/protocol.c core/node/c/update_harness.c core/node/c/update.c core/node/c/node.c core/op/c/apply.c core/op/c/invert.c
guard_src = $(harness_src) filesystem/places/c/guard_harness.c filesystem/places/c/guard.c filesystem/protect/c/protect.c conformance/c/protocol.c filesystem/places/c/places.c filesystem/places/c/world.c core/graph/c/table.c core/node/c/node.c core/node/c/update.c core/op/c/value.c core/op/c/apply.c core/op/c/invert.c core/scheduler/c/paths.c core/scheduler/c/scheduler.c core/scheduler/c/order.c core/scheduler/c/rank.c core/scheduler/c/causes.c core/scheduler/c/ptrmap.c core/scheduler/c/tracker.c
scheduler_src = $(harness_src) core/scheduler/c/scheduler.c core/scheduler/c/order.c core/scheduler/c/rank.c core/scheduler/c/causes.c core/scheduler/c/ptrmap.c core/scheduler/c/tracker.c core/scheduler/c/scheduler_harness.c
names_src = playground/files/c/names.c playground/files/c/names_harness.c ermine/encoding/c/json.c
diag_src = playground/files/c/diag.c playground/files/c/diag_harness.c ermine/encoding/c/json.c
layout_src = playground/files/c/layout.c playground/files/c/layout_harness.c playground/files/c/names.c ermine/encoding/c/json.c
store_src = playground/files/c/store.c playground/files/c/store_harness.c playground/files/c/sys.c playground/files/c/manifest.c playground/files/c/layout.c playground/files/c/names.c playground/files/c/diag.c \
	playground/files/c/external.c playground/files/c/foundation.c \
	core/node/c/node.c ermine/encoding/c/pack.c ermine/encoding/c/cbor.c ermine/encoding/c/json.c $(blake3_src)
# the files program: its watcher and harness, on the C store and the C scheduler (and the graph under it)
# sys.c's Trash against homes of its own, no suite
sys_src = playground/files/c/sys.c playground/files/c/foundation.c playground/files/c/sys_harness.c
program_src = playground/files/c/program.c playground/files/c/watch.c playground/files/c/program_harness.c $(filter-out playground/files/c/store_harness.c,$(store_src)) \
	core/scheduler/c/scheduler.c filesystem/places/c/places.c core/scheduler/c/tracker.c core/op/c/value.c core/op/c/apply.c core/node/c/update.c
program_libs = $(if $(filter Darwin,$(shell uname -s)),-framework CoreServices -framework CoreFoundation,) -lpthread
manifest_src = playground/files/c/manifest.c playground/files/c/manifest_harness.c playground/files/c/diag.c core/node/c/node.c \
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
paths = core/scheduler/c/paths-harness
places = filesystem/places/c/places-harness
protect = filesystem/protect/c/protect-harness
update = core/node/c/update-harness
guard = filesystem/places/c/guard-harness
scheduler = core/scheduler/c/scheduler-harness
names = playground/files/c/names-harness
diag = playground/files/c/diag-harness
layout = playground/files/c/layout-harness
manifest = playground/files/c/manifest-harness
store = playground/files/c/store-harness
program = playground/files/c/program-harness
sys = playground/files/c/sys-harness

LIBS = tracker table node pack cbor blop id seal fragment history apply commit transport wiring squish op-apply paths places protect update guard scheduler names diag layout manifest store program sys
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
$(HARNESSES) $(CHECKS): $(wildcard */*/c/*.h conformance/c/*.h)

# a suite on the one runner (conformance/run.ts): its scenarios (<package>/conformance/<suite>/), and
# the package's tests of its harness (<package>/typescript/<suite>_harness_test.ts), both asked of
# the harness given. its binary is the shared loop (conformance/c/harness.c), its adapter and the library
define conformance
HARNESS="$(2)" $(DENO) $($(1)_deno) conformance/run.ts $($(1)_tests) -- $($(1)_suite)
endef
tracker_suite = tracker
tracker_tests = $(wildcard core/scheduler/typescript/tracker_harness_test.ts)
table_suite = table
table_tests = $(wildcard core/graph/typescript/table_harness_test.ts)
node_suite = node
node_tests = $(wildcard core/node/typescript/node_harness_test.ts)
update_suite = update
update_tests = $(wildcard core/node/typescript/update_harness_test.ts)
squish_suite = squish
squish_tests = $(wildcard core/op/typescript/squish_harness_test.ts)
op-apply_suite = apply
op-apply_tests = $(wildcard core/op/typescript/apply_harness_test.ts)
op-invert_suite = invert
op-invert_tests = $(wildcard core/op/typescript/invert_harness_test.ts)
paths_suite = paths
paths_tests = $(wildcard core/scheduler/typescript/paths_harness_test.ts)
scheduler_suite = scheduler
scheduler_tests = $(wildcard core/scheduler/typescript/scheduler_harness_test.ts)
places_suite = places
places_tests = $(wildcard filesystem/places/typescript/places_harness_test.ts)
protect_suite = protect
protect_tests = $(wildcard filesystem/protect/typescript/protect_harness_test.ts)
guard_suite = guard
guard_tests = $(wildcard filesystem/places/typescript/guard_harness_test.ts)
# the rest: env var, then the folders of their scenarios (conformance/<lib>/)
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
	@$(if $($(1)_suite),$$(call conformance,$(1),$(CURDIR)/$($(1))),$(if $($(1)_test),$(skips) $(firstword $($(1)_test))="$(CURDIR)/$($(1))" $(DENO) $($(1)_deno) $(wordlist 2,9,$($(1)_test)),$($(1)) $(CURDIR)/ermine/encoding/conformance/cbor/vectors.json))
test-check-$(1): $($(1))-check
	@echo "== $(1) (sanitizers)"
	@$(if $($(1)_suite),$$(call conformance,$(1),$(CURDIR)/$($(1))-check),$(if $($(1)_test),$(skips) $(firstword $($(1)_test))="$(CURDIR)/$($(1))-check" $(DENO) $($(1)_deno) $(wordlist 2,9,$($(1)_test)),$($(1))-check $(CURDIR)/ermine/encoding/conformance/cbor/vectors.json))
test-leaks-$(1): $($(1))
	@echo "== $(1) (leaks)"
	@log=$$$$(mktemp); $(if $($(1)_suite),LEAKS_LOG=$$$$log $$(call conformance,$(1),sh $(CURDIR)/conformance/leaks.sh $(CURDIR)/$($(1))),$(if $($(1)_test),LEAKS_LOG=$$$$log $(skips) $(firstword $($(1)_test))="sh $(CURDIR)/conformance/leaks.sh $(CURDIR)/$($(1))" $(DENO) $($(1)_deno) $(wordlist 2,9,$($(1)_test)),LEAKS_LOG=$$$$log sh $(CURDIR)/conformance/leaks.sh $(CURDIR)/$($(1)) $(CURDIR)/ermine/encoding/conformance/cbor/vectors.json)); \
	if [ -s $$$$log ]; then cat $$$$log; rm -f $$$$log; echo "== $(1): leaked"; exit 1; fi; rm -f $$$$log
endef
$(foreach l,$(LIBS),$(eval $(call run,$(l))))
# invert's suite alone, on op-apply's harness (the same protocol)
op-invert = $(op-apply)
$(eval $(call run,op-invert))

test:
	$(DENO)
	deno task conformance

TESTED = $(LIBS) op-invert
test-c: $(addprefix test-c-,$(TESTED))
test-check: $(addprefix test-check-,$(TESTED))
# the harnesses under macOS's leaks (conformance/leaks.sh): the sanitizers find no leaks there
test-leaks: $(addprefix test-leaks-,$(TESTED))

# benches, -O2, not part of all
BENCHES = ermine/encoding/c/pack-bench core/scheduler/c/paths-bench core/op/c/squish-bench core/op/c/apply-bench
bench: $(BENCHES)
ermine/encoding/c/pack-bench: core/node/c/node.c core/op/c/value.c core/op/c/apply.c core/op/c/invert.c ermine/encoding/c/pack.c ermine/encoding/c/pack_bench.c ermine/encoding/c/json.c ermine/encoding/c/cbor.c
	$(CC) $(CFLAGS) -o $@ $^ -lm
core/scheduler/c/paths-bench: core/scheduler/c/paths.c core/op/c/value.c core/scheduler/c/paths_bench.c
	$(CC) $(CFLAGS) -o $@ $^ -lm
core/op/c/squish-bench: core/op/c/squish.c core/op/c/squish_bench.c
	$(CC) $(CFLAGS) -o $@ $^ -lm
core/op/c/apply-bench: core/op/c/apply.c core/op/c/value.c core/op/c/apply_bench.c
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
