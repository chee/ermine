// big-shell's host: the world, one process (the shell, working in /var/shell so its state is saved
// and a reload finds it), and a little filesystem to walk around in. the shell starts the others
// (ticker, lamp, bunny, mirror) itself, at run time, from /code/<export>: so every function
// export of program.ts is written there on a reload (the world writes only the exports its
// processes run)
import { type API } from "@ermine/api"
import { ATTRIBUTES, satisfy } from "@ermine/programs"
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const TEXT = "public.plain-text"
const JSON_TYPE = "public.json"
const PROGRAMS = ["ticker", "lamp", "bunny", "mirror"]

const world = createWorld({
	render,
	processes: [{ name: "shell", at: ["shell"], cwd: ["var", "shell"] }],
	// the types: what a node says it is is matched against what a loader takes
	types: true,
	// the shell's own tools, what the api and the world have not (stat, whoami and inspect are the
	// world's change, who and inspect):
	//   attrs(x, says?)  a node's attributes by ATTRIBUTES' words ({ type, takes, … }), read (tracked);
	//                    with says, each one written first (ls, which and echo show types)
	//   which(name, from)  what a name finds from a place: satisfy, taken whole: { program, chains,
	//                    why }, or { refused, … } (a command, and what runs it)
	extend: (api: API, ctx) => ({
		attrs(x: any, says?: Partial<Record<keyof typeof ATTRIBUTES, unknown>>) {
			const info = api.info(x)
			if (says !== undefined) {
				for (const [word, v] of Object.entries(says)) {
					const name = ATTRIBUTES[word as keyof typeof ATTRIBUTES]
					if (name === undefined) throw new Error(`attrs: no attribute ${word}`)
					api.edit(info, [{ path: [name], value: v }])
				}
			}
			const out: Record<string, any> = {}
			for (const [word, name] of Object.entries(ATTRIBUTES)) {
				const v = api.read(info, [name])
				if (v !== undefined) out[word] = v
			}
			return out
		},
		which(name: string, from: string[]) {
			const why: any[] = []
			let own: any = null
			const ways = [
				...satisfy(ctx.places, name, from, {
					onwhynot: (w) => void ("for" in w ? why.push(w) : (own = w)),
				}),
			]
			if (own?.why === "nothing-there") return { refused: own.why, path: own.path, at: own.from }
			if (own !== null) return { refused: own.why, program: { id: own.id, at: own.at }, why }
			return { program: ways[0].program, chains: ways.map((w) => w.chain), why }
		},
	}),
})

// a little filesystem
world.seed((h) => {
	const text = (path: string, v: string) => {
		h.open(path, v)
		h.edit(h.info(path), [{ path: [ATTRIBUTES.type], value: TEXT }])
	}
	text("/home/readme", "hi! this is the graph. try ls, tree /, cat, stat, run lamp, help")
	text("/home/notes/today", "make the shell")
	h.open("/home/numbers", [1, 2, 3])
	h.edit(h.info("/home/numbers"), [{ path: [ATTRIBUTES.type], value: JSON_TYPE }])
	text("/etc/motd", "🐰 the ermine shell. type help, or ls")
})

// a reload: the programs' exports are nodes in /code (the world's code), then the world starts
// the shell again on its code
export function reload(mod: Record<string, unknown>) {
	for (const name of PROGRAMS) if (typeof mod[name] === "function") world.code(name, mod[name])
	world.reload(mod)
}
