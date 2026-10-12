// The reference notify on the line protocol: one JSON request per line in, one answer per line
// out, in order. Another implementation joins by speaking this (NOTIFY_HARNESS).
//
//   {"op":"start","value":v}                       the content; every read is dropped    → {}
//   {"op":"read","name":n,"path":p,                a read; path: keys, maybe a span last  → {}
//    "deep"?,"chase"?,"edges"?,"empty"?}
//   {"op":"patch","patch":p,"value":v}             p was applied; v: the content after   → {"heard":{n:[kind]}}
//   {"op":"where","name":n}                        where a read is, and what it sees     → {"path":p,"value":v,"live":b}
//   {"op":"stop","name":n}                                                               → {}
//
// heard: only reads that heard something; each read's kinds once, in any order. A read gone or
// stopped is not live; its path and value are then whatever it last had. A value absent at a
// path: no "value" field. Anything not understood: {"error": why}.
import {
	createNotify,
	facts,
	type Options,
	type Patch,
	type Path,
	type Read,
} from "@ermine/scheduler/notify"

let content: unknown
let notify = createNotify(() => content)
let reads = new Map<string, { r: Read; heard: string[]; live: boolean }>()

type Request = Options & {
	op: string
	name?: string
	path?: Path
	patch?: Patch
	value?: unknown
}

function answer(q: Request): unknown {
	switch (q.op) {
		case "start":
			content = q.value
			notify = createNotify(() => content)
			reads = new Map()
			return {}
		case "read": {
			const { deep, chase, edges, empty } = q
			const r = notify.read(q.path!, { deep, chase, edges, empty })
			const entry = { r, heard: [] as string[], live: true }
			r.on((kind) => {
				if (!entry.heard.includes(kind)) entry.heard.push(kind)
				if (kind === "gone") entry.live = false
			})
			reads.set(q.name!, entry)
			return {}
		}
		case "patch": {
			const before = content
			content = q.value
			notify.patched(q.patch!, facts(q.patch!, before))
			const heard: Record<string, string[]> = {}
			for (const [name, e] of reads) {
				if (e.heard.length > 0) heard[name] = e.heard
				e.heard = []
			}
			return { heard }
		}
		case "where": {
			const e = reads.get(q.name!)
			if (!e) return { error: `no read ${q.name}` }
			return { path: e.r.path, value: e.r.value, live: e.live }
		}
		case "stop": {
			const e = reads.get(q.name!)
			if (!e) return { error: `no read ${q.name}` }
			e.r.stop()
			e.live = false
			return {}
		}
		default:
			return { error: `unknown op ${q.op}` }
	}
}

const out = Deno.stdout.writable.getWriter()
const encoder = new TextEncoder()
let buffer = ""
for await (const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())) {
	buffer += chunk
	let i
	let text = ""
	while ((i = buffer.indexOf("\n")) !== -1) {
		const line = buffer.slice(0, i)
		buffer = buffer.slice(i + 1)
		if (line.trim() === "") continue
		let a: unknown
		try {
			a = answer(JSON.parse(line))
		} catch (e) {
			a = { error: String(e) }
		}
		text += JSON.stringify(a) + "\n"
	}
	if (text) await out.write(encoder.encode(text))
}
