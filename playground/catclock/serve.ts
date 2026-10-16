// serve.ts: the catclock demo, on this machine (http://localhost:8077):
//
//   deno run -A playground/catclock/serve.ts       PORT=… for another port
//
// - web/: the pages. / is the demo (index.html), clock.html the clock alone
// - /demo.js: web/demo.ts and what it imports, bundled by deno again whenever one of them is newer
// - /sources.json: the C, as the demo seeds its graph with it: [{name, text}]
// - POST /compile: an ask (web/clang.ts' wire): {cc: {main, files: {name: text}}}, a C file
//   compiled, or {ld: {objects: {name: gzip base64}, out}}, objects linked → {ok, bytes (gzip
//   base64), warnings, ms} or {ok: false, error, ms}. clang or wasm-ld as build.sh runs them, in a
//   folder of their own. Only from this machine; only the files given and clang's own <stdint.h>
//   <stddef.h> <stdbool.h> are included. A page that stops asking (a build no newer start wants)
//   stops clang too
// - GET /compile: {compiler: "clang", identity}: the page's compiler node's name, and what this
//   clang is ({name, version, target, flags, link}), which the node says
//   (ermine.programs.compiler), so its builds are cached by it
// - /clang.worker.ts: web/clang.worker.ts bundled (wasm-clang, the page's other compiler), and its
//   wasm beside it (llvm.core.wasm and the rest: @yowasp/clang's, from node_modules)
import { type Ask, CC, LD, MAX, objectOf, refuse, SOURCES, wire } from "./web/clang.ts"
const here = new URL(".", import.meta.url).pathname
const web = here + "web/"
const repo = new URL("../../", import.meta.url).pathname
const port = Number(Deno.env.get("PORT") ?? 8077)

const ld = [
	"/opt/homebrew/opt/lld@22/bin/wasm-ld",
	"/opt/homebrew/opt/lld@21/bin/wasm-ld",
	"/opt/homebrew/opt/lld/bin/wasm-ld",
	"/opt/homebrew/opt/llvm/bin/wasm-ld",
].find((p) => {
	try {
		return Deno.statSync(p).isFile
	} catch {
		return false
	}
})

// clang's own words for its version: "Apple clang version 21.0.0 (clang-2100.3.34.2)"
const version = (() => {
	try {
		const out = new Deno.Command("clang", { args: ["--version"], stdout: "piped" }).outputSync()
		return new TextDecoder().decode(out.stdout).split("\n")[0].replace(/^.*version\s+/, "").trim()
	} catch {
		return undefined
	}
})()

const types: Record<string, string> = {
	html: "text/html; charset=utf-8",
	js: "text/javascript; charset=utf-8",
	css: "text/css; charset=utf-8",
	wasm: "application/wasm",
	svg: "image/svg+xml",
	png: "image/png",
	json: "application/json",
}
const json = (v: unknown, status = 200) =>
	new Response(JSON.stringify(v), {
		status,
		headers: { "content-type": types.json, "cache-control": "no-store" },
	})

// ---- /demo.js, /clang.worker.ts: web/demo.ts and web/clang.worker.ts, each bundled when a .ts in
// web/ is newer than its last bundle ----
const bundles = new Map<string, { at: number; code: string }>()
async function bundled(entry: string): Promise<string> {
	let newest = 0
	for (const e of Deno.readDirSync(web)) {
		if (e.name.endsWith(".ts")) {
			newest = Math.max(newest, Deno.statSync(web + e.name).mtime!.getTime())
		}
	}
	const was = bundles.get(entry)
	if (was && was.at >= newest) return was.code
	const out = await Deno.makeTempFile({ suffix: ".js" })
	const r = await new Deno.Command(Deno.execPath(), {
		args: [
			"bundle",
			"--no-lock",
			"--quiet",
			"--minify",
			"--format",
			"esm",
			"--platform",
			"browser",
			web + entry,
			"-o",
			out,
		],
		cwd: repo,
		stderr: "piped",
	}).output()
	if (!r.success) throw new Error(new TextDecoder().decode(r.stderr))
	const code = await Deno.readTextFile(out)
	bundles.set(entry, { at: newest, code })
	await Deno.remove(out)
	return code
}
// wasm-clang's own files, fetched beside the worker
const yowasp = repo + "node_modules/@yowasp/clang/gen/"
const YOWASP = new Set([
	"llvm.core.wasm",
	"llvm.core2.wasm",
	"llvm.core3.wasm",
	"llvm.core4.wasm",
	"llvm-resources.tar",
])

// ---- POST /compile ----
async function compile(req: Request): Promise<Response> {
	if (!ld) return json({ ok: false, error: "no wasm-ld on this machine: brew install lld" }, 501)
	const text = await req.text()
	if (text.length > MAX) {
		return json({ ok: false, error: "that's a lot: 4 MB at most" }, 413)
	}
	let ask: Ask
	try {
		ask = await wire.asked(text)
	} catch {
		return json({ ok: false, error: "not JSON, or its objects not gzip" }, 400)
	}
	const no = refuse(ask)
	if (no) return json({ ok: false, error: no }, 400)
	const dir = await Deno.makeTempDir({ prefix: "catclock-cc-" })
	const started = performance.now()
	const ms = () => Math.round(performance.now() - started)
	const answer = async (v: Parameters<typeof wire.answer>[0]) =>
		new Response(await wire.answer(v), {
			headers: { "content-type": types.json, "cache-control": "no-store" },
		})
	try {
		const run = async (cmd: string, args: string[]) => {
			const p = new Deno.Command(cmd, {
				args,
				cwd: dir,
				stdout: "piped",
				stderr: "piped",
				signal: AbortSignal.any([req.signal, AbortSignal.timeout(20_000)]),
			})
			const r = await p.output()
			return {
				ok: r.success,
				text: new TextDecoder().decode(r.stderr) + new TextDecoder().decode(r.stdout),
			}
		}
		let out: string, done: { ok: boolean; text: string }
		if ("cc" in ask) {
			for (const [file, source] of Object.entries(ask.cc.files)) {
				await Deno.writeTextFile(`${dir}/${file}`, source)
			}
			out = objectOf(ask.cc.main)
			done = await run("clang", [...CC, "-c", ask.cc.main, "-o", out])
		} else {
			for (const [file, bytes] of Object.entries(ask.ld.objects)) {
				await Deno.writeFile(`${dir}/${file}`, bytes)
			}
			// named as build.sh names it, so the same objects make the same bytes
			out = ask.ld.out
			done = await run(ld, [...LD, "-o", out, ...Object.keys(ask.ld.objects).sort()])
		}
		if (!done.ok) return answer({ ok: false, error: done.text.trim(), ms: ms() })
		const bytes = await Deno.readFile(`${dir}/${out}`)
		return answer({ ok: true, bytes, warnings: done.text.trim(), ms: ms() })
	} catch (e) {
		return json({ ok: false, error: String(e) }, 500)
	} finally {
		await Deno.remove(dir, { recursive: true }).catch(() => {})
	}
}

Deno.serve({ port, hostname: "127.0.0.1" }, async (req, info) => {
	const url = new URL(req.url)
	const from = (info.remoteAddr as Deno.NetAddr).hostname
	if (url.pathname === "/compile") {
		if (!["127.0.0.1", "::1"].includes(from)) {
			return new Response("only from this machine", { status: 403 })
		}
		if (req.method === "GET") {
			if (!version || !ld) return json({ error: "no clang, or no wasm-ld, here" }, 501)
			return json({
				compiler: "clang",
				identity: { name: "clang", version, target: "wasm32", flags: CC, link: LD },
			})
		}
		if (req.method !== "POST") return new Response("POST the C", { status: 405 })
		return compile(req)
	}
	if (url.pathname === "/sources.json") {
		return json(SOURCES.map((name) => ({ name, text: Deno.readTextFileSync(here + name) })))
	}
	const entry = { "/demo.js": "demo.ts", "/clang.worker.ts": "clang.worker.ts" }[url.pathname]
	if (entry) {
		try {
			return new Response(await bundled(entry), {
				headers: { "content-type": types.js, "cache-control": "no-store" },
			})
		} catch (e) {
			return new Response(`console.error(${JSON.stringify(String(e))})`, {
				headers: { "content-type": types.js },
			})
		}
	}
	if (YOWASP.has(url.pathname.slice(1))) {
		try {
			const file = await Deno.open(yowasp + url.pathname.slice(1))
			const type = url.pathname.endsWith(".wasm") ? types.wasm : "application/x-tar"
			return new Response(file.readable, { headers: { "content-type": type } })
		} catch {
			return new Response("no @yowasp/clang here: deno install", { status: 404 })
		}
	}
	const path = url.pathname === "/" ? "index.html" : url.pathname.slice(1)
	if (path.includes("..") || path.includes("//")) return new Response("no", { status: 400 })
	try {
		const body = await Deno.readFile(web + path)
		const type = types[path.split(".").pop()!] ?? "application/octet-stream"
		return new Response(body, { headers: { "content-type": type, "cache-control": "no-cache" } })
	} catch {
		return new Response("not here", { status: 404 })
	}
})
