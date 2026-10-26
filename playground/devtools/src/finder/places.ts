// where things are in the page's graph: shaped like dens [chee 10-26]. one den a folder,
// /dens/<id>/, its id hex; the page's programs (/code) and the host's actions (/host) at the root,
// no den's. plain words, no reads: the host and the programs both build paths here, and nowhere
// else.
//
//   /dens/<this browser>/         this browser, a den: its id made once (install, below)
//     about                       { name: "this browser", what, note? }
//     page/…                      the page's state (what was /page): the door, the windows open,
//                                 join, the dock, the explorers' (page/finder/<name>/…), and
//                                 relay: the den the relay reaches (its id), null till its hello
//     finder/<name>/…             what this page's own graph said back to an explorer
//   /dens/<the mac's host key>/   the mac, a den once the relay's hello names its key
//     about                       { name, about } from the machine; away: the line went quiet
//     door/hello, door/auth/…     the relay's hello, a passkey knock's options asked for ahead
//     machine/…, applets, console/…, screen/…, surfaces/…, renderers/…
//     finder/<name>/…             what the mac's graph said back to an explorer

export const DENS = "/dens"
// a den's folder, or a place in it
export const den = (id: string, k?: string) => (k ? `${DENS}/${id}/${k}` : `${DENS}/${id}`)
export const isDenId = (s: unknown): s is string =>
	typeof s === "string" && /^[0-9a-f]{2,256}$/.test(s)

// this browser's den id: 32 random bytes as hex, made once and kept (ermine-love:install); where
// storage is blocked, a new one each load (remembered: false)
const KEY = "ermine-love:install"
const fresh = () =>
	Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0"))
		.join("")
export const install: { id: string; remembered: boolean } = (() => {
	try {
		let id = localStorage.getItem(KEY)
		if (!isDenId(id) || id.length !== 64) {
			id = fresh()
			localStorage.setItem(KEY, id)
		}
		return { id, remembered: localStorage.getItem(KEY) === id }
	} catch {
		return { id: fresh(), remembered: false }
	}
})()
export const BROWSER = install.id

// the page's state, in this browser's den
export const page = (k?: string) => den(BROWSER, k ? `page/${k}` : "page")
// the den the relay reaches: its id (the mac's host key, hex), or null
export const RELAY = page("relay")

// an explorer's two folders: what its graph said back (in the den it looks at) and what it shows
// (this page's state)
export const finderAt = (denId: string, name: string) => ({
	answers: den(denId, `finder/${name}`),
	shows: page(`finder/${name}`),
})

// whether a window shows now, from this page's state (its mode, whether it's in, the dock's windows
// in front): an area's window (the graph explorer's) while its mode is on; a docked one while it's
// in front in the dock, the dens showing. what nobody sees isn't kept up (its clocks don't run)
const AREAS: Record<string, string> = { graph: "graph" }
export const SHOWING = ["mode", "in", "shown"].map((k) => page(k))
export const shows = (name: string, [mode, inside, shown]: unknown[]) =>
	AREAS[name] !== undefined
		? mode === AREAS[name]
		: mode === "dens" && !!inside && Array.isArray(shown) && shown.includes(name)
