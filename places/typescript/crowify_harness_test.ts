// what the crowify suite checks besides its scenarios (conformance/run.ts runs those): the harness
// asked against the TypeScript one (crowify_harness.ts) run here. the harness asked is HARNESS, else
// the TypeScript adapter
import { fuzz, SEEDS, STEPS } from "../../crow/typescript/fuzz_harness.ts"
import { createHarness } from "./crowify_harness.ts"

Deno.test(`fuzz: ${SEEDS} seeds × ${STEPS} steps, as crowify.ts`, () =>
	fuzz("crowify", createHarness, true))
