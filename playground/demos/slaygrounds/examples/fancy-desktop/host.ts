// fancy-desktop's host: the world (@ermine/slaygrounds/world), one process, the shell, running
// program.ts's shell export, the things a person keeps (seeded below), and what the desktop needs
// that the api does not say (extend, at the end): what opens a thing, found from where it was
// reached, and a walk up from a place. the apps are nodes in /apps, written here from program.ts's
// apps each reload (a live function, typed javascript, the types it opens and the keys it wants in
// its attributes); the shell starts a window process for each window it keeps (/windows) and finds
// what opens a thing with openwith, so what runs an app is /apps/run, the world's own runner
import { createWorld } from "@ermine/slaygrounds/world"
import type { API, Node } from "@ermine/api"
import { get, lookup } from "@ermine/places/lib"
import { plan as steps } from "@ermine/places/path"
import { ATTRIBUTES, openwith, type Way, type Why } from "@ermine/programs"
import { installTypes } from "@ermine/types"
import { render } from "ermine-h"

const JS = "com.netscape.javascript-source"

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
export type Extra = {
	// the nearest place walking up from `from` (names from the root) where the address is: its
	// node and id (places' lookup; tracked in a run)
	up: (address: string[], from: string[]) => (Node & { id: string }) | undefined
	// what opens the thing at the address (names from the root): openwith from the folder it was
	// reached in, up to the root: every way, nearest first, and each candidate not taken with why.
	// the api's openwith goes from this process's own working folder; a thing is opened from where
	// it was reached (the dock's doodle in the viewer, the sketches' doodle in paint). tracked
	opening: (address: string[]) => Opening
}

const world = createWorld({
	render,
	processes: [{ name: "shell", export: "shell" }],
	actor: "chee@laptop",
	extend: (_api: API, ctx): Extra => ({
		up(address, from) {
			const at = lookup(ctx.places, address, from)
			const id = at && get(ctx.places, at)
			return typeof id === "string" ? { path: at, part: "value", id } : undefined
		},
		opening(address) {
			const names = steps(address)
			const id = names && get(ctx.places, names)
			if (typeof id !== "string") return { missing: `nothing at /${(names ?? []).join("/")}` }
			const from = names!.slice(0, -1)
			const why: Why[] = []
			let refused: string | null = null
			const ways = [
				...openwith(ctx.places, id, from, {
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
	}),
})

// ---- seed: the types, then the folders a person keeps things in. a thing says its type in its
// attributes, whole; a folder is a node with no value ----
const typed = (host: API, path: string, value: unknown, uti: string, more: object = {}) => {
	const n = host.open(path, value)
	host.edit(host.info(n), [{ path: [], value: { [ATTRIBUTES.type]: uti, ...more } }])
	return n
}
world.seed((host) => {
	const { table, places, header } = world.world
	// the types, as nodes at /ermine/types: the well-known list, then this desktop's own
	places.commit(installTypes(table, "root", header()))
	places.commit(installTypes(table, "root", header(), OWN))
	// /apps holds loaders: its children are looked at in its place (the apps are written there on
	// load), and the world's runner is among them, so what runs an app is found beside it
	typed(host, "/apps", null, FOLDER, { [ATTRIBUTES.loaders]: true })
	host.place("/apps/run", "/code/run")
	typed(host, "/system", null, FOLDER)
	host.open("/system/palette", PALETTE)
	host.open("/system/log", ["✿ the desktop woke up"])
	typed(host, "/home", null, FOLDER)
	typed(
		host,
		"/home/hello",
		"hello!\n\nthis note is one node: /home/hello.\nopen it twice and type in either window.",
		TEXT,
	)
	typed(host, "/home/todo", [
		{ text: "water the ermine", done: true },
		{ text: "fold a window", done: false },
		{ text: "paint a cherry", done: false },
	], LIST)
	typed(host, "/home/pictures", null, FOLDER)
	typed(host, "/home/pictures/rabbit", RABBIT, PICTURE)
	typed(host, "/home/pictures/cherry", CHERRY, PICTURE)
	typed(host, "/home/sketches", null, FOLDER)
	typed(host, "/home/sketches/doodle", heart(), PICTURE)
	typed(host, "/home/clocks", null, FOLDER)
	typed(host, "/home/clocks/london", { label: "london", zone: "Europe/London" }, CLOCK)
	typed(host, "/home/clocks/tokyo", { label: "tokyo", zone: "Asia/Tokyo" }, CLOCK)
	// the windows' processes are placed here by the shell; each window's own things (what it
	// shows, its place on the screen) are kept in /windows
	typed(host, "/desktop", null, FOLDER)
	typed(host, "/windows", null, FOLDER)
	// the dock: things placed again (mounts), opened from here like anywhere else
	typed(host, "/dock", null, FOLDER)
	for (
		const [name, path] of Object.entries({
			files: "/home",
			hello: "/home/hello",
			todo: "/home/todo",
			doodle: "/home/sketches/doodle",
			london: "/home/clocks/london",
		})
	) host.place(`/dock/${name}`, path)
})

// a reload: the apps written into /apps (a node each: the function its value, typed javascript,
// what it opens, the keys it wants, its size), then the world's reload: the shell stopped and
// started again, and with it every window, each started on what is now at its app
export const reload = (mod: Record<string, unknown>) => {
	const apps = (mod.apps ?? {}) as Record<
		string,
		{ run: unknown; opens: string[]; keys?: string[]; size: number[] }
	>
	const { hostAPI, world: w } = world
	w.s.runWithScope(w.host, () => {
		for (const [name, app] of Object.entries(apps)) {
			const at = `/apps/${name}`
			const node = hostAPI.open(at)
			if (hostAPI.read(node) === undefined) hostAPI.open(at, app.run)
			else hostAPI.edit(node, [{ path: [], value: app.run }])
			hostAPI.edit(hostAPI.info(node), [{
				path: [],
				value: {
					[ATTRIBUTES.type]: JS,
					[ATTRIBUTES.opens]: app.opens,
					keys: app.keys ?? [],
					size: app.size,
				},
			}])
		}
		// paint is also placed in /home/sketches, catclock in /home/clocks: nearer to a sketch, a
		// clock there, than /apps is
		for (const [name, folder] of [["paint", "/home/sketches"], ["catclock", "/home/clocks"]]) {
			if (apps[name] && !hostAPI.entries(`${folder}/${name}`).length) {
				hostAPI.place(`${folder}/${name}`, `/apps/${name}`)
			}
		}
	})
	world.reload(mod)
}
