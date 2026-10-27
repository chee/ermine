// big-shell's host: the world, one process (the shell, at /var/shell/shell: its state is beside it,
// in /var/shell, so a reload finds it), and a little filesystem to walk around in. the shell would start the
// others (ticker, lamp, bunny, mirror) itself, at run time, from /code/<export>: so every function
// export of program.ts is written there on a reload (the world writes only the exports its
// processes run). nothing starts them now: a program starts no program, and the world has no way
// to start a process by name after it is made
import { ATTRIBUTES, satisfy } from "@ermine/programs"
import { createWorld } from "@ermine/slaygrounds/world"
import { ensureNode, patchAttributes } from "@ermine/system"
import * as lib from "@ermine/core/places/lib"
import { render } from "ermine-h"

const TEXT = "public.plain-text"
const JSON_TYPE = "public.json"
const PROGRAMS = ["ticker", "lamp", "bunny", "mirror"]

const world = createWorld({
	render,
	processes: [{ name: "shell", folder: ["var", "shell"] }],
	// the types: what a node says it is is matched against what a loader takes
	types: true,
	// the shell's own tools, what the system functions and the world have not (stat's change,
	// whoami's who and inspect are the world's tools):
	//   idOf(address)    the id of the node at an address: what a program has no way to name
	//   which(name, from)  what a name finds from a place: satisfy, taken whole: { program, chains,
	//                    why }, or { refused, … } (a command, and what runs it)
	extend: () => ({
		idOf: (address: string[]) => lib.get(world.ermine.places, address),
		which(name: string, from: string[]) {
			const why: any[] = []
			let own: any = null
			const ways = [
				...satisfy(world.ermine.places, name, from, {
					onwhynot: (w) => void ("for" in w ? why.push(w) : (own = w)),
				}),
			]
			if (own?.why === "nothing-there") return { refused: own.why, path: own.path, at: own.from }
			if (own !== null) return { refused: own.why, program: { id: own.id, at: own.at }, why }
			return { program: ways[0].program, chains: ways.map((w) => w.chain), why }
		},
	}),
})

<<<<<<< Updated upstream
=======
// the beat the programs that move count (a program has no timer that can call in): /beat, every 320ms
world.seed((h) => void h.ensureNode("/beat", 0))
let beats = 0
setInterval(() => {
	world.ermine.patch("/beat", [{ path: [], value: ++beats }])
}, 320)

>>>>>>> Stashed changes
// a little filesystem
world.seed(() => {
	const text = (path: string, v: string) => {
		ensureNode(path, v)
		patchAttributes(path, [{ path: [ATTRIBUTES.type], value: TEXT }])
	}
	text("/home/readme", "hi! this is the graph. try ls, tree /, cat, stat, help")
	text("/home/notes/today", "make the shell")
	ensureNode("/home/numbers", [1, 2, 3])
	patchAttributes("/home/numbers", [{ path: [ATTRIBUTES.type], value: JSON_TYPE }])
	text("/etc/motd", "🐰 the ermine shell. type help, or ls")
})

// a reload: the programs' exports are nodes in /code (the world's code), then the world starts
// the shell again on its code
export function reload(mod: Record<string, unknown>) {
	for (const name of PROGRAMS) if (typeof mod[name] === "function") world.code(name, mod[name])
	world.reload(mod)
}
