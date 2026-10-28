// pipes' costs, each case its median over trials, with the floor (a plain patch, no pipes) in the
// same run:
//   deno run -A extensions/pipe/typescript/pipe_bench.ts [trials]
// pulses run only when a case runs one (onSchedule holds them)
import {
	createErmine,
	ensureNode,
	type Ermine,
	type Feature,
	type Node,
	patch,
	pulse,
} from "@ermine/system"
import pipes, { pipe } from "./pipe.ts"

const TRIALS = Number(Deno.args[0] ?? 9)
const manual: Feature = { name: "manual", setup: (f) => f.onSchedule(() => {}) }

// an ermine (with pipes, or not): the nodes /a, /b, /n0…/n10, /s0…/s199, /t0…/t199 made, then a
// process running setup
const names = ["a", "b"]
for (let k = 0; k < 200; k++) names.push(`n${k}`, `s${k}`, `t${k}`)
function world(withPipes: boolean, setup: () => void): Ermine {
	const e = createErmine({ features: withPipes ? [pipes, manual] : [manual] })
	e.within(() => {
		for (const n of names) ensureNode(`/${n}`, 0)
	})
	e.start(setup, "/code/p")
	e.within(() => pulse())
	return open = e
}

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b)
	return s[Math.floor(s.length / 2)]
}

// each trial: n runs of f (after warm runs), its mean in µs; the median of the trials. each
// trial's ermine closed after it
let open: Ermine | undefined
function measure(name: string, n: number, make: () => (i: number) => void): [string, number] {
	const trials: number[] = []
	for (let t = 0; t < TRIALS; t++) {
		const f = make()
		for (let i = 0; i < Math.min(n, 50); i++) f(i)
		const t0 = performance.now()
		for (let i = 0; i < n; i++) f(i + 1000)
		trials.push((performance.now() - t0) * 1000 / n)
		open?.close()
		open = undefined
	}
	return [name, median(trials)]
}

const v = (i: number) => [{ path: [], value: i }]
const inc = (w: { value: unknown }) => [{ path: [], value: (w.value as number) + 1 }]
const rows: [string, number][] = []

// warm (not shown): the engine's first runs
measure("warm", 2000, () => {
	const e = world(true, () => void pipe("/a", "/b", { timing: "write" }))
	return (i) => e.within(() => patch("/a", v(i)))
})
// the floors
rows.push(measure("floor: a plain patch, no pipe feature", 2000, () => {
	const e = world(false, () => void pipe)
	return (i) => e.within(() => patch("/a", v(i)))
}))
rows.push(measure("floor: a plain patch, pipe feature, no pipes", 2000, () => {
	const e = world(true, () => {})
	return (i) => e.within(() => patch("/a", v(i)))
}))
rows.push(measure("floor: a plain patch plus its pulse, no pipes", 2000, () => {
	const e = world(true, () => {})
	return (i) =>
		e.within(() => {
			patch("/a", v(i))
			pulse()
		})
}))

rows.push(measure("a chain of 10 transforms, write timing, one write at the head", 500, () => {
	const e = world(true, () => {
		for (let k = 0; k < 10; k++) pipe(`/n${k}`, `/n${k + 1}`, inc, { timing: "write" })
	})
	return (i) => e.within(() => patch("/n0", v(i)))
}))
rows.push(measure("a mirror, write timing", 2000, () => {
	const e = world(true, () => void pipe("/a", "/b", { timing: "write" }))
	return (i) => e.within(() => patch("/a", v(i)))
}))
rows.push(measure("a watched write plus its pulse, pulse timing", 2000, () => {
	let seen = 0
	const e = world(true, () => void pipe("/a", () => void seen++))
	return (i) =>
		e.within(() => {
			patch("/a", v(i))
			pulse()
		})
}))
rows.push(measure("a mirror plus its pulse, pulse timing", 2000, () => {
	const e = world(true, () => void pipe("/a", "/b"))
	return (i) =>
		e.within(() => {
			patch("/a", v(i))
			pulse()
		})
}))
rows.push(measure("a plain write with 200 pipes elsewhere", 2000, () => {
	const e = world(true, () => {
		for (let k = 0; k < 200; k++) pipe(`/s${k}`, `/t${k}`)
	})
	return (i) => e.within(() => patch("/a", v(i)))
}))
rows.push(measure("fan-in of 50 sources, write timing, one write", 2000, () => {
	let seen = 0
	const e = world(true, () => {
		const from: string[] = []
		for (let k = 0; k < 50; k++) from.push(`/s${k}`)
		pipe(from, () => void seen++, { timing: "write" })
	})
	return (i) => e.within(() => patch(`/s${i % 50}`, v(i)))
}))
rows.push(measure("fan-in of 50 sources, pulse timing, one write plus its pulse", 1000, () => {
	let seen = 0
	const e = world(true, () => {
		const from: string[] = []
		for (let k = 0; k < 50; k++) from.push(`/s${k}`)
		pipe(from, () => void seen++)
	})
	return (i) =>
		e.within(() => {
			patch(`/s${i % 50}`, v(i))
			pulse()
		})
}))

// making 1,000: one setup making them (ends there), and then their first pulse
const make = (thenPulse: boolean) => {
	const ms: number[] = []
	for (let t = 0; t < TRIALS; t++) {
		const e = createErmine({ features: [pipes, manual] })
		e.within(() => {
			for (let k = 0; k < 1000; k++) ensureNode(`/s${k}`, 0), ensureNode(`/t${k}`, 0)
		})
		const made: Node[] = []
		const t0 = performance.now()
		e.start(() => {
			for (let k = 0; k < 1000; k++) made.push(pipe(`/s${k}`, `/t${k}`))
		}, "/code/p")
		if (thenPulse) e.within(() => pulse())
		ms.push(performance.now() - t0)
		e.close()
	}
	return median(ms)
}

console.log(`median of ${TRIALS} trials, µs a case`)
for (const [name, us] of rows) console.log(`${us.toFixed(1).padStart(8)}  ${name}`)
console.log(`${(make(false) * 1000).toFixed(0).padStart(8)}  making 1,000 pipes (setup only)`)
console.log(
	`${(make(true) * 1000).toFixed(0).padStart(8)}  making 1,000 pipes, then their first pulse`,
)
