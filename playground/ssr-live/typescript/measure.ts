// the prototype's numbers, over http on this machine: the page's script (as written, minified,
// gzip), the first page, the time from an event posted to its update read off the stream, the
// bytes each update is, and one shared click told to many visitors. LLM generated
//   deno task measure [runs]       (in playground/ssr-live; runs: 200)
import { client, serve } from "./server.ts"

const RUNS = 200
const runs = Number(Deno.args[0] ?? RUNS)
// clicks not timed first (the jit warming), items added, the list sizes reported, visitors at once
const WARM = 20
const ITEMS = 50
const SHOWN = [1, 2, 10, ITEMS]
const CROWDS = [10, 100, 1000]
const KB = 1024
const encoder = new TextEncoder()
const bytes = (s: string) => encoder.encode(s).length

async function gzip(s: string): Promise<number> {
	const out = new Blob([s]).stream().pipeThrough(new CompressionStream("gzip"))
	return (await new Response(out).arrayBuffer()).byteLength
}

async function minified(): Promise<string> {
	const out = await Deno.makeTempFile({ suffix: ".js" })
	const from = new URL("../client/live.js", import.meta.url).pathname
	const { code, stderr } = await new Deno.Command(Deno.execPath(), {
		args: ["bundle", "--quiet", "--minify", "--platform", "browser", "-o", out, from],
	}).output()
	if (code !== 0) throw new Error(new TextDecoder().decode(stderr))
	const js = await Deno.readTextFile(out)
	await Deno.remove(out)
	return js
}

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b)
const at = (xs: number[], q: number) =>
	sorted(xs)[Math.min(xs.length - 1, Math.floor(q * xs.length))]
// to a hundredth
const ms = (x: number) => Math.round(x * 100) / 100
const spread = (xs: number[]) => ({
	median: ms(at(xs, 0.5)),
	p95: ms(at(xs, 0.95)),
	min: ms(Math.min(...xs)),
})

// a visitor, as a page is: its first html, its process, its stream's frames in turn
async function visit(base: string) {
	const page = await (await fetch(base + "/")).text()
	const p = page.split('data-ermine-process="')[1].split('"')[0]
	const response = await fetch(`${base}/live?p=${encodeURIComponent(p)}`)
	const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
	let buffer = ""
	const waiting: ((frame: string) => void)[] = []
	const frames: string[] = []
	;(async () => {
		for (;;) {
			const { value, done } = await reader.read().catch(() => ({ value: "", done: true }))
			if (done) return
			buffer += value
			let end
			while ((end = buffer.indexOf("\n\n")) >= 0) {
				const frame = buffer.slice(0, end + 2)
				buffer = buffer.slice(end + 2)
				if (!frame.startsWith("data: ")) continue
				const w = waiting.shift()
				w ? w(frame) : frames.push(frame)
			}
		}
	})()
	const next = () =>
		frames.length
			? Promise.resolve(frames.shift()!)
			: new Promise<string>((done) => waiting.push(done))
	const post = (h: string, t: string, more: Record<string, unknown> = {}) =>
		fetch(base + "/event", { method: "POST", body: JSON.stringify({ p, h, t, ...more }) })
			.then((r) => r.body?.cancel())
	return { page, p, next, post, close: () => reader.cancel() }
}

// the id of the handler for action at, the first in html
const handlerOf = (html: string, at: string) =>
	html.slice(html.indexOf(`="${at}" data-ermine-handler:`)).split('"')[3]

// one event, timed from its post to its update's frame
async function timed(v: Awaited<ReturnType<typeof visit>>, h: string, t: string, more = {}) {
	const t0 = performance.now()
	const [frame] = await Promise.all([v.next(), v.post(h, t, more)])
	return { time: performance.now() - t0, frame }
}

const updates = (frame: string) => JSON.parse(frame.slice("data: ".length)) as unknown[][]
// the same updates as objects ({ binding, prop, value }): their bytes
const asObjects = (frame: string) =>
	bytes(JSON.stringify(updates(frame).map(([binding, prop, value]) => ({ binding, prop, value }))))

const { server, live } = serve(0)
const base = `http://localhost:${server.addr.port}`
const results: Record<string, unknown> = {}

// the page's script
const small = await minified()
results.script = {
	written: { bytes: bytes(client), gzip: await gzip(client) },
	minified: { bytes: bytes(small), gzip: await gzip(small) },
}

// the counter: + clicked runs times
const v = await visit(base)
results.page = { bytes: bytes(v.page), gzip: await gzip(v.page) }
const inc = handlerOf(v.page, "on/inc")
for (let i = 0; i < WARM; i++) await timed(v, inc, "click", { value: "" })
const clicks = []
for (let i = 0; i < runs; i++) clicks.push(await timed(v, inc, "click", { value: "" }))
const one = clicks.at(-1)!.frame
results.counter = {
	ms: spread(clicks.map((c) => c.time)),
	frame: one.trim(),
	updates: updates(one).length,
	frameBytes: bytes(one),
	payloadBytes: bytes(one) - bytes("data: \n\n"),
	asObjectsBytes: asObjects(one),
}

// the list: ITEMS added, then the first taken out
const add = handlerOf(v.page, "on/add")
const adds = []
let first = ""
let last = ""
for (let i = 1; i <= ITEMS; i++) {
	const r = await timed(v, add, "submit", { value: "", form: { text: `item ${i}` } })
	adds.push({ n: i, time: r.time, bytes: bytes(r.frame) })
	if (i === 1) first = r.frame
	last = r.frame
}
const kids = updates(last)[0][2] as string
const removed = await timed(v, handlerOf(kids, "on/remove"), "click", { value: "" })
results.list = {
	ms: spread(adds.map((a) => a.time)),
	frameBytes: Object.fromEntries(
		adds.filter((a) => SHOWN.includes(a.n)).map((a) => [`${a.n} items`, a.bytes]),
	),
	perItemBytes: Math.round((adds.at(-1)!.bytes - adds[0].bytes) / (ITEMS - 1)),
	frame: adds[0] && first.trim(),
	remove: { ms: ms(removed.time), frameBytes: bytes(removed.frame) },
}
v.close()

// one shared click, told to every visitor: from the post till the last visitor's frame
const crowds = []
for (const n of CROWDS) {
	const heapBefore = Deno.memoryUsage().heapUsed
	const t0 = performance.now()
	const vs = []
	for (let i = 0; i < n; i++) vs.push(await visit(base))
	const made = performance.now() - t0
	const heap = Deno.memoryUsage().heapUsed - heapBefore
	const h = handlerOf(vs[0].page, "on/inc")
	const t1 = performance.now()
	const all = Promise.all(vs.map((x) => x.next()))
	await vs[0].post(h, "click", { value: "" })
	await all
	crowds.push({
		visitors: n,
		allToldMs: ms(performance.now() - t1),
		visitMs: ms(made / n),
		heapPerVisitorKB: Math.round(heap / n / KB),
	})
	vs.forEach((x) => x.close())
}
results.crowds = crowds
results.visitorsLeft = live.visitors()

console.log(JSON.stringify(results, null, "\t"))
live.close()
await server.shutdown()
