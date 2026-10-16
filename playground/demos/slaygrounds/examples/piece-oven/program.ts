/** @jsxImportSource ermine-h */
import type { API } from "@ermine/api"
import { bind, handler } from "ermine-h"

// piece-oven: each oven is a compute that awaits a bake. while the promise is out its run is
// pending; a bake too hot rejects, and the run failed. neither is in the oven's own value: they are
// the computer's node (places' status.ts), in its attribute ermine.computer.status: PENDING, the
// Error, or nothing once a run is done. info(memo) is that node's attributes, read tracked, so the
// doors below rerun as it changes.
// the settings are one node, { cherry: { heat, minutes, batch }, … }, changed with recipes: one
// patch at the key that changed, none when the value is already that. watch tells each write's
// patches, for the receipts. the fig oven is made by a recipe only when there is none

type Setting = { heat: number; minutes: number; batch: number }
type Baked = { dish: string; batch: number; heat: number }
type Door = {
	state: "pending" | "burnt" | "done" | "empty"
	says: string
	last?: Baked
	pending: boolean
	sid?: string
	raw: string
}
type Receipt = { n: number; how: string; path: string; patches: string[]; gave?: string }

const ovens = [
	{ name: "cherry", dish: "cherry pie", emoji: "🍒" },
	{ name: "lemon", dish: "lemon tart", emoji: "🍋" },
	{ name: "plum", dish: "plum cake", emoji: "🫐" },
	{ name: "fig", dish: "fig roll", emoji: "🌰" },
]
const TOO_HOT = 220
const STATUS = "ermine.computer.status"

// a bake: minutes are seconds here; too hot and it comes out burnt
const bake = (dish: string, s: Setting) =>
	new Promise<Baked>((done, fail) =>
		setTimeout(
			() =>
				s.heat > TOO_HOT
					? fail(new Error(`burnt! ${s.heat}° is over ${TOO_HOT}°`))
					: done({ dish, batch: s.batch, heat: s.heat }),
			s.minutes * 1000,
		)
	)

// what the attributes hold, said plainly
function said(attributes: unknown, pending: symbol): string {
	const a = attributes as Record<string, unknown> | undefined
	if (!a || !Object.hasOwn(a, "ermine.computer.status")) return "{ } (nothing: the run is done)"
	const v = a["ermine.computer.status"]
	const shown = v === pending
		? "Symbol(ermine.pending)"
		: v instanceof Error
		? `Error("${v.message}")`
		: String(v)
	return `{ "ermine.computer.status": ${shown} }`
}

const showPatch = (p: { path: (string | number)[]; value?: unknown }) =>
	`[${p.path.join(", ")}]${"value" in p ? " = " + JSON.stringify(p.value) : " taken out"}`

export default function program(
	{ open, read, edit, info, entries, memo, method, watch, PENDING }: API,
) {
	const settings = open("./oven/settings", {
		cherry: { heat: 180, minutes: 1.2, batch: 1 },
		lemon: { heat: 200, minutes: 2.6, batch: 1 },
		plum: { heat: 240, minutes: 0.8, batch: 1 },
	} as Record<string, Setting>)
	const receipts = open("./oven/receipts", [] as Receipt[])

	// an oven: a compute that reads its own settings (only them: a patch at another oven's path
	// does not rebake it) and awaits the bake. no settings yet: nothing to bake
	const bakes = Object.fromEntries(ovens.map((o) => [
		o.name,
		memo(`bake-${o.name}`, () => {
			const s = read(settings, [o.name]) as Setting | undefined
			return s ? bake(o.dish, s) : null
		}),
	]))

	// the doors: each oven's status read off its computer's node, tracked
	memo("doors", () =>
		Object.fromEntries(ovens.map((o) => {
			const b = bakes[o.name]
			const attributes = read(info(b))
			const st = read(info(b), [STATUS])
			// not read(b): a memo pending with no value throws PENDING
			const last = entries(b)[0]?.value as Baked | null | undefined
			const door: Door = st === PENDING
				? { state: "pending", says: "⏳ baking… (pending)", pending: true, raw: "" }
				: st instanceof Error
				? { state: "burnt", says: `💥 ${st.message}`, pending: false, raw: "" }
				: last
				? {
					state: "done",
					says: `✓ ${last.dish}, batch ${last.batch}, at ${last.heat}°`,
					pending: false,
					raw: "",
				}
				: { state: "empty", says: "no oven here yet", pending: false, raw: "" }
			door.last = last ?? undefined
			door.sid = String(entries(b)[0]?.id ?? "")
			door.raw = said(attributes, PENDING)
			return [o.name, door]
		})))

	// each write to the settings is told its patches (a write that changes nothing is not told)
	let wrote: readonly { path: (string | number)[]; value?: unknown }[] = []
	watch(settings, (w) => (wrote = w.patches as typeof wrote))
	// a change to the settings, and a receipt for it, the last four kept
	const change = (how: string, path: string[], recipe: (d: Record<string, Setting>) => void) => {
		wrote = []
		edit(settings, recipe)
		const was = read(receipts) as Receipt[]
		const gave = how === "make" ? read(settings, path) : undefined
		const r: Receipt = {
			n: (was[0]?.n ?? 0) + 1,
			how,
			path: "[" + path.join(", ") + "]",
			patches: wrote.map(showPatch),
			gave: gave === undefined ? undefined : JSON.stringify(gave),
		}
		edit(receipts, (d: Receipt[]) => (d.unshift(r), void d.splice(4)))
	}
	const setting = (oven: string) =>
		(read(settings) as Record<string, Setting>)[oven] as Setting | undefined

	method(
		"on/set",
		(oven: string, key: keyof Setting, value: number) =>
			change("set", [oven, key], (d) => void ((d[oven] ??= {} as Setting)[key] = value)),
	)
	method("on/again", (oven: string) => {
		const batch = (setting(oven)?.batch ?? 0) + 1
		change("set", [oven, "batch"], (d) => void ((d[oven] ??= {} as Setting).batch = batch))
	})
	method("on/same", (oven: string) => {
		const heat = setting(oven)?.heat as number
		change("set", [oven, "heat"], (d) => void ((d[oven] ??= {} as Setting).heat = heat))
	})
	method("on/add", () =>
		change("make", ["fig"], (d) => {
			d.fig ??= { heat: 170, minutes: 1.6, batch: 1 }
		}))

	const num = (e: Event) => Number((e.target as HTMLInputElement).value)

	const oven = (o: (typeof ovens)[number]) => (
		<section class="win" key={o.name}>
			<header>
				<b class="close" />
				<span>
					{o.emoji} {o.dish}
				</span>
			</header>
			<div class="body">
				<div class={bind("doors", (d) => `door ${d?.[o.name]?.state ?? "empty"}`)}>
					<b>{bind("doors", (d) => d?.[o.name]?.says ?? "")}</b>
					<small>
						{bind("doors", (d) => {
							const door = d?.[o.name] as Door | undefined
							return door?.state === "burnt" && door.last
								? `its value still holds batch ${door.last.batch}, the last good one`
								: ""
						})}
					</small>
				</div>
				<div class="raw">
					<span class="k">
						status on the oven's node{" "}
						<code>{bind("doors", (d) => String(d?.[o.name]?.sid ?? "").slice(0, 17))}</code>
					</span>
					<code class="v">{bind("doors", (d) => d?.[o.name]?.raw ?? "")}</code>
					<span class="k">
						isPending <code>{bind("doors", (d) => String(!!d?.[o.name]?.pending))}</code>
					</span>
				</div>
				{bind("oven/settings", (all: Record<string, Setting>) => {
					const s = all?.[o.name]
					if (!s) {
						return (
							<div class="add">
								<button class="go" onClick={handler("on/add")}>
									add a fig oven (only if none)
								</button>
							</div>
						)
					}
					return (
						<div class="knobs">
							<label>
								heat <b class={s.heat > TOO_HOT ? "num hot" : "num"}>{s.heat}°</b>
								<input
									type="range"
									min="120"
									max="260"
									step="10"
									value={String(s.heat)}
									onChange={handler("on/set", (e) => [o.name, "heat", num(e)])}
								/>
							</label>
							<label>
								minutes <b class="num">{s.minutes}</b>
								<input
									type="range"
									min="0.4"
									max="3"
									step="0.2"
									value={String(s.minutes)}
									onChange={handler("on/set", (e) => [o.name, "minutes", num(e)])}
								/>
							</label>
							<div class="row">
								<button onClick={handler("on/again", [o.name])}>bake again</button>
								<button onClick={handler("on/same", [o.name])}>same heat again</button>
							</div>
						</div>
					)
				})}
			</div>
		</section>
	)

	return (
		<div class="po">
			<style>{css}</style>
			<h1>
				oven<span>pending and errors, on a computer's own node</span>
			</h1>
			<p class="lede">
				each oven is a compute awaiting a bake. while it bakes its run is pending; too hot and
				it fails. neither goes in the oven's value: both sit in its node's attributes, which the
				doors read. the settings are one node, changed at a path by recipes.
			</p>
			<div class="ovens">{ovens.map(oven)}</div>
			<section class="till">
				<h2>
					receipts<em>what each write to /oven/settings wrote</em>
				</h2>
				<ol>
					{bind("oven/receipts", (rs: Receipt[]) =>
						rs.length === 0
							? <li class="empty">move a knob…</li>
							: rs.map((r) => (
								<li key={String(r.n)}>
									<b>#{r.n}</b> <code class="how">{r.how}</code> <code>{r.path}</code>
									{r.patches.length
										? (
											<span class="wrote">
												wrote {r.patches.map((p) => <code>{p}</code>)}
											</span>
										)
										: (
											<span class="nothing">
												nothing written:{" "}
												{r.how === "set" ? "already that" : "already there"}
											</span>
										)}
									{r.gave ? <span class="gave">gave back {r.gave}</span> : null}
								</li>
							)))}
				</ol>
			</section>
		</div>
	)
}

const css = `
.po{font-family:Jost,system-ui,sans-serif;color:#000;background:#fffbd6;border:1px solid #000;margin:-6px;padding:12px 14px 16px;min-height:calc(100vh - 18px);box-sizing:border-box}
.po *{box-sizing:border-box}
.po h1{font-size:22px;margin:0 0 2px;font-weight:600}
.po h1 span{display:inline-block;background:#ffff88;border:1px solid #000;padding:0 8px;transform:skewX(-10deg);font-size:13px;font-weight:500;vertical-align:3px;margin-left:8px}
.po .lede{margin:0 0 12px;font-size:13.5px;line-height:1.35;max-width:660px}
.po code{font-family:Monaco,ui-monospace,Menlo,monospace;font-size:10.5px}
.po .ovens{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.po .win{background:#fff;border:1px solid #000;box-shadow:2px 2px 0 #000}
.po .win header{position:relative;height:20px;border-bottom:1px solid #000;display:flex;align-items:center;justify-content:center;background:repeating-linear-gradient(#fff 0 1px,#000 1px 2px) 0 4px/100% 12px no-repeat,#fff}
.po .win header span{background:#fff;padding:0 8px;font-size:12px;font-weight:600}
.po .win .close{position:absolute;left:8px;top:4px;width:11px;height:11px;border:1px solid #000;background:#fff}
.po .body{padding:8px 10px 10px;display:flex;flex-direction:column;gap:7px;font-size:12.5px}
.po .door{border:1px solid #000;min-height:46px;padding:5px 8px;display:flex;flex-direction:column;justify-content:center;gap:1px}
.po .door b{font-weight:600;font-size:13px}
.po .door small{font-size:11px;opacity:.7}
.po .door.pending{background:repeating-linear-gradient(135deg,#ffff88 0 10px,#fff 10px 20px);background-size:28px 28px;animation:poslide 1s linear infinite}
.po .door.burnt{background:#ffd6e7;box-shadow:inset 0 0 0 2px #ff2284}
.po .door.burnt b{color:#c4005a}
.po .door.done{background:#d9f7ee;box-shadow:inset 0 0 0 2px #40dcba}
.po .door.empty{background:#fafafa;border-style:dashed;opacity:.7}
@keyframes poslide{to{background-position:28px 0}}
.po .raw{display:flex;flex-direction:column;gap:1px;font-size:11px;background:#fbfbfb;border:1px dashed #000;padding:4px 6px}
.po .raw .k{opacity:.7}
.po .raw .v{word-break:break-all}
.po .knobs{display:flex;flex-direction:column;gap:5px}
.po label{display:flex;align-items:center;gap:6px;font-weight:500}
.po label input{flex:1;accent-color:#ff2284}
.po .num{font-weight:600;color:#2269ff;min-width:34px}
.po .num.hot{color:#ff2284}
.po .row{display:flex;gap:6px}
.po .add{padding:18px 0;display:flex;justify-content:center}
.po button{font:inherit;font-size:12.5px;font-weight:500;background:#fff;color:#000;border:1px solid #000;border-radius:2px;padding:1px 10px;cursor:pointer;box-shadow:1px 1px 0 #000;transition:transform .08s,box-shadow .08s}
.po button:hover{transform:translate(-1px,-1px);box-shadow:2px 2px 0 #000}
.po button:active{transform:translate(1px,1px);box-shadow:none}
.po button.go{background:#ff2284;color:#fff}
.po .till{margin-top:14px;background:#fff;border:1px solid #000;padding:8px 10px;max-width:660px;box-shadow:2px 2px 0 #000}
.po .till h2{font-size:13px;font-weight:600;margin:0 0 6px;display:flex;gap:8px;align-items:center}
.po .till h2 em{font-style:normal;font-weight:500;font-size:11.5px;opacity:.7}
.po .till ol{list-style:none;margin:0;padding:0;font-size:12px}
.po .till li{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline;padding:4px 0;border-top:1px dashed #000;animation:poin .3s ease-out}
.po .till li:first-child{border-top:none}
.po .till li.empty{opacity:.6;animation:none}
.po .till .how{background:#ffff88;border:1px solid #000;padding:0 4px}
.po .till .wrote code{background:#d9f7ee;margin-left:4px;padding:0 3px}
.po .till .nothing{color:#ff2284;font-weight:600}
.po .till .gave{opacity:.7}
@keyframes poin{from{opacity:0;transform:translateY(-4px)}}
`
