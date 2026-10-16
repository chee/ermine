// compile.mts: wasm-clang on Netlify, at /catclock/compile: what serve.ts' /compile is on this
// machine, for the demos site. The same build as the page's worker (web/yowasp.ts), so the same
// compiler: its identity is wasm-clang's, and its builds share wasm-clang's keys.
//
// - GET: {compiler: "netlify-clang", identity}
// - POST an ask (web/clang.ts' wire: {cc: {main, files}} or {ld: {objects, out}}) → {ok, bytes
//   (gzip base64), warnings, ms} or {ok: false, error, ms}, refused as serve.ts refuses
//   (web/clang.ts). clang reads only the files given, in its own filesystem. A page that stops asking doesn't stop it: it builds on (one at a time, an instance
//   each), within Netlify's 60 s
//
// netlify.toml says where this is, and keeps @yowasp/clang whole (its 105 MB beside its bundle.js)
import { type Ask, MAX, refuse, WASM_CLANG, wire } from "../web/clang.ts"
import { build } from "../web/yowasp.ts"

const json = (v: unknown, status = 200) =>
	new Response(JSON.stringify(v), {
		status,
		headers: { "content-type": "application/json", "cache-control": "no-store" },
	})

export default async (req: Request): Promise<Response> => {
	if (req.method === "GET") return json({ compiler: "netlify-clang", identity: WASM_CLANG })
	if (req.method !== "POST") return new Response("POST the C", { status: 405 })
	const text = await req.text()
	if (text.length > MAX) return json({ ok: false, error: "that's a lot: 4 MB at most" }, 413)
	let ask: Ask
	try {
		ask = await wire.asked(text)
	} catch {
		return json({ ok: false, error: "not JSON, or its objects not gzip" }, 400)
	}
	const no = refuse(ask)
	if (no) return json({ ok: false, error: no }, 400)
	return new Response(await wire.answer(await build(ask)), {
		headers: { "content-type": "application/json", "cache-control": "no-store" },
	})
}

export const config = { path: "/catclock/compile" }
