// Runs the commit scenarios (sync/conformance/commit/*.json, written by fixtures.ts) against a
// commit harness. COMMIT_HARNESS: the command for another implementation (default: the
// reference). COMMIT_SKIP: scenario files it does not speak, comma separated (C has no live
// values, so none of the live scenarios). ../apply/session.ts has the protocol; ../apply/run.ts the scenarios' shape.
import { run } from "../apply/run.ts"

const here = new URL(".", import.meta.url).pathname
const reference = `deno run --quiet --allow-env --allow-read ${here}harness.ts`
await run(
	`${here}../suites-aside/sync/subduction/conformance/commit`,
	(Deno.env.get("COMMIT_HARNESS") ?? reference).split(" "),
	new Set((Deno.env.get("COMMIT_SKIP") ?? "").split(",").filter((x) => x)),
)
