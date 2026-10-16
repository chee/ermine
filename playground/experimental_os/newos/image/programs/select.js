// /programs/select: focuses another window, a line to the window manager's
// ctl (/dev/wm/ctl), then it ends:
//
//   select next | prev          the one at the back to the front, or the one behind the front
//   select left|right|up|down   while tiled, the column or the window that way; floating, up is
//                               prev and down next, so one binding serves both
//   select <id>                 that one, back from minimized if it was
import { data, drop, val } from "ermine:kit"
import { here } from "ermine:os"

export default (given) => {
	const { api, call, self, name } = given
	const [to] = data(given)?.args ?? []
	const WM = ["/", "dev", "wm"]
	const ctl = val(api, [...WM, "ctl"])
	const view = val(api, [...WM, "view"])
	const tiled = val(api, [...WM, "tag", String(view)])?.layout === "tile"
	const line = tiled
		? `select ${to}`
		: to === "down"
		? "select next"
		: to === "up"
		? "select prev"
		: to === "left" || to === "right"
		? null
		: `select ${to}`
	const said = to && line && Array.isArray(ctl) ? String(call(ctl, [line])) : null
	if (line && said !== "ok") {
		console.log("select:", said ?? "select next|prev|left|right|up|down|<id>")
	}
	drop(api, here(self).slice(0, -1), name, self)
}
