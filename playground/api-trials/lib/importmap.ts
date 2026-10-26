// "ermine", importable: design L's programs import their words from it (designs/l/ermine.ts).
// deno's --import-map takes the place of the config's imports, so the map is the repo's
// deno.json imports with "ermine" added; the workspace's own packages resolve as before. run.ts
// and lib/whole.ts run under it: started without it, they start themselves again with it
const ROOT = new URL("../../../deno.json", import.meta.url)
export const ERMINE = new URL("../designs/l/ermine.ts", import.meta.url).href

// "ermine" resolves here
export function mapped(): boolean {
	try {
		return import.meta.resolve("ermine") === ERMINE
	} catch {
		return false
	}
}

let file: string | undefined

// the map's file (a temp file, made once per deno)
export async function importMap(): Promise<string> {
	if (file !== undefined) return file
	const root = JSON.parse(await Deno.readTextFile(ROOT)) as { imports?: Record<string, string> }
	const imports: Record<string, string> = {}
	// a relative entry is the root's: an import map's are against the map's own url
	for (const [k, v] of Object.entries(root.imports ?? {})) {
		imports[k] = /^\.\.?\//.test(v) ? new URL(v, ROOT).href : v
	}
	imports.ermine = ERMINE
	file = await Deno.makeTempFile({ prefix: "api-trials-", suffix: ".json" })
	await Deno.writeTextFile(file, JSON.stringify({ imports }))
	return file
}

export async function dropMap() {
	if (file !== undefined) await Deno.remove(file).catch(() => {})
	file = undefined
}

// script again under the map, with args, its output passed through; exits with its code
export async function again(script: string | URL, args: string[]): Promise<never> {
	const map = await importMap()
	const path = typeof script === "string" ? script : script.pathname
	const child = new Deno.Command(Deno.execPath(), {
		args: ["run", "-A", "--quiet", "--import-map", map, path, ...args],
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	}).spawn()
	const { code } = await child.status
	await dropMap()
	Deno.exit(code)
}
