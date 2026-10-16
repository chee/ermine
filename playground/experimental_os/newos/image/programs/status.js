// /programs/status: the bar's right side, as wmiirc's status loop writes
// wmii's /rbar. Each reading is an item of its own in /dev/wm/rbar, written
// when the device it reads changes, so nothing polls. Its items are its own:
// they go when it does. rbar is the window manager's, ephemeral: killed, it
// goes, and each reading waits for the next to place it, then is placed again.
// Each item's fg (and the clock's bg) is a key of /etc/theme, which wmii reads as it
// draws; from, the node it reads, which a click opens.
import { effect, idAt, make, val, whole } from "ermine:kit"

export default (given) => {
	const RBAR = ["/", "dev", "wm", "rbar"]
	const dev = (api, ...path) => val(api, ["/", "dev", ...path])
	const item = (api, name, text, fg, from, bg) => {
		const value = {
			text,
			...(fg ? { fg } : {}),
			...(bg ? { bg } : {}),
			from: ["/", "dev", ...from],
		}
		if (!idAt(api, [...RBAR, name])) make(api, RBAR, name, value, { ephemeral: true })
		else if (JSON.stringify(val(api, [...RBAR, name])) !== JSON.stringify(value)) {
			api.write([...RBAR, name], whole(value))
		}
	}
	const RED = "cherry", AMBER = "butter", GREEN = "mint"
	// a reading, shown while there is an rbar to show it in
	const wm = (api) => !!idAt(api, RBAR)
	const reading = (n, read, show) =>
		effect(
			given,
			n,
			({ api }) => ({ on: wm(api), v: read({ api }) }),
			({ value: { on, v }, api }) => {
				if (on) show(v, { api })
			},
		)

	reading("cpu", ({ api }) => dev(api, "cpu", "load")?.average ?? null, (avg, { api }) => {
		if (avg !== null) {
			item(api, "1cpu", `cpu ${String(avg).padStart(2)}%`, avg > 80 ? RED : undefined, [
				"cpu",
				"load",
			])
		}
	})
	reading("mem", ({ api }) => dev(api, "cpu", "memory") ?? null, (m, { api }) => {
		if (m?.total) {
			item(
				api,
				"2mem",
				`mem ${Math.round(100 - (m.free / m.total) * 100)}%`,
				m.pressure === "critical" ? RED : m.pressure === "warn" ? AMBER : undefined,
				["cpu", "memory"],
			)
		}
	})
	reading("net", ({ api }) => dev(api, "net", "path") ?? null, (n, { api }) => {
		if (!n) return
		const kinds = (n.interfaces ?? []).map((i) => i.type).filter((t) =>
			t !== "loopback" && t !== "other"
		)
		item(
			api,
			"3net",
			`net ${n.status === "satisfied" ? "●" : "○"} ${kinds.join(",")}`,
			n.status === "satisfied" ? GREEN : RED,
			["net", "path"],
		)
	})
	reading(
		"usb",
		({ api }) =>
			api.children(["/", "dev", "usb"]).filter((n) =>
				api.children(["/", "dev", "usb"], n).some((x) => x.id.startsWith("usb/"))
			).length,
		(n, { api }) => item(api, "4usb", `usb ${n}`, undefined, ["usb"]),
	)
	reading("battery", ({ api }) => dev(api, "power", "battery") ?? null, (b, { api }) => {
		if (!b) return
		const pct = b.percent === null || b.percent === undefined ? "" : `${b.percent}%`
		item(
			api,
			"5battery",
			`${b.ac ? "⚡" : "▪"} ${pct}${b.charging ? " charging" : ""}`,
			!b.ac && b.percent !== null && b.percent < 20 ? RED : undefined,
			["power", "battery"],
		)
	})
	reading("thermal", ({ api }) => dev(api, "power", "thermal") ?? null, (t, { api }) => {
		if (t) {
			item(
				api,
				"6thermal",
				t.state + (t.lowPower ? " low-power" : ""),
				{ nominal: GREEN, fair: AMBER, serious: "peach", critical: RED }[t.state],
				["power", "thermal"],
			)
		}
	})
	reading("clock", ({ api }) => dev(api, "clock", "wall") ?? null, (w, { api }) => {
		// the clock in its tray, as catclock's dock has it: /etc/theme's tray, a pink to a blue
		if (w) item(api, "7clock", w, "paper", ["clock", "wall"], "tray")
	})
}
