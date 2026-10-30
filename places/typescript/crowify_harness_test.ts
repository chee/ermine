// Checks the crowify harness (HARNESS, else the TypeScript adapter) besides conformance/run.ts.
import { fuzz, SEEDS, STEPS } from "../../crow/typescript/fuzz_harness.ts"
import { createHarness } from "./crowify_harness.ts"

Deno.test(`fuzz: ${SEEDS} seeds × ${STEPS} steps, as crowify.ts`, () =>
	fuzz("crowify", createHarness, true))
