// /programs/view: shows a tag, as wm's bin/workspace switch does: a line to
// the window manager's ctl (/dev/wm/ctl), then it ends. view 2 (A-2 in
// /etc/keys) shows the windows tagged 2.
import { data, val } from "ermine:kit"
import { end } from "ermine:os"

export default (given) => {
	const { api, call } = given
	const [tag] = data(given)?.args ?? []
	const ctl = val(api, ["/", "dev", "wm", "ctl"])
	const said = tag && Array.isArray(ctl) ? String(call(ctl, [`view ${tag}`])) : "view <tag>"
	if (said !== "ok") console.log("view:", said)
	end(given)
}
