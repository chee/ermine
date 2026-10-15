// Runs the wiring scenarios (sync/conformance/wiring/*.json, written by fixtures.ts) against a
// wiring harness. WIRING_HARNESS: the command for another implementation (default: the reference,
// harness.ts, over sync/ts/wiring.ts and the scheduler). harness.ts has the protocol;
// ../apply/run.ts the scenarios' shape: each answer compared whole with what is expected.
// A scenario with skip (why) rests on what is still open: not sent, shown ignored with why.
import { run } from "../apply/run.ts"

const here = new URL(".", import.meta.url).pathname
const dir = `${here}../suites-aside/sync/subduction/conformance/wiring`
const reference = `deno run --quiet --allow-env --allow-read ${here}harness.ts`

// the reference wiring harness drives the old scheduler's host operations (write, set, insert,
// remove, pop, rename, move, create, start, internal.versions), which are gone: today's graph is a
// table, places and a scheduler composed by a host (subduction's world.ts, whose own tests
// are wiring_test.ts there), and an object's several heads show as one value. The scenarios and
// harness wait here, shown ignored, until they are written over the graph of today. Set RUNS to run
// them
const RUNS = false

const skipped = new Set<string>()
for await (const f of Deno.readDir(dir)) {
	if (!f.name.endsWith(".json")) continue
	const s = JSON.parse(await Deno.readTextFile(`${dir}/${f.name}`))
	if (s.skip === undefined && RUNS) continue
	skipped.add(f.name)
	const why = s.skip ?? "the old scheduler's host operations are gone"
	Deno.test({ name: `${f.name}: ${s.title} (skipped: ${why})`, ignore: true, fn() {} })
}
await run(dir, (Deno.env.get("WIRING_HARNESS") ?? reference).split(" "), skipped)
