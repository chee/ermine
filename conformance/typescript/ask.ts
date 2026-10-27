// the side that asks: a suite's place in the repo, the harness to run it against, and a harness
// run on a list of requests. HARNESS (a command, split at spaces) names another implementation
// than the TypeScript one, such as a C binary
// deno-lint-ignore-file no-explicit-any
import { line } from "./form.ts"
import { read } from "./json.ts"
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
	// "now" in an expect: a whole number of seconds since 1970, as of the run
	now?: boolean
	// invert's answers are checked as undoing, not compared to expect (conformance/run.ts)
	undoes?: boolean
	// the scenarios run again, a request that has the field (or this op) given more fields
	again?: { name: string; has?: string; op?: string; set: Record<string, unknown> }
	// the suite runs only against the TypeScript harness: --c, --check and --leaks skip it (a loader
	// importing JavaScript or instantiating wasm, which C has no way to)
	typescript?: boolean
	// what the TypeScript harness is allowed beyond reading: deno's flags (native: --allow-ffi, ...)
	allow?: string[]
	// requests that change nothing, asked around every refused step: the same before and after
	// (conformance/run.ts)
	reads?: Record<string, unknown>[]
	// what make builds before the suite runs, from the repository's root (native: its fixtures)
	make?: string[]
}

// every suite there is: a folder in <package>/conformance/ with an adapter in <package>/typescript/
export function suites(): Suite[] {
	const found: Suite[] = []
	// a package is a folder of a group with conformance/ in it, and any one folder further down
	// (playground/tools/files, playground/together/presence)
	const packages: string[] = []
	const has = (path: string) => {
		try {
			return Deno.statSync(`${root}${path}/conformance`).isDirectory
		} catch {
			return false
		}
	}
	for (
		const group of ["core", "ermine", "extensions", "playground", "experiments"]
	) {
		for (const p of Deno.readDirSync(`${root}${group}`)) {
			if (!p.isDirectory) continue
			if (has(`${group}/${p.name}`)) packages.push(`${group}/${p.name}`)
			for (const q of Deno.readDirSync(`${root}${group}/${p.name}`)) {
				if (q.isDirectory && has(`${group}/${p.name}/${q.name}`)) {
					packages.push(`${group}/${p.name}/${q.name}`)
				}
			}
		}
	}
	const claimed: Record<string, Record<string, string>> = JSON.parse(
		Deno.readTextFileSync(`${root}conformance/implementations.json`),
	)
	for (const path of packages) {
		const dir = `${root}${path}/conformance`
		let names: Deno.DirEntry[]
		try {
			names = [...Deno.readDirSync(dir)].filter((d) => d.isDirectory)
		} catch {
			continue
		}
		for (const d of names) {
			const fixtures = `${dir}/${d.name}/`
			let options: Options = {}
			const file = `${fixtures}suite.json`
			let text: string | undefined
			try {
				text = Deno.readTextFileSync(file)
			} catch (e) {
				if (!(e instanceof Deno.errors.NotFound)) throw e
			}
			// no suite.json is no options; a broken one is an error
			if (text !== undefined) {
				try {
					options = JSON.parse(text)
				} catch (e) {
					throw new Error(`${file}: ${e}`)
				}
			}
			const pkg = `${root}${path}`
			const shared = options.harness ?? d.name
			const typescript = `${pkg}/typescript/${shared}_harness.ts`
			try {
				Deno.statSync(typescript)
			} catch {
				// a suite implementations.json gives a TypeScript harness must have it; others have none yet
				if (claimed.typescript?.[d.name] !== undefined) {
					throw new Error(`suite ${d.name}: no TypeScript harness at ${typescript}`)
				}
				continue
			}
			found.push({
				name: d.name,
				package: path,
				fixtures,
				typescript,
				binary: `${pkg}/c/${shared}-harness`,
				options,
			})
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
	// as the scenario has them: -0 too, for the harness to read
	const text =
		requests.map((r) => typeof r === "string" ? r : line(r, undefined, true)).join("\n") +
		"\n"
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
	// every key in its order (json.ts)
	return lines.map((l) => read(l) as Answer)
}
