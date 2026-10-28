/** @jsxImportSource @ermine */
import {
	addTeardown,
	createAction,
	createEffect,
	ensureNode,
	patch,
	peep,
	read,
} from "@ermine/system"
import { host } from "@ermine/slaygrounds/tools"
import { bind, handler } from "@ermine/render/h"

// piece-cursors: presence, two devices in one page. the laptop and the phone each have their own
// world; a pair of channels joins them (and a BroadcastChannel joins this tab to others). a
// pointer over a pane sets that device's row in the "presence" part at the pad's id: a patch, sent
// over the channel, landing on the other device as a patch too. each pane draws the rows its own
// world reads. a row lives until its until: the heartbeat renews it, moving sets it again, leaving
// clears it. let it lapse and it greys, then the sweeper takes it out

// what the host's extend adds (host.ts): the phone's world, and what crossed the channels
type Host = {
	laptop: {
		rows: () => Live[]
		set: (v: unknown) => void
		renew: () => void
		clear: () => void
	}
	phone: {
		rows: () => Live[]
		set: (v: unknown) => void
		renew: () => void
		clear: () => void
		effect: (
			read: () => Live[],
			act: (live: Live[]) => void,
			teardown: (f: () => void) => void,
		) => void
	}
	crossed: () => { pair: number; tabs: number; tab: string; ttl: number; topic: string }
}

type Live = { who: string; value: { x: number; y: number }; until: number }

const TTL = 3000 // ms a row lives unless renewed

const colors: Record<string, string> = { laptop: "#ff2284", phone: "#2269ff" }
const colorOf = (who: string) => colors[who] ?? "#40dcba"
const round = (n: number) => Math.round(n * 1000) / 1000

// a cursor: an arrow and a name tag
function cursor(who: string, me: boolean) {
	const el = document.createElement("div")
	el.className = "cur"
	el.innerHTML =
		`<svg width="16" height="20" viewBox="0 0 16 20"><path d="M1 1 L1 16 L5 12 L8 19 L11 18 L8 11 L14 11 Z" fill="${
			colorOf(who)
		}" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/></svg><b style="background:${
			colorOf(who)
		}">${who}${me ? " (me)" : ""}</b>`
	return el
}

export default function program() {
	const { laptop, phone, crossed } = host<Host>()
	const beat = ensureNode("./beat", { laptop: true, phone: true })
	createAction("on/beat", (who: string) => {
		const was = peep(() => read(beat)) as Record<string, boolean>
		patch(beat, [{ path: [who], value: !was[who] }])
	})
	// the heartbeat's timer has nothing open to read in: an effect keeps what it needs
	let beating: Record<string, boolean> = { laptop: true, phone: true }
	createEffect("beating", () => read(beat) as Record<string, boolean>, (b) => {
		beating = b
	})
	const info = crossed()

	// each device's pane: a pad and its rows, drawn by an effect from the rows its own world reads.
	// both are the host's: the laptop's in this world, the phone's in its own
	const panes = new Map<string, { pad: HTMLElement; rows: HTMLElement }>()
	const device = (
		name: string,
		rows: () => Live[],
		set: (v: { x: number; y: number }) => void,
		clear: () => void,
		watch: (read: () => Live[], act: (live: Live[]) => void) => void,
	) => {
		const pad = document.createElement("div")
		pad.className = "pad"
		const tbody = document.createElement("tbody")
		panes.set(name, { pad, rows: tbody })
		pad.onpointermove = (e: PointerEvent) => {
			const r = pad.getBoundingClientRect()
			set({
				x: round((e.clientX - r.left) / r.width),
				y: round((e.clientY - r.top) / r.height),
			})
		}
		pad.onpointerleave = clear
		const shown = new Map<string, HTMLElement>()
		watch(rows, (live) => {
			const here = new Set(live.map((l) => l.who))
			for (const [who, el] of shown) if (!here.has(who)) (el.remove(), shown.delete(who))
			for (const l of live) {
				let el = shown.get(l.who)
				if (!el) shown.set(l.who, el = pad.appendChild(cursor(l.who, l.who === name)))
				el.classList.toggle("flip", l.value.x > 0.6)
				el.style.left = `${l.value.x * 100}%`
				el.style.top = `${l.value.y * 100}%`
				el.dataset.until = String(l.until)
			}
			tbody.replaceChildren(
				...live.map((l) => {
					const tr = document.createElement("tr")
					tr.innerHTML = `<td><i style="background:${colorOf(l.who)}"></i>${l.who}</td><td>${
						l.value.x.toFixed(2)
					}</td><td>${l.value.y.toFixed(2)}</td><td class="left" data-until="${l.until}"></td>`
					return tr
				}),
			)
			if (live.length === 0) {
				tbody.innerHTML = `<tr><td colspan="4" class="none">nobody here</td></tr>`
			}
			tick()
		})
	}
	device(
		"laptop",
		laptop.rows,
		laptop.set,
		laptop.clear,
		(read, act) => createEffect("pointers", read, act),
	)
	device(
		"phone",
		phone.rows,
		phone.set,
		phone.clear,
		(read, act) => phone.effect(read, act, addTeardown),
	)

	// the heartbeat: each device with it on renews its row (only one that is there) every second
	const hb = setInterval(() => {
		if (beating.laptop) laptop.renew()
		if (beating.phone) phone.renew()
	}, 1000)
	// not the graph's: how long each row has left, drawn ten times a second
	const counter = document.createElement("span")
	function tick() {
		const now = Date.now()
		for (const el of document.querySelectorAll<HTMLElement>(".cu [data-until]")) {
			const left = Number(el.dataset.until) - now
			const k = Math.max(0, Math.min(1, left / (TTL * 0.6)))
			if (el.classList.contains("cur")) {
				el.style.opacity = String(0.25 + 0.75 * k)
				el.style.filter = `grayscale(${1 - k})`
			} else el.textContent = left > 0 ? `${(left / 1000).toFixed(1)} s` : "lapsed"
		}
		const c = crossed()
		counter.textContent = `${c.pair} messages over the pair, ${c.tabs} heard from other tabs`
	}
	const ticker = setInterval(tick, 100)
	addTeardown(() => (clearInterval(hb), clearInterval(ticker)))

	const pane = (name: string, icon: string, wide: boolean) => {
		const { pad, rows } = panes.get(name)!
		return (
			<section class={`win ${wide ? "wide" : "narrow"}`}>
				<header>
					<b class="close" />
					<span>
						{icon} {name}
					</span>
				</header>
				<div class="body">
					{pad}
					<div class="row">
						<button
							class={bind("./beat", (b: Record<string, boolean>) => (b[name] ? "on" : ""))}
							onClick={handler("on/beat", [name])}
						>
							{bind(
								"./beat",
								(
									b: Record<string, boolean>,
								) => (b[name] ? "💓 heartbeat on" : "🩶 heartbeat off"),
							)}
						</button>
					</div>
					<table class="rows">
						<thead>
							<tr>
								<th>who</th>
								<th>x</th>
								<th>y</th>
								<th>until</th>
							</tr>
						</thead>
						{rows}
					</table>
				</div>
			</section>
		)
	}

	return (
		<div class="cu">
			<style>{css}</style>
			<h1>
				cursors<span>who is here, on two devices</span>
			</h1>
			<p class="lede">
				point at a pad. each device writes its own row in the <code>presence</code> part at{" "}
				<code>{info.topic}</code>, a patch sent over a channel to the other device. a row lives
				{" "}
				{TTL / 1000}{" "}
				s unless renewed: turn a heartbeat off and keep still, and it greys, then goes. open
				this example in another tab: <code>{info.tab}</code> shows up there.
			</p>
			<div class="cols">
				{pane("laptop", "💻", true)}
				<div class="wire">
					<i />
					<em>pair</em>
				</div>
				{pane("phone", "📱", false)}
			</div>
			<p class="foot">{counter}</p>
		</div>
	)
}

const css = `
.cu{font-family:Jost,system-ui,sans-serif;color:#000;background:#fffbd6;border:1px solid #000;margin:-6px;padding:12px 14px 16px;min-height:calc(100vh - 18px);box-sizing:border-box}
.cu *{box-sizing:border-box}
.cu h1{font-size:22px;margin:0 0 2px;font-weight:600}
.cu h1 span{display:inline-block;background:#ffff88;border:1px solid #000;padding:0 8px;transform:skewX(-10deg);font-size:13px;font-weight:500;vertical-align:3px;margin-left:8px}
.cu .lede{margin:0 0 12px;font-size:13.5px;line-height:1.35;max-width:660px}
.cu code{font-family:Monaco,ui-monospace,Menlo,monospace;font-size:11px}
.cu .cols{display:flex;align-items:flex-start;flex-wrap:wrap}
.cu .win{background:#fff;border:1px solid #000;box-shadow:2px 2px 0 #000}
.cu .win.wide{flex:1 1 300px;min-width:260px;max-width:400px}
.cu .win.narrow{flex:0 0 220px}
.cu .win header{position:relative;height:20px;border-bottom:1px solid #000;display:flex;align-items:center;justify-content:center;background:repeating-linear-gradient(#fff 0 1px,#000 1px 2px) 0 4px/100% 12px no-repeat,#fff}
.cu .win header span{background:#fff;padding:0 8px;font-size:12px;font-weight:600}
.cu .win .close{position:absolute;left:8px;top:4px;width:11px;height:11px;border:1px solid #000;background:#fff}
.cu .body{padding:10px;display:flex;flex-direction:column;gap:8px}
.cu .pad{position:relative;height:200px;border:1px solid #000;background:#fff radial-gradient(#0002 1px,transparent 1.5px) 0 0/14px 14px;overflow:hidden;cursor:crosshair;touch-action:none}
.cu .narrow .pad{height:260px;border-radius:14px;border-width:2px}
.cu .cur{position:absolute;width:0;height:0;pointer-events:none;transition:left .08s linear,top .08s linear}
.cu .cur svg{position:absolute;left:-1px;top:-1px}
.cu .cur b{position:absolute;left:12px;top:14px;font-size:11px;font-weight:600;color:#fff;border:1px solid #000;padding:0 5px;white-space:nowrap}
.cu .cur.flip b{left:auto;right:-4px}
.cu .row{display:flex;gap:6px}
.cu button{font:inherit;font-size:12.5px;font-weight:500;background:#fff;color:#000;border:1px solid #000;border-radius:2px;padding:1px 10px;cursor:pointer;box-shadow:1px 1px 0 #000;transition:transform .08s,box-shadow .08s}
.cu button:hover{transform:translate(-1px,-1px);box-shadow:2px 2px 0 #000}
.cu button:active{transform:translate(1px,1px);box-shadow:none}
.cu button.on{background:#ffff88}
.cu .rows{border-collapse:collapse;font-size:11.5px;width:100%}
.cu .rows th,.cu .rows td{border:1px solid #000;padding:1px 5px;text-align:left;font-weight:500}
.cu .rows thead th{background:#fffbd6;font-weight:600}
.cu .rows td{font-family:Monaco,ui-monospace,monospace;font-size:10.5px}
.cu .rows td i{display:inline-block;width:8px;height:8px;border:1px solid #000;margin-right:4px}
.cu .rows td.none{font-family:Jost,system-ui,sans-serif;opacity:.6}
.cu .wire{flex:0 0 48px;align-self:center;display:flex;flex-direction:column;align-items:center;gap:2px;margin-top:-80px}
.cu .wire i{width:48px;height:6px;border-top:1px solid #000;border-bottom:1px solid #000;background:#ffff88}
.cu .wire em{font-style:normal;font-size:11px;font-weight:600}
.cu .foot{font-size:12px;margin:10px 0 0;opacity:.75}
`
