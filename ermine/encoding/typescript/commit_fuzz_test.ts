// the commit fuzz: commits with every optional field or none, values of every kind in them, then
// one thing wrong: a field missing, of another kind or at an edge (-0, a fraction, 2^31, 2^53, a
// lone surrogate), a key no commit has (at the top, in a patch, a move, a site), a patch with both
// value and move. checked:
// - here: a commit encodes, decodes to itself (maps by content) and encodes to the same bytes; its
//   name is BLAKE3 of them; the same commit with its keys in another order the same bytes
// - across: the harness (HARNESS, the C one; default the TypeScript, against itself) answers as
//   commit_harness.ts does: encoding each, decoding each as bytes (wrong fields too, written as
//   plain values), and bytes near a commit's (non-canonical rewrites, cut, grown, flipped)
// a few dozen seeds (fuzz runs small; SEEDS for more). today's rules: see fuzz_values.ts
import { assert, assertEquals } from "@std/assert"
import { blake3 } from "@ermine/blake3"
import * as cbor from "./cbor.ts"
import { type Commit, decode, encode, joinKey, name } from "./commit.ts"
import { toJson } from "../../../conformance/typescript/form.ts"
import { ask, command, reference } from "../../../conformance/typescript/ask.ts"
import {
	hex,
	JUNK,
	mutate,
	type Pick,
	rand,
	rewrites,
	same,
	show,
	shuffled,
	stable,
	value,
} from "./fuzz_values.ts"

const SEEDS = Number(Deno.env.get("SEEDS") ?? 40)
const subject = command("commit"), here = reference("commit")

const bytes = (pick: Pick, n: number) => Uint8Array.from({ length: n }, () => pick(256))
const whole = (pick: Pick) =>
	[0, 1, 2 ** 31 - 1, 2 ** 31, 2 ** 53 - 1, 1760000000, pick(1000)][pick(7)]
const small = (pick: Pick) => [0, 1, 2 ** 31 - 1, pick(100)][pick(4)]
const TEXTS = ["value", "t", "中", "😀", "x".repeat(30), "info/a", "\u0000"]

const STRAY = ["", "a", "zz", "node", "__proto__", "constructor", "/", "😀", "\uD800", "tablex"]

function site(pick: Pick): Record<string, unknown> {
	const s: Record<string, unknown> = { file: TEXTS[pick(TEXTS.length)], line: small(pick) }
	if (pick(2)) s.column = small(pick)
	if (pick(2)) s.function = TEXTS[pick(TEXTS.length)]
	return s
}

function patch(pick: Pick): Record<string, unknown> {
	const place = () => {
		const p: Record<string, unknown> = {
			path: Array.from(
				{ length: pick(4) },
				() => pick(2) ? TEXTS[pick(TEXTS.length)] : small(pick),
			),
		}
		if (pick(3) === 0) p.range = [whole(pick), whole(pick)]
		return p
	}
	const p = place()
	const k = pick(3)
	if (k === 0) p.value = value(pick)
	else if (k === 1) p.move = place()
	return p
}

export function commit(pick: Pick): Record<string, unknown> {
	const c: Record<string, unknown> = {
		table: TEXTS[pick(TEXTS.length)],
		actor: value(pick),
		time: whole(pick),
		signer: pick(4) === 0
			? new Uint8Array(32).fill(0x11)
			: joinKey([0xed, 0xe7, 0x1200, 0, 1, 2 ** 40][pick(6)], bytes(pick, 1 + pick(40))),
		nonce: whole(pick),
		lamport: whole(pick) || 1,
		patches: Array.from({ length: pick(4) }, () => patch(pick)),
	}
	const parents = Array.from({ length: pick(4) }, () => bytes(pick, 32))
		.sort((a, b) => hex(a) < hex(b) ? -1 : 1)
		.filter((p, i, all) => i === 0 || hex(p) !== hex(all[i - 1]))
	c.parents = parents
	if (parents.length >= 2) {
		if (pick(2)) c.base = parents[pick(parents.length)].slice()
		else c.merge = TEXTS[pick(TEXTS.length)]
	}
	if (pick(2)) c.reader = TEXTS[pick(TEXTS.length)]
	if (pick(2)) c.external = Array.from({ length: pick(3) }, () => site(pick))
	if (pick(2)) {
		c.metadata = Object.fromEntries(
			Array.from({ length: pick(3) }, () => [TEXTS[pick(TEXTS.length)], value(pick)]),
		)
	}
	return c
}

// one thing wrong, or at an edge
function wrong(pick: Pick, c: Record<string, unknown>): Record<string, unknown> {
	const w = { ...c }
	const fields = Object.keys(w)
	const junk = () => JUNK[pick(JUNK.length)]
	switch (pick(6)) {
		case 0:
			delete w[fields[pick(fields.length)]]
			break
		case 1:
			w[fields[pick(fields.length)]] = junk()
			break
		case 2:
			Object.defineProperty(w, STRAY[pick(STRAY.length)], {
				value: junk(),
				enumerable: true,
				writable: true,
				configurable: true,
			})
			break
		case 3: {
			// in a patch: a stray key, a path key, a range, both value and move
			const ps = (w.patches as Record<string, unknown>[]).map((p) => ({ ...p }))
			if (!ps.length) ps.push({ path: [] })
			const p = ps[pick(ps.length)]
			const k = pick(5)
			if (k === 0) p[STRAY[pick(STRAY.length)]] = 1
			else if (k === 1) p.path = [junk()]
			else if (k === 2) p.range = pick(2) ? [junk(), 1] : junk()
			else if (k === 3) p.value = 1, p.move = { path: [] }
			else p.move = pick(2) ? { path: [], [STRAY[pick(STRAY.length)]]: 1 } : junk()
			w.patches = ps
			break
		}
		case 4: {
			// in a site, or metadata not a map (the old form, pairs, too: read, never written)
			if (pick(2)) {
				const s = site(pick)
				const k = pick(4)
				if (k === 0) s[STRAY[pick(STRAY.length)]] = 1
				else s[["file", "line", "column", "function"][pick(4)]] = junk()
				w.external = [s]
			} else {
				w.metadata = [[["a", 1]], [], 1, "a", null][pick(5)]
			}
			break
		}
		default: {
			// the parents, base and merge
			const p = Array.from({ length: 2 }, () => bytes(pick, 32))
			const k = pick(5)
			if (k === 0) w.parents = [p[0], p[0]]
			else if (k === 1) w.parents = p.sort((a, b) => hex(a) < hex(b) ? 1 : -1)
			else if (k === 2) w.parents = p, w.base = bytes(pick, 32)
			else if (k === 3) w.parents = p, w.base = p[0], w.merge = "m"
			else w.parents = [p[0]], w.merge = "m"
		}
	}
	return w
}

// a commit in the harness's JSON: byte fields hex when bytes, everything a value form
function form(c: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	// a string there is hex to the harness: a wrong one is null instead
	const bytesOr = (x: unknown) =>
		x instanceof Uint8Array ? hex(x) : typeof x === "string" ? null : toJson(x)
	for (const k of Object.keys(c)) {
		const v = c[k]
		Object.defineProperty(out, k, {
			value: k === "signer" || k === "base"
				? bytesOr(v)
				: k === "parents" && Array.isArray(v)
				? v.map(bytesOr)
				: toJson(v),
			enumerable: true,
			writable: true,
			configurable: true,
		})
	}
	return out
}

Deno.test(`commit fuzz: ${SEEDS} seeds, a commit encodes, decodes to itself, one encoding`, () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { pick } = rand(seed)
		for (let n = 0; n < 10; n++) {
			const c = commit(pick)
			const at = `seed ${seed}.${n}: ${show(c)}`
			const b = encode(c as Commit)
			const back = decode(b)
			assert(same(back, c), `${at}: back as ${show(back)}`)
			assertEquals(hex(encode(back)), hex(b), `${at}: encoded again`)
			assertEquals(hex(encode(shuffled(pick, c as never) as never)), hex(b), `${at}: keys`)
			assertEquals(hex(name(b)), hex(blake3(b)), at)
		}
	}
})

async function across(requests: Record<string, unknown>[]) {
	const [want, got] = await Promise.all([ask(here, requests), ask(subject, requests)])
	const differ: string[] = [], counts: Record<string, number> = {}
	requests.forEach((r, i) => {
		const kind = `${r.op} ${want[i].error ?? "taken"}`
		counts[kind] = (counts[kind] ?? 0) + 1
		if (stable(got[i]) !== stable(want[i])) {
			differ.push(
				`${stable(r).slice(0, 600)}\n  here  ${stable(want[i]).slice(0, 300)}\n  there ${
					stable(got[i]).slice(0, 300)
				}`,
			)
		}
	})
	console.log(`  ${subject.at(-1)?.split("/").at(-1)}: ${stable(counts)}`)
	assertEquals(differ.slice(0, 8).join("\n"), "", `${differ.length} of ${requests.length} differ`)
}

Deno.test(`commit fuzz: ${SEEDS} seeds across, encoding commits and wrong ones`, async () => {
	const requests: Record<string, unknown>[] = []
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { pick } = rand(seed + 100)
		for (let n = 0; n < 15; n++) {
			const c = commit(pick)
			requests.push({ op: "encode", commit: form(c) })
			requests.push({ op: "encode", commit: form(wrong(pick, c)) })
		}
	}
	// not a map
	for (const x of [null, 1, "c", [], [1]]) requests.push({ op: "encode", commit: x })
	await across(requests)
})

Deno.test(`commit fuzz: ${SEEDS} seeds across, decoding wrong fields and bytes near a commit`, async () => {
	const requests: Record<string, unknown>[] = []
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { pick } = rand(seed + 200)
		for (let n = 0; n < 8; n++) {
			const c = commit(pick)
			const b = encode(c as Commit)
			requests.push({ op: "decode", bytes: hex(b) })
			for (const [, r] of rewrites(pick, b)) requests.push({ op: "decode", bytes: hex(r) })
			for (let k = 0; k < 4; k++) requests.push({ op: "decode", bytes: hex(mutate(pick, b)) })
			// a wrong one as a plain value: what encode would refuse, read
			try {
				requests.push({ op: "decode", bytes: hex(cbor.encode(wrong(pick, c) as cbor.Value)) })
			} catch { /* no encoding at all */ }
		}
	}
	await across(requests)
})
