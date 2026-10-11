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
seal_src = sync/c/seal.c sync/c/seal_harness.c encoding/c/blop.c encoding/c/json.c encoding/c/cbor.c $(blake3_src) c/ed25519/ed25519.c sync/c/sha2.c
chain_src = sync/c/chain.c sync/c/apply.c sync/c/chain_harness.c encoding/c/blop.c encoding/c/json.c encoding/c/cbor.c $(blake3_src) \
	opstreams/c/mutate.c notify/c/notify.c nodes/c/node.c nodes/c/change.c nodes/c/because.c
apply_src = sync/c/chain.c sync/c/apply.c sync/c/apply_harness.c encoding/c/blop.c encoding/c/json.c encoding/c/cbor.c $(blake3_src) \
	opstreams/c/mutate.c notify/c/notify.c nodes/c/node.c nodes/c/change.c nodes/c/because.c
commit_src = sync/c/chain.c sync/c/apply.c sync/c/commit.c sync/c/commit_harness.c encoding/c/blop.c encoding/c/json.c encoding/c/cbor.c $(blake3_src) \
	opstreams/c/mutate.c notify/c/notify.c nodes/c/node.c nodes/c/change.c nodes/c/because.c
change_src = nodes/c/change.c nodes/c/change_harness.c
fragment_src = sync/c/fragment.c sync/c/fragment_harness.c encoding/c/json.c
because_src = nodes/c/because.c nodes/c/because_harness.c
squish_src = opstreams/c/squish.c opstreams/c/squish_harness.c
notify_src = notify/c/notify.c notify/c/harness.c
places_src = graph/c/places.c graph/c/places_harness.c nodes/c/node.c
protect_src = protect/c/protect.c protect/c/harness.c
mutate_src = opstreams/c/mutate.c opstreams/c/mutate_harness.c notify/c/notify.c nodes/c/node.c
graph_src = graph/c/graph.c graph/c/graph_harness.c \
	graph/c/places.c notify/c/notify.c trackgraph/c/trackgraph.c protect/c/protect.c opstreams/c/mutate.c nodes/c/node.c
scheduler_src = scheduler/c/scheduler.c scheduler/c/steps.c scheduler/c/harness.c \
	graph/c/places.c notify/c/notify.c trackgraph/c/trackgraph.c protect/c/protect.c opstreams/c/mutate.c

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
chain = sync/c/chain-harness
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

LIBS = trackgraph node pack cbor blop id seal fragment chain apply commit change because squish notify places protect mutate graph scheduler
HARNESSES = $(foreach l,$(LIBS),$($(l)))
CHECKS = $(addsuffix -check,$(HARNESSES))

all: $(HARNESSES)
check: $(CHECKS)

define harness
$($(1)): $($(1)_src)
	$$(CC) $$(CFLAGS) $$(BLAKE3FLAGS) -Isync/c -o $$@ $$(filter %.c,$$^) -lm
$($(1))-check: $($(1)_src)
	$$(CC) $$(CHECKFLAGS) $$(BLAKE3FLAGS) -Isync/c -o $$@ $$(filter %.c,$$^) -lm
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
chain_test = CHAIN_HARNESS conformance/chain/
apply_test = APPLY_HARNESS conformance/apply/
commit_test = COMMIT_HARNESS conformance/commit/
change_test = CHANGE_HARNESS conformance/change/
because_test = BECAUSE_HARNESS conformance/because/
squish_test = SQUISH_HARNESS conformance/squish/
notify_test = NOTIFY_HARNESS conformance/notify/
places_test = PLACES_HARNESS conformance/places/
protect_test = PROTECT_HARNESS conformance/protect/
mutate_test = MUTATE_HARNESS conformance/mutate/
graph_test = GRAPH_HARNESS conformance/graph/
scheduler_test = SCHEDULER_HARNESS conformance/scheduler/
# graph/c's places has no write by path; nt_value has no typed arrays
skips = PLACES_SKIP=13-write.json MUTATE_SKIP=04-typed-arrays.json

# per library: test-c-<lib> against its harness, test-check-<lib> against its harness-check
define run
test-c-$(1): $($(1))
	@echo "== $(1)"
	@$(if $($(1)_test),$(skips) $(firstword $($(1)_test))="$(CURDIR)/$($(1))" $(DENO) $(wordlist 2,9,$($(1)_test)),$($(1)) $(CURDIR)/encoding/conformance/cbor/vectors.json)
test-check-$(1): $($(1))-check
	@echo "== $(1) (sanitizers)"
	@$(if $($(1)_test),$(skips) $(firstword $($(1)_test))="$(CURDIR)/$($(1))-check" $(DENO) $(wordlist 2,9,$($(1)_test)),$($(1))-check $(CURDIR)/encoding/conformance/cbor/vectors.json)
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

clean:
	rm -rf $(HARNESSES) $(CHECKS) $(BENCHES) $(addsuffix .dSYM,$(HARNESSES) $(CHECKS))

.PHONY: all bench check test test-c test-check clean $(addprefix test-c-,$(LIBS)) $(addprefix test-check-,$(LIBS))
