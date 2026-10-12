// A device in Deno: the same node.ts a tab runs, its storage in a directory, its lines on the
// terminal. Joins a folder by id, or makes one.
//   deno run -A sync/demo/peer.ts [--name bob] [--folder ermine://…] [--store DIR] [--server ws://localhost:8321
//     [--service localhost:8321]] [--legacy]
// stdin, a command a line:
//   make TITLE [TEXT]      a note   |  edit TITLE TEXT   its text replaced   |  at TITLE FROM TO   cursor
//   list                   notes and devices            |  quit
import { files } from "../live/files.ts"
import { newSeed, start, type View } from "./node.ts"

const flag = (n: string, d?: string) => {
	const i = Deno.args.indexOf("--" + n)
	return i >= 0 ? Deno.args[i + 1] : d
}
const name = flag("name", "deno")!
const dir = flag("store") ?? await Deno.makeTempDir({ prefix: "ermine-notes-peer-" })
const backend = files(dir)
let seed: Uint8Array
try {
	seed = await Deno.readFile(`${dir}/seed.bin`)
} catch {
	seed = newSeed()
	await Deno.mkdir(dir, { recursive: true })
	await Deno.writeFile(`${dir}/seed.bin`, seed)
}
let view: View | undefined
let last = ""
const describe = (v: View) =>
	v.notes.map((n) => `${n.title}: ${n.versions.map((t) => JSON.stringify(t)).join(" | ")}`).join(
		"\n",
	) +
	"\n" +
	v.peers.map((p) =>
		`  ${p.live ? "*" : "-"} ${p.name}${p.self ? " (you)" : ""}${
			p.note ? ` in ${p.note} ${p.from}-${p.to}` : ""
		}`
	).join("\n")
const n = await start({
	backend,
	seed,
	name,
	colour: "#36c",
	folder: flag("folder"),
	server: flag("server"),
	service: flag("service"),
	legacy: Deno.args.includes("--legacy"),
	render: (v) => {
		view = v
		// not the age of a beat: only what is on show
		const text = describe({ ...v, peers: v.peers.map((p) => ({ ...p, age: 0 })) })
		if (text !== last) console.log(last = text), console.log("--")
	},
	log: (l) => console.log("#", l),
})
console.log(`device ${n.key.slice(0, 12)}; folder ${n.folder}; kept in ${dir}`)
const rest = (s: string, k: number) => s.split(" ").slice(k).join(" ")
const text = (t: string) => view?.notes.find((x) => x.title === t)?.versions[0] ?? ""
const decoder = new TextDecoder()
let buffer = ""
for await (const chunk of Deno.stdin.readable) {
	buffer += decoder.decode(chunk, { stream: true })
	let at
	while ((at = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, at).trim()
		buffer = buffer.slice(at + 1)
		const [cmd, title] = line.split(" ")
		try {
			if (cmd === "make") await n.make(title, rest(line, 2))
			else if (cmd === "edit") n.edit(title, text(title), rest(line, 2))
			else if (cmd === "at") n.at(title, Number(line.split(" ")[2]), Number(line.split(" ")[3]))
			else if (cmd === "list" && view) console.log(describe(view))
			else if (cmd === "quit") {
				await n.close()
				Deno.exit(0)
			}
		} catch (e) {
			console.log("error:", String(e))
		}
	}
}
await n.close()
