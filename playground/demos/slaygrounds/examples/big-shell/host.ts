// big-shell's host: the world, one process (the shell, working in /var/shell so its state is saved
// and a reload finds it), and a little filesystem to walk around in. the shell starts the others
// (ticker, lamp, bunny, mirror) itself, at run time, from /code/<export>: so every function
// export of program.ts is written there on a reload (the world writes only the exports its
// processes run)
import { type API } from "@ermine/api"
import { getWho } from "@ermine/places/header"
import * as lib from "@ermine/places/lib"
import { ATTRIBUTES, satisfy } from "@ermine/programs"
import { installTypes } from "@ermine/types"
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const JS = "com.netscape.javascript-source"
const TEXT = "public.plain-text"
const JSON_TYPE = "public.json"
const PROGRAMS = ["ticker", "lamp", "bunny", "mirror"]

// the pairs of a header, walking the "owner" links outward: caller and trusted are in there somewhere
export const flat = (pairs: readonly (readonly [string, unknown])[] = []) => {
	const out: [string, unknown][] = []
	for (let p: any = pairs; p;) {
		let up
		for (const [k, v] of p) k === "owner" ? (up = v) : out.push([k, v])
		p = up
	}
	return out
}

const world = createWorld({
	render,
	processes: [{ name: "shell", at: ["shell"], cwd: ["var", "shell"] }],
	// the shell's own tools, what the old Tools had that the api has not:
	//   attrs(x, says?)  a node's attributes by ATTRIBUTES' words ({ type, takes, … }), read (tracked);
	//                    with says, each one written first (ls, which and echo show types)
	//   which(name, from)  what a name finds from a place: satisfy, taken whole: { program, chains,
	//                    why }, or { refused, … } (a command, and what runs it)
	//   change(x)        the last change of x's value: time, actor, pairs (flat), site; tracked (stat)
	//   who()            who a write made now is: actor and the pairs, flat (whoami)
	//   inspect(address) pick a node in the page's graph tab
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
		change(x: { path?: readonly string[] }) {
			const id = x.path && lib.get(ctx.places, x.path)
			const c = id === undefined ? undefined : ctx.places.readChange("value", id)
			return c &&
				{ time: c.time, actor: c.actor, metadata: flat(c.metadata), external: c.external }
		},
		who() {
			const w = getWho(ctx.scheduler)
			return w && { actor: w.actor, metadata: flat(w.metadata) }
		},
		inspect: (address: string[]) => (parent as any).__pick?.(address),
	}),
})

// the types (what a node says it is is matched against what a loader takes), a little filesystem
const { s, host, table, header } = world.world
s.runWithScope(host, () => world.world.places.commit(installTypes(table, "root", header())))
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

// a reload: the programs' exports are nodes in /code (typed javascript, as the world makes its own),
// then the world starts the shell again on its code
export function reload(mod: Record<string, unknown>) {
	world.seed((h) => {
		for (const name of PROGRAMS) {
			const code = mod[name]
			if (typeof code !== "function") continue
			const node = h.open(["code", name])
			if (h.read(node) === undefined) h.open(["code", name], code)
			else h.edit(node, [{ path: [], value: code }])
			h.edit(h.info(node), [{ path: [ATTRIBUTES.type], value: JS }])
		}
	})
	world.reload(mod)
}
