// Runs the id scenarios (sync/conformance/id/*.json, written by fixtures.ts) and a small fuzzer
// against an id harness. ID_HARNESS: the command for another implementation (default: the
// reference). A scenario: {title, ask: [requests], expect: [answers]}, an answer per request,
// compared whole (harness.ts has the protocol).
import { assertEquals } from "@std/assert"
import { blake3 } from "npm:@noble/hashes@1.8.0/blake3"
import { encode } from "@ermine/encoding/cbor"

const here = new URL(".", import.meta.url).pathname
const reference = `deno run --quiet --allow-env ${here}harness.ts`
const subject = (Deno.env.get("ID_HARNESS") ?? reference).split(" ")
const scenarios = `${here}../../extensions/subduction/conformance/id/`

type Request = Record<string, unknown> & { op: string }
type Scenario = { title: string; ask: Request[]; expect: unknown[] }

async function ask(command: string[], requests: Request[]): Promise<unknown[]> {
	if (requests.length === 0) return []
	const child = new Deno.Command(command[0], {
		args: command.slice(1),
		stdin: "piped",
		stdout: "piped",
		// a harness that loops fails, not hangs
		signal: AbortSignal.timeout(30_000),
	}).spawn()
	// answers read while requests are written: a full pipe either way never stops both
	const output = child.output()
	const w = child.stdin.getWriter()
	await w.write(new TextEncoder().encode(requests.map((r) => JSON.stringify(r)).join("\n") + "\n"))
	await w.close()
	const { stdout } = await output
	const answers = new TextDecoder().decode(stdout).trim().split("\n").map((l) => JSON.parse(l))
	assertEquals(answers.length, requests.length, "an answer per request")
	return answers
}

for await (const f of Deno.readDir(scenarios)) {
	if (!f.name.endsWith(".json")) continue
	const s = JSON.parse(await Deno.readTextFile(scenarios + f.name)) as Scenario
	Deno.test(`${f.name}: ${s.title}`, async () => {
		const answers = await ask(subject, s.ask)
		s.ask.forEach((r, i) => assertEquals(answers[i], s.expect[i], `${f.name} #${i}: ${r.op}`))
	})
}

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
const NAMES = ["unlocked", "keyhive", "", "a", "日本", "é", "x".repeat(30), "y".repeat(300)]

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
		const id = model(lock, made)
		requests.push({ op: "id", lock, made: hex(made) }, { op: "bytes", id }, { op: "is", id })
		expect.push({ id }, { bytes: id.slice("ermine://".length) }, { is: true })
	}
	const answers = await ask(subject, requests)
	requests.forEach((r, i) => assertEquals(answers[i], expect[i], `#${i}: ${r.op}`))
})
