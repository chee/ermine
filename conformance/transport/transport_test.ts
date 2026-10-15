// Runs the transport scenarios (sync/conformance/transport/*.json, written by fixtures.ts) against
// a transport harness. TRANSPORT_HARNESS: the command for another implementation (default: the
// reference, harness.ts, over sync/ts/transport.ts). harness.ts has the protocol; ../apply/run.ts
// the scenarios' shape: each answer compared whole with what is expected.
import { run } from "../apply/run.ts"

const here = new URL(".", import.meta.url).pathname
const reference = `deno run --quiet --allow-env --allow-read ${here}harness.ts`
await run(
	`${here}../suites-aside/sync/subduction/conformance/transport`,
	(Deno.env.get("TRANSPORT_HARNESS") ?? reference).split(" "),
)
