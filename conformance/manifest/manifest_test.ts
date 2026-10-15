// Runs the manifest scenarios (files/conformance/manifest/*.json, written by fixtures.ts) against a
// manifest harness. MANIFEST_HARNESS: the command for another implementation (default: the
// reference). A scenario: {title, steps: [{request, expect}]}; each answer compared whole
// (harness.ts has the protocol). A scenario on a folder is given a new temporary one: each of its
// open requests gets dir, <temp>/.ermine, which does not exist yet. Every scenario runs in one
// harness process, in order. A run that may not write skips the folder's scenarios.
import { assertEquals } from "@std/assert"
import { line } from "../pack/form.ts"

const here = new URL(".", import.meta.url).pathname
const reference = `deno run --quiet --allow-env --allow-read --allow-write ${here}harness.ts`
const subject = (Deno.env.get("MANIFEST_HARNESS") ?? reference).split(" ")
const scenarios = `${here}../suites-aside/playground/files/conformance/manifest/`
const writes = Deno.permissions.querySync({ name: "write" }).state === "granted"

type Request = Record<string, unknown> & { op: string }
type Step = { request: Request; expect: unknown }
type Scenario = { title: string; steps: Step[] }

async function ask(command: string[], requests: Request[]): Promise<unknown[]> {
	if (requests.length === 0) return []
	const child = new Deno.Command(command[0], {
		args: command.slice(1),
		stdin: "piped",
		stdout: "piped",
		// a harness that loops fails, not hangs
		signal: AbortSignal.timeout(60_000),
	}).spawn()
	// answers read while requests are written: a full pipe either way never stops both
	const output = child.output()
	const w = child.stdin.getWriter()
	await w.write(new TextEncoder().encode(requests.map((r) => line(r)).join("\n") + "\n"))
	await w.close()
	const { stdout } = await output
	const answers = new TextDecoder().decode(stdout).trim().split("\n").map((l) => JSON.parse(l))
	assertEquals(answers.length, requests.length, "an answer per request")
	return answers
}

const files: { name: string; s: Scenario; folder: boolean }[] = []
for await (const f of Deno.readDir(scenarios)) {
	if (!f.name.endsWith(".json")) continue
	const s: Scenario = JSON.parse(await Deno.readTextFile(scenarios + f.name))
	files.push({ name: f.name, s, folder: s.steps.some((t) => t.request.op === "open") })
}
files.sort((a, b) => a.name.localeCompare(b.name))
const run = files.filter((f) => writes || !f.folder)

const temps: string[] = []
const requests: Request[] = []
for (const { s, folder } of run) {
	let dir = ""
	if (folder) {
		const root = await Deno.makeTempDir()
		temps.push(root)
		dir = `${root}/.ermine`
	}
	for (const t of s.steps) {
		requests.push(t.request.op === "open" ? { ...t.request, dir } : t.request)
	}
}
let answers: unknown[] = []
let died: unknown
try {
	answers = await ask(subject, requests)
} catch (e) {
	died = e
} finally {
	for (const t of temps) await Deno.remove(t, { recursive: true })
}

let at = 0
for (const { name, s, folder } of files) {
	const skipped = !run.some((f) => f.name === name)
	const mine = skipped ? [] : answers.slice(at, at += s.steps.length)
	Deno.test({
		name: `${name}: ${s.title}`,
		ignore: skipped && folder,
		fn() {
			if (died) throw died
			s.steps.forEach((t, i) => assertEquals(mine[i], t.expect, `step ${i}: ${t.request.op}`))
		},
	})
}
