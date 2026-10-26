// the blop fuzz: blops with every optional field or none, values of every kind in them, then one
// thing wrong (a field missing, of another kind or at an edge, a key no blop has, at the top, in a
// patch, a move or the site; parents, base and combine that don't go together). checked:
// - here: a blop encodes, decodes to itself (maps by content), encodes to the same bytes; the
//   same blop with its keys in another order the same bytes; its name BLAKE3 of them
// - across: the harness (BLOP_HARNESS, the C one; default the reference, against itself) answers
//   as conformance/blop/harness.ts does: encoding each, decoding wrong ones written as plain
//   values, and bytes near a blop's (non-canonical rewrites, cut, grown, flipped)
// a few dozen seeds (fuzz runs small; SEEDS for more). today's rules: see fuzz_values.ts
import { assert, assertEquals } from "@std/assert"
import { blake3 } from "@ermine/core/blake3"
import * as cbor from "@ermine/encoding/cbor"
import { type Blop, decode, encode, name } from "./blop.ts"
import { toJson } from "../../../conformance/typescript/form.ts"
import { ask } from "../../../conformance/typescript/ask.ts"
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
} from "../../../ermine/encoding/typescript/fuzz_values.ts"

const SEEDS = Number(Deno.env.get("SEEDS") ?? 40)
const reference = [
	"deno",
	"run",
	"--quiet",
	"--allow-env",
	new URL("../../../conformance/blop/harness.ts", import.meta.url).pathname,
]
const subject = Deno.env.get("BLOP_HARNESS")?.split(" ") ?? reference

const bytes = (pick: Pick, n: number) => Uint8Array.from({ length: n }, () => pick(256))
const whole = (pick: Pick) => [0, 1, 2 ** 31 - 1, 2 ** 31, 2 ** 53 - 1, pick(1000)][pick(6)]
const TEXTS = ["value", "n", "中", "😀", "x".repeat(30), "ermine://ab", "\u0000"]
const STRAY = ["", "a", "zz", "table", "__proto__", "constructor", "/", "😀", "nodex"]

function site(pick: Pick): Record<string, unknown> {
	const s: Record<string, unknown> = { file: TEXTS[pick(TEXTS.length)], line: whole(pick) }
	if (pick(2)) s.column = whole(pick)
	if (pick(2)) s.function = TEXTS[pick(TEXTS.length)]
	return s
}

function place(pick: Pick): Record<string, unknown> {
	const p: Record<string, unknown> = {
		path: Array.from(
			{ length: pick(4) },
			() => pick(2) ? TEXTS[pick(TEXTS.length)] : whole(pick),
		),
	}
	if (pick(3) === 0) p.range = [whole(pick), whole(pick)]
	return p
}

function patch(pick: Pick): Record<string, unknown> {
	const p = place(pick)
	const k = pick(3)
	if (k === 0) p.value = value(pick)
	else if (k === 1) p.move = place(pick)
	return p
}

function blop(pick: Pick): Record<string, unknown> {
	const b: Record<string, unknown> = {
		node: TEXTS[pick(TEXTS.length)],
		object: [
			"value",
			["info", TEXTS[pick(TEXTS.length)]],
			["children", TEXTS[pick(TEXTS.length)]],
		][pick(3)],
		actor: value(pick),
		signer: bytes(pick, 32),
		nonce: bytes(pick, 8),
		lamport: whole(pick) || 1,
		patches: Array.from({ length: pick(4) }, () => patch(pick)),
	}
	const parents = Array.from({ length: pick(4) }, () => bytes(pick, 32))
		.sort((a, b) => hex(a) < hex(b) ? -1 : 1)
		.filter((p, i, all) => i === 0 || hex(p) !== hex(all[i - 1]))
	b.parents = parents
	if (parents.length >= 2) {
		b.base = parents[pick(parents.length)].slice()
		if (pick(2)) b.combine = true
	}
	if (pick(2)) b.reader = TEXTS[pick(TEXTS.length)]
	if (pick(2)) b.site = site(pick)
	if (pick(2)) b.cause = value(pick)
	if (pick(2)) b.wallclock = whole(pick)
	if (pick(2)) b.message = TEXTS[pick(TEXTS.length)]
	return b
}

function wrong(pick: Pick, b: Record<string, unknown>): Record<string, unknown> {
	const w = { ...b }
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
			const s = site(pick)
			if (pick(2)) s[STRAY[pick(STRAY.length)]] = 1
			else s[["file", "line", "column", "function"][pick(4)]] = junk()
			w.site = s
			if (pick(2)) w.object = [["info"], ["other", "a"], ["info", 1], "children"][pick(4)]
			break
		}
		default: {
			const p = Array.from({ length: 2 }, () => bytes(pick, 32))
			const k = pick(5)
			if (k === 0) w.parents = [p[0], p[0]]
			else if (k === 1) w.parents = p.sort((a, b) => hex(a) < hex(b) ? 1 : -1)
			else if (k === 2) w.parents = p, w.base = bytes(pick, 32)
			else if (k === 3) w.parents = p, delete w.base, w.combine = true
			else w.parents = [p[0]], w.base = p[0]
		}
	}
	return w
}

Deno.test(`blop fuzz: ${SEEDS} seeds, a blop encodes, decodes to itself, one encoding`, () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { pick } = rand(seed)
		for (let n = 0; n < 10; n++) {
			const b = blop(pick)
			const at = `seed ${seed}.${n}: ${show(b)}`
			const bytes = encode(b as Blop)
			const back = decode(bytes)
			assert(same(back, b), `${at}: back as ${show(back)}`)
			assertEquals(hex(encode(back)), hex(bytes), `${at}: encoded again`)
			assertEquals(hex(encode(shuffled(pick, b as never) as never)), hex(bytes), `${at}: keys`)
			assertEquals(hex(name(bytes)), hex(blake3(bytes)), at)
		}
	}
})

async function across(requests: Record<string, unknown>[]) {
	const [want, got] = await Promise.all([ask(reference, requests), ask(subject, requests)])
	const differ: string[] = [], counts: Record<string, number> = {}
	requests.forEach((r, i) => {
		const kind = `${r.op} ${want[i].code ?? "taken"}`
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

Deno.test(`blop fuzz: ${SEEDS} seeds across, encoding blops and wrong ones`, async () => {
	const requests: Record<string, unknown>[] = []
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { pick } = rand(seed + 100)
		for (let n = 0; n < 15; n++) {
			const b = blop(pick)
			requests.push({ op: "encode", blop: toJson(b) })
			requests.push({ op: "encode", blop: toJson(wrong(pick, b)) })
		}
	}
	for (const x of [null, 1, "b", [], [1]]) requests.push({ op: "encode", blop: x })
	await across(requests)
})

Deno.test(`blop fuzz: ${SEEDS} seeds across, decoding wrong fields and bytes near a blop`, async () => {
	const requests: Record<string, unknown>[] = []
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { pick } = rand(seed + 200)
		for (let n = 0; n < 8; n++) {
			const b = blop(pick)
			const bytes = encode(b as Blop)
			requests.push({ op: "decode", bytes: hex(bytes) })
			for (const [, r] of rewrites(pick, bytes)) requests.push({ op: "decode", bytes: hex(r) })
			for (let k = 0; k < 4; k++) {
				requests.push({ op: "decode", bytes: hex(mutate(pick, bytes)) })
			}
			try {
				requests.push({ op: "decode", bytes: hex(cbor.encode(wrong(pick, b) as cbor.Value)) })
			} catch { /* no encoding at all */ }
		}
	}
	await across(requests)
})
