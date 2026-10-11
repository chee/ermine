// Asks the oracle (oracle/: Subduction's own build_fragment_store and fragment, sedimentree_core
// 0.14.2) the harness's questions. Requests and answers are the harness protocol (harness.ts);
// the oracle's own line form is in oracle/src/main.rs. Used by fixtures.ts and the fuzz.
//   cargo build --release --offline -q   (in oracle/)

export type Commit = { id: string; parents: string[] }
export type Fragment = {
	head: string
	members: string[]
	boundary: string[]
	checkpoints: string[]
}
export type Build = { op: "build"; commits: Commit[]; heads: string[]; known: Fragment[] }
export type Walk = { op: "walk"; commits: Commit[]; head: string; known: Fragment[] }
export type Request = Build | Walk
export type Answer =
	| { fragments: Fragment[] }
	| { members: string[]; boundary: string[]; checkpoints: string[] }
	| { error: "missing" | "depth-zero" }

const dir = new URL("./oracle/", import.meta.url).pathname
export const binary = `${dir}target/release/fragment_oracle`

export async function make() {
	const { success } = await new Deno.Command("cargo", {
		args: ["build", "--release", "--offline", "-q"],
		cwd: dir,
	}).output()
	if (!success) throw new Error("oracle: cargo build failed")
}

export async function built(): Promise<boolean> {
	try {
		await Deno.stat(binary)
		return true
	} catch {
		return false
	}
}

const frag = (f: Fragment) =>
	[f.head, f.members.join(","), f.boundary.join(","), f.checkpoints.join(",")].join("/")
const unfrag = (s: string): Fragment => {
	const [head, m, b, c] = s.split("/")
	const l = (x: string) => x === "" ? [] : x.split(",")
	return { head, members: l(m), boundary: l(b), checkpoints: l(c) }
}

function line(r: Request): string {
	const commits = r.commits.map((c) => `${c.id}:${c.parents.join(",")}`).join(";")
	const heads = r.op === "build" ? r.heads.join(",") : r.head
	return [r.op, commits, heads, r.known.map(frag).join(";")].join("|")
}

function parse(r: Request, s: string): Answer {
	if (s === "!missing") return { error: "missing" }
	if (s === "!depth-zero") return { error: "depth-zero" }
	if (r.op === "build") return { fragments: s === "" ? [] : s.split(";").map(unfrag) }
	const { members, boundary, checkpoints } = unfrag(s)
	return { members, boundary, checkpoints }
}

export async function ask(requests: Request[]): Promise<Answer[]> {
	if (requests.length === 0) return []
	const child = new Deno.Command(binary, {
		stdin: "piped",
		stdout: "piped",
		signal: AbortSignal.timeout(30_000),
	}).spawn()
	const output = child.output()
	const w = child.stdin.getWriter()
	await w.write(new TextEncoder().encode(requests.map(line).join("\n") + "\n"))
	await w.close()
	const { stdout, success } = await output
	if (!success) throw new Error("oracle failed")
	const lines = new TextDecoder().decode(stdout).split("\n").slice(0, requests.length)
	if (lines.length !== requests.length) throw new Error("oracle: an answer per request")
	return lines.map((l, i) => parse(requests[i], l))
}

// ---- DAGs for the fixtures and the fuzz

// 32 bytes from `bytes`, the first `depth` zero and the next not: depth exactly `depth` under
// Subduction's CountLeadingZeroBytes
export function idOf(bytes: Uint8Array, depth: number): string {
	const b = bytes.slice(0, 32)
	for (let i = 0; i < depth; i++) b[i] = 0
	if (b[depth] === 0) b[depth] = 1
	return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
}

export const depthOf = (id: string) => {
	let d = 0
	while (d < 32 && id.slice(2 * d, 2 * d + 2) === "00") d++
	return d
}

// a seeded PRNG (mulberry32)
export function random(seed: number) {
	let a = seed >>> 0
	const next = () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
	const int = (n: number) => Math.floor(next() * n)
	const bytes = (n: number) => Uint8Array.from({ length: n }, () => int(256))
	return { next, int, bytes }
}

// A random DAG: n commits, each with up to 3 earlier parents; depths mostly 0, some 1, 2, 3.
// Some commits are left out (named as parents, not here); heads are the childless commits and
// sometimes a few others. `known`: fragments built first from an earlier prefix of the history
// (as a device that built before would have them).
export async function dag(seed: number): Promise<{ build: Build; walks: Walk[] }> {
	const r = random(seed)
	const n = 4 + r.int(40)
	const all: Commit[] = []
	for (let i = 0; i < n; i++) {
		const x = r.next()
		const depth = x < 0.55 ? 0 : x < 0.8 ? 1 : x < 0.94 ? 2 : 3
		const parents = new Set<string>()
		if (i > 0) {
			const k = r.next() < 0.6 ? 1 : r.next() < 0.7 ? 2 : 3
			// mostly recent parents, so lines with merges
			for (let j = 0; j < k; j++) parents.add(all[Math.max(0, i - 1 - r.int(Math.min(i, 6)))].id)
		}
		all.push({ id: idOf(r.bytes(32), depth), parents: [...parents].sort() })
	}
	const children = new Set(all.flatMap((c) => c.parents))
	let heads = all.filter((c) => !children.has(c.id)).map((c) => c.id)
	if (r.next() < 0.3) heads.push(all[r.int(n)].id)
	// missing commits, some of the time
	const missing = new Set<string>()
	if (r.next() < 0.3) { for (let j = 0; j < 1 + r.int(2); j++) missing.add(all[r.int(n)].id) }
	const commits = all.filter((c) => !missing.has(c.id))
	// known: the fragments a build over an earlier prefix gave
	let known: Fragment[] = []
	if (r.next() < 0.4) {
		const cut = r.int(n)
		const prefix = commits.filter((c) => all.findIndex((a) => a.id === c.id) <= cut)
		const ch = new Set(prefix.flatMap((c) => c.parents))
		const ph = prefix.filter((c) => !ch.has(c.id)).map((c) => c.id)
		const [a] = await ask([{ op: "build", commits: prefix, heads: ph, known: [] }])
		if ("fragments" in a) known = a.fragments
	}
	heads = [...new Set(heads)]
	const walks: Walk[] = []
	for (let j = 0; j < 3; j++) {
		walks.push({ op: "walk", commits, head: all[r.int(n)].id, known })
	}
	return { build: { op: "build", commits, heads, known }, walks }
}
