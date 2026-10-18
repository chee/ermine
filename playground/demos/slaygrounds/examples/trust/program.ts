/** @jsxImportSource ermine-h */
import type { API } from "@ermine/api"
import { bind, handler } from "ermine-h"

// trust: a vault that opens only for a person. the world decides trusted by itself, from the
// event the window is dispatching right now (read through the native getter it kept before this
// program ran); nothing a program hands it counts. each row below is an attempt: press its button.
// what the row says it got is not this program's guess: it is the "trusted-event" key on the change
// the vault's handler wrote (vault/tries/<row>), the same pair the inspector and explain show

const css = `
body { background: #ffff88 }
.lab { max-width: 860px; margin: 0 auto; font-family: Jost, system-ui, sans-serif }
.vault { display: flex; align-items: center; gap: 16px; background: #fff; border: 1px solid #000;
	border-radius: 6px; box-shadow: 0 0 10px 2px #66003322; padding: 12px 16px; margin-bottom: 12px }
.door { font-size: 64px; line-height: 1; transition: transform 200ms }
.vault.open .door { transform: scale(1.15) rotate(-8deg) }
.vault.open { background: #c8f6ea }
.vault .say { flex: 1 }
.vault .say b { display: inline-block; background: #ffff88; border: 1px solid #000; padding: 0 10px;
	transform: skew(-8deg); font-size: 16px }
.vault .say p { margin: 6px 0 0; font-size: 13px }
.tally { font-size: 13px; text-align: right }
.tally span { font-variant-numeric: tabular-nums; font-weight: 600 }
table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #000;
	border-radius: 6px; overflow: hidden; font-size: 13px }
td { border-top: 1px solid #0002; padding: 5px 8px; vertical-align: top }
td.n { width: 18px; color: #ff2284; font-weight: 600 }
td.what b { display: block }
td.what small { color: #0009 }
td.go { width: 60px }
td.got { width: 150px }
td.why { color: #333; max-width: 300px }
.pill { display: inline-block; border: 1px solid #000; border-radius: 9px; padding: 0 8px;
	font-size: 12px; font-weight: 600; white-space: nowrap }
.pill.yes { background: #40dcba } .pill.no { background: #ff2284; color: #fff }
.pill.none { background: #fff; color: #0008; font-weight: 400; border-style: dashed }
.caller { display: block; font: 10px Monaco, ui-monospace, monospace; color: #0009; margin-top: 2px }
.note { display: block; font: 10px Monaco, ui-monospace, monospace; color: #2269ff; margin-top: 2px }
code { font: 11px Monaco, ui-monospace, monospace; background: #ffffc2; padding: 0 3px }
button.decoy { display: none }
`

// how a row's attempt is made: kept here, so each row's code is what you read
type Row = {
	id: string
	what: string
	how: string
	why: string
	// what pressing the row's button does; none: the button is the handler itself
	go?: (ctx: Ctx) => void | Promise<void>
	// a row with no button: done somewhere else (the console, the inspector)
	elsewhere?: boolean
}
type Ctx = {
	knock: (id: string, ...rest: unknown[]) => unknown
	decoy: () => HTMLButtonElement
	note: (text: string) => void
}

const rows: Row[] = [
	{
		id: "click",
		what: "a real click",
		how: 'the button\'s own handler: onClick={handler("on/knock")}',
		why: "a person's click is being dispatched while send runs: its isTrusted is true",
	},
	{
		id: "chain",
		what: "a real click, then a second handler",
		how: "knock calls on/relay synchronously, inside the same click",
		why: "the click is still being dispatched when the second call runs: both are trusted",
	},
	{
		id: "scripted",
		what: "button.click() from code",
		how: "inside your click, the code clicks a hidden button that calls knock",
		why:
			"click() dispatches a new event of its own, made by script (isTrusted false); while it is dispatched, it is the window's event, not your click",
		go: ({ decoy }) => decoy().click(),
	},
	{
		id: "dispatch",
		what: 'dispatchEvent(new MouseEvent("click"))',
		how: "inside your click, a made-up click dispatched on the hidden button",
		why: "an event a script made is never trusted: only the browser makes trusted events",
		go: ({ decoy }) => decoy().dispatchEvent(new MouseEvent("click", { bubbles: true })),
	},
	{
		id: "forged",
		what: 'Object.defineProperty(event, "isTrusted", …)',
		how: "a made-up click, isTrusted redefined as true, then dispatched",
		why:
			"isTrusted is unforgeable: an own property that cannot be configured, so redefining it throws; the event stays untrusted",
		go: ({ decoy, note }) => {
			const forged = new MouseEvent("click", { bubbles: true })
			try {
				Object.defineProperty(forged, "isTrusted", { get: () => true })
				note("defineProperty did not throw")
			} catch (e) {
				note(`threw: ${(e as Error).message}`)
			}
			decoy().dispatchEvent(forged)
		},
	},
	{
		id: "spoof",
		what: "window.event = { isTrusted: true }",
		how: "from code (a timer), window.event replaced, then a call",
		why:
			"window.event can be replaced, so a host reading it would be fooled; this host kept the native getter before any program ran",
		go: ({ knock, note }) => {
			setTimeout(() => {
				const real = Object.getOwnPropertyDescriptor(window, "event")!
				;(window as any).event = { isTrusted: true }
				note(`window.event.isTrusted read ${(window as any).event.isTrusted}`)
				try {
					knock("spoof")
				} finally {
					Object.defineProperty(window, "event", real) // put back
				}
			})
		},
	},
	{
		id: "fake",
		what: "a fake { isTrusted: true } handed in",
		how: "from code (a timer), as the event and as an argument",
		why: "call takes no event and no flag: what it is handed is never asked",
		go: ({ knock }) => void setTimeout(() => knock("fake", { isTrusted: true })),
	},
	{
		id: "await",
		what: "a real click that awaits, then calls",
		how: "async: await a 10ms timer, then knock",
		why:
			"after the await the click is over: no event is being dispatched (the same rule as scopes and reads)",
		go: async ({ knock }) => {
			await new Promise((r) => setTimeout(r, 10))
			knock("await")
		},
	},
	{
		id: "microtask",
		what: "a real click that awaits a promise already settled",
		how: "async: await null, then knock",
		why:
			"the code after this await runs before the click is done being dispatched (a microtask, before the listener's turn ends), so it is still your click",
		go: async ({ knock }) => {
			await null
			knock("microtask")
		},
	},
	{
		id: "timer",
		what: "a real click that starts a timer",
		how: "setTimeout(0), and the timer calls knock",
		why: "a timer runs in a task of its own: no event is being dispatched",
		go: ({ knock }) => void setTimeout(() => knock("timer")),
	},
	{
		id: "console",
		what: "a call from the console",
		how: "type knock() in the console below and press enter",
		why:
			"your enter is dispatched in the page around the program, not in its window: the program's window has no event",
		elsewhere: true,
	},
	{
		id: "inspector",
		what: "the inspector's call box",
		how: 'graph tab → vault/on/knock → call with ["inspector"]',
		why: "the call box runs from the page around the program: no event in the program's window",
		elsewhere: true,
	},
]

// the world's two tools: who is the caller and trusted of the call (or of a change), change a
// node's latest change
type Tools = API & {
	who: (change?: unknown) => { caller: unknown; "trusted-event": boolean }
	change: (x: unknown) => { metadata?: [string, unknown][] } | undefined
}

export default function program(
	{ open, read, edit, memo, effect, method, send, teardown, who, change }: Tools,
) {
	const door = open("door", "shut")
	const opened = open("opened", 0)
	const bounced = open("bounced", 0)
	const notes = open("notes", {})
	const n = (x: unknown) => read(x as never) as number
	const add = (x: unknown) => edit(x as never, (c: number) => c + 1)

	// every attempt ends here. what it writes (vault/tries/<id>) carries the send's pairs: the
	// rows read "trusted-event" off that change. the door opens only for a person
	let shut: ReturnType<typeof setTimeout> | undefined
	method("on/knock", (id: string = "inspector") => {
		add(open(`tries/${id}`, 0))
		if (id === "chain") send("on/relay")
		if (!who()["trusted-event"]) return void add(bounced)
		edit(door, () => "open")
		add(opened)
		clearTimeout(shut)
		// a timer writes as the vault, with no method between
		shut = setTimeout(() => edit(door, () => "shut"), 1600)
	})
	method("on/relay", () => add(open("tries/chain-relay", 0)))
	method(
		"on/note",
		(id: string, text: string) => edit(notes, (d: Record<string, string>) => void (d[id] = text)),
	)
	teardown(() => clearTimeout(shut))

	// what each row got: the trusted-event and caller keys of its node's latest change
	memo("verdicts", () => {
		const out: Record<string, { trusted: boolean; caller: unknown; times: unknown }> = {}
		for (const id of [...rows.map((r) => r.id), "chain-relay"]) {
			const node = open(`tries/${id}`)
			const times = read(node)
			if (times === undefined) continue
			const { caller, "trusted-event": trusted } = who(change(node))
			out[id] = { trusted, caller, times }
		}
		return out
	})

	// a failed attempt bounces off the vault
	let vault: HTMLElement | undefined
	effect("bounce", () => n(bounced), (_, before) => {
		if (before !== undefined) {
			vault?.animate([
				{ transform: "translateX(0)" },
				{ transform: "translateX(-9px) rotate(-1deg)" },
				{ transform: "translateX(7px) rotate(1deg)" },
				{ transform: "translateX(0)" },
			], 260)
		}
	})

	// the console's way in: knock() typed in the console below
	const g = globalThis as any
	g.knock = (id = "console") => send("on/knock", id)
	teardown(() => delete g.knock)

	const decoys = new Map<string, HTMLButtonElement>()
	const ctx = (id: string): Ctx => ({
		knock: (row, ...rest) => send("on/knock", row, ...rest),
		decoy: () => decoys.get(id)!,
		note: (text) => void send("on/note", id, text),
	})
	const pill = (v?: { trusted: boolean; caller: unknown; times: unknown }) =>
		!v ? <span class="pill none">not tried</span> : (
			<span>
				<span class={v.trusted ? "pill yes" : "pill no"}>
					{v.trusted ? "🔓 trusted" : "🙅 untrusted"}
				</span>
				<span class="caller">caller {String(v.caller)} · ×{String(v.times)}</span>
			</span>
		)

	return (
		<div class="lab">
			<style>{css}</style>
			<div class={bind("door", (d) => `vault ${d}`)} ref={(e) => (vault = e as HTMLElement)}>
				<div class="door">{bind("door", (d) => (d === "open" ? "🔓" : "🔒"))}</div>
				<div class="say">
					<b>the vault opens for a person</b>
					<p>
						send reads <code>window.event.isTrusted</code>{" "}
						itself, through the native getter the host kept. try to fool it below.
					</p>
				</div>
				<div class="tally">
					opened <span>{bind("opened")}</span>×<br />
					bounced <span>{bind("bounced")}</span>×
				</div>
			</div>
			<table>
				{rows.map((r, i) => (
					<tr key={r.id}>
						<td class="n">{i + 1}</td>
						<td class="what">
							<b>{r.what}</b>
							<small>{r.how}</small>
						</td>
						<td class="go">
							{r.elsewhere
								? <small>↓</small>
								: r.go
								? <button onClick={() => void r.go!(ctx(r.id))}>try</button>
								: <button onClick={handler("on/knock", [r.id])}>try</button>}
							{r.go && (
								<button
									class="decoy"
									ref={(e) => decoys.set(r.id, e as HTMLButtonElement)}
									onClick={handler("on/knock", [r.id])}
								/>
							)}
						</td>
						<td class="got">
							{bind("verdicts", (v) => pill(v[r.id]))}
							{r.id === "chain" && bind("verdicts", (v) =>
								v["chain-relay"] && (
									<span class="note">
										relay: {v["chain-relay"].trusted ? "trusted" : "untrusted"}
									</span>
								))}
							{bind("notes", (v) => v[r.id] && <span class="note">{v[r.id]}</span>)}
						</td>
						<td class="why">{r.why}</td>
					</tr>
				))}
			</table>
		</div>
	)
}
