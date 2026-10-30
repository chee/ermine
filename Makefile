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
# glibc declares arc4random_buf, clock_gettime and open_memstream only in its default set, which
# -std=c11 turns off (processes/c/platform.h: what a platform supplies)
SOURCE = $(if $(filter Linux,$(shell uname -s)),-D_DEFAULT_SOURCE,)
CFLAGS += $(SOURCE)
CHECKFLAGS = -std=c11 -g -O1 -Wall -Wextra -Wpedantic -fsanitize=address,undefined -fno-omit-frame-pointer $(SOURCE)
DENO = deno test --quiet --allow-run --allow-read --allow-env

# the shared loop of every harness on the one runner: it and changeable's value and JSON
harness_src = conformance/c/harness.c changeable/c/value.c changeable/c/json.c changeable/c/frame.c

tracker_src = $(harness_src) reactivity/c/tracker_harness.c reactivity/c/tracker.c
table_src = $(harness_src) graph/c/table_harness.c graph/c/table.c
node_src = $(harness_src) conformance/c/protocol_harness.c graph/c/node_harness.c graph/c/node.c changeable/c/apply.c changeable/c/invert.c
cbor_src = encoding/c/cbor_test.c encoding/c/cbor.c encoding/c/json.c
squish_src = $(harness_src) changeable/c/squish.c changeable/c/squish_harness.c
changeable-apply_src = $(harness_src) conformance/c/protocol_harness.c changeable/c/apply_harness.c changeable/c/apply.c changeable/c/invert.c graph/c/node.c
paths_src = $(harness_src) conformance/c/protocol_harness.c reactivity/c/paths_harness.c reactivity/c/paths.c graph/c/node.c changeable/c/apply.c changeable/c/invert.c
places_src = $(harness_src) places/c/places_harness.c conformance/c/protocol_harness.c places/c/places.c crow/c/crow.c places/c/crowify.c places/c/world_harness.c graph/c/table.c graph/c/node.c graph/c/update.c changeable/c/value.c changeable/c/apply.c changeable/c/invert.c reactivity/c/paths.c reactivity/c/scheduler.c reactivity/c/order.c reactivity/c/rank.c reactivity/c/causes.c changeable/c/ptrmap.c reactivity/c/tracker.c
processes_src = $(filter-out places/c/places_harness.c,$(places_src)) processes/c/processes_harness.c processes/c/processes.c processes/c/scopes.c
protect_src = protect/c/protect.c protect/c/protect_harness.c $(harness_src)
update_src = $(harness_src) conformance/c/protocol_harness.c graph/c/update_harness.c graph/c/update.c graph/c/node.c changeable/c/apply.c changeable/c/invert.c
guard_src = $(harness_src) processes/c/guard_harness.c processes/c/guard.c protect/c/protect.c conformance/c/protocol_harness.c places/c/places.c crow/c/crow.c places/c/crowify.c places/c/world_harness.c graph/c/table.c graph/c/node.c graph/c/update.c changeable/c/value.c changeable/c/apply.c changeable/c/invert.c reactivity/c/paths.c reactivity/c/scheduler.c reactivity/c/order.c reactivity/c/rank.c reactivity/c/causes.c changeable/c/ptrmap.c reactivity/c/tracker.c
scheduler_src = $(harness_src) reactivity/c/scheduler.c reactivity/c/order.c reactivity/c/rank.c reactivity/c/causes.c changeable/c/ptrmap.c reactivity/c/tracker.c reactivity/c/scheduler_harness.c

# BLAKE3 portable only: no SIMD dispatch, no NEON (encoding/c/blake3 has no such files)
blake3_src = encoding/c/blake3/blake3.c encoding/c/blake3/blake3_dispatch.c encoding/c/blake3/blake3_portable.c
BLAKE3FLAGS = -DBLAKE3_NO_SSE2 -DBLAKE3_NO_SSE41 -DBLAKE3_NO_AVX2 -DBLAKE3_NO_AVX512 -DBLAKE3_USE_NEON=0

# name: binary, sources, the suite, its env var, and what C skips
tracker = reactivity/c/tracker-harness
table = graph/c/table-harness
node = graph/c/node-harness
cbor = encoding/c/cbor-test
squish = changeable/c/squish-harness
changeable-apply = changeable/c/apply-harness
paths = reactivity/c/paths-harness
places = places/c/places-harness
processes = processes/c/processes-harness
protect = protect/c/protect-harness
update = graph/c/update-harness
guard = processes/c/guard-harness
scheduler = reactivity/c/scheduler-harness

LIBS = tracker table node cbor squish changeable-apply paths places processes protect update guard scheduler
# squish at the ends of a 64-bit whole number, what no scenario reaches: a test of its own
squish-test_src = changeable/c/squish.c changeable/c/squish_test.c
squish-test = changeable/c/squish-test
LIBS += squish-test
# the JSON writer (changeable's json.c) on a value far deeper than the C stack holds by recursion
json-test_src = changeable/c/json.c changeable/c/value.c changeable/c/json_test.c
json-test = changeable/c/json-test
LIBS += json-test
# Ed25519 (encoding/ed25519): RFC 8032's first test vector and what a strict check refuses
ed25519-test_src = encoding/ed25519/c/ed25519.c encoding/ed25519/c/sha2.c encoding/ed25519/c/ed25519_test.c
ed25519-test = encoding/ed25519/c/ed25519-test
LIBS += ed25519-test
# cbor on the line protocol (encoding/c/cbor_harness.c): the fuzz against the TypeScript (cbor_fuzz_test.ts),
# through HARNESS (the cbor suite has no scenarios of its own)
cbor-lines_src = encoding/c/cbor_harness.c encoding/c/cbor.c encoding/c/json.c encoding/c/json_text.c
cbor-lines = encoding/c/cbor-harness
cbor-lines_test = HARNESS encoding/typescript/cbor_fuzz_test.ts
LIBS += cbor-lines
# crow (crow): a root's writes change in place what its own earlier writes copied, until someone else has the value
crow_src = $(harness_src) conformance/c/protocol_harness.c crow/c/crow.c crow/c/crow_harness.c graph/c/node.c changeable/c/apply.c changeable/c/invert.c changeable/c/ptrmap.c
crow = crow/c/crow-harness
crow_suite = crow
crow_tests = $(wildcard crow/typescript/crow_harness_test.ts)
LIBS += crow
# crowify (places): crow through a scheduler's runs and an entry's writes
crowify_src = $(harness_src) conformance/c/protocol_harness.c crow/c/crow.c places/c/crowify.c places/c/crowify_harness.c graph/c/node.c changeable/c/apply.c changeable/c/invert.c reactivity/c/scheduler.c reactivity/c/order.c reactivity/c/rank.c reactivity/c/causes.c changeable/c/ptrmap.c reactivity/c/tracker.c
crowify = places/c/crowify-harness
crowify_suite = crowify
crowify_tests = $(wildcard places/typescript/crowify_harness_test.ts)
LIBS += crowify
# ermine (system): the process api and createErmine, over core's scheduler, table, places, guard, protect and status, ermine's processes (rows, start, scopes), and runs. five files (ermine.h says each's job), the last the line protocol; no places or world harness
system_src = $(filter-out places/c/places_harness.c places/c/world_harness.c,$(places_src)) processes/c/guard.c processes/c/status.c protect/c/protect.c processes/c/processes.c processes/c/scopes.c processes/c/start.c processes/c/runs.c system/c/nodes.c system/c/computers.c system/c/actions.c system/c/host.c system/c/ermine_harness.c
system = system/c/ermine-harness
system_suite = ermine
LIBS += system
# ids (ids): ermine ids, their text and tree ids, on encoding's BLAKE3
ids_src = $(harness_src) ids/c/ids.c ids/c/ids_harness.c $(blake3_src)
ids = ids/c/ids-harness
ids_suite = ids
LIBS += ids
# the scheduler's frees (reactivity/c/free_test.c): what holds a scope, and when it goes; no suite
scheduler-free-test_src = changeable/c/value.c changeable/c/frame.c reactivity/c/scheduler.c reactivity/c/order.c reactivity/c/rank.c reactivity/c/causes.c changeable/c/ptrmap.c reactivity/c/tracker.c reactivity/c/free_test.c
scheduler-free-test = reactivity/c/free-test
LIBS += scheduler-free-test
# what comes out for sc_escaped, two before it is read (reactivity/c/escaped_test.c): the first; no suite
scheduler-escaped-test_src = changeable/c/value.c changeable/c/frame.c reactivity/c/scheduler.c reactivity/c/order.c reactivity/c/rank.c reactivity/c/causes.c changeable/c/ptrmap.c reactivity/c/tracker.c reactivity/c/escaped_test.c
scheduler-escaped-test = reactivity/c/escaped-test
LIBS += scheduler-escaped-test
# places (places): a watch that writes, the watches after it told what landed first; no suite
places-test_src = $(filter-out conformance/c/harness.c changeable/c/json.c conformance/c/protocol_harness.c places/c/places_harness.c places/c/world_harness.c,$(places_src)) places/c/places_test.c
places-test = places/c/places-test
LIBS += places-test
# runs (processes): each computer's latest run, on a table of its own; places' harness's world, programs and requests, and the runs'
runs_src = $(places_src) processes/c/guard.c processes/c/status.c processes/c/status_harness.c protect/c/protect.c processes/c/runs.c processes/c/runs_harness.c
runs = processes/c/runs-harness
runs_flags = -DPH_LIB -DSH_LIB
runs_suite = runs
runs_tests = $(wildcard processes/typescript/runs_harness_test.ts)
LIBS += runs
# status (processes): a computer's status on its own node; the places harness's world and programs (PH_LIB), and status's requests
status_src = $(places_src) processes/c/status.c processes/c/status_harness.c
status = processes/c/status-harness
status_flags = -DPH_LIB
status_suite = status
LIBS += status
# software (experiments/software): run a program through a loader, on the ermine (system). its harness runs the suite;
# ermine-run is the terminal program: make experiments/software/c/ermine-run, and hello.so beside it
software_lib = experiments/software/c/software.c
software_src = $(filter-out system/c/ermine_harness.c,$(system_src)) $(software_lib) experiments/software/c/software_harness.c
software = experiments/software/c/software-harness
software_suite = software
LIBS += software
ermine-run_src = $(filter-out system/c/ermine_harness.c conformance/c/harness.c conformance/c/protocol_harness.c,$(system_src)) $(software_lib) experiments/software/c/ermine-run.c
ermine-run = experiments/software/c/ermine-run
ermine-run_flags = -rdynamic
$(ermine-run) $(ermine-run)-check: $(wildcard */*/c/*.h)
experiments/software/c/hello.so: experiments/software/c/hello.c experiments/software/c/software.h
	$(CC) $(CFLAGS) -shared -fPIC $(if $(filter Darwin,$(shell uname -s)),-undefined dynamic_lookup,) -o $@ experiments/software/c/hello.c
# JSON text (encoding/c/json_text.c): only what reads or writes it, the harnesses
json_text_src = encoding/c/json_text.c
$(foreach l,cbor,$(eval $(l)_src += $(json_text_src)))
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
# software's terminal program (its section above)
$(eval $(call harness,ermine-run))
# start's stop (processes/c/start_test.c): what its scope's teardown threw is given back. make test-start-processes, test-check-start-processes (the sanitizers)
processes-start_src = $(filter-out places/c/places_harness.c conformance/c/harness.c conformance/c/protocol_harness.c places/c/world_harness.c,$(places_src)) processes/c/processes.c processes/c/scopes.c processes/c/start.c processes/c/runs.c processes/c/start_test.c processes/c/status.c
processes-start = processes/c/start-test
$(eval $(call harness,processes-start))
$(processes-start): $(wildcard */*/c/*.h)
test-start-processes: $(processes-start)
	@echo "== processes (start)"
	@$(processes-start)
test-check-start-processes: $(processes-start)-check
	@echo "== processes (start, sanitizers)"
	@$(processes-start)-check
# promises (system/c/promise_test.c): a then on a settled promise, its callback letting go
# of the maker's hold. make test-promise-system, test-check-promise-system (the sanitizers)
system-promise_src = $(filter-out conformance/c/harness.c conformance/c/protocol_harness.c system/c/ermine_harness.c,$(system_src)) system/c/promise_test.c
system-promise = system/c/promise-test
$(eval $(call harness,system-promise))
$(system-promise): $(wildcard */*/c/*.h)
test-promise-system: $(system-promise)
	@echo "== system (promise)"
	@$(system-promise)
test-check-promise-system: $(system-promise)-check
	@echo "== system (promise, sanitizers)"
	@$(system-promise)-check

# refused starts (system/c/refuse_test.c): the scope a refused start made is freed. make test-refuse-system, test-check-refuse-system (the sanitizers)
system-refuse_src = $(filter-out conformance/c/harness.c conformance/c/protocol_harness.c system/c/ermine_harness.c,$(system_src)) system/c/refuse_test.c
system-refuse = system/c/refuse-test
$(eval $(call harness,system-refuse))
$(system-refuse): $(wildcard */*/c/*.h)
test-refuse-system: $(system-refuse)
	@echo "== system (refuse)"
	@$(system-refuse)
test-check-refuse-system: $(system-refuse)-check
	@echo "== system (refuse, sanitizers)"
	@$(system-refuse)-check
# what a review found that the harness cannot show (system/c/review_test.c): a wait made as its
# scope goes, a hook calling next twice, a handler failing with no text.
# make test-review-system, test-check-review-system (the sanitizers)
system-review_src = $(filter-out conformance/c/harness.c conformance/c/protocol_harness.c system/c/ermine_harness.c,$(system_src)) system/c/review_test.c
system-review = system/c/review-test
$(eval $(call harness,system-review))
$(system-review): $(wildcard */*/c/*.h)
test-review-system: $(system-review)
	@echo "== system (review)"
	@$(system-review)
test-check-review-system: $(system-review)-check
	@echo "== system (review, sanitizers)"
	@$(system-review)-check

# what a review of marks proved (system/c/marks_test.c): writers and started children used after
# they were freed, and who may stop or ask a child. make test-marks-system, test-check-marks-system (the sanitizers)
system-marks_src = $(filter-out conformance/c/harness.c conformance/c/protocol_harness.c system/c/ermine_harness.c,$(system_src)) system/c/marks_test.c
system-marks = system/c/marks-test
$(eval $(call harness,system-marks))
$(system-marks): $(wildcard */*/c/*.h)
test-marks-system: $(system-marks)
	@echo "== system (marks)"
	@$(system-marks)
test-check-marks-system: $(system-marks)-check
	@echo "== system (marks, sanitizers)"
	@$(system-marks)-check

# steady use (system/c/steady_test.c): each thing a program does, again and again, held
# memory levelling off (leaks sees only what is lost at close). not in LIBS: its counts are the
# allocator's, no sanitizer's. make test-steady-system
system-steady_src = $(filter-out conformance/c/harness.c conformance/c/protocol_harness.c system/c/ermine_harness.c,$(system_src)) system/c/steady_test.c
system-steady = system/c/steady-test
$(eval $(call harness,system-steady))
$(system-steady): $(wildcard */*/c/*.h)
test-steady-system: $(system-steady)
	@echo "== system (steady)"
	@$(system-steady)

# headers: any change rebuilds what includes them
$(HARNESSES) $(CHECKS): $(wildcard */*/c/*.h */*/stacks/*/c/*.h conformance/c/*.h)

# a suite on the one runner (conformance/run.ts): its scenarios (<package>/conformance/<suite>/), and
# the package's tests of its harness (<package>/typescript/<suite>_harness_test.ts), both asked of
# the harness given. its binary is the shared loop (conformance/c/harness.c), its adapter and the library
define conformance
HARNESS="$(2)" $(DENO) $($(1)_deno) conformance/run.ts $($(1)_tests) -- $($(1)_suite)
endef
tracker_suite = tracker
tracker_tests = $(wildcard reactivity/typescript/tracker_harness_test.ts)
table_suite = table
table_tests = $(wildcard graph/typescript/table_harness_test.ts)
node_suite = node
node_tests = $(wildcard graph/typescript/node_harness_test.ts)
update_suite = update
update_tests = $(wildcard changeable/typescript/update_harness_test.ts)
squish_suite = squish
squish_tests = $(wildcard changeable/typescript/squish_harness_test.ts)
changeable-apply_suite = apply
changeable-apply_tests = $(wildcard changeable/typescript/apply_harness_test.ts)
changeable-invert_suite = invert
changeable-invert_tests = $(wildcard changeable/typescript/invert_harness_test.ts)
paths_suite = paths
paths_tests = $(wildcard reactivity/typescript/paths_harness_test.ts)
scheduler_suite = scheduler
scheduler_tests = $(wildcard reactivity/typescript/scheduler_harness_test.ts)
places_suite = places
places_tests = $(wildcard places/typescript/places_harness_test.ts)
processes_suite = processes
processes_tests = $(wildcard processes/typescript/processes_harness_test.ts)
protect_suite = protect
protect_tests = $(wildcard protect/typescript/protect_harness_test.ts)
guard_suite = guard
guard_tests = $(wildcard processes/typescript/guard_harness_test.ts)
# the rest: env var, then the folders of their scenarios (conformance/<lib>/)

# per library: test-c-<lib> against its harness, test-check-<lib> against its harness-check,
# test-leaks-<lib> its harness under leaks
define run
test-c-$(1): $($(1))
	@echo "== $(1)"
	@$(if $($(1)_suite),$$(call conformance,$(1),$(CURDIR)/$($(1))),$(if $($(1)_test),$(skips) $(firstword $($(1)_test))="$(CURDIR)/$($(1))" $(DENO) $($(1)_deno) $(wordlist 2,9,$($(1)_test)),$($(1)) $(CURDIR)/encoding/conformance/cbor/vectors.json))
test-check-$(1): $($(1))-check
	@echo "== $(1) (sanitizers)"
	@$(if $($(1)_suite),$$(call conformance,$(1),$(CURDIR)/$($(1))-check),$(if $($(1)_test),$(skips) $(firstword $($(1)_test))="$(CURDIR)/$($(1))-check" $(DENO) $($(1)_deno) $(wordlist 2,9,$($(1)_test)),$($(1))-check $(CURDIR)/encoding/conformance/cbor/vectors.json))
test-leaks-$(1): $($(1))
	@echo "== $(1) (leaks)"
	@log=$$$$(mktemp); $(if $($(1)_suite),LEAKS_LOG=$$$$log $$(call conformance,$(1),sh $(CURDIR)/conformance/leaks.sh $(CURDIR)/$($(1))),$(if $($(1)_test),LEAKS_LOG=$$$$log $(skips) $(firstword $($(1)_test))="sh $(CURDIR)/conformance/leaks.sh $(CURDIR)/$($(1))" $(DENO) $($(1)_deno) $(wordlist 2,9,$($(1)_test)),LEAKS_LOG=$$$$log sh $(CURDIR)/conformance/leaks.sh $(CURDIR)/$($(1)) $(CURDIR)/encoding/conformance/cbor/vectors.json)); \
	if [ -s $$$$log ]; then cat $$$$log; rm -f $$$$log; echo "== $(1): leaked"; exit 1; fi; rm -f $$$$log
endef
$(foreach l,$(LIBS),$(eval $(call run,$(l))))
# invert's suite alone, on changeable-apply's harness (the same protocol)
changeable-invert = $(changeable-apply)
$(eval $(call run,changeable-invert))

test:
	$(DENO)
	deno task conformance

TESTED = $(LIBS) changeable-invert
test-c: $(addprefix test-c-,$(TESTED))
test-check: $(addprefix test-check-,$(TESTED))
# the harnesses under macOS's leaks (conformance/leaks.sh): the sanitizers find no leaks there
test-leaks: $(addprefix test-leaks-,$(TESTED))

# benches, -O2, not part of all
BENCHES = reactivity/c/paths-bench changeable/c/squish-bench changeable/c/apply-bench places/c/crowify-bench
bench: $(BENCHES)
reactivity/c/paths-bench: reactivity/c/paths.c changeable/c/value.c reactivity/c/paths_bench.c
	$(CC) $(CFLAGS) -o $@ $^ -lm
changeable/c/squish-bench: changeable/c/squish.c changeable/c/squish_bench.c
	$(CC) $(CFLAGS) -o $@ $^ -lm
changeable/c/apply-bench: changeable/c/apply.c changeable/c/value.c changeable/c/apply_bench.c
	$(CC) $(CFLAGS) -o $@ $^ -lm
places/c/crowify-bench: changeable/c/frame.c graph/c/node.c graph/c/update.c changeable/c/value.c changeable/c/apply.c changeable/c/invert.c crow/c/crow.c places/c/crowify.c places/c/crowify_bench.c reactivity/c/scheduler.c reactivity/c/order.c reactivity/c/rank.c reactivity/c/causes.c changeable/c/ptrmap.c reactivity/c/tracker.c
	$(CC) $(CFLAGS) -o $@ $^ -lm

clean:
	rm -rf $(HARNESSES) $(CHECKS) $(BENCHES) $(addsuffix .dSYM,$(HARNESSES) $(CHECKS))
	rm -rf $(ermine-run) $(ermine-run)-check $(ermine-run).dSYM $(ermine-run)-check.dSYM experiments/software/c/hello.so
	rm -rf $(system-steady) $(system-steady)-check $(system-steady).dSYM
	rm -rf $(system-review) $(system-review)-check $(system-review).dSYM
	rm -rf $(system-promise) $(system-promise)-check $(system-promise).dSYM
	rm -rf $(processes-start) $(processes-start)-check $(processes-start).dSYM $(system-refuse) $(system-refuse)-check $(system-refuse).dSYM

.PHONY: all bench check test test-c test-check test-steady-system clean $(addprefix test-c-,$(LIBS)) $(addprefix test-check-,$(LIBS))
