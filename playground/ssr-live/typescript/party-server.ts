// the party's server: one ermine, the shared nodes and their clocks, a process per visitor, on
// PORT (8788). LLM generated: a prototype. the ermine is a device in a tippet room too (room.ts):
// a page of the tippet version runs its visitor itself, synced through here, and is here while its
// link is up
//   deno task party        (in playground/ssr-live; from the repo's root: deno task ssr-live-party)
import { createErmine, hasNode, patch, remove } from "@ermine/system"
import { createLive } from "./live.ts"
import { clocks, EPHEMERAL, LOCAL, party, setupShared } from "./party.tsx"
import { fonts, style } from "./party-style.ts"
import { createRoom } from "./room.ts"
import { shortIds } from "./ids.ts"

const read = (name: string) => Deno.readTextFile(new URL(`../client/${name}`, import.meta.url))
export const client = await read("live.js")
export const pollClient = await read("live-poll.js")
export const sound = await read("party-sound.js")
// the tippet version's script, when it is built (deno task tippet-build)
const tippet = await read("tippet.js").catch(() => undefined)
// a visitor gone this long is stopped (and leaves /shared/here)
const LINGER = 15_000

export async function serveParty(port: number) {
	const ermine = createErmine({ features: [shortIds()], host: { setup: setupShared } })
	for (const [at, clock] of clocks) ermine.start(clock, at)
	// a visitor's presence, by its process's path (/visitors/<id>)
	const here = (path: string) => `/shared/here/${path.split("/").pop()}`
	const away = (path: string, away: boolean) =>
		ermine.within(() =>
			hasNode(here(path)) && patch(here(path), [{ path: ["away"], value: away }])
		)
	const gone = (path: string) => ermine.within(() => hasNode(here(path)) && remove(here(path)))
	// a tippet page: here while its link is up, away when it drops, gone after LINGER (or LINGER
	// after its html, if it never links)
	const leaving = new Map<string, ReturnType<typeof setTimeout>>()
	const leave = (path: string) =>
		leaving.set(path, setTimeout(() => (leaving.delete(path), gone(path)), LINGER))
	const room = await createRoom(ermine, {
		at: "/shared",
		local: LOCAL,
		ephemeral: EPHEMERAL,
		seen(id, on) {
			const path = `/visitors/${id}`
			clearTimeout(leaving.get(path))
			away(path, !on)
			if (!on) leave(path)
		},
	})
	const live = createLive(ermine, party, {
		client,
		pollClient,
		title: "ermine party",
		style,
		head: fonts,
		linger: LINGER,
		scripts: { "party-sound.js": sound },
		away: (path) => away(path, true),
		back: (path) => away(path, false),
		gone,
		tippet: tippet === undefined ? undefined : {
			script: tippet,
			says: (path) => ({
				room: room.path,
				root: room.tie.root,
				have: JSON.stringify(room.have()),
				process: path,
			}),
			rendered: leave,
		},
	})
	const server = Deno.serve(
		{ port, onListen: () => {} },
		(request) => room.fetch(request) ?? live.fetch(request),
	)
	return { ermine, live, room, server }
}

// the port, when PORT says none
const PORT = 8788

if (import.meta.main) {
	const port = Number(Deno.env.get("PORT") ?? PORT)
	await serveParty(port)
	console.log(
		`ermine party: http://localhost:${port}/ (GET and POST only: /?poll, no script: /?plain, ` +
			`the page's own ermine: /?v=tippet)`,
	)
}
