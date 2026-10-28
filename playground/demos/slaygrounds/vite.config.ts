// deno task serve (vite's dev server), deno task build (into dist/), deno task preview (dist/ served)
// the page, plus what the world's iframe imports by its import map: each export of each workspace
// package (@ermine/core/table, @ermine/core/places/path, …, @ermine/render for the views). served
// from source while developing, each its own module in dist/ when built
// - /importmap.json: specifier → url, the same urls vite gives these files inside its own
//   imports, so a host, a program and the libraries share one instance of each module
// - /types.json: the sources each specifier reaches, for the language server's type hints
// - /compile: C to wasm on this machine (compile.ts), in dev and preview only
import { defineConfig, type Plugin, type ViteDevServer } from "vite"
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import process from "node:process"
import { compile } from "./compile.ts"

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, "../../..")
const port = Number(process.env.PORT ?? 8051)

// ---- the modules: specifiers, their source files, their names in dist/ ----
type Entry = { specifiers: string[]; file: string; out: string }
const entries: Entry[] = []
const root = JSON.parse(readFileSync(join(repo, "deno.json"), "utf8")) as {
	workspace: string[]
	imports?: Record<string, string>
}
for (const member of root.workspace) {
	// workspace members that no longer exist are skipped
	const config = join(repo, member, "deno.json")
	if (!existsSync(config)) continue
	const { name, exports } = JSON.parse(readFileSync(config, "utf8")) as {
		name?: string
		exports?: Record<string, string>
	}
	if (!name || !exports) continue
	const pkg = name.split("/").pop()!
	for (const [key, source] of Object.entries(exports)) {
		entries.push({
			specifiers: [key === "." ? name : `${name}/${key.slice(2)}`],
			file: join(repo, member, source),
			out: `ermine/${pkg}/${key === "." ? pkg : key.slice(2)}`,
		})
	}
}
// @jsxImportSource @ermine: @ermine/jsx-runtime, which is the dev runtime too (a program's jsx is
// made for development: sucrase imports @ermine/jsx-dev-runtime)
entries.find((e) => e.specifiers.includes("@ermine/jsx-runtime"))?.specifiers.push(
	"@ermine/jsx-dev-runtime",
)
// ermine-h, the older view library: the sync world's examples draw with it (that world is not on
// @ermine/system); its jsx runtimes are the same module
entries.push({
	specifiers: ["ermine-h", "ermine-h/jsx-runtime", "ermine-h/jsx-dev-runtime"],
	file: join(here, "src/h/h.ts"),
	out: "h/h",
})
const bySpecifier = new Map(entries.flatMap((e) => e.specifiers.map((s) => [s, e])))
// an example's own codemirror (examples/<name>/cm.ts), imported by its host as cm.js
const cms = readdirSync(join(here, "examples"))
	.filter((name) => existsSync(join(here, "examples", name, "cm.ts")))

// ---- what the libraries import from outside: the workspace's deno.json, then npm or jsr ----
function mapped(specifier: string) {
	const imports = root.imports ?? {}
	if (imports[specifier]) return imports[specifier]
	const prefix = Object.keys(imports)
		.filter((k) => k.endsWith("/") && specifier.startsWith(k))
		.sort((a, b) => b.length - a.length)[0]
	return prefix ? imports[prefix] + specifier.slice(prefix.length) : specifier
}
// npm:@scope/name@1.2/sub → @scope/name/sub (from this folder's node_modules)
const npm = /^npm:\/?(@[^/]+\/[^@/]+|[^@/]+)(?:@[^/]*)?(\/.*)?$/
// jsr: deno's own cache, found by `deno info`. a module's id is jsr:/<its path on jsr.io>
const jsr = new Map<string, { local: string; deps: Record<string, string> }>()
const jsrRoots = new Map<string, string>()
function fromJsr(specifier: string) {
	if (jsrRoots.has(specifier)) return jsrRoots.get(specifier)
	const info = JSON.parse(
		execFileSync(process.execPath, ["info", "--json", specifier], {
			cwd: repo,
			encoding: "utf8",
		}),
	) as {
		redirects: Record<string, string>
		modules: {
			specifier: string
			local?: string
			dependencies?: { specifier: string; code?: { specifier: string } }[]
		}[]
	}
	const id = (s: string) => "jsr:" + (info.redirects[s] ?? s).slice("https://jsr.io".length)
	for (const m of info.modules) {
		if (!m.local || !m.specifier.startsWith("https://jsr.io/")) continue
		const deps = (m.dependencies ?? []).filter((d) => d.code)
		jsr.set(id(m.specifier), {
			local: m.local,
			deps: Object.fromEntries(deps.map((d) => [d.specifier, id(d.code!.specifier)])),
		})
	}
	jsrRoots.set(specifier, id(specifier))
	return id(specifier)
}

// ---- the sources each module reaches by relative imports, and the packages it imports ----
// a regex, not a parser: a match in a comment that is not a file is dropped
const imported = /\bfrom\s*["']([^"']+)["']|\bimport\s*\(?\s*["']([^"']+)["']/g
function reach() {
	const files: Record<string, string> = {}
	const paths: Record<string, string[]> = {}
	const packages = new Set<string>()
	const at = (file: string) => "/types/" + relative(repo, file)
	const walk = (file: string) => {
		if (at(file) in files || !existsSync(file)) return
		const text = readFileSync(file, "utf8")
		files[at(file)] = text
		for (const m of text.matchAll(imported)) {
			const specifier = m[1] ?? m[2]
			if (specifier.startsWith(".")) walk(resolve(dirname(file), specifier))
			else if (!bySpecifier.has(specifier) && /^(npm:)?[@\w]/.test(specifier)) {
				const bare = mapped(specifier).replace(npm, "$1$2")
				if (!bare.includes(":")) packages.add(bare)
			}
		}
	}
	for (const e of entries) {
		walk(e.file)
		for (const s of e.specifiers) paths[s] = [at(e.file)]
	}
	return { files, paths, packages }
}

const send = (res: import("node:http").ServerResponse, type: string, body: string | Buffer) => {
	res.writeHead(200, { "content-type": type, "cache-control": "no-cache" })
	res.end(body)
}

// the url vite writes for a file in its imports: /src/… inside this folder, /@fs/… outside, with
// ?t= once the file was edited while serving (a library edit reloads the page, which asks again)
function devUrl(server: ViteDevServer, file: string) {
	const url = file.startsWith(here + "/") ? file.slice(here.length) : "/@fs" + file
	const t = server.environments.client.moduleGraph.getModuleById(file)?.lastHMRTimestamp
	return t ? `${url}?t=${t}` : url
}

function ermine(): Plugin {
	const reached = reach()
	return {
		name: "ermine",
		enforce: "pre",
		config: () => ({
			// the libraries' npm packages, bundled for the dev server up front: one found later
			// reloads the page. but Subduction: it finds its wasm by new URL(.., import.meta.url),
			// so it is served from its own package, unbundled
			optimizeDeps: {
				include: [...reached.packages].filter((p) =>
					!p.startsWith("@automerge/subduction") &&
					existsSync(
						join(here, "node_modules", p.split("/").slice(0, p[0] === "@" ? 2 : 1).join("/")),
					)
				),
				exclude: ["@automerge/subduction"],
			},
			build: {
				rolldownOptions: {
					input: {
						index: join(here, "index.html"),
						...Object.fromEntries(entries.map((e) => [e.out, e.file])),
						...Object.fromEntries(
							cms.map((
								name,
							) => [`examples/${name}/cm`, join(here, "examples", name, "cm.ts")]),
						),
					},
				},
			},
		}),
		// @ermine/* to its source; the libraries' own imports through the workspace's deno.json:
		// npm: and bare ones from this folder's node_modules, jsr: from deno's cache
		async resolveId(source, importer) {
			const entry = bySpecifier.get(source)
			if (entry) return entry.file
			if (importer?.startsWith("jsr:")) return jsr.get(importer)?.deps[source]
			const outside = importer && !importer.startsWith(here + "/") && !importer.startsWith("\0")
			const specifier = outside && /^[@\w]/.test(source) ? mapped(source) : source
			if (specifier.startsWith("jsr:")) return fromJsr(specifier)
			if (specifier.startsWith("npm:") || (outside && /^[@\w][^:]*$/.test(specifier))) {
				return await this.resolve(specifier.replace(npm, "$1$2"), join(here, "index.html"), {
					skipSelf: true,
				})
			}
		},
		load(id) {
			const module = jsr.get(id)
			if (module) return readFileSync(module.local, "utf8")
		},
		configureServer(server) {
			server.middlewares.use(async (req, res, next) => {
				const path = decodeURIComponent(new URL(req.url!, "http://x").pathname)
				if (path === "/compile") return await compile(req, res)
				if (path === "/importmap.json") {
					const imports = Object.fromEntries(
						entries.flatMap((e) => e.specifiers.map((s) => [s, devUrl(server, e.file)])),
					)
					return send(res, "application/json", JSON.stringify({ imports }))
				}
				if (path === "/types.json") {
					const { files, paths } = reach()
					return send(res, "application/json", JSON.stringify({ files, paths }))
				}
				// an example's cm.js is its cm.ts, made by vite
				const cm = /^\/examples\/([\w-]+)\/cm\.js$/.exec(path)
				if (cm) {
					req.url = `/examples/${cm[1]}/cm.ts`
					return next()
				}
				// the examples' host.ts and program.ts are text for the editor, not modules
				const file = resolve(here, "." + path)
				if (
					file.startsWith(join(here, "examples") + "/") && file.endsWith(".ts") &&
					existsSync(file)
				) {
					return send(res, "text/plain; charset=utf-8", readFileSync(file))
				}
				next()
			})
		},
		configurePreviewServer(server) {
			server.middlewares.use(async (req, res, next) => {
				if (new URL(req.url!, "http://x").pathname === "/compile") {
					return await compile(req, res)
				}
				next()
			})
		},
		// built: each module under its own name, the import map and type sources beside them, and
		// the examples copied as they are
		generateBundle(_, bundle) {
			const imports: Record<string, string> = {}
			for (const chunk of Object.values(bundle)) {
				if (chunk.type !== "chunk" || !chunk.isEntry) continue
				const entry = entries.find((e) => e.out === chunk.name)
				for (const s of entry?.specifiers ?? []) imports[s] = chunk.fileName
			}
			this.emitFile({
				type: "asset",
				fileName: "importmap.json",
				source: JSON.stringify({ imports }, null, "\t") + "\n",
			})
			const { files, paths } = reach()
			this.emitFile({
				type: "asset",
				fileName: "types.json",
				source: JSON.stringify({ files, paths }),
			})
			const copy = (dir: string) => {
				for (const e of readdirSync(join(here, dir), { withFileTypes: true })) {
					const path = `${dir}/${e.name}`
					if (e.isDirectory()) copy(path)
					else if (!/^(cm\.[jt]s|\.DS_Store)$/.test(e.name)) {
						this.emitFile({
							type: "asset",
							fileName: path,
							source: readFileSync(join(here, path)),
						})
					}
				}
			}
			copy("examples")
		},
	}
}

export default defineConfig({
	base: "./",
	appType: "mpa",
	clearScreen: false,
	plugins: [ermine()],
	// packages' production builds while serving too, as when built: solid's development build
	// throws on writes the page makes inside its roots
	resolve: { conditions: ["module", "browser", "production"] },
	server: { port, strictPort: true, fs: { allow: [repo] } },
	preview: { port, strictPort: true },
	// workers (the realms worker): only ermine()'s resolving; its generateBundle would write the
	// import map again, empty, over the page's
	worker: {
		format: "es",
		plugins: () => {
			const { resolveId, load } = ermine()
			return [{ name: "ermine:worker", enforce: "pre", resolveId, load }]
		},
	},
	build: {
		target: "esnext",
		// readable, with each function's own name (stack traces, the inspector)
		minify: false,
		reportCompressedSize: false,
		chunkSizeWarningLimit: 100_000,
		rolldownOptions: {
			// a module keeps its exports though another module imports it too
			preserveEntrySignatures: "allow-extension",
			output: {
				keepNames: true,
				// the modules the import map names, at their own paths; the rest hashed
				entryFileNames: (chunk) =>
					chunk.name.includes("/") ? "[name].js" : "assets/[name]-[hash].js",
			},
		},
	},
})
