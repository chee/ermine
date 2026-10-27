// a write outside a run, per write: its site from the trace (whole text, the default; the site
// only, trace: false) or given at build (at(s, patch), as the plugin writes it), shallow and 40
// frames deep
import { createErmine, ensureNode, patch, read } from "@ermine/system"
import { at, site } from "@ermine/system/site"

const S = site("file:///program.ts", 1, 1)
const make = (trace?: false) => {
	const e = createErmine({ schedule: () => {}, trace })
	e.within(() => ensureNode("/x", 0))
	return e.getProcessContext()!
}
const whole = make()
const bare = make(false)
let n = 0
const deep = (d: number, f: () => void): void => d === 0 ? f() : deep(d - 1, f)

for (const [depth, name] of [[0, "shallow"], [40, "40 deep"]] as const) {
	Deno.bench(`trace, whole text (default), ${name}`, { group: name, baseline: true }, () => {
		whole.within(() => deep(depth, () => patch("/x", [{ path: [], value: n++ }])))
	})
	Deno.bench(`trace: false, ${name}`, { group: name }, () => {
		bare.within(() => deep(depth, () => patch("/x", [{ path: [], value: n++ }])))
	})
	Deno.bench(`build site, ${name}`, { group: name }, () => {
		whole.within(() => deep(depth, () => at(S, patch)("/x", [{ path: [], value: n++ }])))
	})
}

// what the rewrite costs a reader (which takes no site): read vs at(s, read)
Deno.bench("read", { group: "a read", baseline: true }, () => {
	whole.within(() => read("/x"))
})
Deno.bench("at(s, read)", { group: "a read" }, () => {
	whole.within(() => at(S, read)("/x"))
})
