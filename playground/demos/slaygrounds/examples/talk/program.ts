/** @jsxImportSource ermine-h */
import type { API } from "@ermine/api"
import type { Tools } from "./host.ts"
import { bind, type Child, handler } from "ermine-h"

// five ways for processes to talk. none of them is a message bus: every one is nodes, calls and
// reads, so every one shows up in the graph tab as it happens (open it, pick a card with ⌖). each
// card's jsx names the nodes it shows and the methods its buttons send to (💡 explain draws them).
// what a process keeps is saved in its own folder, /state/<name>, so a reload finds it

export const sections = [
	{
		title: "1 · a shared node",
		blurb:
			"scribe writes its note. reader reads it inside a memo, so each write reruns the reader. " +
			"nobody calls anybody: the node is the whole conversation, and a read is a subscription.",
	},
	{
		title: "2 · a mailbox",
		blurb:
			"the post's inbox is a list node. ann and bo each append to it from their own handler (their own " +
			"change, their own name on it). post notices the list grew, waits a moment, and drains it.",
	},
	{
		title: "3 · a request and a reply",
		blurb:
			"asker sends to clerk/on/times. the call runs in a scope owned by clerk that says who called and " +
			"whether a person did it. the answer is the call's return. try the two buttons: clerk only " +
			"answers people.",
	},
	{
		title: "4 · publish and subscribe",
		blurb:
			"station writes station/topic and knows nothing else. three fans each read the topic in an " +
			"effect and keep their own history. add a fan and the station does not change.",
	},
	{
		title: "5 · one process starting another",
		blurb: "boss starts a new process under /crew with start. fire stops it: " +
			"the worker's cleanup hears 'ended', its timer stops, its card goes.",
	},
]

// ---- a few things every actor does: a card, a timer that is the process's ----
// a card: the process's name in a tag, its role, then what it shows
const Card = (
	props: {
		name: string
		role: string
		kid?: boolean
		children?: Child
		ref?: (e: HTMLElement) => void
	},
) => (
	<div class={props.kid ? "actor kid" : "actor"} ref={props.ref}>
		<p>
			<span class="tag">{props.name}</span>
			{props.role}
		</p>
		{props.children}
	</div>
)
// a timer of the process's: told "replaced" or "ended", either way it goes. what it calls writes
// as the process, with no method between
const every = (api: API, ms: number, f: () => void) => {
	const id = setInterval(f, ms)
	api.teardown(() => clearInterval(id))
}
const state = (name: string, key: string) => `/state/${name}/${key}`

// ---- 1 · a shared node ----
const words = ["moss", "kettle", "comet", "biscuit", "lantern", "pebble", "thimble"]

export function scribe(api: API) {
	const { open, read, edit, method } = api
	const note = open("./note", "nothing yet")
	const nth = open("./nth", 0)
	// the write is scribe's, the change says so: a button sends to it, the timer calls it
	const write = () => {
		edit(note, () => words[(read(nth) as number) % words.length])
		edit(nth, (k: number) => k + 1)
	}
	method("on/write", write)
	every(api, 5000, write)
	return (
		<Card name="scribe" role="writes a word every 5s">
			<p class="say">scribe/note = {bind(state("scribe", "note"))}</p>
			<button onClick={handler("on/write")}>write a word</button>
		</Card>
	)
}

export function reader({ open, read, edit, memo, effect, PENDING }: API) {
	const heard = open("./heard", 0)
	const note = state("scribe", "note")
	// reading inside a memo is the subscription: it reruns when scribe's note changes
	memo("shout", () => {
		const v = read(note)
		return v === undefined ? PENDING : String(v).toUpperCase() + "!"
	})
	// an effect: its act runs after each change, here counting the reruns
	effect("hear", () => read(note) ?? PENDING, (_, before) => {
		if (before !== undefined) edit(heard, (k: number) => k + 1)
	})
	return (
		<Card name="reader" role="reads scribe/note">
			<p class="get">reader/shout = {bind("shout")}</p>
			<p>reran {bind(state("reader", "heard"))} times</p>
		</Card>
	)
}

// ---- 2 · a mailbox ----
export function post({ open, read, edit, memo, effect, method, teardown }: API) {
	const inbox = open("./inbox", [] as string[])
	const opened = open("./opened", [] as string[])
	const list = (x: ReturnType<typeof open>) => read(x) as string[]
	memo("waiting", () => list(inbox).join("  ·  ") || "(empty)")
	memo("shelf", () => list(opened).join("  ·  ") || "(none yet)")
	// the owner's own method empties the list: others append, only the owner drains
	const drain = () => {
		const mail = list(inbox)
		if (!mail.length) return
		edit(opened, (d: string[]) => {
			d.push(...mail)
			d.splice(0, Math.max(0, d.length - 4))
		})
		edit(inbox, (d: string[]) => void d.splice(0))
	}
	method("on/drain", drain)
	// when the list has something in it, drain it after a moment
	let timer: ReturnType<typeof setTimeout>
	effect("relay", () => list(inbox).length, (count) => {
		clearTimeout(timer)
		if (count > 0) timer = setTimeout(drain, 2500)
	})
	teardown(() => clearTimeout(timer))
	return (
		<Card name="post" role="owns the mailbox">
			<p class="hot">post/inbox: {bind("waiting")}</p>
			<p class="get">read: {bind("shelf")}</p>
		</Card>
	)
}

// ann and bo are the same program with other words: append to the list, as yourself. a push is one
// patch on the list, so two senders in one pulse both land
function sender(api: API, name: string, lines: string[], ms: number) {
	const { open, read, edit, method } = api
	const sent = open("./sent", 0)
	const send = () => {
		const k = read(sent) as number
		edit(
			state("post", "inbox"),
			(d: string[]) => void d.push(`${name}: ${lines[k % lines.length]}`),
		)
		edit(sent, () => k + 1)
	}
	method("on/send", send)
	every(api, ms, send)
	return (
		<Card name={name} role="sends mail">
			<p>sent {bind(state(name, "sent"))} letters</p>
			<button onClick={handler("on/send")}>send a letter</button>
		</Card>
	)
}
export const ann = (api: API) =>
	sender(api, "ann", ["hello!", "lunch?", "see you at 4", "the cat is out"], 8000)
export const bo = (api: API) =>
	sender(api, "bo", ["psst", "got it", "on my way", "ok ok ok"], 11000)

// ---- 3 · a request and a reply ----
export function clerk({ open, edit, method, who }: API & Tools) {
	const answered = open("./answered", 0)
	const last = open("./last", "nobody has asked")
	method("on/times", (a: number, b: number) => {
		// who() reads the call's scope: who called, and did a person do it
		const { caller, "trusted-event": trusted } = who()
		edit(last, () => `${caller} asked ${a} × ${b}, trusted ${trusted}`)
		if (!trusted) return "i only answer people"
		edit(answered, (k: number) => k + 1)
		return a * b
	})
	return (
		<Card name="clerk" role="answers questions">
			<p class="say">{bind(state("clerk", "last"))}</p>
			<p>answered {bind(state("clerk", "answered"))} people</p>
		</Card>
	)
}

export function asker({ open, edit, method, send }: API) {
	const reply = open("./reply", "no reply yet")
	// one method asks the clerk and writes the answer down. the clerk's call inside it is made
	// while the same click is being dispatched, so a person's click is trusted all the way down
	method("on/ask", () => {
		const a = 2 + Math.floor(Math.random() * 8), b = 2 + Math.floor(Math.random() * 8)
		const answer = send("/clerk/on/times", a, b)
		edit(reply, () => `${a} × ${b} = ${answer}`)
	})
	// "from code": the same method, sent to a moment later from a timer: no event is being
	// dispatched then, so it is not a person's
	const later = () => void setTimeout(() => send("/asker/on/ask"), 0)
	return (
		<Card name="asker" role="asks">
			<p class="get">reply: {bind(state("asker", "reply"))}</p>
			<button onClick={handler("on/ask")}>ask (click)</button>
			<button onClick={later}>ask (from code)</button>
		</Card>
	)
}

// ---- 4 · publish and subscribe ----
const headlines = [
	"the bridge is open",
	"free soup on friday",
	"a fox was seen near the library",
	"the clock tower runs fast again",
	"new moon tonight",
]
export function station(api: API) {
	const { open, read, edit, method } = api
	const topic = open("./topic", "(silence)")
	const nth = open("./nth", 0)
	const publish = () => {
		edit(topic, () => headlines[(read(nth) as number) % headlines.length])
		edit(nth, (k: number) => k + 1)
	}
	method("on/publish", publish)
	every(api, 6000, publish)
	return (
		<Card name="station" role="publishes station/topic">
			<p class="say">{bind(state("station", "topic"))}</p>
			<button onClick={handler("on/publish")}>publish</button>
		</Card>
	)
}

// a subscriber: read the topic in an effect, keep your own history, show it your way
function fan(
	{ open, read, edit, memo, effect, PENDING }: API,
	name: string,
	role: string,
	show: (h: string) => string,
) {
	const got = open("./got", [] as string[])
	effect("gather", () => read(state("station", "topic")) ?? PENDING, (h) => {
		const old = read(got) as string[]
		if (typeof h === "string" && old.at(-1) !== h) {
			edit(got, (d: string[]) => {
				d.push(h)
				if (d.length > 3) d.splice(0, d.length - 3)
			})
		}
	})
	memo("shown", () => (read(got) as string[]).map(show).join("  ·  ") || "(nothing yet)")
	return (
		<Card name={name} role={role}>
			<p class="get">{bind("shown")}</p>
		</Card>
	)
}
export const fan1 = (api: API) => fan(api, "fan1", "shouts", (h) => h.toUpperCase())
export const fan2 = (api: API) =>
	fan(api, "fan2", "counts words", (h) => `${h.split(" ").length} w`)
export const fan3 = (api: API) => fan(api, "fan3", "keeps the first word", (h) => h.split(" ")[0])

// ---- 5 · one process starting another ----
export function boss(api: API) {
	const { open, read, edit, method, start, stop } = api
	const hired = open("./hired", 0)
	const roster = open("./roster", [] as string[])
	// the workers running: started here, stopped here (and with boss, at a reload: the roster says
	// who to start again)
	const crew = new Map<string, unknown>()
	const hire = (name: string) => {
		// the worker program is a node the host writes (/code/worker). it runs at /crew/<name>: under
		// /boss would be refused as taken
		const p = start("/code/worker", `/crew/${name}`, { args: [name], cwd: `/state/${name}` })
		if ("refused" in p) console.error(`boss: ${p.refused}`)
		else crew.set(name, p)
	}
	for (const name of read(roster) as string[]) hire(name)
	method("on/hire", () => {
		const k = (read(hired) as number) + 1
		edit(hired, () => k)
		edit(roster, (d: string[]) => void d.push("w" + k))
		hire("w" + k)
	})
	method("on/fire", () => {
		const names = read(roster) as string[]
		if (!names.length) return
		const name = names.at(-1)!
		edit(roster, (d: string[]) => void d.pop())
		// stopped: the worker's cleanup hears "ended"
		stop(crew.get(name) as never)
		crew.delete(name)
	})
	return (
		<Card name="boss" role="starts and stops workers">
			<p class="hot">
				boss/roster:{" "}
				{bind(state("boss", "roster"), (r: string[]) => r.join(", ") || "(nobody)")}
			</p>
			<button onClick={handler("on/hire")}>hire a worker</button>
			<button onClick={handler("on/fire")}>fire the last</button>
		</Card>
	)
}

// the worker program is boss's to start: its card is its own box, and goes with it. its name is
// its argument, and it saves what it sews in a folder of its own like every process
export function worker({ open, edit, method, teardown, args }: API) {
	const name = args[0]
	const stitches = open("./stitches", 0)
	const stitch = () => edit(stitches, (k: number) => k + 1)
	method("on/stitch", stitch)
	const id = setInterval(stitch, 900)
	let card: HTMLElement | undefined
	// told "ended" when fired: its timer stops and its card goes
	teardown((why) => {
		clearInterval(id)
		if (why === "ended") card?.closest("[data-ermine-box]")?.remove()
	})
	return (
		<Card name={name} role="sews" kid ref={(e) => (card = e)}>
			<p class="say">stitches {bind(state(name, "stitches"))}</p>
		</Card>
	)
}
