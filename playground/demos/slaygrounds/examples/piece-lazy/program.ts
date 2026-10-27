/** @jsxImportSource ermine-h */
import { createAction, createMemo, ensureNode, patch, peep, read } from "@ermine/system"
import { bind, handler } from "ermine-h"

// piece-lazy: /dev/clock ticks only while someone reads it. its provider is the host's, through
// the pully feature: any run reading the clock's value wakes it, the last one to stop puts it to
// sleep (host.ts). a reader woken late gets the last time at once, the clock's status saying how
// fresh (ermine.provider.status: asleep, waking, awake).
// each reader is a memo that reads the time only while its switch is on (the switch is ./<name>-on,
// saved, so a reload finds it). this view never reads the time itself, only what the readers made
// of it, and what the provider says (/provider)

type Said = {
	awake: boolean
	ticks: number
	starts: number
	stops: number
	log: { at: string; what: string; awake: boolean }[]
}

const readers = [
	{ name: "watch", emoji: "⌚", says: "a watch" },
	{ name: "cuckoo", emoji: "🐦", says: "a cuckoo" },
	{ name: "sundial", emoji: "☀️", says: "a sundial" },
]

const seconds = (time: unknown) => typeof time === "string" ? Number(time.slice(6, 8)) : 0

export default function program() {
	const toggles = readers.map((r) => {
		const toggle = ensureNode(`./${r.name}-on`, r.name !== "sundial")
		createMemo(r.name, () => (read(toggle) ? read("/dev/clock", ["time"]) : null))
		createAction(
			`on/${r.name}`,
			() => patch(toggle, [{ path: [], value: !peep(() => read(toggle)) }]),
		)
		return toggle
	})
	createAction("on/none", () => {
		for (const toggle of toggles) patch(toggle, [{ path: [], value: false }])
	})

	// what each reader shows, from its own part's value (never the clock's)
	const face = (name: string, time: unknown) => {
		if (time == null) return <div class="off">not reading</div>
		const s = seconds(time)
		if (name === "watch") return <div class="lcd">{String(time)}</div>
		if (name === "cuckoo") {
			return (
				<div class="cuckoo">
					<span class="house">🏠</span>
					<b class={s % 5 === 0 ? "bird out" : "bird"}>{s % 5 === 0 ? "cuckoo!" : "tick"}</b>
					<code>{String(time)}</code>
				</div>
			)
		}
		return (
			<div class="dial">
				<i style={{ transform: `rotate(${s * 6}deg)` }} />
				<code>{String(time)}</code>
			</div>
		)
	}

	return (
		<div class="pl">
			<style>{css}</style>
			<h1>
				lazy<span>/dev/clock ticks only while someone reads its time</span>
			</h1>
			<p class="lede">
				nobody asks the clock to start. its provider hears the scheduler: the first run to read
				the clock wakes it (onTrackingStart), the last one to stop puts it to sleep
				(onTrackingEnd). switch the readers off, all of them, and it stops writing.
			</p>
			<div class="cols">
				<section class="win provider">
					<header>
						<b class="close" />
						<span>/dev/clock's provider</span>
					</header>
					<div class="body">
						<div
							class={bind(
								"/provider",
								(p: Said) => (p?.awake ? "state awake" : "state asleep"),
							)}
						>
							{bind("/provider", (p: Said) =>
								p?.awake ? "⏰ awake: ticking" : "💤 asleep: nobody reads its time")}
						</div>
						<div class="counts">
							<span>
								ticks written{" "}
								<b>
									{bind("/provider", (p: Said) =>
										p?.ticks ?? 0)}
								</b>
							</span>
							<span>
								woken{" "}
								<b>
									{bind("/provider", (p: Said) =>
										p?.starts ?? 0)}
								</b>
							</span>
							<span>
								put to sleep <b>{bind("/provider", (p: Said) => p?.stops ?? 0)}</b>
							</span>
						</div>
						<ol class="log">
							{bind("/provider", (p: Said) =>
								(p?.log ?? []).length === 0
									? <li class="empty">nothing yet</li>
									: p.log.map((l, i) => (
										<li key={`${l.at}:${i}:${l.what}`} class={l.awake ? "up" : "down"}>
											<code>{l.at}</code> {l.what}
										</li>
									)))}
						</ol>
					</div>
				</section>
				<div class="readers">
					{readers.map((r) => (
						<section class="win reader" key={r.name}>
							<header>
								<b class="close" />
								<span>
									{r.emoji} {r.says}
								</span>
							</header>
							<div class="body">
								<label class="switch">
									<input
										type="checkbox"
										checked={bind(`${r.name}-on`)}
										onChange={handler(`on/${r.name}`)}
									/>
									reads <code>/dev/clock</code> at <code>time</code>
								</label>
								<div class="face">{bind(r.name, (time) => face(r.name, time))}</div>
							</div>
						</section>
					))}
					<button class="none" onClick={handler("on/none")}>switch them all off</button>
				</div>
			</div>
		</div>
	)
}

const css = `
.pl{font-family:Jost,system-ui,sans-serif;color:#000;background:#fffbd6;border:1px solid #000;margin:-6px;padding:12px 14px 16px;min-height:calc(100vh - 18px);box-sizing:border-box}
.pl *{box-sizing:border-box}
.pl h1{font-size:22px;margin:0 0 2px;font-weight:600}
.pl h1 span{display:inline-block;background:#ffff88;border:1px solid #000;padding:0 8px;transform:skewX(-10deg);font-size:13px;font-weight:500;vertical-align:3px;margin-left:8px}
.pl .lede{margin:0 0 12px;font-size:13.5px;line-height:1.35;max-width:660px}
.pl code{font-family:Monaco,ui-monospace,Menlo,monospace;font-size:11px}
.pl .cols{display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start}
.pl .win{background:#fff;border:1px solid #000;box-shadow:2px 2px 0 #000}
.pl .win header{position:relative;height:20px;border-bottom:1px solid #000;display:flex;align-items:center;justify-content:center;background:repeating-linear-gradient(#fff 0 1px,#000 1px 2px) 0 4px/100% 12px no-repeat,#fff}
.pl .win header span{background:#fff;padding:0 8px;font-size:12px;font-weight:600}
.pl .win .close{position:absolute;left:8px;top:4px;width:11px;height:11px;border:1px solid #000;background:#fff}
.pl .body{padding:9px 10px 10px;display:flex;flex-direction:column;gap:8px;font-size:12.5px}
.pl .provider{flex:1 1 300px;max-width:380px}
.pl .state{border:1px solid #000;padding:12px 10px;font-size:16px;font-weight:600;text-align:center}
.pl .state.awake{background:#d9f7ee;box-shadow:inset 0 0 0 2px #40dcba}
.pl .state.asleep{background:repeating-linear-gradient(135deg,#ffff88 0 10px,#fff 10px 20px);color:#555}
.pl .counts{display:flex;gap:12px;flex-wrap:wrap}
.pl .counts b{color:#ff2284;font-weight:600}
.pl .log{list-style:none;margin:0;padding:0;border-top:1px dashed #000}
.pl .log li{padding:4px 0 4px 8px;border-bottom:1px dashed #000;font-size:12px;animation:plin .3s ease-out}
.pl .log li.up{box-shadow:inset 3px 0 0 #40dcba}
.pl .log li.down{box-shadow:inset 3px 0 0 #ff2284}
.pl .log li.empty{opacity:.6;animation:none}
@keyframes plin{from{opacity:0;transform:translateY(-4px)}}
.pl .readers{flex:1 1 280px;display:flex;flex-direction:column;gap:10px;max-width:360px}
.pl .switch{display:flex;align-items:center;gap:6px;font-weight:500}
.pl .switch input{accent-color:#ff2284;width:15px;height:15px}
.pl .face{min-height:44px;display:flex;align-items:center}
.pl .off{opacity:.5;font-style:italic}
.pl .lcd{font-family:Monaco,ui-monospace,monospace;font-size:22px;letter-spacing:2px;background:#e6f2c8;border:1px solid #000;padding:3px 10px;box-shadow:inset 1px 1px 0 #0003}
.pl .cuckoo{display:flex;align-items:center;gap:8px}
.pl .cuckoo .house{font-size:24px}
.pl .cuckoo .bird{font-weight:600;font-size:13px;border:1px solid #000;padding:0 6px;background:#fff}
.pl .cuckoo .bird.out{background:#ff2284;color:#fff;transform:rotate(-4deg)}
.pl .dial{display:flex;align-items:center;gap:10px}
.pl .dial i{display:block;width:40px;height:40px;border:1px solid #000;border-radius:50%;background:#ffff88;position:relative;transition:transform .4s}
.pl .dial i::after{content:"";position:absolute;left:19px;top:3px;width:2px;height:17px;background:#000}
.pl button{font:inherit;font-size:12.5px;font-weight:500;background:#fff;color:#000;border:1px solid #000;border-radius:2px;padding:1px 10px;cursor:pointer;box-shadow:1px 1px 0 #000;transition:transform .08s,box-shadow .08s;align-self:flex-start}
.pl button:hover{transform:translate(-1px,-1px);box-shadow:2px 2px 0 #000}
.pl button:active{transform:translate(1px,1px);box-shadow:none}
`
