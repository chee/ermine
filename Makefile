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
table_src = $(harness_src) core/table/c/table_harness.c core/table/c/table.c
node_src = $(harness_src) conformance/c/protocol_harness.c core/node/c/node_harness.c core/node/c/node.c core/op/c/apply.c core/op/c/invert.c
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
fragment_src = extensions/subduction/c/fragment.c extensions/subduction/c/fragment_harness.c ermine/encoding/c/json.c
squish_src = $(harness_src) core/op/c/squish.c core/op/c/squish_harness.c
op-apply_src = $(harness_src) conformance/c/protocol_harness.c core/op/c/apply_harness.c core/op/c/apply.c core/op/c/invert.c core/node/c/node.c
paths_src = $(harness_src) conformance/c/protocol_harness.c core/scheduler/c/paths_harness.c core/scheduler/c/paths.c core/node/c/node.c core/op/c/apply.c core/op/c/invert.c
places_src = $(harness_src) filesystem/places/c/places_harness.c conformance/c/protocol_harness.c filesystem/places/c/places.c filesystem/places/c/cache.c ermine/clingy/c/clingy.c core/scheduler/c/selector.c filesystem/places/c/status.c filesystem/places/c/runs.c filesystem/places/c/world_harness.c core/table/c/table.c core/node/c/node.c core/node/c/update.c core/op/c/value.c core/op/c/apply.c core/op/c/invert.c core/scheduler/c/paths.c core/scheduler/c/scheduler.c core/scheduler/c/order.c core/scheduler/c/rank.c core/scheduler/c/causes.c core/scheduler/c/ptrmap.c core/scheduler/c/tracker.c
processes_src = $(filter-out filesystem/places/c/places_harness.c,$(places_src)) ermine/processes/c/processes_harness.c ermine/processes/c/processes.c ermine/processes/c/scopes.c
protect_src = filesystem/protect/c/protect.c filesystem/protect/c/protect_harness.c $(harness_src)
update_src = $(harness_src) conformance/c/protocol_harness.c core/node/c/update_harness.c core/node/c/update.c core/node/c/node.c core/op/c/apply.c core/op/c/invert.c
guard_src = $(harness_src) filesystem/places/c/guard_harness.c filesystem/places/c/guard.c filesystem/protect/c/protect.c conformance/c/protocol_harness.c filesystem/places/c/places.c filesystem/places/c/cache.c ermine/clingy/c/clingy.c core/scheduler/c/selector.c filesystem/places/c/status.c filesystem/places/c/runs.c filesystem/places/c/world_harness.c core/table/c/table.c core/node/c/node.c core/node/c/update.c core/op/c/value.c core/op/c/apply.c core/op/c/invert.c core/scheduler/c/paths.c core/scheduler/c/scheduler.c core/scheduler/c/order.c core/scheduler/c/rank.c core/scheduler/c/causes.c core/scheduler/c/ptrmap.c core/scheduler/c/tracker.c
scheduler_src = $(harness_src) core/scheduler/c/scheduler.c core/scheduler/c/order.c core/scheduler/c/rank.c core/scheduler/c/causes.c core/scheduler/c/ptrmap.c core/scheduler/c/tracker.c core/scheduler/c/scheduler_harness.c
names_src = playground/tools/files/c/names.c playground/tools/files/c/names_harness.c ermine/encoding/c/json.c
diag_src = playground/tools/files/c/diag.c playground/tools/files/c/diag_harness.c ermine/encoding/c/json.c
layout_src = playground/tools/files/c/layout.c playground/tools/files/c/layout_harness.c playground/tools/files/c/names.c ermine/encoding/c/json.c
store_src = playground/tools/files/c/store.c playground/tools/files/c/store_harness.c playground/tools/files/c/disk_harness.c playground/tools/files/c/sys.c playground/tools/files/c/manifest.c playground/tools/files/c/layout.c playground/tools/files/c/names.c playground/tools/files/c/diag.c \
	playground/tools/files/c/external.c playground/tools/files/c/foundation.c \
	playground/tools/files/c/saved.c playground/tools/files/c/saved_shown_harness.c playground/tools/files/c/saved_pack.c ermine/encoding/c/cbor.c ermine/encoding/c/json.c $(blake3_src)
# the files graph (playground/tools/files/c/graph.c): core's table, places and guard under a scheduler, and the policy they ask
graph_src = filesystem/places/c/places.c filesystem/places/c/guard.c filesystem/protect/c/protect.c core/table/c/table.c core/node/c/node.c core/node/c/update.c \
	core/op/c/value.c core/op/c/apply.c core/op/c/invert.c core/op/c/json.c core/scheduler/c/paths.c core/scheduler/c/scheduler.c core/scheduler/c/order.c core/scheduler/c/rank.c core/scheduler/c/causes.c core/scheduler/c/ptrmap.c core/scheduler/c/tracker.c
# the files program: its watcher and harness, on the C store and the C scheduler (and the graph under it)
# sys.c's Trash against homes of its own, no suite
sys_src = playground/tools/files/c/sys.c playground/tools/files/c/foundation.c playground/tools/files/c/sys_harness.c
program_src = playground/tools/files/c/program.c playground/tools/files/c/watch.c playground/tools/files/c/graph.c playground/tools/files/c/program_harness.c $(filter-out playground/tools/files/c/store_harness.c,$(store_src)) \
	$(graph_src)
program_libs = $(if $(filter Darwin,$(shell uname -s)),-framework CoreServices -framework CoreFoundation,) -lpthread
manifest_src = playground/tools/files/c/manifest.c playground/tools/files/c/manifest_harness.c playground/tools/files/c/diag.c playground/tools/files/c/saved.c playground/tools/files/c/saved_shown_harness.c \
	playground/tools/files/c/saved_pack.c ermine/encoding/c/cbor.c ermine/encoding/c/json.c $(blake3_src)

# BLAKE3 portable only: no SIMD dispatch, no NEON (ermine/encoding/c/blake3 has no such files)
blake3_src = ermine/encoding/c/blake3/blake3.c ermine/encoding/c/blake3/blake3_dispatch.c ermine/encoding/c/blake3/blake3_portable.c
BLAKE3FLAGS = -DBLAKE3_NO_SSE2 -DBLAKE3_NO_SSE41 -DBLAKE3_NO_AVX2 -DBLAKE3_NO_AVX512 -DBLAKE3_USE_NEON=0

# name: binary, sources, the suite, its env var, and what C skips
tracker = core/scheduler/c/tracker-harness
table = core/table/c/table-harness
node = core/node/c/node-harness
pack = ermine/encoding/c/pack-harness
cbor = ermine/encoding/c/cbor-test
blop = ermine/encoding/c/blop-harness
id = extensions/subduction/c/id-harness
seal = extensions/subduction/c/seal-harness
fragment = extensions/subduction/c/fragment-harness
transport = extensions/subduction/c/transport-harness
history = extensions/subduction/c/history-harness
apply = extensions/subduction/c/apply-harness
commit = extensions/subduction/c/commit-harness
squish = core/op/c/squish-harness
op-apply = core/op/c/apply-harness
paths = core/scheduler/c/paths-harness
places = filesystem/places/c/places-harness
processes = ermine/processes/c/processes-harness
protect = filesystem/protect/c/protect-harness
update = core/node/c/update-harness
guard = filesystem/places/c/guard-harness
scheduler = core/scheduler/c/scheduler-harness
names = playground/tools/files/c/names-harness
diag = playground/tools/files/c/diag-harness
layout = playground/tools/files/c/layout-harness
manifest = playground/tools/files/c/manifest-harness
store = playground/tools/files/c/store-harness
program = playground/tools/files/c/program-harness
sys = playground/tools/files/c/sys-harness

# presence (extensions/presence): its harness on places, the table and the scheduler (the C harness has no BroadcastChannel)
presence_src = $(harness_src) extensions/presence/c/presence_harness.c extensions/presence/c/presence.c extensions/presence/c/channel.c filesystem/places/c/places.c core/table/c/table.c core/node/c/node.c core/node/c/update.c core/op/c/value.c core/op/c/apply.c core/op/c/invert.c core/scheduler/c/paths.c core/scheduler/c/scheduler.c core/scheduler/c/order.c core/scheduler/c/rank.c core/scheduler/c/causes.c core/scheduler/c/ptrmap.c core/scheduler/c/tracker.c ermine/encoding/c/pack.c ermine/encoding/c/json.c ermine/encoding/c/cbor.c
presence = extensions/presence/c/presence-harness
presence_suite = presence
presence_tests = $(wildcard extensions/presence/typescript/presence_harness_test.ts)
LIBS = tracker table node pack cbor blop id seal fragment history apply commit transport squish op-apply paths places processes protect update guard scheduler names diag layout manifest store program sys
LIBS += presence
# hash (ermine/encoding): a value's name, BLAKE3 of its canonical CBOR, against conformance/hash/vectors.json
hash_src = ermine/encoding/c/hash_test.c ermine/encoding/c/hash.c ermine/encoding/c/cbor.c ermine/encoding/c/json.c $(blake3_src)
hash = ermine/encoding/c/hash-test
LIBS += hash
# deflate (ermine/encoding): the deterministic raw deflate and its inflater, on the one runner (pack.c includes deflate.c)
deflate_src = $(harness_src) ermine/encoding/c/deflate_harness.c ermine/encoding/c/deflate.c $(blake3_src)
deflate = ermine/encoding/c/deflate-harness
deflate_suite = deflate
LIBS += deflate
# patch nodes (playground/patch-nodes): the overlay and its harness, on the places harness's world
patch_src = $(filter-out filesystem/places/c/places_harness.c,$(places_src)) extensions/patch-nodes/c/patch.c extensions/patch-nodes/c/patch_harness.c
patch = extensions/patch-nodes/c/patch-harness
patch_suite = patch
patch_tests = $(wildcard extensions/patch-nodes/typescript/patch_harness_test.ts)
LIBS += patch
# unread (core/unread): an entry's writes change in place what its own earlier writes copied, until it is read
unread_src = $(harness_src) conformance/c/protocol_harness.c core/unread/c/unread.c core/unread/c/unread_harness.c core/node/c/node.c core/op/c/apply.c core/op/c/invert.c core/scheduler/c/scheduler.c core/scheduler/c/order.c core/scheduler/c/rank.c core/scheduler/c/causes.c core/scheduler/c/ptrmap.c core/scheduler/c/tracker.c
unread = core/unread/c/unread-harness
unread_flags = -DCONFORMANCE_HOOK
unread_suite = unread
unread_tests = $(wildcard core/unread/typescript/unread_harness_test.ts)
LIBS += unread
# boxes (ermine/boxes): a "/" of a process's own, a plain folder, its places a view of the host's, on the places harness's world
boxes_src = $(filter-out filesystem/places/c/places_harness.c,$(places_src)) ermine/processes/c/processes.c ermine/boxes/c/boxes.c ermine/boxes/c/boxes_harness.c
boxes = ermine/boxes/c/boxes-harness
boxes_suite = boxes
boxes_tests = $(wildcard ermine/boxes/typescript/boxes_harness_test.ts)
LIBS += boxes
# sites (ermine/sites): where a scope, computer or effect was made, noted by a macro on the create call; the scheduler alone under it
sites_src = $(harness_src) core/scheduler/c/scheduler.c core/scheduler/c/order.c core/scheduler/c/rank.c core/scheduler/c/causes.c core/scheduler/c/ptrmap.c core/scheduler/c/tracker.c ermine/sites/c/sites.c ermine/sites/c/sites_harness.c
sites = ermine/sites/c/sites-harness
sites_suite = sites
sites_tests = $(wildcard ermine/sites/typescript/sites_harness_test.ts)
sites-test_src = core/scheduler/c/scheduler.c core/scheduler/c/order.c core/scheduler/c/rank.c core/scheduler/c/causes.c core/scheduler/c/ptrmap.c core/scheduler/c/tracker.c ermine/sites/c/sites.c ermine/sites/c/sites_test.c
sites-test = ermine/sites/c/sites-test
LIBS += sites sites-test
# clingy (ermine/clingy): keys known tracked or not, told when their last tracker goes; no suite
clingy-test_src = core/scheduler/c/scheduler.c core/scheduler/c/order.c core/scheduler/c/rank.c core/scheduler/c/causes.c core/scheduler/c/ptrmap.c core/scheduler/c/tracker.c ermine/clingy/c/clingy.c ermine/clingy/c/clingy_test.c
clingy-test = ermine/clingy/c/clingy-test
LIBS += clingy-test
# programs (playground/programs): satisfy and open (programs) and start, over ermine/types, ermine/processes' start and
# extensions/build's build and host functions; build (extensions/build) on its own. on the places harness's world with boxes
programs_base = $(filter-out filesystem/places/c/places_harness.c,$(places_src)) ermine/processes/c/processes.c ermine/boxes/c/boxes.c ermine/encoding/c/pack.c ermine/encoding/c/json.c ermine/encoding/c/cbor.c ermine/encoding/c/hash.c $(blake3_src) extensions/build/c/host.c
programs_lib = ermine/types/c/types.c ermine/types/c/utis.c extensions/programs/c/programs.c extensions/programs/c/programs_json.c
programs_src = $(programs_base) $(programs_lib) extensions/programs/c/programs_harness.c
programs = extensions/programs/c/programs-harness
programs_suite = programs
programs_tests = $(wildcard extensions/programs/typescript/programs_harness_test.ts)
programs-build_src = $(programs_base) extensions/build/c/build.c extensions/build/c/build_harness.c
programs-build = extensions/build/c/build-harness
programs-build_suite = build
programs-start_src = $(programs_base) $(programs_lib) extensions/build/c/build.c ermine/processes/c/start.c extensions/programs/c/start.c extensions/programs/c/start_harness.c ermine/processes/c/scopes.c ermine/sites/c/sites.c extensions/programs/c/dlopen.c
programs-start = extensions/programs/c/start-harness
programs-start_suite = start
programs-start_flags = -DPG_FIXTURES='"$(CURDIR)/extensions/programs/c/fixtures/"'
LIBS += programs programs-build programs-start
# native fixtures (extensions/programs/c/fixtures): libraries for this machine (native.h) the start harnesses
# load through the dlopen runner (conformance/native); built here with the harness, never checked in.
# unsigned.so: runner.c with no ad hoc signature (macOS), for the runner to sign
native_fixtures = extensions/programs/c/fixtures/reverse.so extensions/programs/c/fixtures/runner.so extensions/programs/c/fixtures/unsigned.so
native_darwin = $(filter Darwin,$(shell uname -s))
native_shared = $(if $(native_darwin),-dynamiclib,-shared -fPIC)
extensions/programs/c/fixtures/%.so: extensions/programs/c/fixtures/%.c extensions/programs/c/native.h
	$(CC) $(CFLAGS) $(native_shared) -o $@ $<
extensions/programs/c/fixtures/unsigned.so: extensions/programs/c/fixtures/runner.c extensions/programs/c/native.h
	$(CC) $(CFLAGS) $(native_shared) $(if $(native_darwin),-Wl$(comma)-no_adhoc_codesign) -o $@ $<
comma = ,
$(programs-start) $(programs-start)-check: $(native_fixtures)
clean: clean-native
clean-native:
	rm -f $(native_fixtures)
# the process api (ermine/api): its harness on places, processes, guard, status, presence and patch nodes, on its own world
api_src = $(filter-out filesystem/places/c/places_harness.c filesystem/places/c/world_harness.c,$(places_src)) ermine/processes/c/processes.c ermine/processes/c/scopes.c filesystem/places/c/guard.c filesystem/protect/c/protect.c extensions/presence/c/presence.c extensions/presence/c/channel.c extensions/patch-nodes/c/patch.c ermine/api/c/api.c ermine/api/c/api_harness.c ermine/sites/c/sites.c ermine/encoding/c/pack.c ermine/encoding/c/json.c ermine/encoding/c/cbor.c
api = ermine/api/c/api-harness
api_suite = api
api_tests = $(wildcard ermine/api/typescript/api_harness_test.ts)
LIBS += api
# sync's pieces for the new commit shape (ermine/encoding commit, extensions/sync): their own loop (lines_harness.c is conformance/c/harness.c
# reading a symbol as a string no one can carry), against the suites in ermine/encoding/conformance and extensions/sync/conformance.
# commit_form_harness.c (a commit's forms on the line) and commits_harness.c (the commits a harness makes by label) are the harnesses', never
# the libraries'
sync_harness_src = ermine/encoding/c/lines_harness.c core/op/c/value.c core/op/c/json.c ermine/encoding/c/commit_form_harness.c
sync_commits_src = extensions/sync/c/commits_harness.c
sync_commit_src = ermine/encoding/c/commit.c ermine/encoding/c/pack.c ermine/encoding/c/cbor.c ermine/encoding/c/json.c $(blake3_src) core/node/c/node.c core/op/c/apply.c core/op/c/invert.c
sync-commit_src = $(sync_harness_src) ermine/encoding/c/commit_harness.c $(sync_commit_src)
sync-commit = ermine/encoding/c/commit-harness
sync-commit_suite = commit
LIBS += sync-commit
sync-seal_src = $(sync_harness_src) extensions/sync/c/seal_harness.c extensions/sync/c/seal.c extensions/sync/c/ed25519/ed25519.c extensions/sync/c/ed25519/sha2.c $(sync_commit_src)
sync-seal = extensions/sync/c/seal-harness
sync-seal_suite = seal
LIBS += sync-seal
sync_signed_src = extensions/sync/c/seal.c extensions/sync/c/ed25519/ed25519.c extensions/sync/c/ed25519/sha2.c $(sync_commit_src)
sync-run_src = $(sync_harness_src) $(sync_commits_src) extensions/sync/c/run_harness.c extensions/sync/c/run.c $(sync_signed_src)
sync-run = extensions/sync/c/run-harness
sync-run_suite = run
LIBS += sync-run
# history, replay and snapshot: one harness, three suites (replay's and snapshot's suite.json name history's)
sync-history_src = $(sync_harness_src) $(sync_commits_src) conformance/c/protocol_harness.c extensions/sync/c/history_harness.c extensions/sync/c/history.c extensions/sync/c/replay.c extensions/sync/c/snapshot.c extensions/sync/c/egwalker.c $(sync_signed_src)
sync-history = extensions/sync/c/history-harness
sync-history_suite = history replay snapshot egwalker
LIBS += sync-history
# the transport (devices over Subduction for C) and the integration with the table: Subduction's BLAKE3 and ermine/encoding's
# are both linked, the C ones renamed (subduction_rename). Fragments are extensions/subduction's, as in the TypeScript
sync_transport_src = extensions/sync/c/transport.c extensions/sync/c/ids.c extensions/sync/c/history.c extensions/sync/c/replay.c extensions/sync/c/snapshot.c \
	extensions/sync/c/run.c extensions/subduction/c/fragment.c extensions/subduction/c/subduction/platform_posix.c $(sync_signed_src)
sync-transport_src = $(sync_harness_src) $(sync_commits_src) conformance/c/protocol_harness.c extensions/sync/c/transport_harness.c extensions/sync/c/wires_harness.c \
	extensions/subduction/c/subduction/store_memory.c $(sync_transport_src) $(subduction_lib)
sync-transport = extensions/sync/c/transport-harness
sync-transport_suite = transport
sync-transport_flags = $(subduction_rename) -DCONFORMANCE_HOOK
sync-transport_libs = $(transport_libs)
LIBS += sync-transport
sync-sync_src = $(sync_harness_src) $(sync_commits_src) conformance/c/protocol_harness.c extensions/sync/c/sync_harness.c extensions/sync/c/sync.c extensions/sync/c/egwalker.c extensions/sync/c/wires_harness.c \
	extensions/subduction/c/subduction/store_memory.c core/table/c/table.c core/node/c/update.c $(sync_transport_src) $(subduction_lib)
sync-sync = extensions/sync/c/sync-harness
sync-sync_suite = sync
sync-sync_flags = $(subduction_rename)
sync-sync_libs = $(transport_libs)
LIBS += sync-sync
# the presence channel over a device's ephemeral messages: two devices on a pipe, as channel_test.ts tries it; no suite
sync-channel-test_src = extensions/sync/c/channel_test.c extensions/sync/c/channel.c extensions/sync/c/wires_harness.c core/op/c/value.c \
	extensions/subduction/c/subduction/store_memory.c $(sync_transport_src) $(subduction_lib)
sync-channel-test = extensions/sync/c/channel-test
sync-channel-test_flags = $(subduction_rename)
sync-channel-test_libs = $(transport_libs)
LIBS += sync-channel-test
# two hosts typing into one text, merging by eg-walker (merge_bench.ts in C): merge-bench [keys] [pure]; no suite
sync-merge-bench_src = extensions/sync/c/merge_bench.c extensions/sync/c/sync.c extensions/sync/c/egwalker.c extensions/sync/c/wires_harness.c \
	core/op/c/value.c core/op/c/json.c extensions/subduction/c/subduction/store_memory.c core/table/c/table.c core/node/c/update.c \
	$(sync_transport_src) $(subduction_lib)
sync-merge-bench = extensions/sync/c/merge-bench
sync-merge-bench_flags = $(subduction_rename)
sync-merge-bench_libs = $(transport_libs)
LIBS += sync-merge-bench
# JSON text (ermine/encoding/c/json_text.c): only what reads or writes it, the harnesses and the files store; program
# has it through store
json_text_src = ermine/encoding/c/json_text.c
$(foreach l,blop cbor hash pack id seal history apply commit fragment transport sync-run names diag layout manifest store,$(eval $(l)_src += $(json_text_src)))
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
table_tests = $(wildcard core/table/typescript/table_harness_test.ts)
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
processes_suite = processes
processes_tests = $(wildcard ermine/processes/typescript/processes_harness_test.ts)
protect_suite = protect
protect_tests = $(wildcard filesystem/protect/typescript/protect_harness_test.ts)
guard_suite = guard
guard_tests = $(wildcard filesystem/places/typescript/guard_harness_test.ts)
# the rest: env var, then the folders of their scenarios (conformance/<lib>/)
pack_test = PACK_HARNESS conformance/pack/ conformance/cbor/
blop_test = BLOP_HARNESS conformance/blop/
# extensions/subduction's suites (extensions/subduction/conformance/subduction-<suite>/, the names of extensions/sync's and core/op's
# are theirs): the C commit has no live values, so subduction-commit-live is only the TypeScript harness's (not here: HARNESS would send it to C)
id_suite = subduction-id
seal_suite = subduction-seal
fragment_suite = subduction-fragment
history_suite = subduction-history
apply_suite = subduction-apply
commit_suite = subduction-commit
transport_suite = subduction-transport
# their fuzzes, against the same harness (HARNESS): the id's, the history's order fuzz and the fragment's against Subduction's own code
id_tests = extensions/subduction/conformance/id_fuzz_test.ts
history_tests = extensions/subduction/conformance/history_fuzz_test.ts
fragment_tests = extensions/subduction/conformance/fragment_fuzz_test.ts
# the files program's suites (playground/tools/files/conformance); the manifest's, the store's and the program's harnesses
# work in temp folders of their own, the store's and the program's on real folders with extended attributes (macOS)
names_suite = names
diag_suite = diag
layout_suite = layout
manifest_suite = manifest
store_suite = store
program_suite = program

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
# open's suite alone, on programs' harness (the same protocol)
programs-open = $(programs)
programs-open_suite = open
$(eval $(call run,programs-open))
# types' suite (a node's type by its name) alone, on programs' harness
programs-types = $(programs)
programs-types_suite = types
$(eval $(call run,programs-types))
# native's suite alone, on start's harness (the same protocol, and the dlopen runner)
programs-native = $(programs-start)
programs-native_suite = native
$(eval $(call run,programs-native))

test:
	$(DENO)
	deno task conformance

TESTED = $(LIBS) op-invert
TESTED += programs-open
TESTED += programs-types
TESTED += programs-native
test-c: $(addprefix test-c-,$(TESTED))
test-check: $(addprefix test-check-,$(TESTED))
# the harnesses under macOS's leaks (conformance/leaks.sh): the sanitizers find no leaks there
test-leaks: $(addprefix test-leaks-,$(TESTED))

# benches, -O2, not part of all
BENCHES = ermine/encoding/c/pack-bench core/scheduler/c/paths-bench core/op/c/squish-bench core/op/c/apply-bench extensions/patch-nodes/c/patch-bench core/unread/c/unread-bench
bench: $(BENCHES)
ermine/encoding/c/pack-bench: core/node/c/node.c core/op/c/value.c core/op/c/apply.c core/op/c/invert.c ermine/encoding/c/pack.c ermine/encoding/c/pack_bench.c ermine/encoding/c/json.c ermine/encoding/c/cbor.c
	$(CC) $(CFLAGS) -o $@ $^ -lm
core/scheduler/c/paths-bench: core/scheduler/c/paths.c core/op/c/value.c core/scheduler/c/paths_bench.c
	$(CC) $(CFLAGS) -o $@ $^ -lm
core/op/c/squish-bench: core/op/c/squish.c core/op/c/squish_bench.c
	$(CC) $(CFLAGS) -o $@ $^ -lm
core/op/c/apply-bench: core/op/c/apply.c core/op/c/value.c core/op/c/apply_bench.c
	$(CC) $(CFLAGS) -o $@ $^ -lm
extensions/patch-nodes/c/patch-bench: $(filter-out filesystem/places/c/places_harness.c filesystem/places/c/world_harness.c filesystem/places/c/status.c conformance/c/harness.c conformance/c/protocol_harness.c core/op/c/json.c,$(places_src)) extensions/patch-nodes/c/patch.c extensions/patch-nodes/c/patch_bench.c
	$(CC) $(CFLAGS) -o $@ $^ -lm
core/unread/c/unread-bench: core/node/c/node.c core/node/c/update.c core/op/c/value.c core/op/c/apply.c core/op/c/invert.c core/unread/c/unread.c core/unread/c/unread_bench.c core/scheduler/c/scheduler.c core/scheduler/c/order.c core/scheduler/c/rank.c core/scheduler/c/causes.c core/scheduler/c/ptrmap.c core/scheduler/c/tracker.c
	$(CC) $(CFLAGS) -o $@ $^ -lm

# the files tool: a command line over the C store (playground/tools/files/c/files.c). Its synced document (host.c: the files program and
# watcher, the scheduler, the wiring and transport, Subduction over a WebSocket) is left out until sync is rewritten for today's graph:
# host.c is a stub that says so. No suite, not part of all; playground/tools/files/c/test/cli.sh tries it. playground/tools/files/c/files-check:
# the same with the sanitizers
# the files tool, and its host (host.c): the store, the files program and its watcher on the files graph, synced by
# extensions/sync over Subduction (its files store, a WebSocket over OpenSSL)
OPENSSL ?= $(shell brew --prefix openssl@3 2>/dev/null || echo /usr)
files_src = $(sort playground/tools/files/c/files.c playground/tools/files/c/host.c playground/tools/files/c/program.c playground/tools/files/c/watch.c playground/tools/files/c/graph.c \
	$(filter-out playground/tools/files/c/store_harness.c playground/tools/files/c/disk_harness.c,$(store_src)) $(graph_src) \
	extensions/sync/c/sync.c extensions/sync/c/egwalker.c $(sync_transport_src) extensions/subduction/c/subduction/store_files.c \
	extensions/subduction/c/subduction/websocket.c extensions/subduction/c/subduction/transport_openssl.c)
files_flags = $(subduction_rename) -I$(OPENSSL)/include
files_libs = $(transport_libs) $(program_libs) -L$(OPENSSL)/lib -lssl -lcrypto
playground/tools/files/c/files: $(files_src) $(wildcard */*/c/*.h)
	$(CC) $(CFLAGS) $(BLAKE3FLAGS) $(files_flags) -o $@ $(filter %.c,$^) $(files_libs) -lm
playground/tools/files/c/files-check: $(files_src) $(wildcard */*/c/*.h)
	$(CC) $(CHECKFLAGS) $(BLAKE3FLAGS) $(files_flags) -o $@ $(filter %.c,$^) $(files_libs) -lm

clean:
	rm -rf playground/tools/files/c/files playground/tools/files/c/files-check playground/tools/files/c/files-check.dSYM
	rm -rf $(HARNESSES) $(CHECKS) $(BENCHES) $(addsuffix .dSYM,$(HARNESSES) $(CHECKS))

.PHONY: all bench check test test-c test-check clean $(addprefix test-c-,$(LIBS)) $(addprefix test-check-,$(LIBS))
