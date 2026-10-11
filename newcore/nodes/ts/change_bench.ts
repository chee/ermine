// deno bench newcore/nodes/ts/change_bench.ts
// outside's capture against a plain make; baselines: the object alone, capture alone
import createChange, { type Header } from "./change.ts"
import { capture } from "./stacktrace.ts"

const small: Header = { time: 1, actor: "chee" }
const full: Header = {
	time: 1,
	actor: { name: "chee", keys: [1, 2] },
	reader: "p",
	site: { file: "x.c", line: 4, column: 2, function: "main" },
	cause: { why: "save" },
}
const ours = new Set([new URL("./stacktrace.ts", import.meta.url).href])

Deno.bench("object literal, no call", { group: "make", baseline: true }, () => {
	;({ ...small, node: "a" })
})
Deno.bench("time and actor", { group: "make" }, () => {
	createChange("a", small)
})
Deno.bench("every field", { group: "make" }, () => {
	createChange("a", full)
})
Deno.bench("outside, site given: no capture", { group: "make" }, () => {
	createChange("a", full, { outside: true })
})

Deno.bench("capture alone", { group: "outside", baseline: true }, () => {
	capture(ours)
})
Deno.bench("outside: captured", { group: "outside" }, () => {
	createChange("a", small, { outside: true })
})

// the stack the call is made from: capture's cost may follow its depth
function deep(n: number, f: () => void): void {
	if (n === 0) f()
	else deep(n - 1, f)
}
for (const depth of [10, 100]) {
	Deno.bench(`outside: captured, ${depth} frames deep`, { group: "outside" }, () => {
		deep(depth, () => createChange("a", small, { outside: true }))
	})
}
