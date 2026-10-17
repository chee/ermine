// The id fuzz: a few dozen seeds, an id made from a lock and bytes, then bytes and is of it, the
// harness's answers against ID.tex read plainly (BLAKE3 and the CBOR codec here, never id.ts). The
// harness: the TypeScript one, or HARNESS (a command: the C binary) as the main run's
// (conformance/run.ts). Its scenarios: subduction-id.
import { assertEquals } from "@std/assert"
import { blake3 } from "npm:@noble/hashes@1.8.0/blake3"
import { encode } from "@ermine/encoding/cbor"
import { ask, command } from "../../../conformance/typescript/ask.ts"

type Request = Record<string, unknown> & { op: string }
const subject = command("subduction-id")

// a few dozen seeds (memory: fuzz runs small)
const SEEDS = 40

function rand(seed: number) {
	let x = seed * 2654435761 >>> 0 || 1
	return (n: number) => {
		x ^= x << 13
		x ^= x >>> 17
		x ^= x << 5
		return (x >>> 0) % n
	}
}
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
// emoji, a skin-toned one (two code points), NUL; and lone surrogates, which have no UTF-8 form, so
// no id: code "name" (08-lone-surrogate.json)
const NAMES = [
	"unlocked",
	"keyhive",
	"",
	"a",
	"日本",
	"é",
	"x".repeat(30),
	"y".repeat(300),
	"😀",
	"👍🏽",
	"a\u0000b",
	"\u0000",
	"\uD83D",
	"\uDE00",
	"x\uD83D",
]

// ID.tex read plainly
function model(lock: string, made: Uint8Array) {
	const all = new Uint8Array([
		...new TextEncoder().encode("ermine/v0/id"),
		...encode(lock),
		...made,
	])
	return "ermine://" + hex(blake3(all))
}

Deno.test(`fuzz: ${SEEDS} seeds, id then bytes and is`, async () => {
	const requests: Request[] = [], expect: unknown[] = []
	for (let seed = 1; seed <= SEEDS; seed++) {
		const pick = rand(seed)
		const lock = NAMES[pick(NAMES.length)] + (pick(2) ? String(pick(1000)) : "")
		const made = Uint8Array.from({ length: 32 }, () => pick(256))
		if (!lock.isWellFormed()) {
			requests.push({ op: "id", lock, made: hex(made) })
			expect.push({ code: "name" })
			continue
		}
		const id = model(lock, made)
		requests.push({ op: "id", lock, made: hex(made) }, { op: "bytes", id }, { op: "is", id })
		expect.push({ id }, { bytes: id.slice("ermine://".length) }, { is: true })
	}
	const answers = await ask(subject, requests)
	requests.forEach((r, i) => assertEquals(answers[i], expect[i], `#${i}: ${r.op}`))
})
