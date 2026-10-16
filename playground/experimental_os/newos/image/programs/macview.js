// /programs/macview: one Mac window shown as an ermine window. Its data,
// {window, fps?, input?}, names the window by its id (mac/<n>, that window
// only) or its node's address in /dev/mac/apps; it places its view node in /dev/mac/views and the mac
// driver does the rest: the owner, /dev/mac/windows/<the same name>, whose
// on/key and on/pointer wmii calls, and the layer, mac-<the same name>. It
// ends when the owner goes (wmii closed the window) or says gone (the window
// or its app went), and its view node with it.
import { data, drop, effect, make, val } from "ermine:kit"
import { here } from "ermine:os"

export default (given) => {
	const { api, self, name } = given
	const d = data(given) ?? {}
	const NAME = `view-${String(self).replace(/[^A-Za-z0-9]/g, "")}`
	const VIEW = ["/", "dev", "mac", "views", NAME]
	const OWNER = ["/", "dev", "mac", "windows", NAME]
	const value = {
		window: d.window ?? null,
		...(d.fps ? { fps: d.fps } : {}),
		...(d.input ? { input: d.input } : {}),
	}
	const view = make(api, VIEW.slice(0, -1), NAME, value, { ephemeral: true })
	// the view let go (its name would stay a name in /dev/mac/views, and the driver would not end the window), then this
	const end = (api) => {
		drop(api, VIEW.slice(0, -1), NAME, view)
		drop(api, here(self).slice(0, -1), name, self)
	}
	// the owner comes once the driver has the view; until then there is nothing to end on
	let seen = false
	effect(given, "owner", ({ api }) => val(api, OWNER) ?? null, ({ value: owner, api }) => {
		if (owner) seen = true
		if (seen && (!owner || owner.state === "gone")) end(api)
	})
}
