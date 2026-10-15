// live checks of sync over a real subduction server, three peer.ts processes (A, B, C), fresh random
// seeds, document and stores each run: only throwaway data is sent.
//   deno run -A extensions/subduction/live/check.ts [--server wss://galaxy.observer] [--zeros]
//     [--service NAME] [--local] [--bulk N] [--wait SECONDS]
// --local: a subduction_cli on this machine (demo/server.ts) instead of --server
// the document is minted by A's sync (sync.mint()) and told to B and C. --zeros: its last 16 bytes
// are zero (the form a server with no grant for a document stores, until Keyhive). exits 1 on a
// failure. the ephemeral checks send on topics (sync's channel), not on documents.
import { local } from "../demo/server.ts"
// deno-lint-ignore no-explicit-any
type Any = any

const flag = (n: string) => {
	const i = Deno.args.indexOf("--" + n)
	return i >= 0 ? Deno.args[i + 1] : undefined
}
const spawned = Deno.args.includes("--local")
	? await local(8321 + Math.floor(Math.random() * 500))
	: undefined
const server = spawned?.url ?? flag("server") ?? "wss://galaxy.observer"
const service = spawned?.service ?? flag("service")
const zeros = Deno.args.includes("--zeros")
const bulk = Number(flag("bulk") ?? 100)
const WAIT = Number(flag("wait") ?? 45) * 1000
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const rand = (n: number) => {
	const b = new Uint8Array(n)
	for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, i + 65536))
	return b
}
const newtopic = () => "live-check-" + hex(rand(16))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const PEER = new URL("./peer.ts", import.meta.url).pathname

class Peer {
	child: Deno.ChildProcess
	writer: WritableStreamDefaultWriter<Uint8Array>
	reader: ReadableStreamDefaultReader<string>
	buf = ""
	ready: Any
	constructor(
		readonly name: string,
		readonly seed: string,
		readonly doc: string | undefined,
		readonly dir: string,
	) {
		this.child = new Deno.Command("deno", {
			args: [
				"run",
				"-A",
				"--quiet",
				PEER,
				"--seed",
				seed,
				...doc ? ["--doc", doc] : [],
				"--store",
				dir,
				"--server",
				server,
				...zeros ? ["--zeros"] : [],
				...service ? ["--service", service] : [],
			],
			stdin: "piped",
			stdout: "piped",
			stderr: "inherit",
		}).spawn()
		this.writer = this.child.stdin.getWriter()
		this.reader = this.child.stdout.pipeThrough(new TextDecoderStream()).getReader()
	}
	async line(ms: number): Promise<Any> {
		const stop = Date.now() + ms
		while (true) {
			const at = this.buf.indexOf("\n")
			if (at >= 0) {
				const l = this.buf.slice(0, at)
				this.buf = this.buf.slice(at + 1)
				return JSON.parse(l)
			}
			const left = stop - Date.now()
			if (left <= 0) throw new Error(`${this.name}: no answer in ${ms} ms`)
			const got = await Promise.race([
				this.reader.read(),
				sleep(left).then(() => "timeout" as const),
			])
			if (got === "timeout") throw new Error(`${this.name}: no answer in ${ms} ms`)
			if (got.done) throw new Error(`${this.name}: closed its output`)
			this.buf += got.value
		}
	}
	async start() {
		this.ready = (await this.line(WAIT)).ready
		return this
	}
	async ask(req: Any, ms = WAIT): Promise<Any> {
		await this.writer.write(new TextEncoder().encode(JSON.stringify(req) + "\n"))
		const a = await this.line(ms)
		if ("error" in a) throw new Error(`${this.name} ${req.cmd}: ${a.error}`)
		return a.ok
	}
	async quit() {
		try {
			await this.writer.write(new TextEncoder().encode('{"cmd":"quit"}\n'))
			await this.line(10000).catch(() => {})
		} catch { /* gone */ }
		await Promise.race([this.child.status, sleep(5000)])
		try {
			this.child.kill()
		} catch { /* gone */ }
	}
}

let failed = 0
// polls until what read gives satisfies want; prints the check
async function check(what: string, read: () => Promise<unknown>, want: (x: any) => boolean) {
	const start = Date.now()
	let last: unknown, error: unknown
	while (Date.now() - start < WAIT) {
		try {
			last = await read()
			if (want(last)) {
				console.log(`  ok    ${what} (${((Date.now() - start) / 1000).toFixed(1)} s)`)
				return true
			}
		} catch (e) {
			error = e
		}
		await sleep(300)
	}
	console.log(
		`  FAIL  ${what} (not within ${WAIT / 1000} s): last ${JSON.stringify(last)}${
			error ? " error " + error : ""
		}`,
	)
	failed++
	return false
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

let doc: string | undefined
const seeds = [0, 1, 2].map(() => hex(rand(32)))
const base = await Deno.makeTempDir({ prefix: "ermine-live-check-" })
const dirs = [0, 1, 2].map((i) => `${base}/${"abc"[i]}`)
console.log(`server ${server}, ${zeros ? "zeros" : "full"} ids`)
const peers: Peer[] = []
const spawn = async (i: number) => {
	const p = new Peer("ABC"[i], seeds[i], doc, dirs[i])
	peers.push(p)
	await p.start()
	doc ??= p.ready.doc
	console.log(`  ${p.name} up: key ${p.ready.key.slice(0, 8)}, doc ${p.ready.doc}`)
	return p
}
try {
	const a = await spawn(0)
	let b = await spawn(1)

	await a.ask({ cmd: "commit", value: "a1" })
	await check(
		"(a) a stored change on A appears on B",
		() => b.ask({ cmd: "read" }),
		(v) => same(v, ["a1"]),
	)

	await Promise.all([a.ask({ cmd: "commit", value: "ca" }), b.ask({ cmd: "commit", value: "cb" })])
	await check(
		"(b) concurrent changes converge to the same versions (one shown, one in conflicts)",
		async () => [await a.ask({ cmd: "read" }), await b.ask({ cmd: "read" })],
		(v) => same(v[0], ["ca", "cb"]) && same(v[1], v[0]),
	)

	const e1 = newtopic()
	await b.ask({ cmd: "view", doc: e1 })
	await a.ask({ cmd: "ephemeral", doc: e1, value: "hello" }).catch((e) =>
		console.log("  note: " + String(e).split("\n")[0])
	)
	await check(
		"(c) an ephemeral message on A is heard on B",
		() => b.ask({ cmd: "read", doc: e1 }),
		(v) => same(v, ["hello"]),
	)

	const big = hex(rand(100000))
	const e2 = newtopic()
	await b.ask({ cmd: "view", doc: e2 })
	const sent = Date.now()
	await a.ask({ cmd: "ephemeral", doc: e2, value: big }).catch((e) =>
		console.log("  note: " + String(e).split("\n")[0])
	)
	console.log(`  (A published the parts in ${((Date.now() - sent) / 1000).toFixed(1)} s)`)
	await check(
		"(d) a ~200 KB ephemeral message crosses in parts",
		() => b.ask({ cmd: "read", doc: e2 }),
		(v) => Array.isArray(v) && v.length === 1 && String(v[0]).startsWith("len:200000:"),
	)

	await b.quit()
	await a.ask({ cmd: "commit", value: "e1" })
	await a.ask({ cmd: "commit", value: "e2" })
	const want = await a.ask({ cmd: "read" })
	b = await spawn(1)
	console.log(
		`  (B's store gave it ${JSON.stringify(await b.ask({ cmd: "read" }))} before the server)`,
	)
	await check(
		"(e) B restarts from its store dir and catches up",
		() => b.ask({ cmd: "read" }),
		(v) => same(v, want) && v.length >= 1,
	)

	await a.ask({ cmd: "commit", value: "bulk", n: bulk }, 5 * WAIT)
	const wantC = await a.ask({ cmd: "read" })
	const c = await spawn(2)
	await check(
		`(f) a fresh device C joins late and gets everything (${bulk} more changes)`,
		() => c.ask({ cmd: "read" }),
		(v) => same(v, wantC),
	)
	const st = await c.ask({ cmd: "status" })
	console.log(
		`  C: ${st.commits} stored commits, ${st.fragments} fragments, refused ${
			JSON.stringify(st.taking.refused)
		}`,
	)
	const sa = await a.ask({ cmd: "status" })
	console.log(`  A: ${sa.commits} stored commits, ${sa.fragments} fragments`)
} catch (e) {
	console.log("  FAIL  " + String((e as Error).stack ?? e))
	failed++
} finally {
	for (const p of peers) await p.quit()
	await Deno.remove(base, { recursive: true }).catch(() => {})
	spawned?.stop()
}
console.log(failed ? `${failed} FAILED` : "all ok")
Deno.exit(failed ? 1 : 0)
