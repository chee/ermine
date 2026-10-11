// Runs the commit scenarios (sync/conformance/commit/*.json, written by fixtures.ts) against a
// commit harness. COMMIT_HARNESS: the command for another implementation (default: the
// reference). ../apply/session.ts has the protocol; ../apply/run.ts the scenarios' shape.
import { run } from "../apply/run.ts"

const here = new URL(".", import.meta.url).pathname
const reference = `deno run --quiet --allow-env --allow-read ${here}harness.ts`
await run(
	`${here}../../sync/conformance/commit`,
	(Deno.env.get("COMMIT_HARNESS") ?? reference).split(" "),
)
