// the side that asks: a suite's place in the repo, the harness to run it against, and a harness
// run on a list of requests. HARNESS (a command, split at spaces) names another implementation
// than the TypeScript one, such as a C binary
// deno-lint-ignore-file no-explicit-any
import { line } from "./form.ts"
import type { Answer, Request } from "./harness.ts"

const root = new URL("../../", import.meta.url).pathname

export type Suite = {
	name: string
	// the package it is in, as a path from the root: core/protect
	package: string
	// its scenarios: <package>/conformance/<name>/
	fixtures: string
	// the adapter and binary it speaks with: <package>/typescript/<harness>_harness.ts,
	// <package>/c/<harness>-harness. (the harness option of its suite.json: it shares another's)
	typescript: string
	binary: string
	// suite.json: how its answers are compared (conformance/run.ts)
	options: Options
}
export type Options = {
	harness?: string
	// the answer need only have the fields expect gives
	loose?: boolean
	// fields compared as sets
	unordered?: string[]
	// a map's keys compared in order too
	ordered?: boolean
	// "now" in an expect: a whole number of seconds since 1970, as of the run
	now?: boolean
	// the scenarios run again, a request that has the field (or this op) given more fields
	again?: { name: string; has?: string; op?: string; set: Record<string, unknown> }
	// the suite runs only against the TypeScript harness: --c, --check and --leaks skip it (a loader
	// importing JavaScript or instantiating wasm, which C has no way to)
	typescript?: boolean
	// what the TypeScript harness is allowed beyond reading: deno's flags (native: --allow-ffi, ...)
	allow?: string[]
}

// every suite there is: a folder in <package>/conformance/ with an adapter in <package>/typescript/
export function suites(): Suite[] {
	const found: Suite[] = []
	for (const group of ["core", "filesystem", "ermine", "extensions", "playground"]) {
		for (const p of Deno.readDirSync(`${root}${group}`)) {
			const dir = `${root}${group}/${p.name}/conformance`
			let names: Deno.DirEntry[]
			try {
				names = [...Deno.readDirSync(dir)].filter((d) => d.isDirectory)
			} catch {
				continue
			}
			for (const d of names) {
				const fixtures = `${dir}/${d.name}/`
				let options: Options = {}
				try {
					options = JSON.parse(Deno.readTextFileSync(`${fixtures}suite.json`))
				} catch { /* none */ }
				const pkg = `${root}${group}/${p.name}`
				const shared = options.harness ?? d.name
				const typescript = `${pkg}/typescript/${shared}_harness.ts`
				try {
					Deno.statSync(typescript)
				} catch {
					continue
				}
				found.push({
					name: d.name,
					package: `${group}/${p.name}`,
					fixtures,
					typescript,
					binary: `${pkg}/c/${shared}-harness`,
					options,
				})
			}
		}
	}
	return found.sort((a, b) => a.name.localeCompare(b.name))
}

export function suite(name: string): Suite {
	const s = suites().find((s) => s.name === name)
	if (!s) throw new Error(`no suite ${name}`)
	return s
}

// the suite's TypeScript harness. reading allowed: an npm package may read its own files as it
// loads (Subduction its wasm); the rest its suite.json allows
export function reference(name: string): string[] {
	const s = suite(name)
	return ["deno", "run", "--quiet", "--allow-read", ...(s.options.allow ?? []), s.typescript]
}

// the harness to ask: HARNESS, else the suite's TypeScript one
export function command(name: string): string[] {
	const given = Deno.env.get("HARNESS")
	return given ? given.split(" ") : reference(name)
}

// a sanitizer's report: undefined behaviour goes on after it (exit 0), so it is looked for
const sanitized = /runtime error:|Sanitizer/

// the requests, one per line (a string is sent as it is), and the answers, in order. the harness
// failing (exiting with other than 0: a crash, a sanitizer, leaks.sh finding a leak) or a sanitizer
// reporting is an error, its stderr in it, even after the last answer; otherwise stderr is passed on
export async function ask(cmd: string[], requests: (Request | string)[]): Promise<Answer[]> {
	const child = new Deno.Command(cmd[0], {
		args: cmd.slice(1),
		stdin: "piped",
		stdout: "piped",
		stderr: "piped",
	}).spawn()
	// the answers are read while the requests are written: a big run fills the pipe both ways
	const done = child.output()
	const w = child.stdin.getWriter()
	const text = requests.map((r) => typeof r === "string" ? r : line(r)).join("\n") + "\n"
	// a harness that dies early closes its stdin: its exit says why
	try {
		await w.write(new TextEncoder().encode(text))
		await w.close()
	} catch { /* told below */ }
	const { stdout, stderr, code } = await done
	const err = new TextDecoder().decode(stderr)
	if (code !== 0 || sanitized.test(err)) {
		throw new Error(`${cmd.join(" ")}: exited ${code}${err ? `\n${err}` : ""}`)
	}
	if (err) await Deno.stderr.write(stderr)
	const lines = new TextDecoder().decode(stdout).trim().split("\n").filter((l) => l !== "")
	return lines.map((l) => JSON.parse(l))
}
