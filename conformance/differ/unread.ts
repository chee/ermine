// unread's streams: an entry started on a random value (core/unread/typescript/random_harness.ts), then
// writes of a few patches (some refused), unwrites, reads, keeps (wrapped, handed, through a
// scheduler), marks and sames, held and value asked between; names held now and then.
// the invariants, each implementation on its own: the value (asked by value or read) is the start
// value with every landed write replayed in order by that implementation's apply (a write's
// patches as sent; an unwrite's, the undo the write before it answered); and what a write, an
// unwrite or a read held is, when asked, what it was then (the patches' values as sent, the undo's
// values as answered, the value read). and a model (model, below): refused as its apply refuses,
// nothing-written as nothing landed, the undo undoes.
// wild: patches of no patch's shape, values that are no JSON form, an unwrite with nothing
// written, odd paths for mark and keep. half the seeds have the keys made tricky (kit.ts)
import apply, { ApplyError, type Patch } from "@ermine/core/changeable/apply"
import { isMap, made, patch, paths } from "../../core/unread/typescript/random_harness.ts"
import { wildPatches } from "./apply.ts"
import {
	type Answer,
	content,
	differs,
	firsts,
	formPatches,
	type Generator,
	picker,
	rename,
	type Request,
	show,
	toJson,
	tricky,
	type Violation,
} from "./kit.ts"

const NAMES = ["h0", "h1", "h2"]

function streams(seed: number, o: { wild: boolean }): Request[][] {
	const { pick, one } = picker(seed)
	const out: Request[] = []
	let v: unknown, prev: unknown, wrote = false
	const begin = () => {
		const x = made(pick, 3)
		v = isMap(x) ? x : { a: x, b: made(pick, 2), c: made(pick, 2) }
		wrote = false
		out.push({ op: "start", value: toJson(v) })
	}
	begin()
	const hold = () => pick(3) === 0 ? { hold: one(NAMES) } : {}
	const somewhere = () => {
		const ps = paths(v)
		return pick(10) ? one(ps) : ["zz", pick(3)]
	}
	for (let step = 0; step < 40; step++) {
		const k = pick(100)
		if (k < 3) begin()
		else if (k < 40) {
			let ps: unknown[] = Array.from({ length: 1 + pick(3) }, () => patch(pick, v))
			if (o.wild && pick(6) === 0) ps = [...ps, ...wildPatches(pick)]
			out.push({ op: "write", patches: formPatches(ps), ...hold() })
			try {
				const next = apply(v, ps as Patch[])
				prev = v, v = next, wrote = true
			} catch (e) {
				if (!(e instanceof ApplyError)) throw e
			}
		} else if (k < 48) {
			if (wrote || o.wild) out.push({ op: "unwrite", ...hold() })
			if (wrote) [v, prev] = [prev, v]
		} else if (k < 58) out.push({ op: "read", ...hold() })
		else if (k < 70) {
			const r: Request = { op: "keep", path: somewhere(), ...hold() }
			if (pick(3) === 0) r.wrap = true
			if (pick(3) === 0) r.handed = true
			if (pick(3) === 0) r.scheduler = one([true, "compute", "fails", "effect"])
			out.push(r)
		} else if (k < 78) out.push({ op: "held", name: one(NAMES) })
		else if (k < 86) out.push({ op: "value" })
		else if (k < 93) out.push({ op: "mark", name: one(NAMES), path: somewhere() })
		else out.push({ op: "same", name: one(NAMES), path: somewhere() })
		if (o.wild && pick(12) === 0) {
			out.push(
				one<Request>([
					{ op: "write" },
					{ op: "write", patches: [{ path: ["a"], value: { "/": { nope: 1 } } }] },
					{ op: "mark", name: "h0", path: "a" },
					{ op: "same", name: "nobody" },
					{ op: "keep", path: [-0] },
					{ op: "Read" },
				]),
			)
		}
	}
	out.push({ op: "value" })
	// half the seeds: the keys made tricky (kit.ts)
	const names = tricky(seed, ["a", "b", "c", "d", "zz"])
	return [out.map((r) => rename(r, names))]
}

// the value is the start with every landed write replayed; what was held stays what it was
async function invariant(
	stream: Request[],
	answers: (Answer | undefined)[],
	ask: (suite: string, requests: Request[]) => Promise<(Answer | undefined)[]>,
): Promise<Violation[]> {
	const replays: Request[] = [], at: number[] = []
	const out: Violation[] = []
	let base: Request | undefined, done: unknown[] = [], last: unknown[] | undefined
	let held = new Map<string, { value?: unknown }>()
	const valuesOf = (ps: unknown) =>
		Array.isArray(ps)
			? ps.filter((p) => isMap(p) && Object.hasOwn(p, "value")).map((p) => p.value)
			: undefined
	stream.forEach((r, i) => {
		const a = answers[i]
		if (!a) return
		if (r.op === "start" && !a.error) {
			base = r, done = [], last = undefined, held = new Map()
		}
		if (!base) return
		if (r.op === "write" && Array.isArray(r.patches)) {
			if (typeof r.hold === "string") {
				const vs = valuesOf(r.patches)
				if (vs) held.set(r.hold, { value: vs })
			}
			if (Array.isArray(a.undo)) {
				done.push(...r.patches)
				last = a.undo
			}
		}
		if (r.op === "unwrite") {
			if (typeof r.hold === "string") {
				const vs = last && valuesOf(last)
				if (vs) held.set(r.hold, { value: vs })
				else held.delete(r.hold)
			}
			if (Array.isArray(a.undo) && last) {
				done.push(...last)
				last = a.undo
			}
		}
		if (r.op === "keep" && typeof r.hold === "string") held.delete(r.hold)
		if (r.op === "read" && typeof r.hold === "string" && !a.error) {
			held.set(r.hold, "value" in a ? { value: a.value } : {})
		}
		if (r.op === "held" && typeof r.name === "string" && held.has(r.name)) {
			const d = differs(a, held.get(r.name))
			if (d) {
				out.push({
					kind: "held changed",
					at: i,
					why: `${d.kind} at ${d.path}: held ${JSON.stringify(held.get(r.name))}, now ${
						JSON.stringify(a)
					}`,
				})
			}
		}
		if ((r.op === "read" || r.op === "value") && !a.error) {
			replays.push({
				op: "apply",
				...("value" in base ? { value: base.value } : {}),
				patches: [...done],
			})
			at.push(i)
		}
	})
	if (replays.length) {
		const got = await ask("apply", replays)
		at.forEach((i, j) => {
			const g = got[j], a = answers[i]!
			if (!g || g.error !== undefined) {
				out.push({ kind: "replay refused", at: i, why: `apply: ${JSON.stringify(g)}` })
				return
			}
			const d = differs(g, "value" in a ? { value: a.value } : {})
			if (d) {
				out.push({
					kind: "replay is not the value",
					at: i,
					why: `${d.kind} at ${d.path}: replayed ${JSON.stringify(g.value)}, value ${
						JSON.stringify(a.value)
					}`,
				})
			}
		})
	}
	return firsts([...out, ...await model(stream, answers, ask)])
}

// the model: a write (an unwrite: the last landed write's undo, written) lands as its patches
// applied (by this implementation's apply) on what the landed ones before it made, refused with
// apply's code and index (counted in the write) when that refuses; an unwrite with nothing landed
// since start is nothing-written; a landed write's undo, applied after it, gives what was before
// (by content)
async function model(
	stream: Request[],
	answers: (Answer | undefined)[],
	ask: (suite: string, requests: Request[]) => Promise<(Answer | undefined)[]>,
): Promise<Violation[]> {
	const out: Violation[] = []
	const no = (kind: string, at: number, why: string) => out.push({ kind, at, why })
	type Case = { at: number; a: Answer; base: Request; done: unknown[]; ps: unknown[] }
	const cases: Case[] = []
	let base: Request | undefined, done: unknown[] = [], last: unknown[] | undefined
	stream.forEach((r, i) => {
		const a = answers[i]
		if (!a) return
		if (r.op === "start" && a.error === undefined) base = r, done = [], last = undefined
		if (!base) return
		let ps: unknown[] | undefined
		if (r.op === "write" && Array.isArray(r.patches)) ps = r.patches
		if (r.op === "unwrite") {
			if ((a.error === "nothing-written") !== (last === undefined)) {
				no(
					"nothing-written unlike the model",
					i,
					`${show(a)}, ${last === undefined ? "nothing" : "something"} landed since start`,
				)
			}
			ps = last
		}
		if (!ps) return
		cases.push({ at: i, a, base, done: [...done], ps })
		if (Array.isArray(a.undo)) done.push(...ps), last = a.undo
	})
	const from = (b: Request) => ("value" in b ? { value: b.value } : {})
	const asked = cases.flatMap((c) => [
		{ op: "apply", ...from(c.base), patches: [...c.done, ...c.ps] },
		{ op: "apply", ...from(c.base), patches: c.done },
		{
			op: "apply",
			...from(c.base),
			patches: [...c.done, ...c.ps, ...(Array.isArray(c.a.undo) ? c.a.undo : [])],
		},
	])
	const got = await ask("apply", asked)
	cases.forEach((c, j) => {
		const whole = got[3 * j], was = got[3 * j + 1], undone = got[3 * j + 2]
		// not understood: no code
		if (c.a.error !== undefined && typeof c.a.patch !== "number") return
		if (!whole || (whole.error !== undefined && typeof whole.error?.code !== "string")) return
		if (whole.error !== undefined) {
			if (whole.error.patch < c.done.length) return
			const want = { error: whole.error.code, patch: whole.error.patch - c.done.length }
			if (differs(c.a, want)) {
				no("refused unlike its apply", c.at, `${show(c.a)}, apply ${show(want)}`)
			}
			return
		}
		if (!Array.isArray(c.a.undo)) {
			no("refused unlike its apply", c.at, `${show(c.a)}, apply takes it`)
			return
		}
		if (content(undone) !== content(was)) {
			no(
				"undo does not undo",
				c.at,
				`undo ${show(c.a.undo)} gives ${show(undone)}, not ${show(was)}`,
			)
		}
	})
	return out
}

export default { streams, invariant } satisfies Generator
