// what a realm costs, on this machine: deno run --allow-all playground/realms/typescript/measure.ts
//   startup      new Worker to setup run (the worker importing ermine: scheduler, table, places,
//                @ermine/system and what it imports), the first and then each one after
//   first read   in the worker, a run reading what isn't loaded to its run with the value: pending,
//                the load asked, the page's entries sent, landed, run again
//   rerun        a write on the page to the act of a worker effect reading it and its write landing
//                on the page again: two crossings, two pulses, three writes (the effect's value, its
//                run record, the echo)
import { get } from "@ermine/core/places/lib"
import { until, world } from "./realms_test.ts"

const ms = (x: number) => `${x.toFixed(2)} ms`
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

const w = world()
const n = w.node("n", 0)

// startup: an empty program, five times
const starts: number[] = []
w.program("empty.js", `export default function () { return "ready" }`)
for (let i = 0; i < 5; i++) {
	const t = performance.now()
	const p = w.start("empty.js", [`empty${i}`])
	await until(() => w.table.get("value", p.process.id)?.value === "ready")
	starts.push(performance.now() - t)
}

// first read, then reruns
w.program(
	"echo.js",
	`import { createEffect, ensureNode, patch, read } from "@ermine/system"
	export default function () {
		let t0
		const echo = ensureNode("./echo", -1)
		createEffect("echo", () => {
			t0 ??= performance.now()
			return read("./n")
		}, (v) => {
			if (v === 0) ensureNode("./took", performance.now() - t0)
			patch(echo, [{ path: [], value: v }])
		})
	}`,
)
w.start("echo.js", ["echoer"])
await until(() => w.value(["took"]) !== undefined)
const first = w.value(["took"]) as number

const reruns: number[] = []
const echo = get(w.places, ["work", "echo"])!
for (let i = 1; i <= 500; i++) {
	const landed = new Promise<void>((resolve) => {
		const off = w.places.watchAll((f) => {
			if (f.id === echo && f.part === "value" && f.entry?.value === i) (off(), resolve())
		})
	})
	const t = performance.now()
	w.write(n, i)
	await landed
	reruns.push(performance.now() - t)
}
w.done()

console.log(`startup     first ${ms(starts[0])}, then ${ms(median(starts.slice(1)))} (median of 4)`)
console.log(`first read  ${ms(first)} (in the worker)`)
console.log(
	`rerun       ${ms(mean(reruns.slice(50)))} mean, ${
		ms(median(reruns.slice(50)))
	} median (450 after 50)`,
)
Deno.exit(0)
