/** @jsxImportSource ermine-h */
import {
	createAction,
	createEffect,
	createMemo,
	ensureNode,
	patch,
	peep,
	read,
} from "@ermine/system"
import { bind, handler } from "ermine-h"

// toy-fortune: ask a yes/no question, shake the ball. the answer is an async compute: it reads the
// question, then thinks (a random wait) before it answers, pending in its place meanwhile. every
// answer goes into a diary (one node); the ball and the diary are two views of it. the input's
// Enter is a handler whose arguments are read off the key: anything else, no call, so typing lands
const answers = [
	"yes, obviously",
	"ask me after snacks",
	"the stars say maybe",
	"no, but sweetly",
	"definitely, go go go",
	"not today, friend",
	"signs point to yes",
	"my sources are dogs: no",
]
const css = `
.fx{background:#fff;border:1px solid #000;border-radius:2px;box-shadow:0 4px 24px #ff228433;padding:16px;max-width:360px;margin:0 auto;text-align:center;font-family:Jost,system-ui,sans-serif}
.fx .ball{width:190px;height:190px;border-radius:50%;margin:8px auto;background:radial-gradient(circle at 35% 30%,#555,#000 60%);color:#fff;display:grid;place-items:center;cursor:pointer;box-shadow:0 6px 0 #ff2284}
.fx .win{width:96px;height:96px;border-radius:50%;background:#2269ff;display:grid;place-items:center;padding:8px;font-size:14px;line-height:1.15}
.fx input{width:80%;margin:6px 0}
.fx ol{text-align:left;margin:10px 0 0;padding-left:24px;font-size:14px;max-height:120px;overflow:auto}
.fx .ball.thinking{animation:think .45s ease-in-out infinite alternate}
@keyframes think{from{transform:rotate(-7deg)}to{transform:rotate(7deg)}}
.fx .tag{display:inline-block;background:#fff7a8;border:1px solid #000;padding:0 10px;transform:skew(-8deg);font-size:13px}
`

type Ask = { q: string; n: number }
type Said = { q: string; a: string; n?: number }

export default function program() {
	const diary = ensureNode("./diary", [{ q: "will this demo be cute?", a: "yes, obviously" }])
	const shakes = ensureNode("./shakes", 0)
	const asking = ensureNode("./asking", null) // the question being thought about: { q, n }
	// the nodes' values, as what they hold
	const said = () => read(diary) as Said[]
	const asked = () => read(asking) as Ask | null
	const answered = () => read(answer) as Said | null

	// the ball thinks: read what it needs first (reads after an await count for nothing), then wait.
	// pending in its place meanwhile, and what is bound to it says so
	const answer = createMemo("answer", () => {
		const ask = asked()
		if (!ask) return null
		// the same question gets a different answer every shake: it is a hash of the shake count
		let h = ask.n * 2654435761
		for (const ch of ask.q) h = (h * 31 + ch.charCodeAt(0)) >>> 0
		return new Promise<Said>((done) =>
			setTimeout(
				() => done({ q: ask.q, a: answers[h % answers.length], n: ask.n }),
				600 + Math.random() * 1600,
			)
		)
	})
	// thinking: asked something it has not answered yet
	const thinking = createMemo("thinking", () => {
		const ask = asked()
		return !!ask && answered()?.n !== ask.n
	})
	createMemo(
		"window",
		() => read(thinking) ? "…thinking…" : answered()?.a ?? said().at(-1)?.a ?? "ask something",
	)
	createMemo("tally", () => `${said().length} answers given`)
	// each new answer goes in the diary, once
	createEffect("remember", answered, (v) => {
		if (!v) return
		const d = peep(() => read(diary)) as Said[]
		if (!d.some((x) => x.n === v.n)) patch(diary, [{ path: [], value: [...d, v] }])
	})

	createAction("on/shake", (q: string) => {
		const n = (peep(() => read(shakes)) as number) + 1
		patch(shakes, [{ path: [], value: n }])
		patch(asking, [{ path: [], value: { q, n } }])
	})
	createAction("on/forget", () => patch(diary, [{ path: [], value: [] }]))

	// the ball and the input: the elements the jsx made, handed back by ref (a shake wobbles one,
	// reads and clears the other)
	let ball: HTMLElement | undefined
	let input: HTMLInputElement | undefined
	// what a shake asks: the question typed (taken out of the input), the ball given a wobble
	const ask = () => {
		const q = input?.value.trim() || "(a silent question)"
		if (input) input.value = ""
		ball?.animate([{ transform: "rotate(0)" }, { transform: "rotate(-12deg) translateX(-8px)" }, {
			transform: "rotate(12deg) translateX(8px)",
		}, { transform: "rotate(0)" }], 350)
		return [q]
	}
	// the diary is drawn from the node, newest first; the ball's window is the window compute
	return (
		<div class="fx">
			<style>{css}</style>
			<span class="tag">ask the ball</span>
			<div
				class={bind("thinking", (on) => (on ? "ball thinking" : "ball"))}
				title="shake me"
				ref={(e) => (ball = e)}
				onClick={handler("on/shake", ask)}
			>
				<div class="win">{bind("window")}</div>
			</div>
			<input
				placeholder="a yes/no question…"
				ref={(e) => (input = e)}
				onKeyDown={handler("on/shake", (e) => (e.key === "Enter" ? ask() : undefined))}
			/>
			<div>
				{bind("tally")} · <button onClick={handler("on/forget")}>🧽 forget all</button>
			</div>
			<ol>
				{bind("diary", (d: Said[]) =>
					d.slice(-6).reverse().map((x, i) => <li key={d.length - i}>{x.q} → {x.a}</li>))}
			</ol>
		</div>
	)
}
