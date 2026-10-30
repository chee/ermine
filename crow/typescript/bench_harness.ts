// what crow's benches share: the names asked for, a header, writing in place, and timing. µs per
// call, fastest of 31 rounds (the machine may be busy)
import apply, { type Patch } from "@ermine/changeable/apply"
import type { Changeable, ChangeHeader } from "@ermine/changeable"

export const only = Deno.args
export const h: ChangeHeader = { time: 1, actor: "bench", frame: { info: {}, parent: undefined } }

// in place, as op's apply does with cow: false: the value changed where it is, the change made
// as update makes it
export function inPlace(e: Changeable<unknown>, ps: Patch[], change: ChangeHeader) {
	const undo: Patch[] = []
	const after = apply(e.value, ps, { undo, cow: false })
	if (after === undefined) delete e.value
	else e.value = after
	e.change = { ...change, op: { patches: ps, undo } }
}

export function fastest(f: () => void, calls: number): number {
	for (let i = 0; i < calls; i++) f()
	const times: number[] = []
	for (let r = 0; r < 31; r++) {
		const t0 = performance.now()
		for (let i = 0; i < calls; i++) f()
		times.push((performance.now() - t0) * 1000 / calls)
	}
	return Math.min(...times)
}
export function row(name: string, ways: Record<string, () => () => void>, calls: number) {
	if (only.length && !only.some((o) => name.includes(o))) return
	const cols = Object.entries(ways).map(([way, make]) =>
		`${way} ${fastest(make(), calls).toFixed(2)}`
	)
	console.log(`${name}\t${cols.join("\t")} µs`)
}

// a changeable of this value and change, as a table's entry is
export const changeable = (value: unknown, change: ChangeHeader): Changeable<unknown> =>
	value === undefined ? { change } : { value, change }
