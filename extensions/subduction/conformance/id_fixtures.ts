// Writes the id scenarios (subduction-id/*.json, in the main run's format: scenarios.ts) from ID.tex, computing each id with
// BLAKE3 and the CBOR codec, never id.ts. Run: deno run --allow-write --allow-read extensions/subduction/conformance/id_fixtures.ts
// A scenario: {title, ask: [requests], expect: [answers]}, an answer per request (harness.ts)
import { text } from "./scenarios.ts"
import { blake3 } from "npm:@noble/hashes@1.8.0/blake3"
import { encode } from "@ermine/encoding/cbor"

const here = new URL(".", import.meta.url).pathname
const out = `${here}subduction-id/`

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const utf8 = (s: string) => new TextEncoder().encode(s)
const counting = (from: number, n: number) => Uint8Array.from({ length: n }, (_, i) => from + i)

// ID.tex: BLAKE3 of "ermine/v0/id", the lock's name as a CBOR text string, the 32 made bytes
function id(lock: string, made: Uint8Array) {
	const parts = [utf8("ermine/v0/id"), encode(lock), made]
	const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
	let at = 0
	for (const p of parts) all.set(p, (at += p.length) - p.length)
	return "ermine://" + hex(blake3(all))
}

// the vector, as ID.tex prints it
const MADE = counting(0x20, 32)
const VECTOR = "ermine://0c8c6f9648e6a9d929cf6d0cd4a04d186434b25d9b58dc1c984d4f31b85217ce"
const before = hex(new Uint8Array([...utf8("ermine/v0/id"), ...encode("unlocked")]))
if (before !== "65726d696e652f76302f696468756e6c6f636b6564") throw new Error(`prefix ${before}`)
if (id("unlocked", MADE) !== VECTOR) throw new Error(`vector ${id("unlocked", MADE)}`)

const digits = VECTOR.slice("ermine://".length)
const NOT = {
	"upper-case hex": "ermine://" + digits.toUpperCase(),
	"one upper-case digit": "ermine://" + digits.slice(0, 63) + digits[63].toUpperCase(),
	"wrong prefix": "ermine:/" + digits,
	"another scheme": "automerge://" + digits,
	"no prefix": digits,
	"63 hex digits": VECTOR.slice(0, -1),
	"65 hex digits": VECTOR + "0",
	"a digit not hex": "ermine://" + digits.slice(0, 10) + "g" + digits.slice(11),
	"empty": "",
}
if (!/[a-f]/.test(digits[63])) throw new Error("the last digit must be a letter for its upper case")

type Scenario = { title: string; ask: Record<string, unknown>[]; expect: Record<string, unknown>[] }
const scenarios: [string, Scenario][] = [
	["01-vector", {
		title: 'ID.tex\'s vector: lock "unlocked", made 20 21 … 3f',
		ask: [{ op: "id", lock: "unlocked", made: hex(MADE) }],
		expect: [{ id: VECTOR }],
	}],
	["02-another-lock", {
		title: "another lock's name over the same made bytes: another id",
		ask: [{ op: "id", lock: "keyhive", made: hex(MADE) }],
		expect: [{ id: id("keyhive", MADE) }],
	}],
	["03-utf8-lock", {
		title: "a lock's name outside ASCII, as UTF-8 in its CBOR text string",
		ask: [{ op: "id", lock: "日本é", made: hex(counting(0, 32)) }],
		expect: [{ id: id("日本é", counting(0, 32)) }],
	}],
	["04-empty-lock", {
		title: "the empty name is a name",
		ask: [{ op: "id", lock: "", made: hex(MADE) }],
		expect: [{ id: id("", MADE) }],
	}],
	["05-made-31", {
		title: "made 31 bytes: size",
		ask: [{ op: "id", lock: "unlocked", made: hex(counting(0x20, 31)) }],
		expect: [{ code: "size" }],
	}],
	["06-made-33", {
		title: "made 33 bytes: size",
		ask: [{ op: "id", lock: "unlocked", made: hex(counting(0x20, 33)) }],
		expect: [{ code: "size" }],
	}],
	["07-made-empty", {
		title: "made no bytes: size",
		ask: [{ op: "id", lock: "unlocked", made: "" }],
		expect: [{ code: "size" }],
	}],
	["08-lone-surrogate", {
		title: "a lock name with a lone surrogate has no UTF-8 form: name",
		ask: [{ op: "id", lock: "un\ud800locked", made: hex(MADE) }],
		expect: [{ code: "name" }],
	}],
	["09-bytes", {
		title: "bytes(id) gives the 32 bytes its hex says; is(id) is true",
		ask: [
			{ op: "bytes", id: VECTOR },
			{ op: "is", id: VECTOR },
			{ op: "bytes", id: id("keyhive", MADE) },
		],
		expect: [
			{ bytes: digits },
			{ is: true },
			{ bytes: id("keyhive", MADE).slice("ermine://".length) },
		],
	}],
	["10-not-an-id", {
		title: `not of the form: bytes refuses (not-an-id), is false: ${Object.keys(NOT).join("; ")}`,
		ask: Object.values(NOT).flatMap((s) => [{ op: "bytes", id: s }, { op: "is", id: s }]),
		expect: Object.values(NOT).flatMap(() => [{ code: "not-an-id" }, { is: false }]),
	}],
]

for (const f of Deno.readDirSync(out)) {
	if (f.name.endsWith(".json") && f.name !== "suite.json") Deno.removeSync(out + f.name)
}
for (const [name, s] of scenarios) {
	Deno.writeTextFileSync(`${out}${name}.json`, text(s))
}
console.log(`${scenarios.length} scenarios in ${out}`)
