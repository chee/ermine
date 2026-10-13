// The reference paths (core/scheduler/typescript/paths.ts) on the line protocol: one JSON request
// per line in, one answer per line out, in order. Another implementation joins by speaking this.
//
//   source, id   a string, or {"symbol": name}: one symbol per name, never equal to a string
//   path         a list of keys: numbers (list indices) and strings (map keys)
//   a spot       in an answer: its path, or "change" for the change spot; spots in any order
//
//   {"op":"spot","source","id","path"}       {}  a read's spot, made or found
//   {"op":"change","source","id"}            {}  the change spot, made or found
//   {"op":"mark","source","id","patches"}    {"spots":[...]}  what the patches mark, each once
//   {"op":"event","source","id"}             {"spots":[...]}  a whole-node event at that key
//   {"op":"release","source","id","path"}    {}  lets the spot go (no path: the change spot);
//                                                 not there: nothing
//   {"op":"marks","patch","paths"}           {"marks":[...]}  the rule, a boolean per path
//   {"op":"kept"}                            {"keys","spots","steps"}  what is kept
//   anything wrong                           {"error": why}
import { createPaths, type Key, marks, type Patch, type Spot } from "@ermine/scheduler/paths"

const paths = createPaths<never>()
const symbols = new Map<string, symbol>()
const key = (k: unknown): unknown => {
	if (typeof k === "string") return k
	const name = (k as { symbol?: unknown })?.symbol
	if (typeof name !== "string") throw new Error("a source or id is a string or a symbol")
	let s = symbols.get(name)
	if (s === undefined) symbols.set(name, s = Symbol(name))
	return s
}
const shown = (s: Spot<never>) => s.path ?? "change"

type Request = {
	op: string
	source?: unknown
	id?: unknown
	path?: Key[]
	patches?: Patch[]
	patch?: Patch
	paths?: Key[][]
}

function answer(r: Request): unknown {
	try {
		return run(r)
	} catch (e) {
		return { error: String(e) }
	}
}
function run(r: Request): unknown {
	switch (r.op) {
		case "spot":
			paths.spot(key(r.source), key(r.id), r.path!)
			return {}
		case "change":
			paths.change(key(r.source), key(r.id))
			return {}
		case "mark":
			return { spots: paths.mark(key(r.source), key(r.id), r.patches!).map(shown) }
		case "event":
			return { spots: paths.event(key(r.source), key(r.id)).map(shown) }
		case "release": {
			// made, then let go: a spot not there stays not there
			const s = r.path === undefined
				? paths.change(key(r.source), key(r.id))
				: paths.spot(key(r.source), key(r.id), r.path)
			paths.release(s)
			return {}
		}
		case "marks":
			return { marks: r.paths!.map((p) => marks(r.patch!, p)) }
		case "kept":
			return paths.kept()
		default:
			return { error: `unknown op ${r.op}` }
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
		text += JSON.stringify(answer(JSON.parse(line))) + "\n"
	}
	if (text) await out.write(encoder.encode(text))
}
