// @ermine/unplugin: ermine's build plugin, one for Vite, Rollup, esbuild, webpack and Rspack
// (unplugin). a write made outside a run has a site, the program line that made it; unbuilt, ermine
// finds it in the stack. built, two things keep it:
//   (a) @ermine/* stays in files of its own: every @ermine/ import is left external (the host's
//       copy, one, as unbuilt), and source maps are on, so a trace's first frame outside ermine's
//       files is the program's, mapped back to its source where the engine maps traces
//   (b) each call to an @ermine/system function is given its site at build time: rewritten to
//       __ermine$at(__ermine$s0, patch)(x, p), s0 a site token from a module only this plugin
//       writes (ermine:site/<n>, one per module rewritten), minted by @ermine/system/site. the call
//       then captures nothing (typescript/transform.ts; the runtime: ermine/system/typescript/site.ts)
// a module naming that module, its runtime entry (or a file of it), or one of the plugin's locals
// (__ermine$…) is refused: the build fails, naming the place.
//
//   import ermine from "@ermine/unplugin"
//   esbuild.build({ plugins: [ermine.esbuild()], … })     // vite: plugins: [ermine.vite()]
//
// options, each with a default:
//   sites      false: (a) only, nothing rewritten (refusals still checked); none: (a) and (b)
//   external   false: @ermine/* bundled in (one copy must still be all that's loaded, and a call
//              not rewritten finds its site in the trace among ermine's bundled frames, not past
//              them); none: left out, for the host to serve (deno: its import map; a page: one too)
//   file       a module's id → its sites' file; none: its path as a file: url, as a trace names it
//
// the builder's picks:
// - (a) is external, not a chunk per package: a bundled copy's files are the chunk's, not the ones
//   ermine's own-file lists name (import.meta.url-derived), and a second copy of @ermine/system
//   finds no process (registry.ts: two-copies). external keeps the one copy and its own files
// - source maps: turned on where the build left them unset (esbuild "linked", vite and rollup true,
//   webpack and rspack "source-map"); the transform's own map goes back to the bundler
// - every call to a binding imported from @ermine/system is rewritten (readers too): the runtime
//   gives a site only to its own functions (mod.ts marks them) and only writers use it, so no name
//   list lives here. a call by binding: a named import not shadowed, or a member (a.b, a["b"]) of a
//   namespace or default import not shadowed. optional calls (f?.()), new, tagged templates,
//   destructured or re-bound copies: left as they are (the trace, as before)
// - a site: the source's file as a file: url, line from 1, column from 1 where V8 places the call
//   (the callee's name; a member call's member; a computed member: just after it); no function
//   name (a trace's frame has one)
// - a site token is opaque (its place held by the runtime), never a location a holder could edit;
//   each token holds the one wrapper its call site needs, made once (no allocation a call)
// - the runtime: go (system.ts) takes the site first thing, for every function, so nothing the
//   function runs (peep's f, a nested call) gets it; enter (ermine.ts) holds it beside its entry,
//   entered (a box handle's place, unplace) clears it. a write's header with one: that site,
//   nothing captured, no trace text; createErmine({ trace: "always" }): the trace text kept too.
//   a computer made in the call (createMemo, createEffect) takes it too (@ermine/sites' given),
//   so its runs' writes have it. a removal places makes (core/places, table.del) still captures
// - one site module per module rewritten, numbered in the order the build reaches them
// - built and run here with esbuild only; Vite, Rollup, webpack and Rspack go through the same
//   hooks, untried. Vite's dev server: a module edited is given new sites, its site module is not
//   invalidated (a stale site till reload)
// - the import goes ahead of line 1 (after a #! line and directives): source lines stay put
// - a module that fails to parse, when it may name any of these: the build fails
// - refused at two points: the transform reads the source (every literal specifier, import,
//   export, import(), require, import x = require; every identifier for the prefix), and
//   resolveId refuses ermine:site/… unless it is the one written into that importer, and the
//   runtime entry unless asked by an ermine:site module
//
// what a program can't do, built: name the mint, the runtime entry, the site module, or a token
// (none of them can be written in its source, and it is never handed one: a token goes from the
// site module straight into at, the wrapper straight into the call); so it can't give its writes a
// site not its own. what a build can't see: code that reaches a module by a url made at run time
// (import() of a computed string, eval), as it can already override Error.prepareStackTrace and
// give the trace a site; and a program run unbuilt, which the plugin never saw
import { createUnplugin, type UnpluginInstance } from "unplugin"
import { dirname, isAbsolute, resolve as resolvePath, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
	mayNeed,
	Refused,
	refusedSpecifier,
	SITE_ENTRY,
	SITE_MODULE,
	transform,
} from "./transform.ts"

export type Options = {
	sites?: false
	external?: false
	file?: (id: string) => string
}

// the resolved id of a site module (rollup's convention for a module with no file)
const VIRTUAL = "\0"

const clean = (id: string) => id.replace(/[?#].*$/, "")

// the runtime's site files, as paths: the entry and what it re-exports. not found from here: none
function guardedFiles(): string[] {
	try {
		const entry = import.meta.resolve(SITE_ENTRY)
		if (!entry.startsWith("file:")) return []
		return [fileURLToPath(entry), fileURLToPath(new URL("./typescript/site.ts", entry))]
	} catch {
		return []
	}
}

// @ermine/system's own folder, as a path prefix (the site entry's folder): never transformed or
// refused, with external false or not. not found from here: none
function ownFolder(): string | undefined {
	try {
		const entry = import.meta.resolve(SITE_ENTRY)
		return entry.startsWith("file:") ? dirname(fileURLToPath(entry)) + sep : undefined
	} catch {
		return undefined
	}
}

// specifier's file from importer, if it names one by path
function fileFrom(importer: string | undefined) {
	return (spec: string): string | undefined => {
		if (spec.startsWith("file:")) return fileURLToPath(clean(spec))
		if (isAbsolute(spec)) return clean(spec)
		if (importer === undefined || !isAbsolute(clean(importer))) return undefined
		if (spec.startsWith("./") || spec.startsWith("../")) {
			return resolvePath(dirname(clean(importer)), clean(spec))
		}
		return undefined
	}
}

const isSiteModule = (id: string | undefined) =>
	id !== undefined && (id.startsWith(VIRTUAL + SITE_MODULE) || id.startsWith(SITE_MODULE))

export const unplugin: UnpluginInstance<Options | undefined, false> = createUnplugin((
	options: Options | undefined = {},
) => {
	const guarded = guardedFiles()
	const folder = ownFolder()
	const isOwn = (id: string | undefined) => {
		if (id === undefined || folder === undefined) return false
		const at = clean(id)
		return isAbsolute(at) && at.startsWith(folder)
	}
	const external = options.external !== false
	// each module rewritten: the site module written into it; and each site module's sites
	const written = new Map<string, string>()
	const modules = new Map<string, { file: string; sites: { line: number; column: number }[] }>()
	const numbers = new Map<string, number>()
	const fileOf = options.file ??
		((id: string) => isAbsolute(clean(id)) ? pathToFileURL(clean(id)).href : clean(id))

	return {
		name: "ermine",
		enforce: "pre",
		resolveId(spec, importer) {
			// @ermine/system's own files import what they guard: not refused
			if (isOwn(importer)) {
				return external && spec.startsWith("@ermine/") ? { id: spec, external: true } : null
			}
			if (spec.includes(SITE_MODULE)) {
				if (importer === undefined || written.get(clean(importer)) !== spec) {
					throw new Refused(
						importer ?? "(entry)",
						undefined,
						undefined,
						`imports ${JSON.stringify(spec)}`,
					)
				}
				return VIRTUAL + spec
			}
			if (refusedSpecifier(spec, guarded, fileFrom(importer))) {
				if (!isSiteModule(importer)) {
					throw new Refused(
						importer ?? "(entry)",
						undefined,
						undefined,
						`imports ${JSON.stringify(spec)}`,
					)
				}
				return external ? { id: spec, external: true } : null
			}
			if (external && spec.startsWith("@ermine/")) return { id: spec, external: true }
			return null
		},
		loadInclude: (id) => id.startsWith(VIRTUAL + SITE_MODULE),
		load(id) {
			if (!id.startsWith(VIRTUAL + SITE_MODULE)) return null
			const m = modules.get(id.slice(VIRTUAL.length))
			if (m === undefined) return null
			const file = JSON.stringify(m.file)
			return [
				`import { at, site } from ${JSON.stringify(SITE_ENTRY)}`,
				`export { at }`,
				...m.sites.map((s, i) => `export const s${i} = site(${file}, ${s.line}, ${s.column})`),
				"",
			].join("\n")
		},
		transformInclude: (id) =>
			!isSiteModule(id) && !isOwn(id) && /\.[cm]?[jt]sx?$/.test(clean(id)),
		transform(code, id) {
			if (!mayNeed(code)) return null
			const key = clean(id)
			const n = numbers.get(key) ?? numbers.size
			numbers.set(key, n)
			const module = `${SITE_MODULE}/${n}`
			const out = transform(code, id, {
				module,
				sites: options.sites !== false,
				guarded,
				resolve: fileFrom(id),
			})
			if (out === undefined) {
				written.delete(key)
				return null
			}
			written.set(key, module)
			modules.set(module, { file: fileOf(id), sites: out.sites })
			return { code: out.code, map: out.map }
		},
		esbuild: {
			config(o) {
				o.sourcemap ??= "linked"
			},
		},
		vite: {
			config(c) {
				if (c.build?.sourcemap === undefined) return { build: { sourcemap: true } }
			},
		},
		rollup: {
			outputOptions(o: { sourcemap?: unknown }) {
				return o.sourcemap === undefined ? { ...o, sourcemap: true } : o
			},
		},
		webpack(compiler) {
			compiler.options.devtool ??= "source-map"
		},
		rspack(compiler) {
			compiler.options.devtool ??= "source-map"
		},
	}
})

export default unplugin
export const esbuildPlugin = unplugin.esbuild
export const vitePlugin = unplugin.vite
export const rollupPlugin = unplugin.rollup
export const webpackPlugin = unplugin.webpack
export const rspackPlugin = unplugin.rspack
export { Refused } from "./transform.ts"
