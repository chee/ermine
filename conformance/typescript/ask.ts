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
	// "now" in an expect: a whole number of seconds since 1970, as of the run
	now?: boolean
	// the scenarios run again, a request that has the field (or this op) given more fields
	again?: { name: string; has?: string; op?: string; set: Record<string, unknown> }
}

// every suite there is: a folder in <package>/conformance/ with an adapter in <package>/typescript/
export function suites(): Suite[] {
	const found: Suite[] = []
	for (const group of ["core", "filesystem", "ermine"]) {
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

// the suite's TypeScript harness
export function reference(name: string): string[] {
	return ["deno", "run", "--quiet", suite(name).typescript]
}

// the harness to ask: HARNESS, else the suite's TypeScript one
export function command(name: string): string[] {
	const given = Deno.env.get("HARNESS")
	return given ? given.split(" ") : reference(name)
}

// the requests, one per line (a string is sent as it is), and the answers, in order
export async function ask(cmd: string[], requests: (Request | string)[]): Promise<Answer[]> {
	const child = new Deno.Command(cmd[0], {
		args: cmd.slice(1),
		stdin: "piped",
		stdout: "piped",
	}).spawn()
	// the answers are read while the requests are written: a big run fills the pipe both ways
	const done = child.output()
	const w = child.stdin.getWriter()
	const text = requests.map((r) => typeof r === "string" ? r : line(r)).join("\n") + "\n"
	await w.write(new TextEncoder().encode(text))
	await w.close()
	const { stdout } = await done
	const lines = new TextDecoder().decode(stdout).trim().split("\n").filter((l) => l !== "")
	return lines.map((l) => JSON.parse(l))
}
