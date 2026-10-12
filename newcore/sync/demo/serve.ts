// The notes demo: a page per device, served with Deno.
//   deno run -A sync/demo/serve.ts [--local | --server wss://galaxy.observer] [--port 8330]
// --local (default if subduction_cli is found): a Subduction server on this machine, open auth, data
// thrown away on exit. Otherwise --server: wss://galaxy.observer needs only throwaway data, ids in
// the legacy form (16 random bytes then zeros), which this sets. Open http://localhost:8330/ and then
// the "another device" link (or the invite) in a second tab.
import { local } from "./server.ts"

const flag = (n: string) => {
	const i = Deno.args.indexOf("--" + n)
	return i >= 0 ? Deno.args[i + 1] : undefined
}
const here = new URL(".", import.meta.url).pathname
const port = Number(flag("port") ?? 8330)
let server = flag("server"), service = flag("service")
let stop = () => {}
if (!server) {
	try {
		const l = await local(Number(flag("subduction-port") ?? 8321))
		server = l.url, service = l.service, stop = l.stop
		console.log(`subduction_cli on ${server}`)
	} catch (e) {
		console.error(String(e instanceof Error ? e.message : e))
		server = "wss://galaxy.observer"
		console.log(`falling back to ${server} (throwaway data only)`)
	}
}
const legacy = !/^wss?:\/\/(localhost|127\.)/.test(server)

const types: Record<string, string> = {
	html: "text/html; charset=utf-8",
	css: "text/css; charset=utf-8",
	js: "text/javascript; charset=utf-8",
	wasm: "application/wasm",
}
const reply = (body: BodyInit, type: string) =>
	new Response(body, { headers: { "content-type": types[type], "cache-control": "no-store" } })

async function bundle(entry: string): Promise<Response> {
	const out = await new Deno.Command(Deno.execPath(), {
		args: ["bundle", "--quiet", "--platform", "browser", "--sourcemap=inline", entry],
		stdout: "piped",
		stderr: "piped",
	}).output()
	if (out.code !== 0) {
		const err = new TextDecoder().decode(out.stderr).replace(/\x1b\[[0-9;]*m/g, "")
		console.error(err)
		return reply(
			`document.body.insertAdjacentHTML("afterbegin", "<pre></pre>");document.querySelector("pre").textContent = ${
				JSON.stringify(err)
			}`,
			"js",
		)
	}
	return reply(out.stdout, "js")
}

// Subduction's wasm, from Deno's npm cache: the bundle loads it from ../subduction.wasm
async function wasm(): Promise<Uint8Array> {
	for (
		const base of [
			`${Deno.env.get("HOME")}/Library/Caches/deno`,
			`${Deno.env.get("HOME")}/.cache/deno`,
			Deno.env.get("DENO_DIR") ?? "",
		]
	) {
		try {
			return await Deno.readFile(
				`${base}/npm/registry.npmjs.org/@automerge/subduction/0.23.0/dist/subduction.wasm`,
			)
		} catch { /* next */ }
	}
	throw new Error(
		"subduction.wasm not in Deno's npm cache: run deno check sync/demo/node.ts first",
	)
}
const binary = await wasm()

const handler = async (req: Request) => {
	const path = new URL(req.url).pathname
	if (path === "/" || path === "/index.html") {
		return reply(await Deno.readFile(`${here}index.html`), "html")
	}
	if (path === "/style.css") return reply(await Deno.readFile(`${here}style.css`), "css")
	if (path === "/page.ts") return bundle(`${here}page.ts`)
	if (path === "/subduction.wasm") return reply(binary as BodyInit, "wasm")
	if (path === "/config") return Response.json({ server, service: service ?? null, legacy })
	return new Response("not found", { status: 404 })
}
Deno.serve(
	{ port, onListen: () => console.log(`http://localhost:${port}/  (server ${server})`) },
	handler,
)
Deno.addSignalListener("SIGINT", () => (stop(), Deno.exit(0)))
