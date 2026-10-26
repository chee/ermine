// planted-bug test: every plant (plants.ts) is applied to a temp copy of the sources and its
// catcher run there; it must fail. before that, every catcher must pass on the unmutated copy.
//   deno task plants [--seeds N] [--only text] [--jobs N]
// seeds: for differ catchers (default 30); the in-process fuzz tests run the seeds written in them.
// exit non-zero when a plant survived, went stale (find not matching exactly once), or broke the
// source (a syntax or import error is no catch)
import { type Catcher, type Plant, plants } from "./plants.ts"

const root = new URL("../../", import.meta.url).pathname
const args = Deno.args
const arg = (k: string) => {
	const i = args.indexOf(k)
	return i >= 0 ? args[i + 1] : undefined
}
const SEEDS = Number(arg("--seeds") ?? 30)
const JOBS = Number(arg("--jobs") ?? 4)
const ONLY = arg("--only")
const TIMEOUT = 180_000

// the tree a catcher imports: core, conformance, and the ermine package it
// uses; no node_modules, no c binaries outside core (the differ's c impl runs core's)
const copied = ["core", "conformance", "ermine/encoding"]
const only = (dir: string) => dir.startsWith("ermine/") ? ["--exclude", "c"] : []

async function sh(cmd: string[], cwd?: string, timeout = TIMEOUT) {
	const r = await new Deno.Command(cmd[0], {
		args: cmd.slice(1),
		cwd,
		stdout: "piped",
		stderr: "piped",
		signal: AbortSignal.timeout(timeout),
	}).output().catch((e) => ({
		code: -1,
		stdout: new Uint8Array(),
		stderr: new TextEncoder().encode(String(e)),
	}))
	const dec = new TextDecoder()
	return { code: r.code, out: dec.decode(r.stdout) + dec.decode(r.stderr) }
}

async function makeTree(): Promise<string> {
	const dir = await Deno.makeTempDir({ prefix: "plants-" })
	for (const d of copied) {
		await Deno.mkdir(`${dir}/${d.split("/").slice(0, -1).join("/")}`, { recursive: true })
		const parent = d.includes("/") ? `${dir}/${d.split("/")[0]}/` : `${dir}/`
		const r = await sh([
			"rsync",
			"-a",
			"--exclude",
			"node_modules",
			...only(d),
			`${root}${d}`,
			parent,
		])
		if (r.code !== 0) throw new Error(`copy ${d}: ${r.out}`)
	}
	// differ reads these groups, empty ones are fine
	for (const d of ["extensions", "playground", "ermine"]) {
		await Deno.mkdir(`${dir}/${d}`, { recursive: true })
	}
	await Deno.symlink(`${root}node_modules`, `${dir}/node_modules`).catch(() => {})
	// the workspace: only what was copied
	const deno = JSON.parse(await Deno.readTextFile(`${root}deno.json`))
	deno.workspace = deno.workspace.filter((w: string) =>
		/^\.\/(core|ermine\/encoding)(\/|$)/.test(w)
	)
	await Deno.writeTextFile(`${dir}/deno.json`, JSON.stringify(deno))
	await Deno.copyFile(`${root}deno.lock`, `${dir}/deno.lock`).catch(() => {})
	return dir
}

const label = (c: Catcher) =>
	"fuzz" in c
		? `fuzz ${c.fuzz.split("/").pop()}`
		: `differ ${c.differ}${c.impls ? ` (${c.impls} only)` : ""}`

function command(c: Catcher): string[] {
	if ("fuzz" in c) return ["deno", "test", "-A", "--no-check", "--quiet", c.fuzz]
	return [
		"deno",
		"run",
		"--no-check",
		"-A",
		"conformance/differ.ts",
		c.differ,
		"--seeds",
		String(SEEDS),
		"--impl",
		c.impls ?? "typescript,c",
	]
}

// what a failure says about how many seeds it took
function seeds(c: Catcher, out: string): string {
	if ("differ" in c) {
		const m = out.match(/(\d+) of (\d+) streams/)
		return m ? `${m[1]} of ${m[2]} seeds` : `${SEEDS} seeds`
	}
	const m = out.match(/seed[ =:]+(\d+)/i)
	return m ? `seed ${m[1]}` : "its seeds"
}

const broken =
	/SyntaxError|error: (Expected|Unexpected|Module not found|Relative import|Import ")|Uncaught ReferenceError|is not defined/

async function run(c: Catcher, dir: string) {
	const r = await sh(command(c), dir)
	return r
}

async function control(dir: string): Promise<boolean> {
	const seen = new Map<string, Catcher>()
	for (const p of plants) seen.set(label(p.catcher), p.catcher)
	let ok = true
	await pool([...seen], async ([name, c]) => {
		const r = await run(c, dir)
		// a differ finding exits non-zero; its text says so
		const bad = r.code !== 0 ||
			("differ" in c && !/all agree/.test(r.out) && !/0 signatures/.test(r.out))
		console.log(`control ${bad ? "FAIL" : "pass"}  ${name}`)
		if (bad) {
			ok = false
			console.log(r.out.split("\n").slice(0, 12).join("\n"))
		}
	})
	return ok
}

async function pool<T>(items: T[], f: (t: T) => Promise<void>) {
	const q = [...items]
	await Promise.all(Array.from({ length: Math.min(JOBS, q.length) }, async () => {
		for (let t = q.shift(); t !== undefined; t = q.shift()) await f(t)
	}))
}

type Result = { plant: Plant; verdict: "caught" | "survived" | "stale" | "broken"; note: string }

async function plant(p: Plant, template: string): Promise<Result> {
	const dir = await Deno.makeTempDir({ prefix: "plant-" })
	try {
		const cp = await sh(["cp", "-R", `${template}/.`, dir])
		if (cp.code !== 0) throw new Error(cp.out)
		const path = `${dir}/${p.file}`
		const text = await Deno.readTextFile(path)
		const n = text.split(p.find).length - 1
		if (n !== 1) return { plant: p, verdict: "stale", note: `find matched ${n} times` }
		await Deno.writeTextFile(path, text.replace(p.find, () => p.replace))
		const r = await run(p.catcher, dir)
		const failed = r.code !== 0 ||
			("differ" in p.catcher && !/all agree|0 signatures/.test(r.out))
		if (!failed) return { plant: p, verdict: "survived", note: label(p.catcher) }
		if (broken.test(r.out)) {
			return {
				plant: p,
				verdict: "broken",
				note: r.out.split("\n").find((l) => broken.test(l))!.trim().slice(0, 100),
			}
		}
		const hang = r.code === -1 ? " (timed out)" : ""
		return {
			plant: p,
			verdict: "caught",
			note: `${label(p.catcher)} in ${seeds(p.catcher, r.out)}${hang}`,
		}
	} finally {
		await Deno.remove(dir, { recursive: true }).catch(() => {})
	}
}

const started = Date.now()
const template = await makeTree()
try {
	console.log(`tree ${template}`)
	if (!await control(template)) {
		console.log(
			"control failed: a catcher fails on the unmutated sources, nothing means anything. aborting",
		)
		Deno.exit(2)
	}
	const chosen = plants.filter((p) => !ONLY || p.name.includes(ONLY))
	const results: Result[] = []
	await pool(chosen, async (p) => {
		results.push(await plant(p, template))
	})
	results.sort((a, b) => plants.indexOf(a.plant) - plants.indexOf(b.plant))
	for (const r of results) console.log(`${r.verdict.padEnd(8)} ${r.plant.name}  [${r.note}]`)
	const count = (v: string) => results.filter((r) => r.verdict === v).length
	console.log(
		`\n${results.length} plants: ${count("caught")} caught, ${count("survived")} survived, ${
			count("stale")
		} stale, ${count("broken")} broken (${Math.round((Date.now() - started) / 1000)} s)`,
	)
	if (results.length !== count("caught")) Deno.exit(1)
} finally {
	await Deno.remove(template, { recursive: true }).catch(() => {})
}
