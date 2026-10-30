// Finds a suite and runs a harness on requests; set HARNESS to test another implementation (such as C).
// deno-lint-ignore-file no-explicit-any
import { line } from "./form.ts"
import { read } from "./json.ts"
import type { Answer, Request } from "./harness.ts"

const root = new URL("../../", import.meta.url).pathname

export type Suite = {
	name: string
	package: string
	fixtures: string
	typescript: string
	binary: string
	options: Options
}
export type Options = {
	harness?: string
	loose?: boolean
	unordered?: string[]
	now?: boolean
	undoes?: boolean
	again?: { name: string; has?: string; op?: string; set: Record<string, unknown> }
	typescript?: boolean
	allow?: string[]
	reads?: Record<string, unknown>[]
	noLinkAttrs?: string[]
	make?: string[]
}

export function suites(): Suite[] {
	const found: Suite[] = []
	const packages: string[] = []
	const has = (path: string) => {
		try {
			return Deno.statSync(`${root}${path}/conformance`).isDirectory
		} catch {
			return false
		}
	}
	const workspace: string[] = JSON.parse(Deno.readTextFileSync(`${root}deno.json`)).workspace
	for (const w of workspace) {
		const p = w.replace(/^\.\//, "")
		if (has(p)) packages.push(p)
		for (const q of Deno.readDirSync(`${root}${p}`)) {
			if (q.isDirectory && has(`${p}/${q.name}`)) packages.push(`${p}/${q.name}`)
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
				binary: claimed.c?.[d.name] ?? `${pkg}/c/${shared}-harness`,
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

export function reference(name: string): string[] {
	const s = suite(name)
	return ["deno", "run", "--quiet", "--allow-read", ...(s.options.allow ?? []), s.typescript]
}

export function command(name: string): string[] {
	const given = Deno.env.get("HARNESS")
	return given ? given.split(" ") : reference(name)
}

// Sanitizers keep running after a report (exit 0), so their stderr is searched for one.
const sanitized = /runtime error:|Sanitizer/

export async function ask(cmd: string[], requests: (Request | string)[]): Promise<Answer[]> {
	const child = new Deno.Command(cmd[0], {
		args: cmd.slice(1),
		stdin: "piped",
		stdout: "piped",
		stderr: "piped",
	}).spawn()
	// Answers are read while requests are written, because a big run fills the pipe both ways.
	const done = child.output()
	const w = child.stdin.getWriter()
	const text =
		requests.map((r) => typeof r === "string" ? r : line(r, undefined, true)).join("\n") +
		"\n"
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
	return lines.map((l) => read(l) as Answer)
}
