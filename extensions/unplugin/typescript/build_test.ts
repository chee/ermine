// a tiny program built with esbuild and the plugin, then run against a real createErmine: its
// writes' site is the program's own file:line, (a) found in the trace through the source map, (b)
// written in at build; a program naming the site module, its entry or a file of it is refused
import { assert, assertEquals, assertRejects } from "@std/assert"
import * as esbuild from "esbuild"
import { join } from "node:path"
import { fileURLToPath as fromFileUrl, pathToFileURL } from "node:url"
import { createErmine, type Feature, read } from "@ermine/system"
import { trace, traceAlways } from "@ermine/system/trace"
import { traceOf } from "@ermine/core/places/header"
import type { ChangeHeader } from "@ermine/core/node/entry"
import ermine, { type Options } from "./unplugin.ts"
import { manual } from "../../../ermine/system/typescript/manual_fixture.ts"

const toFileUrl = (p: string) => pathToFileURL(p)
const here = fromFileUrl(new URL(".", import.meta.url))

// the program: two writes outside a run, on lines 5 and 6
const PROGRAM = `import { ensureNode, patch } from "@ermine/system"
import * as system from "@ermine/system"

export default function setup() {
	ensureNode("/x", 1)
	system.patch("/x", [{ path: [], value: patch === system.patch ? 2 : 0 }])
	ensureNode("/y", 1)
}
`

async function built(dir: string, source: string, options?: Options): Promise<string> {
	const src = join(dir, "program.ts")
	await Deno.writeTextFile(src, source)
	const out = join(dir, "out", "program.js")
	await esbuild.build({
		entryPoints: [src],
		bundle: true,
		format: "esm",
		platform: "neutral",
		outfile: out,
		logLevel: "silent",
		plugins: [ermine.esbuild(options)],
	})
	return out
}

async function inDir<T>(f: (dir: string) => Promise<T>): Promise<T> {
	const dir = await Deno.makeTempDir({ dir: here, prefix: ".build-" })
	try {
		return await f(dir)
	} finally {
		await Deno.remove(dir, { recursive: true })
	}
}

type E = ReturnType<typeof createErmine>
const changeAt = (e: E, name: string): ChangeHeader => {
	const kids = e.table.get("children", e.places.root as string)?.value as Record<string, string>
	return e.table.get("value", kids[name])!.change as ChangeHeader
}

async function run(out: string, features: Feature[] = []) {
	const program = (await import(toFileUrl(out).href)).default as () => unknown
	const e = createErmine({ features: [manual, ...features] })
	e.start(program, "/work/p")
	return e
}

Deno.test("build: (b) each write's site is written in at build: the program's file:line, nothing captured", async () => {
	await inDir(async (dir) => {
		const out = await built(dir, PROGRAM)
		const code = await Deno.readTextFile(out)
		assert(code.includes(`from "@ermine/system"`), "@ermine/system left external")
		assert(code.includes(`from "@ermine/system/site"`))
		const file = toFileUrl(join(dir, "program.ts")).href
		const e = await run(out)
		const x = changeAt(e, "x")
		assertEquals(x.external, [{ file, line: 6, column: 9 }])
		assertEquals(changeAt(e, "y").external, [{ file, line: 7, column: 2 }])
		assertEquals(traceOf(x), undefined, "no trace text: nothing captured")
		assertEquals(e.within(() => read("/x")), 2)
		e.close()
		// traceAlways: the text captured too, the site still the build's
		const always = await run(out, [traceAlways])
		assertEquals(changeAt(always, "y").external, [{ file, line: 7, column: 2 }])
		assert(traceOf(changeAt(always, "y"))?.includes("setup"))
		always.close()
	})
})

Deno.test("build: (a) nothing rewritten: the trace finds the program's line, ermine in files of its own", async () => {
	await inDir(async (dir) => {
		const out = await built(dir, PROGRAM, { sites: false })
		const code = await Deno.readTextFile(out)
		assert(!code.includes("ermine:site") && !code.includes("@ermine/system/site"))
		assert(code.includes("sourceMappingURL=program.js.map"), "source maps on")
		const file = toFileUrl(join(dir, "program.ts")).href
		const e = await run(out, [trace])
		const [x] = changeAt(e, "x").external!
		const [y] = changeAt(e, "y").external!
		assertEquals([x.file, x.line], [file, 6])
		assertEquals([y.file, y.line], [file, 7])
		assert(traceOf(changeAt(e, "y")) !== undefined, "captured: the trace text beside it")
		e.close()
	})
})

Deno.test("build: a program naming the site module, its entry, a file of it or a plugin local is refused", async () => {
	const forged = [
		`import { s0 } from "ermine:site/0"\nexport default () => s0`,
		`import { site } from "@ermine/system/site"\nexport default () => site("x", 1, 1)`,
		`export default () => import("ermine:site")`,
		`export { at } from "@ermine/system/site"`,
		`import { patch } from "@ermine/system"\nexport default () => __ermine$at(__ermine$s0, patch)`,
	]
	for (const source of forged) {
		await inDir(async (dir) => {
			await assertRejects(() => built(dir, source), Error, "only @ermine/unplugin writes it")
		})
	}
	// by path: ermine's own file, relative
	await inDir(async (dir) => {
		const rel = "../../../../ermine/system/site.ts"
		const source = `import { site } from ${JSON.stringify(rel)}\nexport default site`
		await assertRejects(() => built(dir, source), Error, "only @ermine/unplugin writes it")
	})
})

Deno.test("build: teardown", async () => {
	await esbuild.stop()
})

Deno.test("build: external false: @ermine/system's own files are neither transformed nor refused", async () => {
	const plugin = ermine.raw({ external: false }, { framework: "rollup" }) as unknown as {
		resolveId: (spec: string, importer?: string) => unknown
		transformInclude: (id: string) => boolean
	}
	const system = fromFileUrl(new URL("../../../ermine/system/", import.meta.url))
	for (const f of ["mod.ts", "typescript/system.ts", "site.ts"]) {
		const id = join(system, f)
		assertEquals(plugin.transformInclude(id), false, `${f} is not transformed`)
		const text = await Deno.readTextFile(id)
		for (const [, spec] of text.matchAll(/from "(\.[^"]*site[^"]*)"/g)) {
			assertEquals(plugin.resolveId(spec, id), null, `${f} imports ${spec}`)
		}
	}
	// a program's file, as ever
	assertEquals(plugin.transformInclude(join(here, "program.ts")), true)
})
