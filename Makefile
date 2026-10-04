# ermine: the core (its design, protocol, suite and implementations), and the layers to be built on it

LAYERS := scheduler programs views transactions live histories optypes hosts

docs: core/docs/design.pdf core/docs/protocol.pdf core/plans/core-architecture.pdf plans/hosts-and-provenance.pdf plans/found-not-given.pdf $(foreach l,$(LAYERS),$(l)/$(l).pdf)

%.pdf: %.tex docs/common.tex
	tectonic -o $(dir $@) $<

# the scenarios are written in Python and regenerated into JSON
scenarios:
	deno task scenarios

# check the scenario files themselves: shapes, commands, references, matchers
lint:
	deno task lint

# run the suite against an implementation named in core/conformance/impls.json (make conformance IMPL=ts)
IMPL ?= ts
conformance:
	deno task conformance $(IMPL)

# random sessions with invariants, against one implementation or several at once (make fuzz IMPLS="ts c" SEEDS=500)
IMPLS ?= ts
SEEDS ?= 100
fuzz:
	deno task fuzz $(IMPLS) --seeds $(SEEDS)

# how fast, and how big in heap, the TypeScript core is on the shapes that matter
bench:
	deno task bench
	deno task bench:memory
	deno task bench:reactivity
	deno task bench:variants

# rerun the suite whenever the implementation or the suite changes (make watch IMPL=ts)
watch:
	deno task watch $(IMPL)

# the Haskell implementation, compiled to WebAssembly (needs ~/.ghc-wasm)
haskell: core/haskell/ermine.wasm
core/haskell/ermine.wasm: core/haskell/ermine.hs
	. ~/.ghc-wasm/env && wasm32-wasi-ghc -O1 core/haskell/ermine.hs -o core/haskell/ermine.wasm

# type-check and bundle the TypeScript core to core/ts/dist/ermine.js
build:
	deno task build

# the C implementation (clang or gcc)
c: core/c/ermine
core/c/ermine: core/c/*.c core/c/*.h
	$(MAKE) -C core/c

# the Zig implementation (zig 0.16)
zig:
	cd core/zig && zig build

.PHONY: docs scenarios lint conformance fuzz bench watch haskell build c zig
