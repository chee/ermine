// /programs/layout: how the view lays its windows out, a line to the window
// manager's ctl (/dev/wm/ctl), then it ends: layout tile (wmii's columns),
// float (each where it was), toggle.
import { data, drop, val } from "ermine:kit"
import { here } from "ermine:os"

export default (given) => {
	const { api, call, self, name } = given
	const [how] = data(given)?.args ?? []
	const ctl = val(api, ["/", "dev", "wm", "ctl"])
	const said = how && Array.isArray(ctl)
		? String(call(ctl, [`layout ${how}`]))
		: "layout tile|float|toggle"
	if (said !== "ok") console.log("layout:", said)
	drop(api, here(self).slice(0, -1), name, self)
}
