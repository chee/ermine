// fancy-desktop's host: the world (@ermine/slaygrounds/world), one process, the shell, running
// program.ts's shell export, the things a person keeps (seeded below), and what the desktop needs
// that the system functions do not say (extend, at the end): what opens a thing, found from where it
// was reached (a walk up from a place is the world's up), and the id of the node at a path. the
// apps are nodes in /apps, written here from program.ts's apps each reload (a live function, run as
// it is: no type, so no runner is looked for; the types it opens and the keys it wants in its
// attributes); the shell makes an app
// for each window it keeps (/windows) and finds what opens a thing with openwith. there is no
// process for a window: a program starts no program, and the world has no way to start one
import { createWorld } from "@ermine/slaygrounds/world"
import { ensureNode, hasNode, patch, patchAttributes, place } from "@ermine/system"
import { get } from "@ermine/core/places/lib"
import { plan as steps } from "@ermine/core/places/path"
import { ATTRIBUTES, openwith, type Way, type Why } from "@ermine/programs"
import { render } from "ermine-h"

// ---- seed: the root, then the folders a person keeps things in ----
// a picture: 16 rows of 16, each letter a colour of the palette
const PALETTE = [
	"#fffbe6",
	"#000000",
	"#ffffff",
	"#ff2284",
	"#40dcba",
	"#2269ff",
	"#ffff88",
	"#ffd9ea",
]
const letters = ".kwcmbyp"
const picture = (rows) => ({
	w: 16,
	h: 16,
	px: rows.flatMap((r) =>
		[...r.padEnd(16, ".").slice(0, 16)].map((c) => Math.max(0, letters.indexOf(c)))
	),
})
const RABBIT = picture([
	"................",
	"....kk....kk....",
	"...kwwk..kwwk...",
	"...kwpk..kpwk...",
	"...kwpk..kpwk...",
	"...kwpk..kpwk...",
	"....kwkkkkwk....",
	"...kwwwwwwwwk...",
	"..kwwwwwwwwwwk..",
	"..kwkwwwwwwkwk..",
	"..kwwwwppwwwwk..",
	"..kwwwwkkwwwwk..",
	"...kwwwwwwwwk...",
	"....kkwwwwkk....",
	"......kkkk......",
	"................",
])
const CHERRY = picture([
	"................",
	"..........kkk...",
	".........kmmmk..",
	"........kmmmk...",
	"........kkkk....",
	".......k..k.....",
	"......k...k.....",
	".....k....k.....",
	"....k.....k.....",
	"..kkkk...kkkk...",
	".kccwck.kccwck..",
	".kcccck.kcccck..",
	".kcccck.kcccck..",
	"..kkkk...kkkk...",
	"................",
	"................",
])
// a heart, worked out: inside (x²+y²−1)³ ≤ x²y³, a black line where inside meets outside
function heart() {
	const inside = (i, j) => {
		const x = (i - 7.5) / 6.2, y = (8 - j) / 6.2 + 0.15
		return (x * x + y * y - 1) ** 3 - x * x * y ** 3 <= 0
	}
	const px = []
	for (let j = 0; j < 16; j++) {
		for (let i = 0; i < 16; i++) {
			const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => !inside(i + a, j + b))
			px.push(!inside(i, j) ? 0 : edge ? 1 : i === 4 && j === 5 ? 2 : j > 9 ? 7 : 3)
		}
	}
	return { w: 16, h: 16, px }
}

// the types things here say they are: two well-known, three this desktop's own (a 16×16 picture
// in palette indices is no public.image file format, so it is its own type conforming to one)
const TEXT = "public.plain-text", FOLDER = "public.folder"
const PICTURE = "party.chee.ermine.picture"
const LIST = "party.chee.ermine.list"
const CLOCK = "party.chee.ermine.clock"
const OWN = [
	{ name: PICTURE, conformsTo: "public.image" },
	{ name: LIST, conformsTo: "public.json" },
	{ name: CLOCK, conformsTo: "public.json" },
]

// what the shell asks of the host (see program.ts)
export type Opening =
	| { missing: string }
	| {
		id: string
		names: string[]
		name: string
		from: string[]
		found: { refused: string } | { ways: Way[]; why: Why[] }
	}

const world = createWorld({
	render,
	processes: [{ name: "shell", export: "shell" }],
	actor: "chee@laptop",
	// the types, as nodes at /ermine/types: the well-known list, then this desktop's own
	types: OWN,
	extend: () => ({
		// what opens the thing at the address (names from the root): openwith from the folder it was
		// reached in, up to the root: every way, nearest first, and each candidate not taken with why.
		// a thing is opened from where it was reached (the dock's doodle in the viewer, the
		// sketches' doodle in paint). tracked, as it runs in the memo that asks
		opening(address: string[]): Opening {
			const places = world.ermine.places
			const names = steps(address)
			const id = names && get(places, names)
			if (typeof id !== "string") return { missing: `nothing at /${(names ?? []).join("/")}` }
			const from = names!.slice(0, -1)
			const why: Why[] = []
			let refused: string | null = null
			const ways = [
				...openwith(places, id, from, {
					onwhynot: (w) => void ("for" in w ? why.push(w) : (refused = w.why)),
				}),
			]
			return {
				id,
				names: names!,
				name: names!.at(-1)!,
				from,
				found: refused ? { refused } : { ways, why },
			}
		},
		// the id of the node at an absolute path, or none
		idOf: (path: string) => get(world.ermine.places, path.split("/").filter(Boolean)),
	}),
})

// ---- seed: the folders a person keeps things in. a thing says its type in its attributes,
// whole; a folder is a node with no value ----
const typed = (path: string, value: unknown, uti: string, more: object = {}) => {
	const n = ensureNode(path, value)
	patchAttributes(n, [{ path: [], value: { [ATTRIBUTES.type]: uti, ...more } }])
	return n
}
world.seed(() => {
	// /apps holds loaders: its children are looked at in its place (the apps are written there on
	// load), and the world's runner is among them, so what runs an app is found beside it
	typed("/apps", null, FOLDER, { [ATTRIBUTES.loaders]: true })
	typed("/system", null, FOLDER)
	ensureNode("/system/palette", PALETTE)
	ensureNode("/system/log", ["✿ the desktop woke up"])
	typed("/home", null, FOLDER)
	typed(
		"/home/hello",
		"hello!\n\nthis note is one node: /home/hello.\nopen it twice and type in either window.",
		TEXT,
	)
	typed("/home/todo", [
		{ text: "water the ermine", done: true },
		{ text: "fold a window", done: false },
		{ text: "paint a cherry", done: false },
	], LIST)
	typed("/home/pictures", null, FOLDER)
	typed("/home/pictures/rabbit", RABBIT, PICTURE)
	typed("/home/pictures/cherry", CHERRY, PICTURE)
	typed("/home/sketches", null, FOLDER)
	typed("/home/sketches/doodle", heart(), PICTURE)
	typed("/home/clocks", null, FOLDER)
	typed("/home/clocks/london", { label: "london", zone: "Europe/London" }, CLOCK)
	typed("/home/clocks/tokyo", { label: "tokyo", zone: "Asia/Tokyo" }, CLOCK)
	// the windows' processes are placed here by the shell; each window's own things (what it
	// shows, its place on the screen) are kept in /windows
	typed("/desktop", null, FOLDER)
	typed("/windows", null, FOLDER)
	// the dock: things placed again (mounts), opened from here like anywhere else
	typed("/dock", null, FOLDER)
	for (
		const [name, path] of Object.entries({
			files: "/home",
			hello: "/home/hello",
			todo: "/home/todo",
			doodle: "/home/sketches/doodle",
			london: "/home/clocks/london",
		})
	) place(`/dock/${name}`, path)
})

// a reload: the apps written into /apps (a node each: the function its value,
// what it opens, the keys it wants, its size), then the world's reload: the shell stopped and
// started again, and with it every window, each started on what is now at its app
export const reload = (mod: Record<string, unknown>) => {
	const apps = (mod.apps ?? {}) as Record<
		string,
		{ run: unknown; opens: string[]; keys?: string[]; size: number[] }
	>
	world.seed(() => {
		for (const [name, app] of Object.entries(apps)) {
			const at = `/apps/${name}`
			const node = ensureNode(at)
			patch(node, [{ path: [], value: app.run }])
			patchAttributes(node, [{
				path: [],
				value: {
					[ATTRIBUTES.opens]: app.opens,
					keys: app.keys ?? [],
					size: app.size,
				},
			}])
		}
		// paint is also placed in /home/sketches, catclock in /home/clocks: nearer to a sketch, a
		// clock there, than /apps is
		for (const [name, folder] of [["paint", "/home/sketches"], ["catclock", "/home/clocks"]]) {
			if (apps[name] && !hasNode(`${folder}/${name}`)) {
				place(`${folder}/${name}`, `/apps/${name}`)
			}
		}
	})
	world.reload(mod)
}
<<<<<<< Updated upstream
=======

let beats = 0
setInterval(() => {
	world.ermine.patch("/beat", [{ path: [], value: ++beats }])
}, 50)
>>>>>>> Stashed changes
