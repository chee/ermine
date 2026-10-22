/// <reference lib="dom" />
// one pig, two places: the same farm on a Mac and on chee's Cardputer, each a real host (its own
// scheduler, table, places and sync over its own Subduction device), joined by a cable: the sync
// tests' in-memory pipe, each message held a moment so it can be seen crossing. unplug cuts it;
// plugging back in is a new connect. edits made apart are two heads: what sync does with them is
// drawn from each host's own tables (value, conflicts), never guessed.
import { createFarm, type FarmPig } from "../kit/farm.ts"
import { pondPage } from "../kit/page.ts"
import type { Wire } from "../kit/board.ts"
import { cable, type Host, host, type Parcel } from "./hosts.ts"
import type { Conflict } from "@ermine/together/sync"

const page = pondPage("together", {
	say:
		`<p>The same farm on two computers: a Mac, and chee's Cardputer. Each runs its own graph and its own sync. Change the pig on one, and the change goes down the cable as a <b>commit</b>. The other takes it in. Nobody presses save.</p>
		<p>Unplug the cable and both keep working apart. Plug it back in and they meet. Both end up showing the same pig, and the edit that doesn't show isn't thrown away.</p>`,
	tries: [
		{ id: "feed", text: "Feed the pig on the Cardputer. Watch the Mac." },
		{ id: "unplug", text: "Unplug the cable: go on the train." },
		{ id: "drift", text: "Feed her on the Cardputer, and rename her on the Mac." },
		{ id: "plug", text: "Plug back in. Which edit shows? Where did the other one go?" },
		{ id: "settle", text: "Settle it, or turn on the <b>eg-walker</b> merge and keep both." },
	],
	rules:
		`<p><b>commit:</b> every change to the pig's value goes out as one commit, signed by its computer, naming the commits it came after.</p>
		<p><b>the cable:</b> carries Subduction's messages. Plugged in, each side sends what the other is missing. Here it's an in-memory pipe, and the page holds each message 0.3 s so you can watch it cross.</p>
		<p><b>apart:</b> each computer keeps writing commits on its own. Nothing waits for the other.</p>
		<p><b>two heads:</b> two edits made apart are two heads. With no merge rule, one shows on both: the one with more changes behind it, or on a tie, the one whose commit name sorts higher. The other goes in the <code>conflicts</code> table, with the tables where it's different.</p>
		<p><b>settle:</b> a merge commit that keeps what shows. One head again, the list empty. The other edit is still in the history.</p>
		<p><b>eg-walker:</b> a merge rule a computer can turn on. Heads show merged: edits to different fields both stand; on the same field, the one later in its replay order wins (more changes behind it, then commit name).</p>`,
	real:
		`Runs two real hosts in this tab: each a <code>@ermine/scheduler</code>, <code>@ermine/table</code> and <code>@ermine/places</code>, with <code>@ermine/together</code>'s createSync over its own Subduction device (wasm), stored in memory. The cable is the sync tests' pipe; the page delays, counts, draws and cuts it. Both computers live in this one tab: the Cardputer drawn here isn't the real one. The pictures, the frames and the names are the page's.`,
})
const { board } = page

// ---- the two hosts ---------------------------------------------------------------------------
const NAMES = ["cardputer", "mac"] as const
const TITLE = ["the cardputer", "the mac"]
const Cap = ["The Cardputer", "The Mac"]
type Pig = { name: string; weight: number }
let mine = -1 // the host writing right now, so what it hears from itself isn't an arrival
// the last value each host showed, to tell what changed when it hears something
const was: (string | undefined)[] = [undefined, undefined]
// what each side did while apart
const apart = [{ fed: false, renamed: false }, { fed: false, renamed: false }]
let meeting = false
// settling, or switching the merge rule: what shows changes, but nothing arrived
let switching = false
let due = false
// what came in last at each end, on its wire
const labels = ["", ""]
// the board is drawn: hearing before that is the start
let ready = false
const hosts: Host[] = []
for (const [i, n] of NAMES.entries()) {
	hosts.push(await host(i + 1, n, () => heard(i)))
}
const [cp, mac] = hosts
const pig = cp.sync.mint()
// the cardputer shares its pig: what it writes there is carried
await cp.sync.share(pig)
const valueOf = (h: Host) => h.table.get("value", pig)?.value as Pig | undefined
const conflictsOf = (h: Host) => h.table.get("conflicts", pig)?.value as Conflict[] | undefined
const headsOf = (h: Host) => h.device.history(pig).heads()

function write(i: number, patch: { path: string[]; value: unknown }) {
	mine = i
	try {
		hosts[i].write("value", pig, [patch])
	} finally {
		mine = -1
	}
}
// the farm starts on the cardputer; the mac shares the pig's id, and fetches it once plugged in
write(0, { path: [], value: { name: "wilbur", weight: 6 } })
await mac.sync.share(pig)

// ---- the board -------------------------------------------------------------------------------
const style = document.createElement("style")
style.textContent = `
.frame canvas.pond { border: 0; display: block; }
.mac { background: linear-gradient(#ececf0, #cfcfd6); border: 1.5px solid #000; border-radius: 14px; padding: 14px 14px 10px; }
.mac .screen { border: 6px solid #111; border-radius: 4px; background: #111; }
.mac .chin { text-align: center; font: 700 9px var(--mono); color: #777; padding-top: 6px; letter-spacing: .2em; }
.stand { width: 120px; height: 34px; margin: 0 auto; background: linear-gradient(#cfcfd6, #a9a9b3); clip-path: polygon(22% 0, 78% 0, 92% 100%, 8% 100%); }
.foot { width: 200px; height: 7px; margin: 0 auto; background: #a9a9b3; border: 1.5px solid #000; border-radius: 3px; }
.cardputer { background: linear-gradient(#fafafa, #e4e4e4); border: 1.5px solid #000; border-radius: 12px; padding: 12px; width: min-content; }
.cardputer .screen { border: 8px solid #222; border-radius: 3px; background: #222; }
.cardputer .brand { font: 700 8px var(--mono); color: #888; letter-spacing: .25em; padding: 6px 2px 4px; display: flex; justify-content: space-between; }
.keys { display: grid; grid-template-columns: repeat(14, 1fr); gap: 3px; }
.keys i { height: 13px; background: #3a3a3a; border-radius: 3px; font: 7px/13px var(--mono); color: #ddd; text-align: center; font-style: normal; }
.keys i.lit { background: var(--cherry); }
.device .box-badge { color: #000; }
.device .chips { margin-top: 8px; justify-content: center; }
.device .chip { font-size: 13px; }
.track { position: relative; height: 34px; margin: 6px 0 4px; }
.track .wire { position: absolute; left: 14px; right: 14px; top: 16px; height: 3px; background: #000; }
.track .plug { position: absolute; top: 9px; width: 16px; height: 16px; background: #000; border-radius: 3px; transition: transform .3s; }
.track .plug.l { left: 0; } .track .plug.r { right: 0; }
.track.cut .wire { left: 14px; right: 14px; background: repeating-linear-gradient(90deg, #000 0 6px, transparent 6px 12px); opacity: .35; }
.track.cut .plug.l { transform: translateX(-6px) rotate(-12deg); } .track.cut .plug.r { transform: translateX(6px) rotate(12deg); }
.parcel { position: absolute; top: 11px; width: 12px; height: 12px; border: 1.5px solid #000; transition-property: left; transition-timing-function: linear; }
.parcel.from0 { background: var(--lemon); } .parcel.from1 { background: var(--sky); }
.count { display: grid; grid-template-columns: auto 1fr; gap: 0 8px; font: 11px var(--mono); white-space: nowrap; }
.count b { font-weight: 700; }
.plugbtn { width: 100%; margin-top: 8px; font-size: 13px; padding: 4px; }
.crow { font: 12px var(--mono); padding: 4px 0; border-top: 1px dashed #bbb; }
.crow:first-child { border-top: 0; }
.elsewhere p { margin: 0 0 6px; font-size: 13px; line-height: 1.35; }
.elsewhere p:last-child { margin: 0; }
`
document.head.append(style)

// a device box: its frame, its farm, its two chips
const KEYS = "1234567890-=qwertyuiop[]asdfghjkl;'zxcvbnm,./ ".split("").slice(0, 42)
function device(i: number, x: number, y: number, w: number, h: number, scale: number) {
	const b = board.box({
		id: NAMES[i],
		x,
		y,
		title: TITLE[i],
		kind: "picture",
		ins: i === 1 ? [["cable", ""]] : [],
		outs: i === 0 ? [["cable", ""]] : [],
	})
	b.el.classList.add("device")
	const canvas = document.createElement("canvas")
	canvas.style.cursor = "pointer"
	const farm = createFarm(canvas, { width: w, height: h })
	canvas.style.width = `${w * scale}px`
	canvas.style.height = `${h * scale}px`
	const frame = document.createElement("div")
	frame.className = "frame"
	if (i === 0) {
		frame.innerHTML = `<div class="cardputer"><div class="screen"></div>
			<div class="brand"><span>M5</span><span>CARDPUTER</span></div>
			<div class="keys">${KEYS.map((k) => `<i data-k="${k}">${k}</i>`).join("")}</div></div>`
	} else {
		frame.innerHTML =
			`<div class="mac"><div class="screen"></div><div class="chin">MAC</div></div><div class="stand"></div><div class="foot"></div>`
	}
	frame.querySelector(".screen")!.append(canvas)
	const chips = document.createElement("div")
	chips.className = "chips"
	chips.innerHTML = `<button class="chip" data-do="feed">feed her</button>
		<button class="chip" data-do="rename">rename her</button>`
	b.body.append(frame, chips)
	chips.onclick = (e) => {
		const d = (e.target as HTMLElement).closest<HTMLElement>("[data-do]")?.dataset.do
		if (d === "feed") feed(i)
		if (d === "rename") rename(i)
	}
	canvas.onclick = (e) => {
		if (farm.pigAt(e.clientX, e.clientY)) feed(i)
	}
	const size = (k: number) => {
		canvas.style.width = `${w * k}px`
		canvas.style.height = `${h * k}px`
	}
	return { box: b, farm, frame, size }
}
const devices = [device(0, 30, 70, 240, 135, 1.25), device(1, 650, 20, 260, 150, 1.8)]

const cableBox = board.box({
	id: "cable",
	x: 420,
	y: 150,
	title: "the cable",
	width: 240,
	ins: [["a", ""]],
	outs: [["b", ""]],
})
cableBox.body.innerHTML =
	`<div class="track"><div class="wire"></div><div class="plug l"></div><div class="plug r"></div></div>
	<div class="count">
		<span>→ mac</span><b data-c="0">0</b>
		<span>→ cardputer</span><b data-c="1">0</b>
	</div>
	<button class="chip plugbtn" data-do="plug">unplug: go on the train</button>`
const track = cableBox.body.querySelector<HTMLElement>(".track")!
const plugBtn = cableBox.body.querySelector<HTMLButtonElement>(".plugbtn")!
const wires: Wire[] = [
	board.wire(devices[0].box.port("cable"), cableBox.port("a")),
	board.wire(cableBox.port("b"), devices[1].box.port("cable")),
]

const conflictBox = board.box({
	id: "conflicts",
	x: 400,
	y: 360,
	title: "table: conflicts",
	width: 270,
})
const elsewhere = board.box({
	id: "elsewhere",
	x: 30,
	y: 420,
	title: "elsewhere",
	kind: "note",
	width: 330,
})
elsewhere.body.className += " elsewhere"
elsewhere.body.innerHTML =
	`<p>Most apps keep the one real copy on a server. Offline, your edits wait until you're back, or the last save to arrive wins.</p>
	<p>Copy a file between two machines and edit both: now there are two files, and you sort it out by hand.</p>`

// code on the backs
devices[0].box.code(`// each computer: its own graph and its own sync
const table = createTable((part, id) => {
  places.onTableChange(part, id)
  sync.tableChanged(part, id)
})
const places = createPlaces({ root, table, paths, scheduler })
const sync = createSync({
  table, signer, // storage: Subduction's default, in memory
  commit: (changed) => places.commit(changed),
})
// the pig is carried: shared
await sync.share(pig)

// feed her: one update, one commit
update(entry, [{ path: ["weight"], value: w + 4 }], change)
places.commit([entry])
sync.wrote([entry])`)
devices[1].box.code(`// the mac shares the pig's id: what comes
// for it is taken in, from any connection
await sync.share(pig)

// what comes in on the head shown is written
// to the table, and told to places as patches`)
cableBox.code(`// the tests' pipe: what one end sends,
// the other receives, in order
const [a, b] = pipe()
await Promise.all([
  cardputer.device.connect(a, true),
  mac.device.connect(b, false),
])

// unplug: the pipe is cut, both
// receives fail, nothing more crosses
cut()`)
conflictBox.code(`// several heads, no merge rule: the first in
// agreed order shows (higher lamport, then the
// greater commit name); the rest are listed
table.get("conflicts", pig)
// → [{ head, lamport, actor, tables }]

// a merge commit keeping what shows
sync.settle(pig)

// or: show heads merged by a rule
sync.use("eg-walker")`)

// ---- the cable: real messages, held a moment, drawn crossing ---------------------------------
const DELAY = 300
const counts = [{ n: 0, bytes: 0 }, { n: 0, bytes: 0 }]
let lastParcel = 0
function seen(p: Parcel) {
	counts[p.from].n++
	counts[p.from].bytes += p.bytes
	lastParcel = performance.now()
	const el = document.createElement("div")
	el.className = `parcel from${p.from}`
	el.title = `${p.bytes} bytes`
	el.style.transitionDuration = `${DELAY}ms`
	const w = track.offsetWidth - 12
	el.style.left = `${p.from === 0 ? 0 : w}px`
	track.append(el)
	requestAnimationFrame(() =>
		requestAnimationFrame(() => (el.style.left = `${p.from === 0 ? w : 0}px`))
	)
	setTimeout(() => el.remove(), DELAY + 30)
	wires[p.from === 0 ? 0 : 1].flash(p.from === 0 ? "wait" : "pick")
	drawCounts()
}
const kb = (n: number) => n < 1000 ? `${n} B` : `${(n / 1000).toFixed(1)} KB`
function drawCounts() {
	for (const i of [0, 1]) {
		cableBox.body.querySelector(`[data-c="${i}"]`)!.textContent = `${counts[i].n} · ${
			kb(counts[i].bytes)
		}`
	}
}

let line = cable(seen, () => DELAY)
let plugged = false
async function plugIn() {
	line = cable(seen, () => DELAY)
	plugged = true
	labels.fill("")
	await Promise.all([
		cp.device.connect(line.ends[0], true),
		mac.device.connect(line.ends[1], false),
	])
}
function unplug() {
	line.cut()
	plugged = false
}

// ---- what happened, and who heard it ---------------------------------------------------------
const show = (v: Pig | undefined) => v ? `${v.name}, ${v.weight}` : "nothing"

function heard(i: number) {
	if (!ready) return
	if (!due) {
		due = true
		queueMicrotask(() => (due = false, draw()))
	}
	// only arrivals: what changed here that this host didn't write
	if (mine === i) return
	queueMicrotask(() => {
		const v = valueOf(hosts[i]), s = JSON.stringify(v)
		if (s === was[i]) return
		const before = was[i] ? JSON.parse(was[i]!) as Pig : undefined
		was[i] = s
		if (!v || switching) return
		devices[i].box.flash("hot")
		const w = wires[i]
		labels[i] = before ? differ(before, v) : `in: ${show(v)}`
		w.label(labels[i])
		w.flash("hot")
		if (meeting) return
		if (!before) {
			page.say(`${Cap[i]} fetched the farm down the cable: <b>${show(v)}</b>.`)
		} else if (v.weight > before.weight) {
			page.say(
				`${
					Cap[
						i
					]
				}'s pig got fatter: the commit came down the cable and its table took it in. Nobody pressed save.`,
				"ok",
			)
			if (i === 1) page.tick("feed")
		} else if (v.name !== before.name) {
			page.say(
				`${Cap[i]}'s pig is called <b>${v.name}</b> now: the rename came down the cable.`,
				"ok",
			)
		}
	})
}
const differ = (a: Pig, b: Pig) =>
	a.name !== b.name && a.weight !== b.weight
		? `in: ${b.name} ${b.weight}`
		: a.name !== b.name
		? `in: name ${b.name}`
		: a.weight !== b.weight
		? `in: weight ${b.weight}`
		: "in: same"

// ---- the reader's acts -----------------------------------------------------------------------
const PIG_NAMES = ["babe", "truffle", "hamlet", "pumpkin", "wilbur"]
function lightKey(k: string) {
	const key = devices[0].frame.querySelector<HTMLElement>(`[data-k="${k}"]`)
	if (!key) return
	key.classList.add("lit")
	setTimeout(() => key.classList.remove("lit"), 400)
}
function feed(i: number) {
	const v = valueOf(hosts[i])
	if (!v) {
		return page.say(`${Cap[i]} has no pig yet: the farm is still coming down the cable.`, "hot")
	}
	if (v.weight >= 30) return page.say(`She's as big as a pig gets on this farm.`)
	if (i === 0) lightKey("f")
	write(i, { path: ["weight"], value: v.weight + 4 })
	was[i] = JSON.stringify(valueOf(hosts[i]))
	if (!plugged) {
		apart[i].fed = true
		page.say(
			`Fed on ${TITLE[i]}, unplugged: the commit is made and kept, but nothing crosses. ${
				Cap[1 - i]
			} doesn't know.`,
		)
	} else {
		page.say(`Fed on ${TITLE[i]}: one commit went into the cable.`)
	}
	afterEdit()
}
function rename(i: number) {
	const v = valueOf(hosts[i])
	if (!v) {
		return page.say(`${Cap[i]} has no pig yet: the farm is still coming down the cable.`, "hot")
	}
	const next = PIG_NAMES[(PIG_NAMES.indexOf(v.name) + 1) % PIG_NAMES.length]
	if (i === 0) lightKey("r")
	write(i, { path: ["name"], value: next })
	was[i] = JSON.stringify(valueOf(hosts[i]))
	if (!plugged) {
		apart[i].renamed = true
		page.say(`Renamed <b>${next}</b> on ${TITLE[i]}, unplugged: only ${TITLE[i]} knows.`)
	} else {
		page.say(`Renamed <b>${next}</b> on ${TITLE[i]}: one commit went into the cable.`)
	}
	afterEdit()
}
function afterEdit() {
	draw()
	const differs = JSON.stringify(valueOf(cp)) !== JSON.stringify(valueOf(mac))
	if (
		!plugged && differs && (apart[0].fed || apart[0].renamed) &&
		(apart[1].fed || apart[1].renamed)
	) {
		page.tick("drift")
		setTimeout(() =>
			page.say(
				`Two farms, two different pictures now: <b>${
					show(valueOf(cp))
				}</b> on the Cardputer, <b>${show(valueOf(mac))}</b> on the Mac.`,
				"hot",
			), 1600)
	}
}

plugBtn.onclick = async () => {
	if (plugged) {
		unplug()
		apart.forEach((a) => (a.fed = false, a.renamed = false))
		page.say(
			`Unplugged: you're on the train. Each computer keeps its own graph and keeps working.`,
		)
		page.tick("unplug")
		draw()
		return
	}
	const edited = apart.map((a) => a.fed || a.renamed)
	meeting = true
	page.say(`Plugged back in: each side sends the commits the other is missing.`)
	draw()
	await plugIn()
	await settled()
	meeting = false
	draw()
	explainMeeting(edited)
}

// both hosts idle and nothing crossing for a while
async function settled() {
	for (let i = 0; i < 400; i++) {
		await Promise.all(hosts.map((h) => h.sync.idle()))
		await new Promise((r) => setTimeout(r, 100))
		if (performance.now() - lastParcel > DELAY * 3) return
	}
}

function explainMeeting(edited: boolean[]) {
	const v = valueOf(cp)!, c = conflictsOf(cp)
	if (!edited[0] && !edited[1]) {
		return page.say(`Plugged back in. Nothing had changed apart, so there was nothing to meet.`)
	}
	page.tick("plug")
	if (!c?.length) {
		if (rule) {
			return page.say(
				`They met. With eg-walker on, the heads show merged: <b>${show(v)}</b> on both.`,
				"ok",
			)
		}
		return page.say(
			`They met: only ${
				TITLE[edited[0] ? 0 : 1]
			} had changed, so the other caught up. Both show <b>${show(v)}</b>.`,
			"ok",
		)
	}
	const heads = headsOf(cp), top = heads[0], other = c[0]
	const shown = NAMES.find((n) => n !== other.actor) ?? "?"
	const why = top.lamport > other.lamport
		? `the ${shown}'s has more changes behind it`
		: `a tie, broken by commit name`
	if (other.tables.value === undefined) {
		return page.say(
			`They met: two heads, but both made the same pig, <b>${
				show(v)
			}</b>. The conflicts table lists the ${other.actor}'s head with no table different.`,
			"hot",
		)
	}
	page.say(
		`They met, and both show <b>${
			show(v)
		}</b> (${why}). The ${other.actor}'s edit wasn't lost: it's in the conflicts table on both, drawn as a ghost.`,
		"hot",
	)
}

// settle, or a merge rule
let rule: string | undefined
conflictBox.body.onclick = async (e) => {
	const d = (e.target as HTMLElement).closest<HTMLElement>("[data-do]")?.dataset.do
	switching = true
	if (d === "settle") {
		const v = valueOf(mac)
		mac.sync.settle(pig, { time: Math.floor(Date.now() / 1000), actor: "mac" })
		page.say(
			`Settled on the Mac: a merge commit that keeps <b>${
				show(v)
			}</b>. One head again; the other edit is still in the history.${
				plugged ? " The merge goes down the cable too." : ""
			}`,
			"ok",
		)
		page.tick("settle")
	}
	if (d === "rule") {
		rule = rule ? undefined : "eg-walker"
		for (const h of hosts) h.sync.use(rule)
		const v = valueOf(cp)
		page.say(
			rule
				? `The eg-walker merge is on, on both computers: the heads show merged, <b>${
					show(v)
				}</b>. Edits to different fields both stand; on the same field, the later one wins.`
				: `The eg-walker merge is off: one head shows again, the other back in the conflicts table.`,
			"ok",
		)
		if (rule) page.tick("settle")
	}
	draw()
	await settled()
	switching = false
	draw()
}

// ---- drawing ---------------------------------------------------------------------------------
function draw() {
	const same = JSON.stringify(valueOf(cp)) === JSON.stringify(valueOf(mac))
	for (const [i, h] of hosts.entries()) {
		const v = valueOf(h), c = conflictsOf(h) ?? []
		const pigs: FarmPig[] = []
		// each head not shown, as a ghost beside the pig
		c.forEach((k, j) => {
			const g = k.tables.value as Pig | undefined
			if (g) {
				pigs.push({
					name: g.name,
					weight: g.weight,
					x: 0.78,
					y: 0.2 + j * 0.3,
					tone: "dim",
					says: "not shown",
				})
			}
		})
		if (v) {
			pigs.push({
				name: v.name,
				weight: v.weight,
				x: 0.4,
				y: 0.55,
				tone: !same ? "hot" : undefined,
			})
		}
		devices[i].farm.draw({
			pigs,
			apples: 4,
			sign: !plugged ? "offline" : !v ? "waiting for the farm" : undefined,
		})
		const heads = headsOf(h).length
		devices[i].box.badge(
			heads ? `${heads} head${heads === 1 ? "" : "s"}` : "no pig yet",
			heads > 1 ? "hot" : undefined,
		)
	}
	track.classList.toggle("cut", !plugged)
	plugBtn.textContent = plugged ? "unplug: go on the train" : "plug back in"
	plugBtn.setAttribute("aria-pressed", String(!plugged))
	for (const [i, w] of wires.entries()) {
		w.label(plugged ? labels[i] : "unplugged")
		w.dashed(!plugged)
		w.tone(plugged ? undefined : "dim")
	}
	cableBox.badge(
		valueOf(mac) === undefined ? "" : same ? "same farm" : "different",
		same ? "ok" : "hot",
	)
	// the conflicts table, on each
	const rows = hosts.map((h, i) => {
		const c = conflictsOf(h)
		if (!c?.length) {
			return `<div class="crow"><b>${NAMES[i]}:</b> <span class="small">${
				rule ? "empty: eg-walker shows heads merged" : "empty"
			}</span></div>`
		}
		return c.map((k) =>
			`<div class="crow"><b>${NAMES[i]}:</b> a head by the ${k.actor}, not shown: ${
				k.tables.value === undefined ? "the same value" : show(k.tables.value as Pig)
			} <span class="small">(…${k.head.slice(-8)})</span></div>`
		).join("")
	})
	const any = hosts.some((h) => conflictsOf(h)?.length) ||
		hosts.some((h) => headsOf(h).length > 1)
	conflictBox.body.innerHTML = rows.join("") +
		(any || rule
			? `<div class="chips" style="margin-top:6px">
		${
				any && !rule
					? `<button class="chip" data-do="settle">settle: keep what shows</button>`
					: ""
			}
		<button class="chip" data-do="rule" aria-pressed="${!!rule}">eg-walker merge</button></div>`
			: "")
	conflictBox.tone(hosts.some((h) => conflictsOf(h)?.length) ? "hot" : undefined)
	board.redraw()
}

// the boxes placed by their sizes: the cable between the two computers, room for the wires' labels
function layout() {
	const [c, m] = devices.map((d) => d.box)
	// narrow: smaller screens, closer together
	const narrow = innerWidth < 1100, gap = narrow ? 90 : 110
	devices[0].size(narrow ? 1 : 1.25)
	devices[1].size(narrow ? 1.25 : 1.8)
	const cw = c.el.offsetWidth, ch = c.el.offsetHeight
	const k = cableBox.el.offsetWidth, kh = cableBox.el.offsetHeight
	const mh = m.el.offsetHeight
	c.move(30, 40 + Math.max(0, (mh - ch) / 2 - 40))
	cableBox.move(30 + cw + gap, c.pos().y + (ch - kh) / 2)
	m.move(30 + cw + gap * 2 + k, 40)
	conflictBox.move(30 + cw + gap - 15, cableBox.pos().y + kh + 40)
	elsewhere.move(30, c.pos().y + ch + 40)
	board.redraw()
}
addEventListener("resize", () => (layout(), board.fit()))

// ---- start: plugged in, the mac fetching the farm --------------------------------------------
was[0] = JSON.stringify(valueOf(cp))
ready = true
drawCounts()
draw()
requestAnimationFrame(() => (layout(), board.fit()))
plugIn().then(draw)
