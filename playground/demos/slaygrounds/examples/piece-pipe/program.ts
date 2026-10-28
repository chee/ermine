/** @jsxImportSource @ermine */
import { createAction, ensureNode, explain, patch, peep, read } from "@ermine/system"
import { pipe, type Told as Watched } from "@ermine/pipe"
import { bind, handler } from "@ermine/render/h"

// piece-pipe: one thing in two shapes, kept in step by patches (a little cambria). v1 says name,
// temp_c and cute; v2 says title, temp_f and mood. one pipe between the nodes (pipe(v1, v2, there,
// back): a translate) hears every patch that lands on either, and the lens rewrites it into the
// other shape and writes it there. the pipe is never told its own writes, so the lens's write lands
// without being sent back: nothing echoes. the pipe is told as the write lands ({ timing: "write" })

type Patch = Watched["patches"][number]
type Way = "v1→v2" | "v2→v1"
type Flow = {
	n: number
	way: Way
	by: string
	before: Patch[]
	after: Patch[]
	landed: string
}

const c2f = (c: number) => Math.round((c * 9 / 5 + 32) * 10) / 10
const f2c = (f: number) => Math.round(((f - 32) * 5 / 9) * 10) / 10

// the lens: a name on each side, and how a value goes there and back
const rules = [
	{ a: "name", b: "title", there: (v: unknown) => v, back: (v: unknown) => v, says: "rename" },
	{
		a: "temp_c",
		b: "temp_f",
		there: (v: unknown) => c2f(Number(v)),
		back: (v: unknown) => f2c(Number(v)),
		says: "°C·9/5+32",
	},
	{
		a: "cute",
		b: "mood",
		there: (v: unknown) => (v ? "cute" : "grumpy"),
		back: (v: unknown) => v === "cute",
		says: "true ⇄ cute",
	},
]

// a patch on one shape as patches on the other. a whole value: field by field. a name the lens
// has no rule for, or anything deeper than a field: nothing goes across
function rewrite(p: Patch, way: Way): Patch[] {
	const fwd = way === "v1→v2"
	if (p.path.length === 0) {
		const v = (p.value ?? {}) as Record<string, unknown>
		const out: Record<string, unknown> = {}
		for (const r of rules) {
			const from = fwd ? r.a : r.b
			if (Object.hasOwn(v, from)) out[fwd ? r.b : r.a] = (fwd ? r.there : r.back)(v[from])
		}
		return [{ path: [], value: out }]
	}
	const r = rules.find((r) => (fwd ? r.a : r.b) === p.path[0])
	if (!r || p.path.length > 1 || p.move) return []
	const to = fwd ? r.b : r.a
	return "value" in p
		? [{ path: [to], value: (fwd ? r.there : r.back)(p.value) }]
		: [{ path: [to] }]
}

const show = (p: Patch) =>
	`[${p.path.join(".")}]${"value" in p ? " = " + JSON.stringify(p.value) : " taken out"}`

// who made the write a pipe heard: the action that did it (explain: its writer, one step), as the
// pipe sees it; no actor of its own to say (every write here is the host's)
const by = (w: Watched) => {
	const writer = w.change && peep(() => explain(w.change!))?.writer
	if (writer?.kind === "feature") return writer.feature
	return writer?.kind === "method" ? String(writer.path?.join("/")) : writer?.kind ?? "?"
}

export default function program() {
	const v1 = ensureNode("./v1", { name: "ermine", temp_c: 20, cute: true })
	const v2 = ensureNode("./v2", { title: "ermine", temp_f: 68, mood: "cute" })
	const log = ensureNode("log", [] as Flow[])
	const count = ensureNode("count", 0)

	// what a write heard crosses as, and a line of the log for it (the pipe's own scope: the log's
	// writes are the pipe's)
	const across = (way: Way) => (w: Watched): Patch[] => {
		const before = [...w.patches]
		const after = before.flatMap((p) => rewrite(p, way))
		const n = (peep(() => read(count)) as number) + 1
		patch(count, [{ path: [], value: n }])
		const flow: Flow = {
			n,
			way,
			by: by(w),
			before,
			after,
			landed: after.length
				? `${way === "v1→v2" ? "v2" : "v1"}, ${after.length} patch${
					after.length === 1 ? "" : "es"
				}`
				: "",
		}
		const was = peep(() => read(log)) as Flow[]
		patch(log, [{ path: [], value: [flow, ...was].slice(0, 6) }])
		return after
	}
	// one pipe, both ways: a patch on v1 goes to v2 as v1→v2 says, a patch on v2 back as v2→v1 says
	pipe(v1, v2, across("v1→v2"), across("v2→v1"), { timing: "write", name: "lens" })

	// a person's edits: a patch on one field; the action that made it is what says which window
	createAction("on/v1", (field: string, value: unknown) => patch(v1, [{ path: [field], value }]))
	createAction("on/v2", (field: string, value: unknown) => patch(v2, [{ path: [field], value }]))
	createAction(
		"on/reset",
		() => patch(v1, [{ path: [], value: { name: "ermine", temp_c: 20, cute: true } }]),
	)

	const value = (e: Event) => (e.target as HTMLInputElement).value
	const field = (v: unknown, k: string) => (v as Record<string, unknown>)?.[k]

	return (
		<div class="pp">
			<style>{css}</style>
			<h1>
				pipe<span>one thing, two shapes, patches between</span>
			</h1>
			<p class="lede">
				each window edits its own node. a pipe between the nodes hears every patch that lands on
				either, and the lens rewrites it into the other shape. the pipe is never told its own
				write, so nothing is sent back.
			</p>
			<div class="desk">
				<section class="win">
					<header>
						<b class="close" />
						<span>v1 · celsius</span>
					</header>
					<div class="body">
						<label>
							name
							<input
								value={bind("./v1", (v) => field(v, "name") ?? "")}
								onInput={handler("on/v1", (e) => ["name", value(e)])}
								spellcheck={false}
							/>
						</label>
						<label>
							temp_c <b class="num">{bind("./v1", (v) => `${field(v, "temp_c")}°C`)}</b>
							<input
								type="range"
								min="-10"
								max="40"
								step="1"
								value={bind("./v1", (v) => String(field(v, "temp_c")))}
								onInput={handler("on/v1", (e) => ["temp_c", Number(value(e))])}
							/>
						</label>
						<label class="check">
							<input
								type="checkbox"
								checked={bind("./v1", (v) => !!field(v, "cute"))}
								onChange={handler(
									"on/v1",
									(e) => ["cute", (e.target as HTMLInputElement).checked],
								)}
							/>
							cute
						</label>
						<button onClick={handler("on/reset")}>put v1 back whole</button>
						<code class="raw">{bind("./v1", (v) => JSON.stringify(v))}</code>
					</div>
				</section>
				<div class="tube">
					<div class="glass">
						{bind("log", (rows: Flow[]) =>
							rows.slice(0, 1).map((r) => (
								<i
									key={String(r.n)}
									class={`${r.way === "v1→v2" ? "right" : "left"}${
										r.after.length ? "" : " dropped"
									}`}
								/>
							)))}
					</div>
					<div class="arrows">patches</div>
				</div>
				<section class="win">
					<header>
						<b class="close" />
						<span>v2 · fahrenheit</span>
					</header>
					<div class="body">
						<label>
							title
							<input
								value={bind("./v2", (v) => field(v, "title") ?? "")}
								onInput={handler("on/v2", (e) => ["title", value(e)])}
								spellcheck={false}
							/>
						</label>
						<label>
							temp_f <b class="num">{bind("./v2", (v) => `${field(v, "temp_f")}°F`)}</b>
							<input
								type="range"
								min="14"
								max="104"
								step="0.1"
								value={bind("./v2", (v) => String(field(v, "temp_f")))}
								onInput={handler("on/v2", (e) => ["temp_f", Number(value(e))])}
							/>
						</label>
						<div class="mood">
							mood
							<button
								class={bind("./v2", (v) => field(v, "mood") === "cute" ? "on" : "")}
								onClick={handler("on/v2", ["mood", "cute"])}
							>
								cute
							</button>
							<button
								class={bind("./v2", (v) => field(v, "mood") === "grumpy" ? "on" : "")}
								onClick={handler("on/v2", ["mood", "grumpy"])}
							>
								grumpy
							</button>
						</div>
						<button onClick={handler("on/v2", ["sticker", "🐾"])}>add a sticker 🐾</button>
						<code class="raw">{bind("./v2", (v) => JSON.stringify(v))}</code>
					</div>
				</section>
			</div>
			<section class="lens">
				<b class="tag">the lens</b>
				{rules.map((r) => (
					<span class="rule" key={r.a}>
						<code>{r.a}</code> ⇄ <code>{r.b}</code> <em>{r.says}</em>
					</span>
				))}
				<span class="rule">
					<em>anything else: nothing goes across</em>
				</span>
			</section>
			<section class="flows">
				<h2>
					the pipe
					<em>{bind("count")} crossed · the pipe is not told its own writes</em>
				</h2>
				<ol>
					{bind("log", (rows: Flow[]) =>
						rows.length === 0
							? <li class="empty">type a name, drag a temperature…</li>
							: rows.map((r) => (
								<li key={String(r.n)} class={r.way === "v1→v2" ? "right" : "left"}>
									<div class="who">
										<b>#{r.n}</b>
										<span class="way">
											{r.way === "v1→v2" ? "v1 ━━▶ v2" : "v1 ◀━━ v2"}
										</span>
										<span>by {r.by}</span>
									</div>
									<div class="pp-patches">
										<code>{r.before.map(show).join(", ")}</code>
										<span class="arrow">→</span>
										{r.after.length
											? <code class="out">{r.after.map(show).join(", ")}</code>
											: <em class="none">nothing: the lens has no rule for it</em>}
									</div>
									{r.landed
										? <div class="landed">landed on {r.landed}, by the pipe</div>
										: null}
								</li>
							)))}
				</ol>
			</section>
		</div>
	)
}

const css = `
.pp{font-family:Jost,system-ui,sans-serif;color:#000;background:#fffbd6;border:1px solid #000;margin:-6px;padding:12px 14px 16px;min-height:calc(100vh - 18px);box-sizing:border-box}
.pp *{box-sizing:border-box}
.pp h1{font-size:22px;margin:0 0 2px;font-weight:600}
.pp h1 span,.pp .tag{display:inline-block;background:#ffff88;border:1px solid #000;padding:0 8px;transform:skewX(-10deg);font-size:13px;font-weight:500;vertical-align:3px;margin-left:8px}
.pp .lede{margin:0 0 12px;font-size:13.5px;line-height:1.35;max-width:640px}
.pp code{font-family:Monaco,ui-monospace,Menlo,monospace;font-size:11px}
.pp .desk{display:flex;align-items:stretch;gap:0;flex-wrap:wrap}
.pp .win{flex:1 1 250px;min-width:230px;max-width:330px;background:#fff;border:1px solid #000;box-shadow:2px 2px 0 #000}
.pp .win header{position:relative;height:20px;border-bottom:1px solid #000;display:flex;align-items:center;justify-content:center;background:repeating-linear-gradient(#fff 0 1px,#000 1px 2px) 0 4px/100% 12px no-repeat,#fff}
.pp .win header span{background:#fff;padding:0 8px;font-size:12px;font-weight:600}
.pp .win .close{position:absolute;left:8px;top:4px;width:11px;height:11px;border:1px solid #000;background:#fff}
.pp .body{padding:10px;display:flex;flex-direction:column;gap:8px;font-size:12.5px}
.pp label{display:flex;flex-direction:column;gap:3px;font-weight:500}
.pp label.check{flex-direction:row;align-items:center;gap:6px}
.pp .num{font-weight:600;color:#ff2284;margin-left:4px}
.pp input:not([type]){font:inherit;font-size:14px;border:1px solid #000;border-radius:0;padding:3px 6px;background:#fff}
.pp input:not([type]):focus{outline:none;background:#ffff88}
.pp input[type=range]{accent-color:#ff2284}
.pp input[type=checkbox]{accent-color:#ff2284}
.pp .mood{display:flex;gap:6px;align-items:center;font-weight:500}
.pp button{font:inherit;font-size:12.5px;font-weight:500;background:#fff;color:#000;border:1px solid #000;border-radius:2px;padding:1px 10px;cursor:pointer;box-shadow:1px 1px 0 #000;transition:transform .08s,box-shadow .08s;align-self:flex-start}
.pp button:hover{transform:translate(-1px,-1px);box-shadow:2px 2px 0 #000}
.pp button:active{transform:translate(1px,1px);box-shadow:none}
.pp button.on{background:#ff2284;color:#fff}
.pp .raw{display:block;background:#fbfbfb;border:1px dashed #000;padding:4px 6px;word-break:break-all;min-height:34px}
.pp .tube{flex:0 0 70px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px}
.pp .glass{position:relative;width:70px;height:16px;border-top:1px solid #000;border-bottom:1px solid #000;background:#ffff88;overflow:hidden}
.pp .glass i{position:absolute;top:2px;width:10px;height:10px;border-radius:50%;background:#ff2284;border:1px solid #000;animation:ppright .6s ease-in forwards}
.pp .glass i.left{animation-name:ppleft;background:#40dcba}
.pp .glass i.dropped{background:#fff}
@keyframes ppright{from{left:-12px}to{left:58px}}
@keyframes ppleft{from{left:70px}to{left:0}}
.pp .arrows{font-size:11px;font-weight:600}
.pp .lens{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;margin:12px 0 10px;padding:8px 10px;background:#fff;border:1px solid #000;font-size:12.5px}
.pp .lens .tag{margin:0 2px 0 0}
.pp .lens em{font-style:normal;opacity:.6;margin-left:3px}
.pp .flows h2{font-size:13px;font-weight:600;margin:0 0 6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.pp .flows h2 em{font-style:normal;font-weight:500;font-size:12px;background:#fff;border:1px solid #000;padding:0 6px}
.pp ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px}
.pp ol li{background:#fff;border:1px solid #000;padding:5px 8px;font-size:12px;animation:ppin .35s ease-out}
.pp ol li.right{box-shadow:3px 2px 0 #ff2284;margin-right:30px}
.pp ol li.left{box-shadow:-3px 2px 0 #40dcba;margin-left:30px}
.pp ol li.empty{opacity:.6;border-style:dashed;animation:none}
@keyframes ppin{from{transform:translateY(-6px);opacity:0}}
.pp .who{display:flex;gap:10px;align-items:baseline}
.pp .who .way{font-weight:600;letter-spacing:.5px}
.pp .pp-patches{display:flex;gap:6px;align-items:baseline;flex-wrap:wrap;margin-top:2px}
.pp .pp-patches .out{background:#ffff88}
.pp .arrow{color:#ff2284;font-weight:700}
.pp .none{font-size:11.5px;opacity:.7}
.pp .landed{font-size:11px;opacity:.6;margin-top:1px}
`
