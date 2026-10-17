// /programs/ermine: a desktop ermine, as Neko and oneko: a white stoat that chases the pointer,
// sits, washes, yawns and sleeps while it rests, wakes (alert) when it moves, sometimes wanders.
// each launch is another; `ermine away` sends every one away.
//
//   /etc/ermine          {speed, above, sleepy, wander, boot, frames}: speed points/s; above: over
//                        the windows; sleepy: seconds before it yawns; wander: seconds between
//                        wanders (0 never); boot: wmiirc starts one; frames: the pictures' folder
//                        (null: /etc/ermine)
//   /etc/ermine/<frame>  pictures, read live: run-{right,upright,downright,up,down}-{1,2}, alert,
//                        sit, wash-1/2, yawn, sleep-1/2; left is right flipped unless run-left-* is
//                        drawn; a missing frame falls back to the nearest drawn
//   <its node>/state     ephemeral: {doing, x, y, facing, layer}
//
// layer /dev/display/layers/ermine-<pid>: no title, no owner, so clicks pass through. one pixels op
// of every frame side by side; a frame is its x, a step a layer move. ticks at the display's rate
// while running, 10/s awake, 4/s asleep.
import { data, drop, effect, handler, idAt, make, val, whole } from "ermine:kit"
import { after, here } from "ermine:os"

export default (given) => {
	const { api, onCleanup, self, name } = given
	const me = here(self), place = me.slice(0, -1)
	// away: every ermine beside this one is let go (its process node unplaced, its layer with it), then this
	if ((data(given)?.args ?? [])[0] === "away") {
		for (const n of api.children(place)) {
			if (n !== name) { for (const i of api.children(place, n)) drop(api, place, n, i.id) }
		}
		drop(api, place, name, self)
		return
	}
	const ETC = ["/", "etc", "ermine"]
	const MODE = ["/", "dev", "display", "mode"]
	const WINDOWS = ["/", "dev", "display", "windows"]
	const LAYER = ["/", "dev", "display", "layers", `ermine-${self}`]
	const STATE = [...me, "state"]
	const at = (api, address) => val(api, address)
	const set = (key, value) => ({ path: [key], value })
	const FRAMES = [
		"run-right-1",
		"run-right-2",
		"run-upright-1",
		"run-upright-2",
		"run-downright-1",
		"run-downright-2",
		"run-up-1",
		"run-up-2",
		"run-down-1",
		"run-down-2",
		"alert",
		"sit",
		"wash-1",
		"wash-2",
		"yawn",
		"sleep-1",
		"sleep-2",
	]
	// the nearest frame drawn, for one that is not
	const nearer = (f) =>
		f.endsWith("-2")
			? f.replace(/-2$/, "-1")
			: f.startsWith("run-")
			? (f === "run-right-1" ? null : "run-right-1")
			: f === "sit"
			? null
			: "sit"
	const isPicture = (v) =>
		v?.kind === "picture" && Array.isArray(v.rows) && v.rows.every((r) => typeof r === "string")
	// the eight ways it runs: atan2's eighths from the right, anticlockwise; the frame and whether it is flipped
	const WAYS = [
		["right", 0],
		["upright", 0],
		["up", 0],
		["upright", 1],
		["right", 1],
		["downright", 1],
		["down", 0],
		["downright", 0],
	]

	// --- its look: every frame at the screen's unit, facing right then left, side by side
	let look = null // {bits, w, h, u, stride}: w, h a frame's pixels
	let fresh = false // a new look, not yet in the layer
	let config = {}
	effect(given, "look", ({ api }) => {
		const s = at(api, ETC)
		const folder = Array.isArray(s?.frames) && s.frames[0] === "/" ? s.frames : ETC
		const pictures = {}
		for (const f of FRAMES) {
			const p = at(api, [...folder, f])
			if (isPicture(p)) pictures[f] = p
			const l = f.startsWith("run-") ? at(api, [...folder, f.replace("right", "left")]) : null
			if (isPicture(l) && f.includes("right")) pictures[`${f}<`] = l
		}
		return {
			s: s && typeof s === "object" && !Array.isArray(s) ? s : {},
			pictures,
			u: Math.max(1, Math.round(at(api, MODE)?.unit ?? 1)),
		}
	}, ({ value: { s, pictures, u }, call }) => {
		config = s
		const all = Object.values(pictures)
		// a frame is as big as the biggest picture: 24 × 16 as the image draws them
		const W = Math.min(
				64,
				Math.max(1, ...all.map((p) => Math.max(0, ...p.rows.map((r) => r.length)))),
			),
			H = Math.min(64, Math.max(1, ...all.map((p) => p.rows.length)))
		const w = W * u, h = H * u, stride = w * FRAMES.length * 2
		const bits = new Uint32Array(stride * h).fill(0xff000000)
		// one picture into frame n, flipped or not: standing on the frame's bottom, in its middle
		const paint = (p, n, flip) => {
			const cols = Math.max(0, ...p.rows.map((r) => r.length)),
				ox = Math.floor((W - cols) / 2),
				oy = H - p.rows.length
			p.rows.forEach((row, j) => {
				for (let i = 0; i < row.length; i++) {
					const c = p.colors?.[row[i]]
					const x = flip ? W - 1 - (ox + i) : ox + i, y = oy + j
					if (typeof c !== "number" || x < 0 || x >= W || y < 0 || y >= H) continue
					for (let b = 0; b < u; b++) {
						bits.fill(
							c & 0xffffff,
							(y * u + b) * stride + n * w + x * u,
							(y * u + b) * stride + n * w + (x + 1) * u,
						)
					}
				}
			})
		}
		FRAMES.forEach((f, k) => {
			let p = null
			for (let g = f; g && !p; g = nearer(g)) p = pictures[g]
			if (!p) return
			paint(p, 2 * k, false)
			const left = pictures[`${f}<`]
			if (left) paint(left, 2 * k + 1, false)
			else paint(p, 2 * k + 1, true)
		})
		look = { bits, w, h, u, stride }
		fresh = true
		call(POKE)
	})

	// --- where it is and what it is doing, taken up from its state when started again (a replace)
	const was = at(api, STATE) ?? {}
	let x = Number.isFinite(was.x) ? was.x : null, y = Number.isFinite(was.y) ? was.y : null
	let doing = typeof was.doing === "string" ? was.doing : "alert",
		facing = was.facing === -1 ? -1 : 1
	let since = Date.now(), rested = Date.now(), last = Date.now()
	let chasing = true, goal = null, way = WAYS[0], seen = null
	// where by the pointer it sits, a little to one side, so ermines started together sit side by side
	const aside = Number.isFinite(was.aside) ? was.aside : Math.round((Math.random() - 0.5) * 40)
	let shown = null, said = null, stopped = false
	// its layer, there already when it was started again
	let placed = !!idAt(api, LAYER)
	make(api, me, "state", null, { ephemeral: true })

	// the room it has, in pixels: the screen, between the bars, and its rounded corners' radii; read as it
	// changes, not each tick, so a step is a read of the pointer and a write of the layer
	let r = null
	effect(given, "room", ({ api }) => {
		const m = at(api, MODE) ?? {},
			bar = at(api, [...WINDOWS, "bar"]),
			task = at(api, [...WINDOWS, "task"])
		const corner = at(api, ["/", "etc", "desktop"])?.corner ?? {},
			u = Math.max(1, Math.round(m.unit ?? 1))
		const top = bar && !bar.hidden ? bar.y + bar.h : 0,
			bottom = task && !task.hidden ? task.y : m.h ?? 0
		return {
			W: m.w ?? 0,
			H: m.h ?? 0,
			top,
			bottom,
			rt: (corner.top ?? 10) * u,
			rb: (corner.bottom ?? 0) * u,
		}
	}, ({ value: room, call }) => {
		r = room
		call(POKE)
	})
	// a frame's top left inside the room, nearest x, y
	const inside = (px, py) => {
		const cx = Math.max(0, Math.min(px, r.W - look.w)),
			cy = Math.max(r.top, Math.min(py, r.bottom - look.h))
		const R = cy < r.rt ? r.rt : cy + look.h > r.H - r.rb ? r.rb : 0
		return [Math.max(R, Math.min(cx, r.W - look.w - R)), cy]
	}
	const say = (api, X, Y) =>
		api.write(STATE, whole({ doing, x: X, y: Y, facing, aside, layer: LAYER }))
	const now = (to) => {
		doing = to
		since = Date.now()
	}

	// tick called again in ms, by a handler of this process; one asked for later is the one that counts (a cancelled
	// timer is still the host's to fire, and would find nothing there)
	let asked = 0
	const later = (g, ms) => {
		const n = ++asked
		after(g, ms, (g) => n === asked && tick(g))
	}
	const tick = (g) => {
		const { api } = g
		if (stopped || !look || !r) return
		const t = Date.now(), dt = Math.min(0.1, (t - last) / 1000), u = look.u
		last = t
		if (x === null) {
			;[x, y] = inside(Math.random() * r.W, r.top + Math.random() * (r.bottom - r.top))
		}
		// where the pointer would have it: standing just above the pointer's point
		const p = at(api, ["/", "dev", "pointer", "at"])
		const there = p && Number.isFinite(p.x)
			? inside(p.x - look.w / 2 + aside * u, p.y - look.h + 2 * u)
			: null
		const moved = there && (!seen || Math.hypot(there[0] - seen[0], there[1] - seen[1]) > 2 * u)
		if (moved) {
			seen = there
			rested = t
		}
		const far = there && Math.hypot(there[0] - x, there[1] - y) > 8 * u
		const before = doing
		if (doing === "alert") {
			if (t - since > 400) {
				chasing = true
				goal = there ?? [x, y]
				now("run")
			}
		} else if (doing === "run") {
			if (moved && far) chasing = true
			if (chasing && there) goal = there
			if (!goal) goal = [x, y]
			const dx = goal[0] - x,
				dy = goal[1] - y,
				d = Math.hypot(dx, dy),
				step = (Number(config.speed) || 160) * u * dt
			if (d <= step) {
				;[x, y] = goal
				now("sit")
			} else {
				x += (dx / d) * step
				y += (dy / d) * step
				way = WAYS[((Math.round(Math.atan2(-dy, dx) / (Math.PI / 4)) % 8) + 8) % 8]
				if (Math.abs(dx) > 1) facing = dx < 0 ? -1 : 1
			}
		} else if (moved && far) {
			// the pointer gone from where it sat: it startles awake, then runs
			now("alert")
		} else if (doing === "sleep") {
			// asleep it stays
		} else if (doing === "yawn") {
			if (t - since > 900) now("sleep")
		} else if (t - rested > (Number(config.sleepy) || 8) * 1000) now("yawn")
		else if (doing === "sit" && t - since > 1200 && Math.random() < 0.15) now("wash")
		else if (doing === "wash" && t - since > 2400) now("sit")
		else if (
			doing === "sit" && Number(config.wander) > 0 && Math.random() < dt / Number(config.wander)
		) {
			// idle: off to somewhere else on the desk
			chasing = false
			goal = inside(Math.random() * r.W, r.top + Math.random() * (r.bottom - r.top))
			now("run")
		}
		// the frame: a bound ten times a second while running; washing licks, asleep it breathes
		const two = (ms) => (Math.floor(t / ms) % 2) + 1
		const frame = doing === "run"
			? `run-${way[0]}-${two(100)}`
			: doing === "wash"
			? `wash-${two(250)}`
			: doing === "sleep"
			? `sleep-${two(800)}`
			: doing
		// asleep it is not flipped: its z would read backwards
		const flip = doing === "run" ? way[1] : facing < 0 && doing !== "sleep" ? 1 : 0
		const cell = 2 * Math.max(0, FRAMES.indexOf(frame)) + flip
		const z = config.above ? 99000 : -900
		const X = Math.round(x), Y = Math.round(y)
		// its layer: placed, or made again with a new look; else only what changed, a move a set of x and y
		const op = (c) => ({
			op: "pixels",
			x: -c * look.w,
			y: 0,
			w: look.stride,
			h: look.h,
			bits: look.bits,
		})
		if (!placed) {
			placed = true
			make(api, LAYER.slice(0, -1), LAYER.at(-1), {
				x: X,
				y: Y,
				w: look.w,
				h: look.h,
				z,
				over: true,
				draw: [op(cell)],
			}, { ephemeral: true })
			shown = { X, Y, cell, z }
			fresh = false
		} else if (fresh) {
			api.write(
				LAYER,
				whole({ x: X, y: Y, w: look.w, h: look.h, z, over: true, draw: [op(cell)] }),
			)
			shown = { X, Y, cell, z }
			fresh = false
		} else {
			const patches = []
			if (X !== shown.X) patches.push(set("x", X))
			if (Y !== shown.Y) patches.push(set("y", Y))
			if (z !== shown.z) patches.push(set("z", z))
			if (cell !== shown.cell) patches.push({ path: ["draw", 0, "x"], value: -cell * look.w })
			if (patches.length) api.write(LAYER, patches)
			shown = { X, Y, cell, z }
		}
		// what it is doing, said as it changes, and while running at each new frame
		if (doing !== before || (doing === "run" && cell !== said)) {
			said = cell
			say(api, X, Y)
		}
		later(
			g,
			doing === "run"
				? 1000 / Math.max(1, Math.min(120, Number(config.rate) || 60))
				: doing === "sleep"
				? 250
				: 100,
		)
	}
	// a new look shows at once, not at the next tick: the effects call this
	const POKE = [...me, "on", "poke"]
	// started again (a replace), the last setup's poke is still in on/poke, first, and would be the one called: let it go
	for (const i of api.children([...me, "on"], "poke")) drop(api, [...me, "on"], "poke", i.id)
	handler(given, "poke", (g) => later(g, 0))
	onCleanup(({ api }) => {
		stopped = true
		drop(api, LAYER.slice(0, -1), LAYER.at(-1))
	})
}
