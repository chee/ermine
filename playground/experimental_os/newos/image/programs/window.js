// /programs/window: does something to the focused window, as wm's bin/window
// does (github.com/chee/wm): a line to the window manager's ctl
// (/dev/wm/ctl), then it ends. Its words are its data's args, as a binding in
// /etc/keys gives them (s-w = window close):
//
//   window close | minimize | restore | raise | lower
//   window move x-10 | y+10 | <x> <y>       points, by so many or to there
//   window resize x+10 | y-10 | <w> <h>
//   window tag <tag>[+<tag>...]             its tags; tag 2 shows it in view 2
//   window send left|right|up|down          to the next column, or along it, while tiled
//   window mode default|stack|max           its column's mode, while tiled
import { data, val } from "ermine:kit"
import { end } from "ermine:os"

export default (given) => {
	const { api, call } = given
	const [verb, ...rest] = data(given)?.args ?? []
	const WM = ["/", "dev", "wm"]
	const ctl = val(api, [...WM, "ctl"])
	const u = val(api, ["/", "dev", "display", "mode"])?.unit ?? 1
	// the focused window, as the window manager keeps it: where it is and how big
	const focus = val(api, ["/", "dev", "display", "focus"])
	const c = focus ? val(api, [...WM, "client", focus]) : null
	// x-10, y+10: so many points along one axis from where it is; two numbers: there
	const by = (a, b, x, y) => {
		const m = /^([xy])([+-])(\d+)$/.exec(a ?? "")
		if (m) {
			const d = Number(m[3]) * u * (m[2] === "-" ? -1 : 1)
			return m[1] === "x" ? [x + d, y] : [x, y + d]
		}
		return Number.isFinite(Number(a)) && Number.isFinite(Number(b))
			? [Number(a), Number(b)]
			: null
	}
	const line = (() => {
		switch (verb) {
			case "close":
				return "kill"
			case "minimize":
			case "restore":
			case "raise":
			case "lower":
				return verb
			case "move": {
				const to = c && by(rest[0], rest[1], c.x, c.y)
				return to && `move ${to[0]} ${to[1]}`
			}
			case "resize": {
				const to = c && by(rest[0], rest[1], c.w, c.h)
				return to && `resize ${to[0]} ${to[1]}`
			}
			case "tag":
				return rest[0] && `tag sel ${rest[0]}`
			case "send":
				return rest[0] && `send sel ${rest[0]}`
			case "mode":
				return rest[0] && `colmode sel ${rest[0]}`
		}
		return null
	})()
	let said = line
		? null
		: `close|minimize|restore|raise|lower|move|resize|tag|send|mode, not ${
			[verb, ...rest].join(" ")
		}`
	if (line && Array.isArray(ctl)) said = String(call(ctl, [line]))
	if (said !== "ok") console.log("window:", said ?? "no window manager")
	end(given)
}
