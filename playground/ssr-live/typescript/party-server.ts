// the party's server: one ermine, the shared nodes and their clocks, a process per visitor, on
// PORT (8788). LLM generated: a prototype
//   deno task party        (in playground/ssr-live; from the repo's root: deno task ssr-live-party)
import { createErmine, hasNode, patch, remove } from "@ermine/system"
import { createLive } from "./live.ts"
import { clocks, party, setupShared } from "./party.tsx"
import { fonts, style } from "./party-style.ts"

const read = (name: string) => Deno.readTextFile(new URL(`../client/${name}`, import.meta.url))
export const client = await read("live.js")
export const pollClient = await read("live-poll.js")
export const sound = await read("party-sound.js")
// a visitor gone this long is stopped (and leaves /shared/here)
const LINGER = 15_000

export function serveParty(port: number) {
	const ermine = createErmine({ host: { setup: setupShared } })
	for (const [at, clock] of clocks) ermine.start(clock, at)
	// a visitor's presence, by its process's path (/visitors/<id>)
	const here = (path: string) => `/shared/here/${path.split("/").pop()}`
	const away = (path: string, away: boolean) =>
		ermine.within(() =>
			hasNode(here(path)) && patch(here(path), [{ path: ["away"], value: away }])
		)
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
		gone: (path) => ermine.within(() => hasNode(here(path)) && remove(here(path))),
	})
	const server = Deno.serve({ port, onListen: () => {} }, live.fetch)
	return { ermine, live, server }
}

// the port, when PORT says none
const PORT = 8788

if (import.meta.main) {
	const port = Number(Deno.env.get("PORT") ?? PORT)
	serveParty(port)
	console.log(
		`ermine party: http://localhost:${port}/ (GET and POST only: /?poll, no script: /?plain)`,
	)
}
