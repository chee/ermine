// room: the server's side of the tippet version. the server's ermine is one device in the room, as
// every page's is: its shared folder tied (tie.ts), a websocket for each page's link, and whether a
// page is here told while its link is up. a page links to the folder it was rendered from (?r, the
// folder's id): a server started again has another, and its old pages are refused, to load again
//
//   const room = await createRoom(ermine, { at: "/shared", local, seen: (visitor, here) => … })
//   Deno.serve((req) => room.fetch(req) ?? …)
//   room.have()   // what a page rendered now waits for before it takes over
import type { Ermine } from "@ermine/system"
import { socket } from "@ermine/tippet/carriers/websocket"
import { createTie, OTHER_ROOM } from "./tie.ts"

export async function createRoom(ermine: Ermine, o: {
	at: string
	local?: string[]
	ephemeral?: string[]
	// where pages link
	path?: string
	seen?: (visitor: string, here: boolean) => void
}) {
	const tie = await createTie(ermine, { at: o.at, local: o.local, ephemeral: o.ephemeral })
	const path = o.path ?? "/tippet"
	return {
		tie,
		path,
		// a page's link: a websocket at path, ?r the folder's id, ?p its visitor
		fetch(req: Request): Response | undefined {
			const url = new URL(req.url)
			if (url.pathname !== path || req.headers.get("upgrade") !== "websocket") return undefined
			const visitor = url.searchParams.get("p")
			const { socket: ws, response } = Deno.upgradeWebSocket(req)
			if (url.searchParams.get("r") !== tie.root) {
				ws.addEventListener("open", () => ws.close(OTHER_ROOM, "another room"))
				return response
			}
			tie.link(socket(ws))
			if (visitor) {
				ws.addEventListener("open", () => o.seen?.(visitor, true))
				ws.addEventListener("close", () => o.seen?.(visitor, false))
			}
			return response
		},
		have: () => (tie.flush(), tie.log.have()),
		stop: () => tie.stop(),
	}
}
