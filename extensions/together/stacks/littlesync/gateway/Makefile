# the gateway (README.md). Quiet by default: V=1 shows each command.
#   make pigs           littlesync-pigs, built from playground/demos/pigs/littlesync into build/ here (the C
#                       peer the tests drive)
#   make test           the TS peer's unit tests, and the gateway with a C peer and a sync.ts device,
#                       all in this process (no server); HTTP sessions; the upstream dropped and dialled again
#   make galaxy-test    the C peer, the gateway and a lab-pig-style device in the pig room on
#                       wss://galaxy.observer (UPSTREAM=... another server); HTTP devices; a dropped socket
#   make run            the gateway (PORT, UPSTREAM: README.md)
#   make check          deno check and deno fmt --check of these files
#   make clean
Q = $(if $(V),,@)
BUILD = $(CURDIR)/build
DENO = deno
PERMS = --allow-net --allow-env --allow-read --allow-write --allow-run

all: pigs

pigs:
	$(Q)$(MAKE) --no-print-directory -C ../../../../../playground/demos/pigs/littlesync BUILD=$(BUILD)

test: pigs
	$(Q)PIGS=$(BUILD)/littlesync-pigs $(DENO) test --quiet $(PERMS) frame_test.ts link_test.ts gateway_test.ts http_test.ts upstream_test.ts

galaxy-test: pigs
	$(Q)PIGS=$(BUILD)/littlesync-pigs $(DENO) test --quiet $(PERMS) galaxy_test.ts

run:
	$(Q)$(DENO) run $(PERMS) main.ts

check:
	$(Q)$(DENO) check *.ts
	$(Q)$(DENO) fmt --check *.ts README.md

clean:
	$(Q)rm -rf $(BUILD)

.PHONY: all pigs test galaxy-test run check clean
