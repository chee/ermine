# newcore's C: every library's harness, and their conformance runs against the reference suites.
#   make              every harness
#   make check        every harness-check: address and undefined-behaviour sanitizers
#   make test         the TypeScript tests (the references)
#   make test-c       each conformance suite against its C harness
#   make test-check   the same against the harness-checks
#   make clean
# a library's own build.sh still builds it alone.

CC ?= cc
CFLAGS = -std=c11 -O2 -Wall -Wextra -Wpedantic
CHECKFLAGS = -std=c11 -g -O1 -Wall -Wextra -Wpedantic -fsanitize=address,undefined -fno-omit-frame-pointer
DENO = deno test --quiet --allow-run --allow-read --allow-env

trackgraph_src = c/trackgraph.c c/harness.c
node_src = c/node.c c/shown.c c/node_harness.c
pack_src = c/node.c c/shown.c c/pack.c c/pack_harness.c
change_src = change/c/change.c change/c/harness.c
because_src = because/c/because.c because/c/harness.c
squish_src = squish/c/squish.c squish/c/harness.c
notify_src = notify/c/notify.c notify/c/harness.c
places_src = places/c/places.c places/c/harness.c c/node.c
protect_src = protect/c/protect.c protect/c/harness.c
mutate_src = mutate/c/mutate.c mutate/c/harness.c notify/c/notify.c c/node.c
scheduler_src = scheduler/c/scheduler.c scheduler/c/steps.c scheduler/c/harness.c \
	places/c/places.c notify/c/notify.c c/trackgraph.c protect/c/protect.c mutate/c/mutate.c

# name: binary, sources, the suite, its env var, and what C skips
trackgraph = c/harness
node = c/node-harness
pack = c/pack-harness
change = change/c/harness
because = because/c/harness
squish = squish/c/harness
notify = notify/c/harness
places = places/c/harness
protect = protect/c/harness
mutate = mutate/c/harness
scheduler = scheduler/c/harness

LIBS = trackgraph node pack change because squish notify places protect mutate scheduler
HARNESSES = $(foreach l,$(LIBS),$($(l)))
CHECKS = $(addsuffix -check,$(HARNESSES))

all: $(HARNESSES)
check: $(CHECKS)

define harness
$($(1)): $($(1)_src)
	$$(CC) $$(CFLAGS) -o $$@ $$(filter %.c,$$^) -lm
$($(1))-check: $($(1)_src)
	$$(CC) $$(CHECKFLAGS) -o $$@ $$(filter %.c,$$^) -lm
endef
$(foreach l,$(LIBS),$(eval $(call harness,$(l))))

# headers: any change rebuilds what includes them
$(HARNESSES) $(CHECKS): $(wildcard c/*.h */c/*.h)

# suite, env var, skips
trackgraph_test = conformance/conformance_test.ts TRACKGRAPH_HARNESS
node_test = conformance/node/ NODE_HARNESS
pack_test = conformance/pack/ PACK_HARNESS
change_test = conformance/change/ CHANGE_HARNESS
because_test = because/conformance/ BECAUSE_HARNESS
squish_test = squish/conformance/ SQUISH_HARNESS
notify_test = notify/conformance/ NOTIFY_HARNESS
places_test = places/conformance/ PLACES_HARNESS
protect_test = protect/conformance/ PROTECT_HARNESS
mutate_test = mutate/conformance/ MUTATE_HARNESS
scheduler_test = scheduler/conformance/ SCHEDULER_HARNESS
# places/c has no write by path; nt_value has no typed arrays
skips = PLACES_SKIP=13-write.json MUTATE_SKIP=04-typed-arrays.json

# per library: test-c-<lib> against its harness, test-check-<lib> against its harness-check
define run
test-c-$(1): $($(1))
	@echo "== $(1)"
	@$(skips) $(word 2,$($(1)_test))="$(CURDIR)/$($(1))" $(DENO) $(word 1,$($(1)_test))
test-check-$(1): $($(1))-check
	@echo "== $(1) (sanitizers)"
	@$(skips) $(word 2,$($(1)_test))="$(CURDIR)/$($(1))-check" $(DENO) $(word 1,$($(1)_test))
endef
$(foreach l,$(LIBS),$(eval $(call run,$(l))))

test:
	$(DENO)

test-c: $(addprefix test-c-,$(LIBS))
test-check: $(addprefix test-check-,$(LIBS))

clean:
	rm -rf $(HARNESSES) $(CHECKS) $(addsuffix .dSYM,$(HARNESSES) $(CHECKS))

.PHONY: all check test test-c test-check clean $(addprefix test-c-,$(LIBS)) $(addprefix test-check-,$(LIBS))
