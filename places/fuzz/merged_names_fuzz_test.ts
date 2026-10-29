// differential, small: places' names from several contributors (tries on value entries, then
// children) are merged in one order, so the TypeScript and C places harnesses must answer alike.
// a world of 2-4 tries and a children entry, names from a nasty alphabet (U+0000, U+FFFF, astral,
// lone surrogates), random rewrites and takings away; after each, the root's names and each name's
// answer asked of both, and the names checked against keyorder (changeable) too. a few dozen seeds
// (fuzz runs small); SEEDS=n for another count, SEED=n for one seed. a C harness not built
// (make places/c/places-harness) skips the test
import { assert, assertEquals } from "@std/assert"
import { ask, command } from "../../conformance/typescript/ask.ts"
import { line } from "../../conformance/typescript/form.ts"
import type { Answer, Request } from "../../conformance/typescript/harness.ts"
import { keyorder } from "@ermine/changeable/keyorder"
import { rand } from "./gen_harness.ts"

const SEEDS = Number(Deno.env.get("SEEDS") ?? 40)
const STEPS = 6
const PARTS = ["a", "b", "A", "\u0000", "￿", "", "😀", "\uD83D", "\uDE00", "é", "中"]
const REFUSED = ["", ".", "..", "/"]
const root = new URL("../../", import.meta.url).pathname
const c = `${root}places/c/places-harness`

function build(seed: number): { requests: Request[]; names: number[] } {
	const { pick, one } = rand(seed)
	const name = (): string => {
		const n = Array.from({ length: 1 + pick(3) }, () => one(PARTS)).join("")
		return REFUSED.includes(n) ? "a" : n
	}
	const tries = 2 + pick(3)
	const ids = Array.from({ length: tries }, (_, i) => `t${i}`)
	const requests: Request[] = []
	const names: number[] = []
	// every name seen, to ask each: top, then one level down
	const seen = new Set<string>()
	// a trie's map: names to a leaf id or a level of names to ids
	const trie = (id: string) => {
		const m: Record<string, unknown> = {}
		for (let i = pick(6); i > 0; i--) {
			const n = name()
			seen.add(n)
			if (pick(4)) m[n] = id.toUpperCase()
			else {
				const level: Record<string, string> = {}
				for (let j = pick(4); j > 0; j--) {
					const k = name()
					seen.add(k)
					level[k] = id.toUpperCase()
				}
				m[n] = level
			}
		}
		return m
	}
	const kids: Record<string, string> = {}
	for (let i = pick(4); i > 0; i--) kids[name()] = "C"
	requests.push({ op: "kids", id: "R", value: kids })
	for (const id of ids) requests.push({ op: "value", id, value: trie(id) })
	requests.push({ op: "rows", of: ids })
	const check = () => {
		names.push(requests.length)
		requests.push({ op: "list", at: [] })
		for (const n of seen) {
			requests.push({ op: "get", path: [n] })
			requests.push({ op: "list", at: [n] })
			requests.push({ op: "lookup", names: [n], from: [] })
		}
	}
	for (let step = 0; step < STEPS; step++) {
		check()
		const id = one(ids)
		if (pick(4) === 0) requests.push({ op: "del", part: "value", id })
		else requests.push({ op: "value", id, value: trie(id) })
	}
	check()
	return { requests, names }
}

async function seeded(seed: number) {
	const { requests, names } = build(seed)
	const ts = await ask(command("places"), requests)
	const native = await ask([c], requests)
	for (let i = 0; i < requests.length; i++) {
		assertEquals(line(native[i]), line(ts[i]), `request ${i}: ${line(requests[i])}`)
	}
	for (const i of names) {
		const got = (ts[i] as { names: string[] }).names
		assertEquals(got, [...got].sort(keyorder), `names at request ${i}`)
	}
	assert(ts.length === requests.length)
	return ts as Answer[]
}

Deno.test("merged names: TypeScript and C order a folder's names from several contributors alike", async (t) => {
	try {
		Deno.statSync(c)
	} catch {
		console.warn(`${c} not built: skipped`)
		return
	}
	const only = Deno.env.get("SEED")
	const seeds = only !== undefined
		? [Number(only)]
		: Array.from({ length: SEEDS }, (_, i) => i + 1)
	for (const seed of seeds) {
		await t.step(`seed ${seed}`, async () => {
			try {
				await seeded(seed)
			} catch (e) {
				console.error(`merged names fuzz: failing seed ${seed} (SEED=${seed})`)
				throw e
			}
		})
	}
})
