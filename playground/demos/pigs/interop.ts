// interop.ts: ermine-pigs and the web lab-pig on one server, checked against each other.
//   deno run -A interop.ts [--look nethack] [--bin ./ermine-pigs-check] [--url http://localhost:8051/] [--room ermine://...] [--out DIR]
// needs slaygrounds' dev server (cd ../ermine-slaygrounds && deno task serve) and make. The terminal
// runs on a pty (pty_drive.py), its view read from its --state; the page in a headless Chrome
// (web.ts), its view read from its DOM. A fresh room unless --room: only pigs this test adds are
// moved, set down ashamed or binned (the first pig is in every room: it is only looked at)
import { open, type Page, type Seen, seen, start } from "./web.ts"

const args = Deno.args
const opt = (name: string, or: string) => {
	const i = args.indexOf(name)
	return i >= 0 ? args[i + 1] : or
}
const dir = new URL(".", import.meta.url).pathname
const out = opt("--out", `${Deno.env.get("TMPDIR") ?? "/tmp"}/ermine-pigs-interop`)
await Deno.mkdir(out, { recursive: true })
const hex = (n: number) =>
	Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0"))
		.join("")
const room = opt("--room", `ermine://${hex(16)}${"0".repeat(32)}`)
const url = `${opt("--url", "http://localhost:8051/")}?room=${encodeURIComponent(room)}#lab-pig`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// --look nethack: the terminal in its NetHack look, driven its way (travel, `,`, hjkl, d)
const hack = opt("--look", "pixels") === "nethack"
const ROWS = 40, COLS = 150

type Pig = {
	id: string
	x: number
	y: number
	held: boolean
	by: string
	shame: boolean
	binned: boolean
	col: number
	row: number
	size: number
}
type State = {
	name: string
	online: boolean
	cols: number
	rows: number
	selected: string
	holding: string
	look: string
	at: [number, number]
	dragged_by: string
	stuck: boolean
	px: number
	py: number
	pigs: Pig[]
	pointers: { name: string; x: number; y: number }[]
}

let failed = 0
const began = Date.now()
const check = (ok: boolean, what: string, detail = "") => {
	const at = ((Date.now() - began) / 1000).toFixed(1).padStart(5)
	console.log(`${at}s ${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`)
	if (!ok) failed++
}
async function until<T>(
	f: () => Promise<T | undefined | false>,
	ms = 15000,
): Promise<T | undefined> {
	const end = Date.now() + ms
	while (Date.now() < end) {
		try {
			const v = await f()
			if (v) return v
		} catch { /* not yet */ }
		await sleep(150)
	}
	return undefined
}

// ---- the terminal
const stateFile = `${out}/state.json`
await Deno.remove(stateFile).catch(() => {})
const term = new Deno.Command("python3", {
	args: [
		`${dir}pty_drive.py`,
		`${out}/terminal.ans`,
		`${ROWS}`,
		`${COLS}`,
		"--",
		opt("--bin", `${dir}ermine-pigs`),
		"--room",
		room,
		"--state",
		stateFile,
		"--log",
		`${out}/terminal.log`,
		...(hack ? ["--look", "nethack"] : []),
	],
	stdin: "piped",
	stdout: "null",
	stderr: "inherit",
}).spawn()
const pty = term.stdin.getWriter()
const say = (line: string) => pty.write(new TextEncoder().encode(line + "\n"))
const tstate = async (): Promise<State> => JSON.parse(await Deno.readTextFile(stateFile))

// ---- the page
await start()
const page: Page = await open(url, 1600, 1000)
const web = () => seen(page)

console.log(`room ${room}\npage ${url}\nout ${out}`)
const t0 = await until(async () => (await tstate()).online && (await tstate()), 20000)
check(!!t0, "terminal online")
const w0 = await until(async () => {
	const s = await web()
	return s && / online/.test(s.count) && s.pigs.length > 0 && s
}, 40000)
check(!!w0, "page online", w0?.count)
if (!t0 || !w0) Deno.exit(1)
// the page's name is read each time: a page reloads (an edit to what it imports), as a new device
const tname = t0.name
console.log(`terminal is ${tname}, page is ${w0.name}`)

// the page's pig nearest a spot (fractions), and how far. A page draws a pig whole inside its field
// (110 px a size across): a terminal's pig is where the page would draw it
const drawn = (s: Seen, p: Pig) => {
	const half = (110 * p.size) / 2 + 2
	return Math.min(s.field.width - half, Math.max(half, p.x * s.field.width)) / s.field.width
}
const near = (s: Seen, p: Pig) => nearest(s, drawn(s, p), p.y)
const nearest = (s: Seen, x: number, y: number) => {
	let best = s.pigs[0], d = Infinity
	for (const p of s.pigs) {
		const e = Math.hypot(p.x - x, p.y - y)
		if (e < d) d = e, best = p
	}
	return { pig: best, d }
}

// the page's pig that is the terminal's id: the nearest to where the terminal has it, and only when
// clearly it (the first pig, in every room, never taken by mistake): waits for the pigs to part
const FIRST = "ermine://f849ff1304dc7e0cba4d758258a6a907" + "0".repeat(32)
const pagePig = (id: string) =>
	until(async () => {
		const [t, s] = await Promise.all([tstate(), web()])
		const me = t.pigs.find((p) => p.id === id), first = t.pigs.find((p) => p.id === FIRST)
		if (!me) return undefined
		const { pig, d } = near(s, me)
		const apart = !first || Math.hypot(first.x - pig.x, first.y - pig.y) > 0.08
		return d < 0.02 && apart && !pig.held ? { pig, s } : undefined
	}, 30000)

// my pig chosen in the terminal by tab, and only then true: each tab waited for in its state, then
// the choice read twice, apart, before anything is pressed (no other pig is ever picked up by mistake)
async function choose(id: string) {
	await say("type \\x1b")
	await sleep(600)
	for (let i = 0; i < 16; i++) {
		if ((await tstate()).selected === id) {
			await sleep(600)
			if ((await tstate()).selected === id) return true
		}
		await say("type \\t")
		await sleep(700)
	}
	return false
}

// space, and the pig held in the terminal's state
async function lift(id: string) {
	await say("type  ")
	return !!(await until(async () => (await tstate()).holding === id || undefined, 3000))
}

// NetHack's room: a cell's middle in field units, as hack.c has it
const hx = (col: number) => (col - 1 + 0.5) / (COLS - 2)
const hy = (row: number) => (row - 2 + 0.5) / (ROWS - 5)
// travel there (a click) and wait to arrive
async function travel(col: number, row: number) {
	for (let i = 0; i < 4; i++) {
		await say(`click ${col} ${row}`)
		const there = await until(async () => {
			const at = (await tstate()).at
			return at[0] === col && at[1] === row || undefined
		}, 5000)
		if (there) return true
	}
	return false
}
// my pig picked up the NetHack way: travel next to it, then `,`, only while no other pig (the first
// pig least of all) is within a few cells of it, so `,` can only take it
async function take(id: string) {
	if (!hack) return await choose(id) && await lift(id)
	for (let attempt = 0; attempt < 8; attempt++) {
		const apart = async () => {
			const s = await tstate(), me = s.pigs.find((p) => p.id === id)
			const ok = me && !me.held &&
				s.pigs.every((p) =>
					p.id === id || Math.abs(p.col - me.col) > 4 || Math.abs(p.row - me.row) > 3
				)
			return ok ? me : undefined
		}
		const me = await until(apart, 30000)
		if (!me) return false
		await say(`click ${me.col} ${me.row}`)
		const close = await until(async () => {
			const s = await tstate(), p = s.pigs.find((q) => q.id === id)
			return p && Math.abs(s.at[0] - p.col) <= 1 && Math.abs(s.at[1] - p.row) <= 1 || undefined
		}, 4000)
		if (!close || !(await apart())) continue
		await say("type ,")
		return !!(await until(async () => (await tstate()).holding === id || undefined, 3000))
	}
	return false
}
const put = () => say(hack ? "type d" : "type  ")
// NetHack: the terminal's @ tile on the page, once it is where the terminal's @ is (presence follows
// a moment later)
const tileAt = () =>
	until(async () => {
		const [t, s] = await Promise.all([tstate(), web()])
		const q = s.pointers.find((q) => q.look === "nethack" && q.name === tname)
		return q && Math.abs(q.x - hx(t.at[0])) < 0.01 && Math.abs(q.y - hy(t.at[1])) < 0.02 && q
	})
// the page drags the terminal's @ to fx, fy (field units) and lets go; the terminal's state after
async function pageDrag(fx: number, fy: number) {
	const tile = await tileAt()
	if (!tile) return undefined
	const s = await web()
	const tx = s.field.left + s.field.width * fx, ty = s.field.top + s.field.height * fy
	await page.mouse("mouseMoved", tile.cx, tile.cy)
	await page.mouse("mousePressed", tile.cx, tile.cy)
	for (let i = 1; i <= 10; i++) {
		await page.mouse(
			"mouseMoved",
			tile.cx + (tx - tile.cx) * i / 10,
			tile.cy + (ty - tile.cy) * i / 10,
		)
		await sleep(90)
	}
	await sleep(400)
	await page.mouse("mouseReleased", tx, ty)
	await until(async () => (await tstate()).dragged_by === "" || undefined, 4000)
	await sleep(300)
	return await tstate()
}
const wc = 1 + Math.floor(0.78 * (COLS - 2)), wr = 2 + Math.floor(0.45 * (ROWS - 5))
const inCloset = (at: [number, number]) => at[0] > wc && at[1] < wr
const told = async (text: string) => (await Deno.readTextFile(`${out}/terminal.log`)).includes(text)

// ---- 1: walking agrees (the first pig, only looked at): read close together, several times
async function walking(what: string) {
	let worst = 0, which = ""
	for (let i = 0; i < 5; i++) {
		const [t, s] = await Promise.all([tstate(), web()])
		for (const p of t.pigs.filter((p) => !p.held && !p.binned)) {
			const n = near(s, p)
			if (n.d > worst) {
				worst = n.d
				which = `${p.id.slice(9, 17)} at ${p.x.toFixed(3)}, ${p.y.toFixed(3)} here, ${
					n.pig.x.toFixed(3)
				}, ${n.pig.y.toFixed(3)} on the page`
			}
		}
		await sleep(400)
	}
	// both read within ~250 ms of each other; a pig walks at most ~0.06 of the field a second
	check(
		worst < 0.03,
		what,
		`worst distance ${worst.toFixed(4)} of the field${worst >= 0.03 ? ` (${which})` : ""}`,
	)
}
await walking("walking positions agree")

// ---- 2: a pig added in the terminal shows on the page
let mine: Pig | undefined
{
	const before = (await web()).pigs.length
	await say("type a")
	const t = await until(async () => {
		const s = await tstate()
		return s.pigs.find((p) => p.id === s.selected && !t0.pigs.some((q) => q.id === p.id))
	})
	mine = t
	const s = await until(async () => {
		const s = await web()
		return s.pigs.length === before + 1 && s
	})
	check(
		!!s && !!t,
		"a pig added in the terminal appears on the page",
		`${before} -> ${s?.pigs.length}`,
	)
	if (s && t) {
		const t2 = (await tstate()).pigs.find((p) => p.id === t.id)!
		check(near(await web(), t2).d < 0.03, "  and walks where the terminal walks it")
	}
}

// ---- 3: a pig added on the page shows in the terminal
let theirs: Pig | undefined
{
	const before = (await tstate()).pigs.map((p) => p.id)
	await page.inFrame(
		`[...d.querySelectorAll("header button")].find((b) => /add a pig/.test(b.textContent)).click()`,
	)
	theirs = await until(async () => (await tstate()).pigs.find((p) => !before.includes(p.id)))
	check(!!theirs, "a pig added on the page appears in the terminal", theirs?.id)
	if (theirs) {
		await sleep(500)
		const t = (await tstate()).pigs.find((p) => p.id === theirs!.id)!
		check(near(await web(), t).d < 0.03, "  and walks where the page walks it")
	}
}

// ---- 4: a drag on the page moves live in the terminal; the drop ends the hold there
const found4 = theirs && await pagePig(theirs.id)
check(!theirs || !!found4, "the page's pig found apart from the first pig")
if (theirs && found4) {
	const p = found4.pig
	await page.mouse("mouseMoved", p.cx, p.cy)
	await page.mouse("mousePressed", p.cx, p.cy)
	const seenHeld: { x: number; y: number }[] = []
	for (let i = 1; i <= 12; i++) {
		await page.mouse("mouseMoved", p.cx - i * 12, p.cy + i * 4)
		await sleep(120)
		const [h, wname] = [
			(await tstate()).pigs.find((q) => q.id === theirs!.id),
			(await web()).name,
		]
		if (h?.held && h.by === wname) seenHeld.push({ x: h.x, y: h.y })
	}
	const ws = await web()
	const wheld = ws.pigs.find((q) => q.held)
	const th = (await tstate()).pigs.find((q) => q.id === theirs!.id)!
	check(
		seenHeld.length >= 3,
		"a pig dragged on the page is held in the terminal, by the page's name",
		`${seenHeld.length} frames held`,
	)
	const moves = new Set(seenHeld.map((h) => h.x.toFixed(3))).size
	check(moves >= 3, "  and moves live there", `${moves} distinct places`)
	check(
		!!wheld && Math.hypot(wheld.x - drawn(ws, th), wheld.y - th.y) < 0.03,
		"  where the page has it",
		wheld ? `${Math.hypot(wheld.x - drawn(ws, th), wheld.y - th.y).toFixed(4)}` : "",
	)
	await page.shot(`${out}/page-dragging.png`)
	await page.mouse("mouseReleased", p.cx - 12 * 12, p.cy + 12 * 4)
	const dropped = await until(async () => {
		const h = (await tstate()).pigs.find((q) => q.id === theirs!.id)
		return h && !h.held && h
	})
	check(!!dropped, "the page's drop ends the hold in the terminal")
	await sleep(600)
	const after = (await tstate()).pigs.find((q) => q.id === theirs!.id)!
	check(near(await web(), after).d < 0.03, "  and it walks on from the same place in both")
}

// ---- 5: a pig carried by the keys in the terminal moves live on the page; space ends it everywhere
if (mine) {
	const chosen = await take(mine.id)
	check(chosen, hack ? "travel to a pig and , picks it up" : "tab chooses a pig")
	const places: string[] = []
	let held = 0
	const right = (await tstate()).pigs.find((p) => p.id === mine!.id)!.x <= 0.5
	for (let i = 0; i < 10; i++) {
		await say(hack ? `type ${right ? "l" : "h"}` : `type \\x1b[${right ? "C" : "D"}`)
		await sleep(150)
		const s = await web()
		const h = s.pigs.find((q) => q.held && q.by === tname)
		if (h) held++, places.push(h.x.toFixed(3))
	}
	check(
		held >= 5,
		"a pig picked up with space is held on the page, by the terminal's name",
		`${held} of 10`,
	)
	check(
		new Set(places).size >= 4,
		"  and the arrows move it live there",
		`${new Set(places).size} distinct places`,
	)
	await page.shot(`${out}/page-held-by-terminal.png`)
	await put()
	const free = await until(async () => {
		const s = await web()
		return !s.pigs.some((q) => q.held) && s
	})
	check(!!free, "space sets it down: held nowhere on the page")
	await sleep(800)
	const t = (await tstate()).pigs.find((q) => q.id === mine!.id)!
	check(near(await web(), t).d < 0.03, "  and it walks on from the same place in both")
}

// ---- 6: the terminal's mouse: its pointer shows on the page; press, drag and let go carries a pig
{
	// the mouse moved to the middle (NetHack: you travel there; your pointer is where you are)
	const [mx, my] = hack ? [hx(Math.floor(COLS / 2)), hy(Math.floor(ROWS / 2))] : [0.5, 0.5]
	if (hack) await travel(Math.floor(COLS / 2), Math.floor(ROWS / 2))
	else await say(`move ${Math.floor(COLS / 2)} ${Math.floor(ROWS / 2)}`)
	const p = await until(async () =>
		(await web()).pointers.find((q) =>
			q.name === tname && Math.abs(q.x - mx) < 0.02 && Math.abs(q.y - my) < 0.04
		)
	)
	check(
		!!p,
		"the terminal's mouse shows as its pointer on the page",
		p ? `at ${p.x.toFixed(3)}, ${p.y.toFixed(3)}` : "",
	)
	if (p) {
		check(
			Math.abs(p.x - mx) < 0.02 && Math.abs(p.y - my) < 0.04,
			"  where it is in the terminal",
		)
	}
	const wp = await (async () => {
		const s = await web()
		await page.mouse(
			"mouseMoved",
			s.field.left + s.field.width * 0.3,
			s.field.top + s.field.height * 0.6,
		)
		return until(async () => {
			const name = (await web()).name
			return (await tstate()).pointers.find((q) => q.name === name)
		})
	})()
	check(
		!!wp,
		"the page's pointer shows in the terminal",
		wp ? `at ${wp.x.toFixed(3)}, ${wp.y.toFixed(3)}` : "",
	)
	// my pig's cell, when no other pig is drawn near it (the first pig is never pressed on)
	const t = mine && await until(async () => {
		const s = await tstate(), me = s.pigs.find((q) => q.id === mine!.id)
		const clear = me && me.col >= 0 &&
			s.pigs.every((q) =>
				q.id === me.id || Math.abs(q.col - me.col) > (hack ? 4 : 30) ||
				Math.abs(q.row - me.row) > (hack ? 3 : 12)
			)
		return clear && me
	}, 40000)
	check(!mine || !!t, "my pig found apart from the others in the terminal")
	if (mine && t) {
		await say(`press ${t.col} ${t.row}`)
		let held = 0
		const places: string[] = []
		for (let i = 1; i <= 8; i++) {
			await say(`drag ${t.col - i * 2} ${t.row + (i % 3 === 0 ? 1 : 0)}`)
			await sleep(150)
			const h = (await web()).pigs.find((q) => q.held && q.by === tname)
			if (h) held++, places.push(h.x.toFixed(3))
		}
		check(
			held >= 4 && new Set(places).size >= 3,
			"a mouse drag in the terminal carries the pig on the page",
			`${held} held, ${new Set(places).size} places`,
		)
		await say(`release ${t.col - 16} ${t.row + 2}`)
		const free = await until(async () => !(await web()).pigs.some((q) => q.held))
		check(!!free, "  letting go sets it down there")
	}
}

// ---- 7: set down in the corner of shame in the terminal: ashamed on the page
if (mine && await take(mine.id)) {
	// NetHack: travel into the closet (round by its door, when its walls are up)
	if (hack) check(await travel(COLS - 3, 3), "  carried into the closet")
	else for (let i = 0; i < 40; i++) await say("type L"), await say("type K")
	await sleep(600)
	await put()
	const shamed = await until(async () => (await web()).pigs.find((q) => q.shame))
	check(
		!!shamed,
		"set down in the corner of shame in the terminal: ashamed on the page",
		shamed ? `at ${shamed.x.toFixed(3)}, ${shamed.y.toFixed(3)}` : "",
	)
	const t = await until(async () =>
		(await tstate()).pigs.find((q) => q.id === mine!.id && q.shame)
	)
	check(!!t, "  and in the terminal")
	await page.shot(`${out}/page-shame.png`)
	if (hack) {
		// walked in by the door: stuck, and it can't leave by itself
		const s1 = await until(async () => (await tstate()).stuck || undefined, 3000)
		check(
			!!s1 && await told("The door swings shut behind you"),
			"walked into the closet: the terminal is stuck",
		)
		const st = await until(async () =>
			(await web()).pointers.find((q) => q.name === tname && q.stuck)
		)
		check(!!st, "  the page shows it stuck (its tile dim, sweating)")
		await say(`click ${Math.floor(COLS * 0.4)} ${Math.floor(ROWS * 0.6)}`)
		await sleep(1500)
		for (let i = 0; i < 15; i++) await say("type j")
		await say("type H"), await say("type J")
		await sleep(800)
		const t3 = await tstate()
		check(
			inCloset(t3.at) && t3.stuck,
			"  travel, steps and runs don't take it out",
			`at ${t3.at}`,
		)
		check(await told("The door is stuck. You feel ashamed."), "  told: the door is stuck")
		await page.shot(`${out}/page-stuck.png`)
		await Deno.copyFile(`${out}/terminal.ans`, `${out}/terminal-stuck.ans`)
		// a page pulls it out
		const t4 = await pageDrag(0.45, 0.6)
		const wname = (await web()).name
		check(
			!!t4 && !inCloset(t4.at) && !t4.stuck,
			"a page drags it out of the closet: free",
			t4 ? `at ${t4.at}` : "",
		)
		check(await told(`${wname} pulls you out of the corner of shame!`), "  told: pulled out")
		const free = await until(async () =>
			(await web()).pointers.find((q) => q.name === tname && !q.stuck && q.look === "nethack")
		)
		check(!!free, "  the page shows it free")
		const t5 = await tstate()
		await say("type h"), await say("type h")
		await sleep(400)
		check((await tstate()).at[0] < t5.at[0], "  and it walks again")
	}
}

// ---- 8: dropped on the page in the corner of shame: ashamed in the terminal
const found8 = theirs && await pagePig(theirs.id)
if (theirs && found8) {
	const { pig: p, s } = found8
	await page.mouse("mousePressed", p.cx, p.cy)
	const tx = s.field.left + s.field.width - 60, ty = s.field.top + 120
	for (let i = 1; i <= 10; i++) {
		await page.mouse("mouseMoved", p.cx + (tx - p.cx) * i / 10, p.cy + (ty - p.cy) * i / 10)
		await sleep(60)
	}
	await page.mouse("mouseReleased", tx, ty)
	const shamed = await until(async () =>
		(await tstate()).pigs.find((q) => q.id === theirs!.id && q.shame && !q.held)
	)
	check(!!shamed, "set down in the corner of shame on the page: ashamed in the terminal")
}

// the corner is open now (ashamed pigs in the room): walking pigs keep out of it, in both alike
await walking("walking positions agree while the corner of shame is open")

// ---- 10 (NetHack): the page drags the terminal's @, carrying a pig: its @, its presence and the pig
// move, for everyone; the closet's wall stops it; letting go ends it
if (hack) {
	await say("type a")
	const fresh = await until(async () => {
		const s = await tstate()
		return s.pigs.find((p) =>
			p.id === s.selected && p.id !== mine?.id && p.id !== theirs?.id && !p.shame
		)
	})
	const carrying = !!fresh && await take(fresh.id)
	check(carrying, "the terminal picks up a fresh pig")
	// out of the closet's way first: the middle left
	await travel(Math.floor(COLS * 0.3), Math.floor(ROWS * 0.6))
	// its tile on the page, once it is where the terminal's @ is (presence follows a moment later)
	const tile = await until(async () => {
		const [t, s] = await Promise.all([tstate(), web()])
		const q = s.pointers.find((q) => q.look === "nethack" && q.name === tname)
		return q && Math.abs(q.x - hx(t.at[0])) < 0.01 && Math.abs(q.y - hy(t.at[1])) < 0.02 && q
	})
	check(!!tile, "the terminal shows on the page as a NetHack @ tile")
	if (tile && carrying) {
		const s0 = await tstate(), wname = (await web()).name
		await page.mouse("mouseMoved", tile.cx, tile.cy)
		await page.mouse("mousePressed", tile.cx, tile.cy)
		const ats = new Set<string>(), pigs = new Set<string>(), tiles = new Set<string>()
		let by = ""
		for (let i = 1; i <= 12; i++) {
			await page.mouse("mouseMoved", tile.cx + i * 14, tile.cy - i * 4)
			await sleep(120)
			const [t, s] = await Promise.all([tstate(), web()])
			ats.add(t.at.join(",")), by = t.dragged_by || by
			const h = s.pigs.find((q) => q.held && q.by === tname)
			if (h) pigs.add(h.x.toFixed(3))
		}
		await sleep(600)
		for (let i = 0; i < 4; i++) {
			const s = await web(), q = s.pointers.find((q) => q.look === "nethack" && q.name === tname)
			if (q) tiles.add(q.x.toFixed(3))
			await sleep(200)
		}
		const t1 = await tstate()
		check(
			ats.size >= 4 && t1.at[0] > s0.at[0],
			"a page drags the terminal's @ there",
			`${ats.size} cells, ${s0.at} -> ${t1.at}`,
		)
		check(by === wname, "  the terminal says who drags it", by)
		check(pigs.size >= 4, "  the pig it carries comes along, on the page", `${pigs.size} places`)
		check(
			Math.abs(t1.px - hx(t1.at[0])) < 1e-3 && Math.abs(t1.py - hy(t1.at[1])) < 1e-3,
			"  its presence is where its @ is",
		)
		const wt = (await web()).pointers.find((q) => q.look === "nethack" && q.name === tname)
		check(
			!!wt && Math.abs(wt.x - t1.px) < 0.02 && Math.abs(wt.y - t1.py) < 0.03,
			"  and the page draws its tile there",
			wt ? `${wt.x.toFixed(3)}, ${wt.y.toFixed(3)}` : "",
		)
		await page.shot(`${out}/page-dragging-terminal.png`)
		await Deno.copyFile(`${out}/terminal.ans`, `${out}/terminal-dragged.ans`)
		// let go of there (the drag above ends), then dragged into the closet, through its wall: stuck
		await page.mouse("mouseReleased", tile.cx + 12 * 14, tile.cy - 12 * 4)
		await until(async () => (await tstate()).dragged_by === "" || undefined, 4000)
		check(
			await told(`You are dragged by ${wname}!`) && await told(`${wname} lets go of you.`),
			"  told: dragged by, lets go",
		)
		const t2 = await pageDrag(0.93, 0.15)
		check(
			!!t2 && inCloset(t2.at) && t2.stuck,
			"dragged into the closet through its wall: stuck there",
			t2 ? `at ${t2.at}` : "",
		)
		check(await told(`${wname} leaves you in the corner of shame.`), "  told: left in the corner")
		check(!!(await tstate()).holding, "  still carrying its pig")
		// and out again, through the wall, carrying its pig
		const t3 = await pageDrag(0.35, 0.65)
		check(
			!!t3 && !inCloset(t3.at) && !t3.stuck,
			"dragged out through the wall: free",
			t3 ? `at ${t3.at}` : "",
		)
		await put()
		await until(async () => !(await web()).pigs.some((q) => q.held))
	}
}

// the terminal's picture now, from what it drew
await sleep(1500)
await Deno.copyFile(`${out}/terminal.ans`, `${out}/terminal-before-bins.ans`)

// ---- 9: binned in the terminal: gone from the page; binned on the page: gone from the terminal
if (mine && (await tstate()).pigs.some((p) => p.id === mine!.id)) {
	const before = (await web()).pigs.length
	const again = await take(mine.id)
	check(again, "my pig picked up again")
	if (again) {
		// NetHack: in the closet now, stuck: the page drags it (and the pig) out to the bin
		if (hack) {
			const t = await pageDrag(hx(COLS - 6), hy(ROWS - 6))
			check(
				!!t && !t.stuck && t.at[0] >= COLS - 8,
				"  the page drags it, carrying the pig, out to the bin",
				t ? `at ${t.at}` : "",
			)
		} else for (let i = 0; i < 40; i++) await say("type L"), await say("type J")
		await sleep(600)
		await put()
	}
	const gone = await until(async () => (await web()).pigs.length === before - 1)
	check(!!gone, "binned in the terminal: gone from the page")
	const tg = await until(async () => !(await tstate()).pigs.some((q) => q.id === mine!.id))
	check(!!tg, "  and from the terminal")
}
// (ashamed now, it stands still in the corner: found there, apart from the first pig)
const found9 = theirs && await pagePig(theirs.id)
if (theirs && found9) {
	const { pig: p, s } = found9
	await page.mouse("mousePressed", p.cx, p.cy)
	const tx = s.field.left + s.field.width - 40, ty = s.field.top + s.field.height - 40
	for (let i = 1; i <= 10; i++) {
		await page.mouse("mouseMoved", p.cx + (tx - p.cx) * i / 10, p.cy + (ty - p.cy) * i / 10)
		await sleep(80)
	}
	await page.mouse("mouseReleased", tx, ty)
	const tg = await until(async () => !(await tstate()).pigs.some((q) => q.id === theirs!.id))
	check(!!tg, "binned on the page: gone from the terminal")
}

await page.shot(`${out}/page-end.png`)
await say("wait 0.5")
await pty.close()
await term.status
console.log(page.logs.filter((l) => /UNCAUGHT|error/i.test(l)).slice(0, 10).join("\n"))
await page.close()
console.log(failed ? `${failed} failed` : "all ok")
Deno.exit(failed ? 1 : 0)
