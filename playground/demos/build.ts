// build.ts: the demos site, into dist/ (netlify.toml runs it; npx serve dist, or any static server,
// to look)
//
//   deno run -A playground/demos/build.ts
//
// - /: index.html, its pictures (pictures/), and slaygrounds' examples listed (examples/index.json)
// - /slaygrounds/: slaygrounds' own vite build (deno task build there)
// - /catclock/: web/'s pages; demo.ts and clang.worker.ts bundled by deno, as serve.ts bundles
//   them; sources.json, as serve.ts says it; wasm-clang's files beside the worker (@yowasp/clang,
//   from node_modules); catclock.wasm, built here by wasm-clang (web/yowasp.ts), for clock.html and
//   the index's cat. /catclock/compile is functions/compile.mts (netlify.toml)
// - pigs: a terminal program, so its card only
import { build } from "./catclock/web/yowasp.ts"
import { objectOf, SOURCES } from "./catclock/web/clang.ts"

const here = new URL(".", import.meta.url).pathname
const repo = new URL("../../", import.meta.url).pathname
const dist = here + "dist/"
const text = new TextDecoder()

async function run(cmd: string, args: string[], cwd: string) {
	const r = await new Deno.Command(cmd, { args, cwd, stdout: "piped", stderr: "piped" }).output()
	if (!r.success) {
		throw new Error(`${cmd} ${args.join(" ")}\n${text.decode(r.stdout)}${text.decode(r.stderr)}`)
	}
}
function copy(from: string, to: string) {
	if (Deno.statSync(from).isDirectory) {
		Deno.mkdirSync(to, { recursive: true })
		for (const e of Deno.readDirSync(from)) copy(`${from}/${e.name}`, `${to}/${e.name}`)
	} else Deno.copyFileSync(from, to)
}
const escape = (s: string) =>
	s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)

await Deno.remove(dist, { recursive: true }).catch(() => {})
Deno.mkdirSync(dist, { recursive: true })

// ---- slaygrounds ----
await run(Deno.execPath(), ["task", "--quiet", "build"], here + "slaygrounds")
copy(here + "slaygrounds/dist", dist + "slaygrounds")
console.log("built slaygrounds")

// ---- catclock ----
const cat = here + "catclock/"
const catOut = dist + "catclock/"
Deno.mkdirSync(catOut)
for (const page of ["index.html", "clock.html", "style.css", "canvas.js"]) {
	Deno.copyFileSync(cat + "web/" + page, catOut + page)
}
const bundle = async (entry: string, out: string) => {
	await run(Deno.execPath(), [
		"bundle",
		"--no-lock",
		"--quiet",
		"--minify",
		"--format",
		"esm",
		"--platform",
		"browser",
		cat + "web/" + entry,
		"-o",
		catOut + out,
	], repo)
}
await bundle("demo.ts", "demo.js")
await bundle("clang.worker.ts", "clang.worker.js")
// the worker as .js: served as javascript, which a module worker must be
const demo = Deno.readTextFileSync(catOut + "demo.js")
if (!demo.includes('"./clang.worker.ts"')) throw new Error("demo.js: no ./clang.worker.ts in it")
Deno.writeTextFileSync(
	catOut + "demo.js",
	demo.replaceAll('"./clang.worker.ts"', '"./clang.worker.js"'),
)
const files = Object.fromEntries(SOURCES.map((name) => [name, Deno.readTextFileSync(cat + name)]))
Deno.writeTextFileSync(
	catOut + "sources.json",
	JSON.stringify(SOURCES.map((name) => ({ name, text: files[name] }))),
)
const yowasp = repo + "node_modules/@yowasp/clang/gen/"
try {
	Deno.statSync(yowasp)
} catch {
	throw new Error(`no ${yowasp}: deno install --node-modules-dir=auto, at the repo's root`)
}
for (const e of Deno.readDirSync(yowasp)) {
	if (e.name.endsWith(".wasm") || e.name.endsWith(".tar")) {
		Deno.copyFileSync(yowasp + e.name, catOut + e.name)
	}
}
const object = await build({ cc: { main: "catclock.c", files } })
if (!object.ok) throw new Error(`catclock.c: ${object.error}`)
const wasm = await build({
	ld: { objects: { [objectOf("catclock.c")]: object.bytes! }, out: "catclock.wasm" },
})
if (!wasm.ok) throw new Error(`catclock.wasm: ${wasm.error}`)
Deno.writeFileSync(catOut + "catclock.wasm", wasm.bytes!)
console.log(`built catclock (catclock.wasm: ${wasm.bytes!.length} bytes)`)

// ---- the index ----
const examples = JSON.parse(
	Deno.readTextFileSync(here + "slaygrounds/examples/index.json"),
) as { name: string; title: string }[]
// a title that starts with its name says it once
const list = examples.map(({ name, title }) =>
	`<li><a href="slaygrounds/#${escape(name)}"><b>${escape(name)}</b> ${
		escape(title.startsWith(`${name}: `) ? title.slice(name.length + 2) : title)
	}</a></li>`
).join("\n\t\t\t\t\t")
const index = Deno.readTextFileSync(here + "index.html")
if (!index.includes("<!-- examples -->")) throw new Error("index.html: no <!-- examples -->")
Deno.writeTextFileSync(dist + "index.html", index.replace("<!-- examples -->", list))
copy(here + "pictures", dist + "pictures")
console.log(`built the index (${examples.length} examples)`)
