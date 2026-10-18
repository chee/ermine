// deno task dev     the demos at http://localhost:8040/, each page's .ts from source as it is now
// deno task build   the same pages, static, into dist/ (Netlify), /slaygrounds/ built beside them
//
// - demos: each folder here with a demo.json is one (see Demo below): its pages are built, its card
//   listed on the index. a folder without one (not ready, not pushed) is nothing to the site
// - /: index.html; its <!-- demos --> filled with the cards, its <!-- examples --> with slaygrounds'
//   examples (slaygrounds/examples/index.json)
// - /catclock/: catclock/web/'s pages (index.html, clock.html) at /catclock/, with what they fetch:
//   canvas.js, sources.json (the C), catclock.wasm (built here by wasm-clang, web/yowasp.ts: not in
//   git). /catclock/compile is Netlify's (functions/compile.mts, netlify.toml); without it, wasm-clang
//   in the page is its compiler
// - /slaygrounds/: its own vite build (deno task build there), copied in — and in dev served here
//   from that build, so its links run on this port; SLAY_PORT set (or nothing built): its own dev
//   server (deno task serve there, :8051), sent to, for working on it live
// - /shape/: shape/index.html, a page like any (it imports slaygrounds/src/graph-file.ts)
// - pigs: a terminal program, so its card only
// imports resolve as Deno resolves them (@deno/vite-plugin): the workspace's @ermine/* libraries from
// source, npm packages from the repo's node_modules (`deno install`, the names in deno.json)
import deno from "@deno/vite-plugin"
import { existsSync } from "node:fs"
import { defineConfig, type Plugin } from "vite"
import { objectOf, SOURCES } from "./catclock/web/clang.ts"
import { build } from "./catclock/web/yowasp.ts"

const here = new URL(".", import.meta.url).pathname
const repo = new URL("../../", import.meta.url).pathname
const catclock = `${here}catclock/`
const cat = `${catclock}web/`
const slay = `${here}slaygrounds/`

const escape = (s: string) =>
	s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)

// what the slaygrounds dist is, by ending, served raw
const KIND: Record<string, string> = {
	html: "text/html",
	js: "text/javascript",
	mjs: "text/javascript",
	json: "application/json",
	css: "text/css",
	svg: "image/svg+xml",
	png: "image/png",
	jpg: "image/jpeg",
	ico: "image/x-icon",
	wasm: "application/wasm",
	txt: "text/plain",
	map: "application/json",
}

// a folder's demo.json. paths in it (picture, href) are as the index writes them, from here
//   title     the card's name
//   order     where the card goes (then by folder name); default 100
//   tags      the little chips
//   picture   an image under here, or "canvas": the cat's own loader draws on the card
//   alt       the picture's alt text (the canvas's label)
//   href      what the card and the picture open; default the folder
//   buttons   [{ label, href, go? }]; default one go button, "open", at href
//   pages     the html to build, from the folder (served under /name/); only for a demo in here,
//             one elsewhere (playground/*, core/*, ...) is a card only: [] * is any one folder; default ["index.html"]
//   listed    false: built, no card
// the index and slaygrounds are not in here: slaygrounds is built by its own task
type Demo = {
	name: string
	dir: string
	title: string
	order?: number
	tags?: string[]
	picture?: string
	alt?: string
	href?: string
	buttons?: { label: string; href: string; go?: boolean }[]
	pages?: string[]
	listed?: boolean
}

// where demo.json is looked for: these folders' children. a demo is served at /<its folder's name>/
const ROOTS = ["playground/demos", "playground", "core", "ermine", "extensions"]

function demos(): Demo[] {
	const found = new Map<string, Demo>()
	for (const root of ROOTS) {
		if (!existsSync(repo + root)) continue
		for (const e of Deno.readDirSync(repo + root)) {
			const dir = `${repo}${root}/${e.name}/`
			if (!e.isDirectory || !existsSync(`${dir}demo.json`)) continue
			if (found.has(e.name)) {
				throw new Error(`two demos named ${e.name}: ${found.get(e.name)!.dir}, ${dir}`)
			}
			found.set(e.name, {
				...JSON.parse(Deno.readTextFileSync(`${dir}demo.json`)),
				name: e.name,
				dir,
			})
		}
	}
	return [...found.values()].sort((a, b) =>
		(a.order ?? 100) - (b.order ?? 100) || (a.name < b.name ? -1 : 1)
	)
}

// a demo's pages that exist, as absolute paths
function pagesOf(demo: Demo): string[] {
	const out: string[] = []
	// vite builds only the html under its root (here): a page elsewhere is dropped, and the rest of
	// the site with it
	if (!demo.dir.startsWith(here) && demo.pages?.length !== 0) {
		throw new Error(`${demo.dir}demo.json: outside ${here}, so "pages": [] (a card only)`)
	}
	for (const pattern of demo.pages ?? ["index.html"]) {
		let paths = [demo.dir.slice(0, -1)]
		for (const part of pattern.split("/")) {
			paths = paths.flatMap((p) =>
				part !== "*"
					? [`${p}/${part}`]
					: existsSync(p)
					? [...Deno.readDirSync(p)].filter((e) => e.isDirectory).map((e) => `${p}/${e.name}`)
					: []
			)
		}
		out.push(...paths.filter(existsSync))
	}
	return out
}

const cards = () =>
	demos().filter((d) => d.listed !== false).map((d) => {
		const href = d.href ?? `${d.name}/`
		const buttons = d.buttons ?? [{ label: "open", href, go: true }]
		const alt = escape(d.alt ?? d.title)
		const picture = d.picture === "canvas"
			? `<a class="picture ${d.name}" href="${href}" tabindex="-1" aria-label="${alt}">
					<canvas width="150" height="300"></canvas>
				</a>`
			: `<a class="picture ${d.name}" href="${href}" tabindex="-1">
					<img src="${d.picture ?? "pictures/ermine.svg"}" alt="${alt}" />
				</a>`
		return `<article class="demo">
				${picture}
				<div class="text">
					<h2><a href="${href}">${escape(d.title)}</a></h2>
					<ul class="tags">
${(d.tags ?? []).map((t) => `\t\t\t\t\t\t<li>${escape(t)}</li>`).join("\n")}
					</ul>
					<div class="buttons">
${
			buttons.map((b) =>
				`\t\t\t\t\t\t<a class="button${b.go ? " go" : ""}" href="${b.href}">${
					escape(b.label)
				}</a>`
			).join("\n")
		}
					</div>
				</div>
			</article>`
	}).join("\n\n\t\t\t")

// slaygrounds' examples, as the index's list: a title that starts with its name says it once
function examples() {
	const list = JSON.parse(Deno.readTextFileSync(`${slay}examples/index.json`)) as {
		name: string
		title: string
	}[]
	return list.map(({ name, title }) =>
		`<li><a href="slaygrounds/#${escape(name)}"><b>${escape(name)}</b> ${
			escape(title.startsWith(`${name}: `) ? title.slice(name.length + 2) : title)
		}</a></li>`
	).join("\n")
}

const sources = () =>
	JSON.stringify(SOURCES.map((name) => ({ name, text: Deno.readTextFileSync(catclock + name) })))

// catclock.wasm: catclock.c and what it includes, compiled and linked by wasm-clang; once, until the
// C changes
let wasm: { key: string; bytes: Uint8Array } | undefined
async function catWasm(): Promise<Uint8Array> {
	const files = Object.fromEntries(
		SOURCES.map((name) => [name, Deno.readTextFileSync(catclock + name)]),
	)
	const key = JSON.stringify(files)
	if (wasm?.key === key) return wasm.bytes
	const object = await build({ cc: { main: "catclock.c", files } })
	if (!object.ok) throw new Error(`catclock.c: ${object.error}`)
	const linked = await build({
		ld: { objects: { [objectOf("catclock.c")]: object.bytes! }, out: "catclock.wasm" },
	})
	if (!linked.ok) throw new Error(`catclock.wasm: ${linked.error}`)
	wasm = { key, bytes: linked.bytes! }
	return wasm.bytes
}

// before the Deno plugin. npm:name@version/path as name/path, from node_modules (one version of
// each: deno.json's): the Deno plugin drops the /path. a local file the Deno plugin resolves (a
// workspace library, @ermine/*) is loaded by Vite as the file it is, not through Deno's loader, so an
// edit to it reloads like any other
const specifiers: Plugin = {
	name: "demos:specifiers",
	enforce: "pre",
	async resolveId(id, importer) {
		if (/^https?:\/\//.test(id)) return { id, external: true }
		const npm = id.match(/^npm:\/?((?:@[^/]+\/)?[^@/]+)(?:@[^/]*)?(\/.*)?$/)
		if (npm) return this.resolve(npm[1] + (npm[2] ?? ""), undefined, { skipSelf: true })
		if (/^[./\0]/.test(id) || id.includes(":") || importer?.includes("/node_modules/")) return
		const found = await this.resolve(id, importer, { skipSelf: true })
		return found?.id.match(/^\0deno::[^:]+::.*?::(\/.*)#deno$/)?.[1] ?? found
	},
}

const pages: Plugin = {
	name: "demos:pages",
	configureServer(server) {
		server.middlewares.use(async (req, res, next) => {
			const path = req.url?.split("?")[0] ?? ""
			try {
				// the slaygrounds page, from its built dist (deno task build in slaygrounds, what
				// the site copies in), so the demos links run here, no server of its own; the
				// files under it the same, read raw (an example's program.ts is fetched as text,
				// which vite would parse instead). SLAY_PORT set, or no dist yet: its own dev
				// server instead, sent to, for working on it live (deno task serve there, :8051).
				// a path not in the dist goes on to vite: the sources, a module under it (shape's
				// import of src/graph-file.ts)
				if (path === "/slaygrounds" || path === "/slaygrounds/") {
					const port = Number(Deno.env.get("SLAY_PORT") ?? 8051)
					if (Deno.env.has("SLAY_PORT") || !existsSync(`${slay}dist/index.html`)) {
						res.writeHead(302, { location: `http://localhost:${port}/` }).end()
					} else {
						res.setHeader("content-type", "text/html")
						res.end(Deno.readFileSync(`${slay}dist/index.html`))
					}
				} else if (path.startsWith("/slaygrounds/")) {
					const rest = req.url!.slice("/slaygrounds/".length)
					// a dist path is as vite's rewriting of the built html left it
					const file =
						`${slay}${rest.startsWith("dist/") ? rest : `dist/${rest}`}`.split("?")[0]
					if (
						!rest.includes("..") && existsSync(file) && Deno.statSync(file).isFile
					) {
						res.setHeader(
							"content-type",
							KIND[file.split(".").at(-1)!] ?? "application/octet-stream",
						)
						res.end(Deno.readFileSync(file))
					} else next()
				} else if (path === "/catclock") {
					res.writeHead(301, { location: "/catclock/" }).end()
				} else if (path === "/catclock/sources.json") {
					res.setHeader("content-type", "application/json")
					res.end(sources())
				} else if (path === "/catclock/canvas.js") {
					// as it is, not vite's: the page reads it as text, the runner's code
					res.setHeader("content-type", "text/javascript")
					res.end(Deno.readFileSync(`${cat}canvas.js`))
				} else if (path === "/catclock/catclock.wasm") {
					res.setHeader("content-type", "application/wasm")
					res.end(await catWasm())
				} else if (path.startsWith("/catclock/") && !path.startsWith("/catclock/web/")) {
					// the pages and what they fetch, from web/: /catclock/ is web/index.html
					req.url = `/catclock/web/${path.slice(10) || "index.html"}`
					next()
				} else next()
			} catch (e) {
				res.statusCode = 500
				res.end(String(e))
			}
		})
	},
	transformIndexHtml: {
		order: "pre",
		handler(html, ctx) {
			if (ctx.filename === `${here}index.html`) {
				return html.replace("<!-- demos -->", cards).replace("<!-- examples -->", examples)
			}
			// the page's demo.js is serve.ts' bundle of demo.ts: here, demo.ts itself
			if (ctx.filename === `${cat}index.html`) {
				return html.replace(`src="demo.js"`, `src="./demo.ts"`)
			}
		},
	},
}

// the static site: catclock's pages moved from catclock/web/ to catclock/ (their urls are from /),
// what they fetch beside them, and slaygrounds' own build under /slaygrounds/
const site: Plugin = {
	name: "demos:site",
	apply: "build",
	async generateBundle() {
		this.emitFile({ type: "asset", fileName: "catclock/sources.json", source: sources() })
		this.emitFile({
			type: "asset",
			fileName: "catclock/canvas.js",
			source: Deno.readFileSync(`${cat}canvas.js`),
		})
		this.emitFile({ type: "asset", fileName: "catclock/catclock.wasm", source: await catWasm() })
	},
	async closeBundle() {
		// the pages, written last of all (vite's html), up out of web/
		const web = `${here}dist/catclock/web/`
		for (const e of Deno.readDirSync(web)) {
			Deno.renameSync(web + e.name, `${here}dist/catclock/${e.name}`)
		}
		Deno.removeSync(web)
		const run = await new Deno.Command(Deno.execPath(), {
			args: ["task", "--quiet", "build"],
			cwd: slay,
			stdout: "inherit",
			stderr: "inherit",
		}).output()
		if (!run.success) throw new Error("slaygrounds build failed")
		const copy = (from: string, to: string) => {
			Deno.mkdirSync(to, { recursive: true })
			for (const e of Deno.readDirSync(from)) {
				if (e.name === ".DS_Store") continue
				if (e.isDirectory) copy(`${from}/${e.name}`, `${to}/${e.name}`)
				else Deno.copyFileSync(`${from}/${e.name}`, `${to}/${e.name}`)
			}
		}
		copy(`${slay}dist`, `${here}dist/slaygrounds`)
	},
}

// how a module's imports resolve: the pages' and the workers' (catclock's wasm-clang, bundled on its
// own) the same. pages and site are the pages' own: what the dev server serves, the pages' html, what
// the site gets beside them (in a worker's build, site would write it all again)
const resolving = () => [specifiers, deno()]

// every page of every demo: its path from the repo with / as -, no index.html
function inputs() {
	const input: Record<string, string> = { index: `${here}index.html` }
	for (const page of demos().flatMap(pagesOf)) {
		input[
			page.slice(repo.length).replace(/(^|\/)index\.html$/, "").replace(/\.html$/, "")
				.replaceAll("/", "-")
		] = page
	}
	return input
}

export default defineConfig({
	appType: "mpa",
	plugins: [...resolving(), pages, site],
	worker: { format: "es", plugins: resolving },
	// wasm-clang (@yowasp/clang) finds its 105 MB by new URL(.., import.meta.url): served from its own
	// package, unbundled
	optimizeDeps: {
		exclude: ["@yowasp/clang"],
		entries: ["index.html", ...demos().flatMap(pagesOf)],
	},
	server: { port: 8040, strictPort: true, fs: { allow: [repo] } },
	build: {
		outDir: "dist",
		emptyOutDir: true,
		target: "esnext",
		rolldownOptions: {
			input: inputs(),
		},
	},
})
