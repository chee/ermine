# ermine: the core (its design, protocol, suite and implementations), and the layers to be built on it

LAYERS := scheduler programs views transactions live histories optypes hosts

docs: core/docs/design.pdf core/docs/protocol.pdf core/plans/core-architecture.pdf plans/hosts-and-provenance.pdf $(foreach l,$(LAYERS),$(l)/$(l).pdf)

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

.PHONY: docs scenarios lint conformance watch haskell build
