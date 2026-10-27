// update's streams: an entry started on a random value
// (core/fuzz/gen_harness.ts), then updates of a few patches each (some refused: they change nothing), an
// entry asked after each; a put of a fresh list, map or string then spliced into in the same
// update, now and then. headers given or not ({ time: 1, actor: "me" }), {} too.
// the invariant, each implementation on its own: the entry's value is the start value with every
// stored op's patches (each update's change.op.patches, as the entry right after it answered)
// replayed in order, by that implementation's apply; asked at every entry. and a model (model,
// below), each implementation on its own: refused as its apply refuses, changing nothing; the
// change the header and patches given; the undo undoes.
// wild: patches of no patch's shape, odd numbers, updates with no patches or patches not a list,
// values that are no JSON form. half the seeds have the keys made tricky (kit.ts)
// deno-lint-ignore-file no-explicit-any
import apply, { ApplyError, type Patch } from "@ermine/core/changeable/apply"
import { KEYS, patch, start } from "../../core/fuzz/gen_harness.ts"
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

// a put of a fresh container, then spliced into, in one update
function fresh(pick: (n: number) => number, v: unknown): Patch[] {
	const isMap = (x: unknown) =>
		x !== null && typeof x === "object" && !Array.isArray(x) && !ArrayBuffer.isView(x)
	const where: (string | number)[] = isMap(v) ? [["l", "s", "m", "z"][pick(4)]] : []
	const kind = pick(3)
	const empty = kind === 0 ? [] : kind === 1 ? "" : {}
	const ps: Patch[] = [{ path: where, value: empty }]
	if (kind === 0) {
		ps.push({ path: where, range: [0, 0], value: [pick(9)] })
		if (pick(2)) ps.push({ path: where, range: [0, 0], value: [[pick(9)]] })
		if (pick(2)) ps.push({ path: [...where, 0], value: pick(9) })
	} else if (kind === 1) {
		// a lone high, then a lone low after it: one pair from the second splice on
		ps.push({ path: where, range: [0, 0], value: pick(2) ? "ab" : "\uD83D" })
		if (pick(2)) {
			ps.push({ path: where, range: [1, 1], value: pick(2) ? "\uDE00" : "\uDE00👍🏽\u0000" })
		}
	} else {
		ps.push({ path: [...where, "k"], value: [pick(9)] })
		if (pick(2)) ps.push({ path: [...where, "k"], range: [0, 0], value: [pick(9)] })
	}
	return ps
}

function streams(seed: number, o: { wild: boolean }): Request[][] {
	const { pick } = picker(seed)
	const out: Request[] = []
	let v: unknown
	const begin = () => {
		v = start(pick)
		const r: Request = { op: "start", value: toJson(v), header: { time: 0, actor: "host" } }
		out.push(r, { op: "entry" })
	}
	begin()
	for (let step = 0; step < 20; step++) {
		if (pick(15) === 0) begin()
		let ps: unknown[] = pick(6) === 0
			? fresh(pick, v)
			: Array.from({ length: 1 + pick(3) }, () => patch(pick, v))
		if (o.wild && pick(5) === 0) ps = [...ps, ...wildPatches(pick)]
		const r: Request = { op: "update", patches: formPatches(ps) }
		const h = pick(4)
		if (h === 0) r.header = {}
		else if (h === 1) r.header = { time: 2 + step, actor: { step }, metadata: { s: step } }
		if (o.wild && pick(8) === 0) {
			out.push(
				[{ op: "update" }, { op: "update", patches: {} }, {
					op: "update",
					patches: [{ path: ["m"], value: { "/": { nope: 1 } } }],
				}][pick(3)],
			)
		}
		out.push(r, { op: "entry" })
		try {
			v = apply(v, ps as Patch[])
		} catch (e) {
			if (!(e instanceof ApplyError)) throw e
		}
	}
	// half the seeds: the keys made tricky (kit.ts)
	const names = tricky(seed, [...KEYS, "k"])
	return [out.map((r) => rename(r, names))]
}

// the start value with every stored op replayed, by the implementation's own apply, is the
// entry's value
async function invariant(
	stream: Request[],
	answers: (Answer | undefined)[],
	ask: (suite: string, requests: Request[]) => Promise<(Answer | undefined)[]>,
): Promise<Violation[]> {
	const replays: Request[] = [], at: number[] = []
	let base: Request | undefined, kept: unknown[] = []
	stream.forEach((r, i) => {
		const a = answers[i]
		if (r.op === "start" && a && !a.error) {
			base = r
			kept = []
		}
		if (r.op === "update" && a && !a.error && stream[i + 1]?.op === "entry") {
			const ps = answers[i + 1]?.entry?.change?.op?.patches
			if (Array.isArray(ps)) kept.push(...ps)
		}
		if (r.op === "entry" && a?.entry && base) {
			replays.push({
				op: "apply",
				...("value" in base ? { value: base.value } : {}),
				patches: [...kept],
			})
			at.push(i)
		}
	})
	if (!replays.length) return []
	const got = await ask("apply", replays)
	const out: Violation[] = []
	at.forEach((i, j) => {
		const g = got[j], entry = answers[i]!.entry
		if (!g || g.error !== undefined) {
			out.push({ kind: "replay refused", at: i, why: `apply: ${JSON.stringify(g)}` })
			return
		}
		const d = differs(g, "value" in entry ? { value: entry.value } : {})
		if (d) {
			out.push({
				kind: "replay is not the entry",
				at: i,
				why: `${d.kind} at ${d.path}: replayed ${JSON.stringify(g.value)}, entry ${
					JSON.stringify(entry.value)
				}`,
			})
		}
	})
	return firsts([...out, ...await model(stream, answers, ask)])
}

const isMap = (x: unknown): x is Record<string, any> =>
	x !== null && typeof x === "object" && !Array.isArray(x)
const coded = (e: unknown): e is { code: string; patch: number } =>
	isMap(e) && typeof e.code === "string"
// a patch as the change keeps it: path, range, value, move, -0 as 0
const zero = (k: unknown) => Object.is(k, -0) ? 0 : k
const kept = (p: any) =>
	isMap(p)
		? {
			path: Array.isArray(p.path) ? p.path.map(zero) : p.path,
			...("range" in p ? { range: Array.isArray(p.range) ? p.range.map(zero) : p.range } : {}),
			...("value" in p ? { value: p.value } : {}),
			...("move" in p ? { move: p.move } : {}),
		}
		: p

// the model: an update lands as its patches applied (by this implementation's apply) on what the
// landed ones before it made, refused with apply's code and index (counted in the update) when that
// refuses; a refused update changes nothing (the entry after is the entry before); a landed one's
// change is its header (none: { time: 1, actor: "me" }) with its patches as given, and its undo,
// applied to the entry after, gives the entry before (by content)
async function model(
	stream: Request[],
	answers: (Answer | undefined)[],
	ask: (suite: string, requests: Request[]) => Promise<(Answer | undefined)[]>,
): Promise<Violation[]> {
	const out: Violation[] = []
	const no = (kind: string, at: number, why: string) => out.push({ kind, at, why })
	type Case = {
		at: number
		r: Request
		a: Answer
		base: Request
		landed: unknown[]
		before?: Answer
		after?: Answer
	}
	const cases: Case[] = []
	let base: Request | undefined, landed: unknown[] = [], last: Answer | undefined
	stream.forEach((r, i) => {
		const a = answers[i]
		if (!a) return
		if (r.op === "start" && a.error === undefined) base = r, landed = [], last = undefined
		if (r.op === "entry" && a.entry) last = a.entry
		if (r.op !== "update" || !base || !Array.isArray(r.patches)) return
		const after = stream[i + 1]?.op === "entry" ? answers[i + 1]?.entry : undefined
		cases.push({ at: i, r, a, base, landed: [...landed], before: last, after })
		if (a.error === undefined) landed.push(...r.patches)
	})
	const from = (b: Request) => ("value" in b ? { value: b.value } : {})
	const value = (e?: Answer) => (e && "value" in e ? { value: e.value } : {})
	// each update on the landed before it; the landed before it alone; the undo on the entry after
	const asked: Request[] = []
	for (const c of cases) {
		asked.push(
			{ op: "apply", ...from(c.base), patches: [...c.landed, ...c.r.patches] },
			{ op: "apply", ...from(c.base), patches: c.landed },
			{ op: "apply", ...value(c.after), patches: c.after?.change?.op?.undo ?? [] },
		)
	}
	const got = await ask("apply", asked)
	cases.forEach((c, j) => {
		const whole = got[3 * j], was = got[3 * j + 1], undone = got[3 * j + 2]
		if (c.a.error !== undefined) {
			if (c.before && c.after && differs(c.after, c.before)) {
				no(
					"refused changes the entry",
					c.at,
					`before ${show(c.before)}, after ${show(c.after)}`,
				)
			}
		}
		if (c.a.error !== undefined && !coded(c.a.error)) return
		if (!whole || (whole.error !== undefined && !coded(whole.error))) return
		if (coded(whole.error)) {
			if (whole.error.patch < c.landed.length) return
			const want = {
				error: { code: whole.error.code, patch: whole.error.patch - c.landed.length },
			}
			if (differs(c.a, want)) {
				no("refused unlike its apply", c.at, `${show(c.a)}, apply ${show(want)}`)
			}
			return
		}
		if (c.a.error !== undefined) {
			no("refused unlike its apply", c.at, `${show(c.a)}, apply takes it`)
			return
		}
		if (!c.after) return
		const d = differs(value(c.after), whole)
		if (d) no("entry is not the model", c.at, `${d.kind} at ${d.path}: ${show(c.after)}`)
		const { op, ...header } = c.after.change ?? {}
		const given = c.r.header ?? { time: 1, actor: "me" }
		if (differs(header, given)) {
			no("change is not the header", c.at, `${show(header)}, not ${show(given)}`)
		}
		const ps = c.r.patches.map(kept)
		if (differs(op?.patches, ps)) {
			no("stored patches are not the patches", c.at, `${show(op?.patches)}, not ${show(ps)}`)
		}
		if (content(undone) !== content(was)) {
			no(
				"undo does not undo",
				c.at,
				`undo ${show(op?.undo)} gives ${show(undone)}, not ${show(was)}`,
			)
		}
	})
	return out
}

export default { streams, invariant } satisfies Generator
