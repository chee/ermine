// /programs/wmiirc: the window manager's policy, as wmii's wmiirc is. It
// runs what /etc/keys binds a chord to when the wm hears it, and what a menu
// item runs (a Run event), keeps a task bar item for each tag, and at boot
// starts again the windows the wm keeps away (/dev/wm/client/<id>, away),
// minimized ones minimized. A click on a reading in the menu bar opens the node
// it reads (its from) in the graph browser. It binds no keys of its own: every binding is
// data, as github.com/chee/wm's are.
// It reads /dev/wm/event (and rbar, a reading's from; /etc/ermine's boot) and calls /dev/wm/ctl and launch, nothing else: edit
// it, save, and replace it (cmd-r in the editor) to change how the desktop behaves.
//
//   /etc/keys        a document, {chord: command}: what each chord the wm takes runs. A chord is
//                    Emacs's: modifiers A (alt), C (control), H (fn), S (shift), s (cmd), then the key,
//                    lower case (return, space, tab, period, comma, left…): A-return, s-S-1. A command is
//                    a program and its words, started through launch in /apps/<its name>, its words
//                    its data's args (A-return = term, A-2 = view 2, s-w = window close); or an
//                    address, a handler or a node holding one's address (/dev/wm/ctl), called with
//                    the rest of the line. The Keys app (/programs/keys) edits it.
//   window, view, select, layout   the wm's own doings, as small programs: each a line to ctl
import { drop, effect, idAt, make, put, val, whole } from "ermine:kit"
import * as readline from "ermine:readline"

export default (given) => {
	const { api, call } = given
	const WM = ["/", "dev", "wm"]
	const KEYS = ["/", "etc", "keys"]
	// the names in a folder with a loaded node in their list
	const listed = (api, at) =>
		api.children(at).filter((n) => api.children(at, n).some((i) => i.node))
	// what a line says to ctl is answered in /dev/wm/said, as a call answers nothing from a part
	const ctl = ({ api, call }, line) => call(val(api, [...WM, "ctl"]), [line])
	// what the person starts, the window manager starts (/dev/wm/launch), so it lives as long as the
	// window manager does, not as long as the run of this effect that asked (SCHEDULER.tex, Children)
	const launch = ({ api, call, start }, folder, program, data) => {
		const op = {
			address: ["/", "apps", folder],
			program: program.split("/").filter((n) => n),
			...(data ? { data } : {}),
		}
		const to = val(api, [...WM, "launch"])
		if (Array.isArray(to)) return call(to, [op])
		const pid = start({ address: op.address, program: op.program })
		if (data) put(api, pid, "data", data)
		return pid
	}

	// a binding: its chord, as written, made the one way the wm writes a key it hears
	const bindings = (api) => {
		const v = val(api, KEYS)
		// m, meta: cmd (s) while ermineOS takes the Mac over, else alt (A)
		const meta = val(api, ["/", "dev", "display", "mode"])?.takeover ? "s" : "A"
		const out = {}
		if (v && typeof v === "object" && !Array.isArray(v)) {
			for (const [k, c] of Object.entries(v)) {
				if (typeof c === "string") out[readline.normal(k, meta)] = c
			}
		}
		return out
	}
	// a command: an address called, or a program started with its words
	const run = (g, line) => {
		const { api, call } = g
		const [first, ...args] = line.trim().split(/\s+/).filter((w) => w)
		if (!first) return
		if (first.startsWith("/")) {
			// a handler, or a node holding a handler's address (as /dev/wm/ctl does): given the rest of the line
			const at = ["/", ...first.split("/").filter((n) => n)]
			const held = val(api, at)
			const to = Array.isArray(held) && held.every((n) => typeof n === "string") ? held : at
			return call(to, args.length ? [args.join(" ")] : [])
		}
		// /programs/<name>, or a path from the root (programs/term); in /apps/<its last name>, made if it is not there
		const program = first.includes("/") ? first : `programs/${first}`
		const folder = program.split("/").filter((n) => n).at(-1)
		make(api, ["/", "apps"], folder, null)
		return launch(g, folder, program, args.length ? { args } : null)
	}

	// windows come back: each away client (/dev/wm/client/<id>, the wm's) whose process is not running, as
	// none is after a boot, is started again through launch, given that client, so the wm puts it where it
	// was, in its columns and as far back in the stack, the one focused focused: a terminal comes back as a
	// fresh shell there. Replaced, this finds them running and starts none
	const back = val(api, [...WM, "launch"])
	const running = (api, e) =>
		Array.isArray(e.node) &&
		api.children(e.node.slice(0, -1), e.node.at(-1)).some((i) => i.id === e.pid)
	const away = listed(api, [...WM, "client"]).flatMap((id) => {
		const c = val(api, [...WM, "client", id])
		return c?.away && c.start ? [{ id, ...c }] : []
	})
	for (const e of Array.isArray(back) ? away : []) {
		try {
			if (!running(api, e)) call(back, [e.start, { client: e.id }])
		} catch {
			// a window that cannot start again leaves the others be
		}
	}
	// with none to bring back and no window open, as at a first boot or after the last was closed, a terminal
	const WINDOWS = ["/", "dev", "display", "windows"]
	const open = listed(api, WINDOWS).some((n) => val(api, [...WINDOWS, n])?.title != null)
	if (!away.length && !open) launch(given, "term", "programs/term")
	// an ermine on the desk, when /etc/ermine says boot: true (programs/ermine), unless one runs already, as when this is replaced
	if (
		val(api, ["/", "etc", "ermine"])?.boot === true &&
		!listed(api, ["/", "apps", "ermine"]).length
	) run(given, "ermine")

	// a task bar item for each tag, the one shown lit: inverted, black on the paper. A part of its own: the view
	// changes when the events part asks for it (view 2), and a part is not run by what its own run brought about
	const LBAR = [...WM, "lbar"]
	effect(given, "tags", ({ api }) => ({
		lbar: !!idAt(api, LBAR),
		view: val(api, [...WM, "view"]) ?? null,
		names: listed(api, [...WM, "tag"]),
	}), ({ value: { lbar, view, names }, api }) => {
		if (!lbar) return
		for (const name of names) {
			const value = { text: name, ...(name === view ? { bg: "line", fg: "paper" } : {}) }
			if (!idAt(api, [...LBAR, name])) make(api, LBAR, name, value, { ephemeral: true })
			else if (JSON.stringify(val(api, [...LBAR, name])) !== JSON.stringify(value)) {
				api.write([...LBAR, name], whole(value))
			}
		}
		for (const name of api.children(LBAR)) {
			const items = api.children(LBAR, name)
			if (!names.includes(name) && items[0]) drop(api, LBAR, name, items[0].id)
		}
	})

	let seen = val(api, [...WM, "event"])?.n ?? 0
	// the wm's nodes are its own, ephemeral: killed, they go, and this waits for the next to place them
	effect(given, "events", ({ api }) => ({ ev: val(api, [...WM, "event"]) ?? null }), (g) => {
		const { api, value: { ev } } = g
		if (!ev) return
		// a wm started again counts its events from nothing
		if (ev.n < seen) seen = 0
		for (const e of ev.events) {
			if (e.n <= seen) continue
			seen = e.n
			try {
				if (e.type === "Key") {
					const line = bindings(api)[readline.normal(e.key)]
					if (line) run(g, line)
				} else if (e.type === "Run") run(g, e.command)
				else if (e.type === "LeftBarClick") ctl(g, `view ${e.item}`)
				else if (e.type === "RightBarClick") {
					const from = val(api, [...WM, "rbar", e.item])?.from
					if (
						Array.isArray(from) && from[0] === "/" &&
						from.slice(1).every((n) => typeof n === "string")
					) run(g, `graph /${from.slice(1).join("/")}`)
				}
				// a click on the desk does nothing: the world menu is the rabbit's, the wm's menu bar's first
			} catch {
				// a binding that failed leaves the others be
			}
		}
	})
}
