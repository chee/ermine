// Runs the wiring scenarios (sync/conformance/wiring/*.json, written by fixtures.ts) against a
// wiring harness. WIRING_HARNESS: the command for another implementation (default: the reference,
// harness.ts, over sync/ts/wiring.ts and the scheduler). harness.ts has the protocol;
// ../apply/run.ts the scenarios' shape: each answer compared whole with what is expected.
// A scenario with skip (why) rests on what is still open: not sent, shown ignored with why.
import { run } from "../apply/run.ts"

const here = new URL(".", import.meta.url).pathname
const dir = `${here}../../extensions/subduction/conformance/wiring`
const reference = `deno run --quiet --allow-env --allow-read ${here}harness.ts`

const skipped = new Set<string>()
for await (const f of Deno.readDir(dir)) {
	if (!f.name.endsWith(".json")) continue
	const s = JSON.parse(await Deno.readTextFile(`${dir}/${f.name}`))
	if (s.skip === undefined) continue
	skipped.add(f.name)
	Deno.test({ name: `${f.name}: ${s.title} (skipped: ${s.skip})`, ignore: true, fn() {} })
}
await run(dir, (Deno.env.get("WIRING_HARNESS") ?? reference).split(" "), skipped)
