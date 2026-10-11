// The reference fragment.ts on the line protocol: one JSON request per line in, one answer per
// line out, in order. Ids are stored ids (32 bytes) in lowercase hex.
//   commits: [{id, parents: [id]}]  the commits here; a parent not listed is not here
//   known:   [{head, members, boundary, checkpoints}]  fragments here already, by head
//   {op: "build", commits, heads: [id], known}
//     -> {fragments: [{head, members, boundary, checkpoints}]}
//        the new fragments only (FRAGMENT.tex, Building), not the known ones
//   {op: "walk", commits, head: id, known}
//     -> {members, boundary, checkpoints}   one fragment (FRAGMENT.tex, The walk)
//      | {error: "missing"}                 a commit the walk needs not here
//      | {error: "depth-zero"}              the head has depth 0
// Answers: fragments sorted by head, each list sorted bytewise (hex order is the same), no
// duplicates; checkpoints whole 32-byte ids. Another implementation joins by speaking this.
//
// The API of fragment.ts is not written yet; this shim assumes:
//   lookup(id) -> parents (Uint8Array[]) | undefined (not here)
//   known(head) -> Fragment | undefined
//   walk(head, lookup, known) -> Fragment, throwing FragmentError {code: "missing" | "depth-zero"}
//   build(heads, lookup, known) -> Fragment[], the new ones
//   Fragment: {head, members, boundary, checkpoints}, each a Uint8Array or a list of them
import { build, FragmentError, walk } from "../../sync/ts/fragment.ts"

type Hex = { head: string; members: string[]; boundary: string[]; checkpoints: string[] }
type Bytes = {
	head: Uint8Array
	members: Uint8Array[]
	boundary: Uint8Array[]
	checkpoints: Uint8Array[]
}
type Request = {
	op: string
	commits: { id: string; parents: string[] }[]
	heads?: string[]
	head?: string
	known: Hex[]
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))
const list = (xs: Iterable<Uint8Array>) => [...xs].map(hex).sort()
const toHex = (f: Bytes): Hex => ({
	head: hex(f.head),
	members: list(f.members),
	boundary: list(f.boundary),
	checkpoints: list(f.checkpoints),
})
const toBytes = (f: Hex): Bytes => ({
	head: unhex(f.head),
	members: f.members.map(unhex),
	boundary: f.boundary.map(unhex),
	checkpoints: f.checkpoints.map(unhex),
})

function answer(r: Request): unknown {
	const parents = new Map(r.commits.map((c) => [c.id, c.parents.map(unhex)]))
	const lookup = (id: Uint8Array) => parents.get(hex(id))
	const fragments = new Map(r.known.map((f) => [f.head, toBytes(f)]))
	const known = (head: Uint8Array) => fragments.get(hex(head))
	try {
		switch (r.op) {
			case "build":
				return {
					fragments: build(r.heads!.map(unhex), lookup, known).map(toHex).sort((a, b) =>
						a.head < b.head ? -1 : a.head > b.head ? 1 : 0
					),
				}
			case "walk": {
				const { members, boundary, checkpoints } = toHex(walk(unhex(r.head!), lookup, known))
				return { members, boundary, checkpoints }
			}
			default:
				return { error: `unknown op ${r.op}` }
		}
	} catch (e) {
		if (e instanceof FragmentError) return { error: e.code }
		throw e
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
		const l = buffer.slice(0, i)
		buffer = buffer.slice(i + 1)
		if (l.trim() === "") continue
		text += JSON.stringify(answer(JSON.parse(l))) + "\n"
	}
	if (text) await out.write(encoder.encode(text))
}
