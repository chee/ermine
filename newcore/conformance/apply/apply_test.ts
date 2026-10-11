// Runs the apply scenarios (sync/conformance/apply/*.json, written by fixtures.ts) against an
// apply harness. APPLY_HARNESS: the command for another implementation (default: the reference).
// session.ts has the protocol; run.ts the scenarios' shape.
import { run } from "./run.ts"

const here = new URL(".", import.meta.url).pathname
const reference = `deno run --quiet --allow-env --allow-read ${here}harness.ts`
await run(
	`${here}../../sync/conformance/apply`,
	(Deno.env.get("APPLY_HARNESS") ?? reference).split(" "),
)
