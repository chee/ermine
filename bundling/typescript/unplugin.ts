// Ermine's build plugin for Vite, Rollup, esbuild, webpack and Rspack (via unplugin).
// It rewrites each call to an @ermine/system function so the call carries its source location
// as a site token, and leaves @ermine/* external so there is only one copy at run time.
//
//   import ermine from "@ermine/bundling"
//   esbuild.build({ plugins: [ermine.esbuild()], … })     // vite: plugins: [ermine.vite()]
//
// Options (all optional): `sites: false` skips the rewrite, `external: false` bundles @ermine/*
// in, and `file` maps a module id to the file name its sites report.
//
// A module that names the site module, the runtime entry or a plugin local (`__ermine$…`) is
// refused, so a program cannot give its writes a site that is not its own. Vite's dev server
// does not invalidate a site module when its source is edited, so sites are stale until reload.
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

const VIRTUAL = "\0"

const clean = (id: string) => id.replace(/[?#].*$/, "")

function guardedFiles(): string[] {
	try {
		const entry = import.meta.resolve(SITE_ENTRY)
		if (!entry.startsWith("file:")) return []
		return [fileURLToPath(entry), fileURLToPath(new URL("./typescript/site.ts", entry))]
	} catch {
		return []
	}
}

function ownFolder(): string | undefined {
	try {
		const entry = import.meta.resolve(SITE_ENTRY)
		return entry.startsWith("file:") ? dirname(fileURLToPath(entry)) + sep : undefined
	} catch {
		return undefined
	}
}

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
	const written = new Map<string, string>()
	const modules = new Map<string, { file: string; sites: { line: number; column: number }[] }>()
	const numbers = new Map<string, number>()
	const fileOf = options.file ??
		((id: string) => isAbsolute(clean(id)) ? pathToFileURL(clean(id)).href : clean(id))

	return {
		name: "ermine",
		enforce: "pre",
		resolveId(spec, importer) {
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
