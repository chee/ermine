/** @jsxImportSource ermine-h */
import {
	addTeardown,
	createAction,
	createEffect,
	createMemo,
	ensureNode,
	type Node,
	patch,
	peep,
	PENDING,
	read,
	ref,
} from "@ermine/system"
import { bind, handler } from "ermine-h"

// toy-tarot: you cannot draw until you have gathered enough entropy. mouse moves over the pad become
// samples (x, y, time, time since the last); the pool is a SHA-256 of them (an async compute); when
// 256 bits are credited the seed is fixed; a xoshiro128** seeded from it shuffles the 78 cards and
// decides which are reversed. the deck, the spread, what is turned: all nodes, so a reload keeps
// the reading and the same seed is always the same reading.
//
// the deck: the Rider-Waite-Smith tarot (1909), drawn by Pamela Colman Smith, public domain.
// meanings: condensed from A. E. Waite, The Pictorial Key to the Tarot (1910), public domain.

const NEED = 256 // bits of credit before the seed is fixed

// ---- the cards: 22 major arcana, then wands, cups, swords, pentacles (ace..ten, page..king) ----
const majors =
	"The Fool|The Magician|The High Priestess|The Empress|The Emperor|The Hierophant|The Lovers|The Chariot|Strength|The Hermit|Wheel of Fortune|Justice|The Hanged Man|Death|Temperance|The Devil|The Tower|The Star|The Moon|The Sun|Judgement|The World"
		.split("|")
const ranks = "Ace|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Page|Knight|Queen|King".split("|")
const suits = ["Wands", "Cups", "Swords", "Pentacles"]
const names = [...majors, ...suits.flatMap((s) => ranks.map((r) => `${r} of ${s}`))]
// "upright / reversed", in the order of names
const meanings =
	`Folly, a venture begun in innocence; the spirit before the step.|Carelessness, distraction, vanity, a leap without looking.
Skill, will, the power to act; self-confidence.|Weak will, skill ill-used, delay, deceit.
Secrets, silence, hidden knowledge beyond the text.|Passion, conceit, surface knowledge, a veil unlifted.
Fruitfulness, abundance, action, initiative.|Doubt, inaction, vacillation; or a truth unveiled.
Stability, power, protection, reason, a firm hand.|Immaturity, obstruction, control lost.
Mercy, goodness, inspiration; alliance and tradition.|Over-kindness, weakness, too much conformity.
Attraction, love, beauty; a trial overcome, a choice.|Failure, foolish designs, a quarrel.
Triumph, succession, help, victory.|Riot, quarrel, dispute, defeat.
Power, energy, courage, magnanimity.|Abuse of power, weakness, discord.
Prudence, circumspection, withdrawal, counsel.|Concealment, fear, caution unreasoned.
Destiny, fortune, success; a turn of luck.|Ill-luck, a check on fortune, unwelcome change.
Equity, rightness, honour; the law's balance.|Severity, bias, unfairness, delay.
Wisdom, trial, sacrifice; a pause.|Selfishness, the crowd, a prophet without honour.
An ending, mortality; transformation and rebirth.|Inertia, sleep, a lethargic hope.
Economy, moderation, management.|Disunion, bad management, clashing interests.
Bondage to the merely material; violence, ravage.|Weakness, pettiness, blindness; release from bondage.
Distress, ruin; the sudden fall of false structures.|Oppression, imprisonment, the same tyranny continued.
Hope, bright prospects, renewal after loss.|Arrogance, haughtiness, impotence.
Hidden enemies, danger, darkness, deception.|Instability, inconstancy, a slight deceit.
Material happiness, contentment, a fortunate union.|The same joy, in a lesser or clouded degree.
Change of position, renewal, the outcome.|Weakness, simplicity, delay, indecision.
Assured success, recompense, voyage, completion.|Inertia, fixity, stagnation.
Creation, invention, enterprise; the origin of fortune.|Fall, decadence, a fruitless start.
Dominion, boldness; the world in your hand.|Surprise, trouble, fear, captivity.
Established strength, enterprise, trade; a ship coming in.|The end of troubles, delay.
Rural felicity, harmony; a haven reached.|The same, in lesser measure.
Strife, contention, competition; many small battles.|Trickery, contradiction, litigation.
Victory, good news, great expectation realized.|Apprehension, fear, treachery.
Valour, a stand held; courage against odds.|Perplexity, embarrassment, anxiety.
Great haste, swift movement, news arriving.|Jealousy, a quarrel, domestic disputes.
Strength in opposition; a guarded pause.|Obstacles, adversity, calamity.
A burden: oppression, fortune weighed by overload.|Contrivance, intrigue; a burden thrown off.
A faithful dark youth; a messenger bearing news.|Anecdotes, instability, bad news.
Departure, a journey, change of residence.|Rupture, division, discord.
A warm woman, honourable, chaste and loving.|Good and economical, but jealous and deceitful.
A dark man, friendly, honest, conscientious.|Good but severe; austere, yet tolerant.
The house of the true heart: joy, content, abundance.|Instability, revolution; the cup spilt.
Love, passion, friendship; the union of two.|False love, folly, misunderstanding.
The conclusion of a matter: plenty, merriment, healing.|Dispatch, the end; excess.
Weariness, disgust, aversion, imaginary vexations.|Novelty, presentiment, new instruction.
A loss, though something remains; vain regret.|News, alliances; the return of hope.
The past and memories; childhood, a gift, happiness fading.|The future, renewal; what is yet to come.
Fairy favours, images of fancy, illusion, dreams.|Desire, will, determination, a project.
The decline of a matter; leaving what was abandoned.|Great joy, feasting, happiness.
Concord, contentment, well-being; wishes fulfilled.|Truth, loyalty, liberty; also imperfections.
Contentment, repose of the heart; a home at peace.|Loss of friendship, a quarrel, violence.
A fair studious youth; reflection, news.|Taste, attachment, inclination, seduction.
Arrival, approach, an advance, an invitation.|Trickery, artifice, subtlety, fraud.
A fair woman, good, devoted; vision and imagination.|A woman not to be trusted; perverse.
A fair man of business or law; creative, just, kindly.|A dishonest, double-dealing man; injustice.
Triumph, conquest, excess in everything.|The same, overthrown; great disaster.
Conformity, courage, a balanced stalemate; peace held.|Imposture, falsehood, disloyalty.
Removal, absence, delay, division, rupture.|Mental alienation, error, loss, distraction.
Vigilance, retreat, solitude; rest after strife.|Wise administration, circumspection, economy.
Degradation, destruction, infamy, dishonour.|The same; burial, loss.
A journey by water, a way; passage to calmer seas.|Declaration, confession, publicity; no way out.
Design, attempt, wish, hope; a quarrel, or a theft.|Good advice, counsel, instruction; slander.
Bad news, violent chagrin, crisis; power in bonds.|Disquiet, difficulty, opposition, accident.
Death, failure, delay, deception, disappointment.|Imprisonment, suspicion, doubt, reasonable fear.
Pain, affliction, tears, desolation; an ending.|Advantage, profit, success; but not lasting.
Authority, overseeing, secret service, vigilance.|The unforeseen, unprepared; an imposter.
Skill, bravery, capacity, defence; enmity.|Incapacity, extravagance, a boaster.
Widowhood, female sadness, absence, sterility.|Malice, bigotry, artifice, prudery.
Judgment, power, command, militant intelligence.|Cruel, perverse, harsh; evil intent.
Perfect contentment, felicity, ecstasy; gold.|The evil side of wealth; bad intelligence.
Harmony in change; news in writing; a juggle of affairs.|Enforced gaiety, simulated enjoyment.
Mastery in art, skill, nobility; a craft recognised.|Pettiness, weakness, sordidness.
The surety of possessions, gift, inheritance; holding tight.|Suspense, delay, opposition.
Material trouble; destitution, want.|Disorder, chaos, ruin, discord.
Presents, gifts, gratification; alms given and received.|Desire, cupidity, envy, illusion.
Money, business, barter; a pause, and anxiety about the crop.|Cause for anxiety regarding money.
Work, employment, commission, skill in business.|Voided ambition, vanity, usury.
Prudence, safety, success, accomplishment; discernment.|Roguery, deception, a voided project, bad faith.
Gain, riches; family, archives, the house.|Chance, fatality, loss, robbery, games of hazard.
Application, study, scholarship; news, a message.|Prodigality, dissipation, luxury.
Utility, serviceableness, responsibility, rectitude.|Inertia, idleness, stagnation.
Opulence, generosity, magnificence, security, liberty.|Evil, suspicion, suspense, mistrust.
Valour, realizing intelligence, business, wealth.|Vice, weakness, perversity, corruption, peril.`
		.split("\n").map((l) => l.split("|"))
const file = (i: number) =>
	i < 22
		? "m" + String(i).padStart(2, "0")
		: "wcsp"[Math.floor((i - 22) / 14)] + String((i - 22) % 14 + 1).padStart(2, "0")
const base = () =>
	new URL("examples/toy-tarot/cards/", parent.__base ?? parent.location.origin + "/").href

// ---- the spreads ----
const spreads = {
	three: ["past", "present", "future"],
	cross: [
		"the heart",
		"crossing",
		"foundation",
		"recent past",
		"crown",
		"near future",
		"yourself",
		"surroundings",
		"hopes and fears",
		"outcome",
	],
}

// ---- the random: splitmix32 spreads the seed over xoshiro128**'s four words ----
const rotl = (x: number, k: number) => (x << k) | (x >>> (32 - k))
function xoshiro(seed: string) {
	const words = [0, 1, 2, 3].map((i) => parseInt(seed.slice(i * 8, i * 8 + 8), 16) >>> 0)
	let z = words[0] ^ rotl(words[1], 7) ^ rotl(words[2], 13) ^ rotl(words[3], 19)
	const mix = () => { // splitmix32
		z = (z + 0x9e3779b9) | 0
		let r = Math.imul(z ^ (z >>> 16), 0x21f0aaad)
		r = Math.imul(r ^ (r >>> 15), 0x735a2d97)
		return (r ^ (r >>> 15)) >>> 0
	}
	const s = words.map((w) => (w ^ mix()) | 0)
	let [a, b, c, d] = s
	const next = () => {
		const r = Math.imul(rotl(Math.imul(b, 5), 7), 9)
		const t = b << 9
		c ^= a
		d ^= b
		b ^= c
		a ^= d
		c ^= t
		d = rotl(d, 11)
		return r >>> 0
	}
	for (let i = 0; i < 16; i++) next()
	// uniform in [0, n): reject the uneven top of the range
	next.below = (n: number) => {
		const limit = 0x100000000 - (0x100000000 % n)
		let x
		do x = next()
		while (x >= limit)
		return x % n
	}
	return next
}
// Fisher-Yates over all 78, then a coin for each card
function shuffle(seed: string) {
	const rng = xoshiro(seed) as ReturnType<typeof xoshiro> & { below: (n: number) => number }
	const order = [...names.keys()]
	for (let i = order.length - 1; i > 0; i--) {
		const j = rng.below(i + 1)
		;[order[i], order[j]] = [order[j], order[i]]
	}
	return order.map((c) => [c, rng.below(2)]) // [card, reversed?]
}
async function sha256(text: string) {
	const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
	return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("")
}
const fnv = (list: number[][]) => {
	let h = 0x811c9dc5
	for (const [c, r] of list) h = Math.imul(h ^ (c * 2 + r), 0x01000193)
	return (h >>> 0).toString(16).padStart(8, "0")
}

const css = `
body{background:#fffbe0}
.tr{max-width:780px;margin:0 auto;font-family:Jost,system-ui,sans-serif;color:#000}
.tr *{box-sizing:border-box}
.tr h1{margin:0 0 2px;font-size:26px;font-weight:600}
.tr .sub{margin:0 0 12px;font-size:14px}
.tr .tag{display:inline-block;background:#fff7a8;border:1px solid #000;padding:0 10px;transform:skew(-8deg);font-size:13px}
.tr .box{background:#fff;border:1px solid #000;border-radius:2px;box-shadow:0 4px 24px #ff228433;padding:12px 14px;margin:10px 0}
.tr .box h2{margin:0 0 6px;font-size:15px;font-weight:600}
.tr .pad{position:relative;height:170px;border:1px dashed #000;background:#fffbe0;touch-action:none;cursor:crosshair;overflow:hidden}
.tr .pad canvas{position:absolute;inset:0;width:100%;height:100%}
.tr .pad .hint{position:absolute;inset:0;display:grid;place-items:center;font-size:15px;pointer-events:none;opacity:.6}
.tr .meter{height:16px;border:1px solid #000;margin:8px 0 4px;background:#fff;position:relative}
.tr .meter i{display:block;height:100%;width:0;background:#ff2284;transition:width .12s}
.tr.fixed .meter i{background:#40dcba}
.tr .num{font-size:13px;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
.tr .mono{font:12px ui-monospace,Menlo,monospace;word-break:break-all;margin-top:4px;min-height:1.3em}
.tr .gathrow{display:flex;gap:12px;align-items:stretch}
.tr .gathrow .pad{flex:1}
.tr .stage{position:relative;width:210px;height:170px;border:1px solid #000;background:#fff;flex:none;overflow:hidden}
.tr .stage .cap{position:absolute;left:0;right:0;bottom:3px;text-align:center;font-size:11px;line-height:1.2;z-index:99}
.tr .sc{position:absolute;left:50%;top:44%;width:54px;height:94px;margin:-47px 0 0 -27px;border:1px solid #000;border-radius:4px;background:#fffbe0;padding:3px;box-shadow:0 2px 8px #ff228455}
.tr .sc i{display:block;width:100%;height:100%;border:1px solid #000;background:repeating-linear-gradient(45deg,#fff 0 5px,#ffd0e4 5px 6px),repeating-linear-gradient(-45deg,transparent 0 5px,#40dcba55 5px 6px)}
.tr .stage.landed{animation:land .5s}
@keyframes land{0%{transform:scale(1)}40%{transform:scale(1.06)}100%{transform:scale(1)}}
.tr.fixed .gathrow .stage{margin:0 auto}
.tr .gather .done{display:none}
.tr.fixed .gather .pad,.tr.fixed .gather .mono{display:none}
.tr.fixed .gather .done{display:block}
.tr .done{font-size:15px}
.tr .seed{font:600 18px ui-monospace,Menlo,monospace;background:#fff7a8;border:1px solid #000;padding:0 8px}
.tr .bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
.tr button.on{background:#40dcba}
.tr button.go{background:#ff2284;color:#fff}
.tr button[disabled]{opacity:.4;pointer-events:none}
.tr .table{display:flex;gap:18px;justify-content:center;padding:6px 0 4px;min-height:120px}
.tr .table.cross{display:grid;grid-template-columns:repeat(4,max-content);grid-template-rows:repeat(4,max-content);gap:8px 14px;justify-content:center}
.tr .cell{display:flex;flex-direction:column;align-items:center;gap:4px;font-size:12px;text-align:center;width:124px}
.tr .cross .cell{width:100px}
.tr .lab{height:2.4em;line-height:1.15}
.tr .lab b{display:block;font-weight:600}
.tr .cross .pos1{grid-area:2/2}.tr .cross .pos2{grid-area:2/2;z-index:2;align-self:start;margin-top:30px}
.tr .cross .pos2 .card{transform:rotate(90deg)}.tr .cross .pos2 .lab{visibility:hidden}
.tr .cross .pos3{grid-area:3/2}.tr .cross .pos4{grid-area:2/1}.tr .cross .pos5{grid-area:1/2}.tr .cross .pos6{grid-area:2/3}
.tr .cross .pos7{grid-area:4/4}.tr .cross .pos8{grid-area:3/4}.tr .cross .pos9{grid-area:2/4}.tr .cross .pos10{grid-area:1/4}
.tr .card{width:116px;height:201px;perspective:900px;cursor:pointer;transition:transform .15s}
.tr .cross .card{width:92px;height:160px}
.tr .card:not(.up):not(.empty):hover{transform:translateY(-4px)}
.tr .card .inner{position:relative;width:100%;height:100%;transform-style:preserve-3d;transition:transform .7s;transform:rotateY(180deg)}
.tr .card.up .inner{transform:rotateY(0)}
.tr .face{position:absolute;inset:0;backface-visibility:hidden;border:1px solid #000;border-radius:5px;overflow:hidden;box-shadow:0 4px 24px #ff228455;background:#fff}
.tr .face img{width:100%;height:100%;display:block}
.tr .card.rev .face img{transform:rotate(180deg)}
.tr .back{transform:rotateY(180deg);background:#fffbe0;padding:6px}
.tr .back div{width:100%;height:100%;border:1px solid #000;display:grid;place-items:center;font-size:30px;color:#ff2284;
background:repeating-linear-gradient(45deg,#fff 0 7px,#ffd0e4 7px 8px),repeating-linear-gradient(-45deg,transparent 0 7px,#40dcba55 7px 8px)}
.tr .table[data-wave=on] .card.up .inner{transition-delay:calc(var(--i) * .65s)}
.tr .card.empty{opacity:.5}
.tr .card.empty .inner{transform:rotateY(180deg)}
.tr .card.empty .back div{background:none;border-style:dashed;color:#000}
.tr .words{margin:6px 0 0;padding:0;list-style:none;font-size:14px}
.tr .words li{margin:6px 0;padding-left:10px;border-left:3px solid #2269ff}
.tr .words li.rev{border-left-color:#ff2284}
.tr .words em{font-style:normal;background:#ffd0e4;padding:0 5px;font-size:12px;margin-left:4px}
.tr .credit{font-size:12px;opacity:.75;margin:12px 0 0;line-height:1.35}
.tr.fixed .wait{display:none}
.tr .wait{font-size:14px;text-align:center;margin:0}
`

// the process: the reading is saved under "./" (samples, spread, flipped, rereads, wave), so a reload
// finds the same cards; what is derived (stats, bits, pool, seed, deck, reading…) is memos inside the
// process, made again at each start. the canvas is a ref, the frame loop has a
// teardown
export default function program() {
	// a node's value, as the program uses it: any (the nodes hold what this program put there)
	const get = (x: Node): any => read(x)
	// the same, in an action: not tracked
	const now = (x: Node): any => peep(() => read(x))
	const put = (x: Node, value: unknown) => patch(x, [{ path: [], value }])
	// a memo that is still out is nothing yet (the pool, while its digest runs)
	const soft = (x: Node): any => {
		try {
			return read(x)
		} catch (e) {
			if (e === PENDING) return undefined
			throw e
		}
	}
	// ---- nodes: the whole reading lives here ----
	const samples = ensureNode("./samples", []) // [x, y, time, since last, credit, clock], only the credited ones
	const spread = ensureNode("./spread", "three")
	const flipped = ensureNode("./flipped", []) // positions turned face up, in order
	const rereads = ensureNode("./rereads", 0)
	// turn them all, staggered: the turns wait their place in the order (css), as a timer cannot call
	const wave = ensureNode("./wave", false)

	// a summary of the samples, so the graph shows the shape without every number
	createMemo("stats", () => {
		const s = get(samples)
		const last = s.at(-1)
		const gaps = s.map((x) => x[3])
		return {
			n: s.length,
			last: last ? { x: last[0], y: last[1], t: last[2], dt: last[3] } : null,
			meanGap: s.length ? +(gaps.reduce((a, b) => a + b, 0) / s.length).toFixed(3) : 0,
			span: s.length ? +(last[2] - s[0][2]).toFixed(1) : 0,
		}
	})
	const bits = createMemo("bits", () => Math.min(NEED, get(samples).reduce((a, x) => a + x[4], 0)))
	// the rate of gathering over the last 1.5 s: bits per second, and which way the pointer went
	// (-1 left .. 1 right); pace is the same rate as 0..1, what the shuffling is driven by
	const rate = createMemo("rate", () => {
		const s = get(samples)
		const last = s.at(-1)
		if (!last) return { bps: 0, dir: 0, pace: 0 }
		const win = s.filter((x) => x[2] > last[2] - 1500)
		let credit = 0, dx = 0, ax = 0
		win.forEach((x, i) => {
			credit += x[4]
			if (i) dx += x[0] - win[i - 1][0], ax += Math.abs(x[0] - win[i - 1][0])
		})
		const bps = +(credit / 1.5).toFixed(1)
		return { bps, dir: ax ? +(dx / ax).toFixed(2) : 0, pace: +Math.min(1, bps / 90).toFixed(2) }
	})
	// the pool: SHA-256 of all samples. async: it reads first, then awaits the digest. the hash
	// says how many samples it took in, so the seed can wait for a pool that is up to date
	const pool = createMemo("pool", () => {
		const s = get(samples)
		if (!s.length) return { n: 0, hex: "" }
		return sha256("tarot-pool:" + s.map((x) => x.join(",")).join(";")).then((hex) => ({
			n: s.length,
			hex,
		}))
	})
	// the seed: fixed when the bits are full and the pool has taken in every sample (no more come)
	const seed = createMemo("seed", () => {
		const p = soft(pool)
		const full = get(samples).length
		if (get(bits) < NEED || !p || typeof p !== "object" || p.n !== full) return null
		return p.hex.slice(0, 32)
	})
	const deck = createMemo("deck", () => {
		const s = get(seed)
		return typeof s === "string" ? shuffle(s) : null // [card, reversed] x 78
	})
	const print = createMemo("fingerprint", () => {
		const d = get(deck)
		return Array.isArray(d) ? fnv(d) : null
	})
	// what is on the table: the top of the deck laid out in the spread, with what is turned
	createMemo("reading", () => {
		const d = get(deck)
		const kind = get(spread)
		const up = get(flipped)
		const labels = spreads[kind] ?? spreads.three
		return {
			kind,
			cards: labels.map((label, i) => {
				const [c, r] = Array.isArray(d) ? d[i] : [-1, 0]
				return { label, card: c, rev: r === 1, up: Array.isArray(d) && up.includes(i) }
			}),
		}
	})

	// ---- actions: what the buttons and the pad call ----
	const turn = (i: number) => {
		const up = now(flipped)
		if (now(seed) && !up.includes(i)) put(flipped, [...up, i])
	}
	createAction("on/sample", (batch: number[][]) => {
		// samples come in as the pointer moves; once the bits are full, none more are taken
		let have = now(samples).reduce((a: number, x: number[]) => a + x[4], 0)
		const take: number[][] = []
		for (const x of batch) {
			if (have >= NEED) break
			take.push(x)
			have += x[4]
		}
		if (take.length) put(samples, [...now(samples), ...take])
	})
	createAction("on/flip", (i: number) => {
		put(wave, false)
		turn(i)
	})
	createAction("on/next", () => {
		put(wave, false)
		const n = spreads[now(spread) as string].length
		const up = now(flipped)
		for (let i = 0; i < n; i++) if (!up.includes(i)) return turn(i)
	})
	// every card at once, each turn waiting for its place in the spread (the wave class: a css
	// delay by position); the old one called on/next from a timer
	createAction("on/all", () => {
		put(wave, true)
		put(flipped, spreads[now(spread) as string].map((_: string, i: number) => i))
	})
	createAction("on/spread", (kind: string) => {
		put(spread, kind)
		put(flipped, [])
	})
	// the same seed again: the deck is a function of it, so the same cards come back. they settle
	// face down; turning them again is up to whoever reads (a timer cannot call on/next)
	createAction("on/reread", () => {
		put(flipped, [])
		put(rereads, now(rereads) + 1)
	})
	// a new reading needs new entropy: the samples go, and with them the pool, seed and deck
	createAction("on/renew", () => {
		put(samples, [])
		put(flipped, [])
		put(rereads, 0)
	})

	// what the shuffling stage says under the cards: a node, so it can be bound like the rest
	createMemo("caption", () => {
		const r = get(rate), b = get(bits), fp = get(print)
		return typeof get(seed) === "string"
			? `deck fixed · lands as ${fp}`
			: b
			? `${r.bps} bits/s · ${Math.round((b / NEED) * 100)}% mixed`
			: "the deck listens"
	})

	// ---- the view: jsx bound to the nodes. what the program draws itself (the pad's canvas, the
	// shuffling cards, the timers' state) lives in this setup ----
	const st = { x: NaN, y: NaN, t: 0, dt: 0, full: false, moved: 0 }
	const canvas: HTMLCanvasElement = get(
		ref(
			"el/canvas",
			() => Object.assign(document.createElement("canvas"), { width: 760, height: 170 }),
		),
	)
	const ctx = canvas.getContext("2d")!
	const N = 16
	const sc = Array.from({ length: N }, () => {
		const c = document.createElement("div")
		c.className = "sc"
		c.append(document.createElement("i"))
		return c
	})
	let stage: HTMLElement | undefined

	// a move over the pad: samples at full resolution, handed to on/sample as the move happens (the
	// handler's arguments are read off the event: a listener of this code's own could not call)
	const move = (e: PointerEvent) => {
		if (st.full) return undefined
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
		const evs = e.getCoalescedEvents?.() ?? []
		const batch: number[][] = []
		for (const ev of evs.length ? evs : [e]) {
			// full resolution: the fractional position, the time to the microsecond, the gap since the last
			const now = performance.now()
			const when = ev.timeStamp > 0 && Math.abs(ev.timeStamp - now) < 1000 ? ev.timeStamp : now
			const x = ev.clientX - rect.left, y = ev.clientY - rect.top
			const dt = when - st.t
			const moved = x !== st.x || y !== st.y
			// credit, kept low: a move is a bit, and a gap unlike the last is another
			const credit = !moved ? 0 : 1 + (Math.abs(dt - st.dt) >= 0.5 ? 1 : 0)
			st.x = x, st.y = y, st.t = when, st.dt = dt
			if (!credit) continue
			st.moved = now
			batch.push([x, y, when, dt, credit, performance.timeOrigin + now])
			ctx.fillStyle = "rgba(255,251,224,.035)"
			ctx.fillRect(0, 0, canvas.width, canvas.height)
			ctx.fillStyle = credit > 1 ? "#ff2284" : "#2269ff"
			ctx.beginPath()
			ctx.arc((x / rect.width) * canvas.width, (y / rect.height) * canvas.height, 3.5, 0, 7)
			ctx.fill()
		}
		return batch.length ? [batch] : undefined
	}

	// a spread's button is lit while it is the spread
	const lit = (kind: string) => bind("spread", (k) => (k === kind ? "on" : ""))
	// the buttons that need a deck: off until the reading is dealt
	const undealt = bind("reading", (r) => r.cards[0].card < 0)

	const card = (c, i: number) => {
		const dealt = c.card >= 0
		return (
			<div class={"cell pos" + (i + 1)} key={String(i)}>
				<div
					style={`--i:${i}`}
					class={"card" + (dealt ? "" : " empty") + (c.up ? " up" : "") +
						(c.rev ? " rev" : "")}
					onClick={handler("on/flip", [i])}
				>
					<div class="inner">
						<div class="face">
							<img
								alt={dealt ? names[c.card] : ""}
								draggable={false}
								src={dealt ? base() + file(c.card) + ".jpg" : undefined}
							/>
						</div>
						<div class="face back">
							<div>✦</div>
						</div>
					</div>
				</div>
				<div class="lab">
					<b>{c.label}</b>
					{c.up ? names[c.card] + (c.rev ? " (reversed)" : "") : dealt ? "face down" : ""}
				</div>
			</div>
		)
	}
	// what each turned card says, in the order of the positions
	const word = (c) => {
		const [up, rev] = meanings[c.card]
		return (
			<li key={c.label} class={c.rev ? "rev" : ""}>
				<b>{`${c.label} · ${names[c.card]}`}</b>
				<em>{c.rev ? "reversed" : "upright"}</em> {c.rev ? rev : up}
			</li>
		)
	}

	// the shuffle is a view of the nodes: this effect copies the rate and the bits into what the
	// loop below draws from; nothing here is random, the order of the real deck is the seed's
	const anim: Record<string, any> = {
		phase: 0,
		pace: 0,
		mix: 0,
		dir: 0,
		calm: 1,
		full: false,
		last: 0,
		raf: 0,
		was: false,
	}
	createEffect("shuffle", () => ({
		r: get(rate),
		b: get(bits),
		full: typeof get(seed) === "string",
		fp: get(print),
	}), (v) => {
		st.full = v.full
		anim.target = { pace: v.r.pace, mix: v.b / NEED, dir: v.r.dir, full: v.full }
	})
	const ease = (a: number, b: number, x: number) => {
		const u = Math.min(1, Math.max(0, (x - a) / (b - a)))
		return u * u * (3 - 2 * u)
	}
	const frame = (now: number) => {
		anim.raf = requestAnimationFrame(frame)
		const dt = Math.min(0.05, (now - (anim.last || now)) / 1000)
		anim.last = now
		const g = anim.target ?? { pace: 0, mix: 0, dir: 0, full: false }
		// a still hand: the rate node holds its last value (nothing ticks it), so the pace is let go
		// here once the pointer has been quiet for a moment
		const still = performance.now() - st.moved > 1500
		const k = 1 - Math.exp(-dt * 6)
		anim.pace += ((still ? 0 : g.pace) - anim.pace) * k
		anim.mix += (g.mix - anim.mix) * k
		anim.dir += (g.dir - anim.dir) * k
		anim.calm += ((g.full ? 0 : 1) - anim.calm) * k
		if (g.full && !anim.was && stage) {
			const it = stage
			it.classList.add("landed"), setTimeout(() => it.classList.remove("landed"), 600)
		}
		anim.was = g.full
		anim.phase += dt * (0.8 + 9 * anim.pace) // faster gathering, faster hands
		const f = anim.phase, mix = anim.mix
		const move = Math.min(1, anim.pace * 4) * anim.calm // a still hand, a still deck
		const wr = ease(0.3, 0.6, mix), wo = ease(0.65, 0.9, mix)
		const active = 0.12 + 0.88 * Math.pow(mix, 0.8) // few cards early, all of them near full
		sc.forEach((c, i) => {
			const r = (Math.sin(i * 12.9898) * 43758.5453) % 1
			const on = Math.abs(r) < active ? 1 : 0
			let x = (i - N / 2) * 0.4, y = -i * 0.9, rot = 0
			const amp = 14 + 40 * anim.pace
			x += move * on * amp * Math.sin(f + i * 0.9) +
				move * anim.dir * 16 * anim.pace * Math.sin(f * 0.5 + i)
			y += move * on * 6 * Math.cos(f * 1.3 + i)
			const side = i % 2 ? 1 : -1 // a riffle: two halves, drawn together
			const spread = wr * move * (0.5 + 0.5 * Math.cos(f * 0.8)) * (20 + 24 * anim.pace)
			x += side * spread
			rot += side * spread * 0.3
			if (i >= N * 0.55) { // an overhand cut: the top lifts off and drops behind
				const u = 0.5 + 0.5 * Math.sin(f * 0.6)
				y -= wo * move * u * 52
				x += wo * move * u * 26 * (anim.dir >= 0 ? 1 : -1)
				rot += wo * move * u * 12
			}
			c.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) rotate(${
				rot.toFixed(1)
			}deg)`
			c.style.zIndex = String(i)
		})
	}
	anim.raf = requestAnimationFrame(frame)
	addTeardown(() => cancelAnimationFrame(anim.raf))
	const hud = (s) => `${s.n} samples · gap ${s.last ? s.last.dt.toFixed(2) : 0} ms`
	return (
		// fixed: the seed is fixed, so the reading is dealt (bound to the reading: it always has a
		// value, where the seed is null until then, and a binding's function runs only on a value)
		<div class={bind("reading", (r) => (r.cards[0].card >= 0 ? "tr fixed" : "tr"))}>
			<style>{css}</style>
			<div>
				<span class="tag">toy tarot</span>
				<h1>draw from the dark</h1>
				<p class="sub">
					The deck stays shut until you have shaken enough chance out of your hand. Move over
					the pad.
				</p>
			</div>
			<div class="box gather">
				<h2>1 · gather entropy</h2>
				<div class="gathrow">
					<div
						class="pad"
						onPointerMove={handler("on/sample", move)}
						onPointerDown={(e) =>
							(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)}
					>
						{canvas}
						<div class="hint" style={bind("stats", (s) => (s.n ? "display:none" : ""))}>
							move here (or drag a finger) to gather entropy
						</div>
					</div>
					<div class="stage" ref={(e) => (stage = e)}>
						{sc}
						<div class="cap">{bind("caption")}</div>
					</div>
				</div>
				<div class="meter">
					<i style={bind("bits", (b) => `width:${(b / NEED) * 100}%`)} />
				</div>
				<div class="num">
					<span>
						{bind("bits")} of {NEED} bits · {bind("stats", hud)}
					</span>
					<span>
						{bind(
							"stats",
							(s) =>
								s.last
									? `x ${s.last.x.toFixed(2)} · y ${s.last.y.toFixed(2)} · t ${
										s.last.t.toFixed(3)
									}`
									: "",
						)}
					</span>
				</div>
				<div class="mono">
					{bind(
						"pool",
						(p) => (p && typeof p === "object" && p.hex ? "pool " + p.hex : "pool (empty)"),
					)}
				</div>
				<div class="done">
					entropy gathered, seed fixed:{" "}
					<span class="seed">
						{bind("seed", (sd) => (typeof sd === "string" ? sd.slice(0, 8) : ""))}
					</span>
					{" · "}
					{bind("stats", (s) => s.n)} samples mixed with SHA-256 · deck fingerprint{" "}
					{bind("fingerprint")} · read {bind("rereads", (r) => r + 1)} of this seed
				</div>
			</div>
			<div class="box">
				<h2>2 · the reading</h2>
				<div class="bar">
					<button class={lit("three")} onClick={handler("on/spread", ["three"])}>
						three cards
					</button>
					<button class={lit("cross")} onClick={handler("on/spread", ["cross"])}>
						celtic cross
					</button>
					<button disabled={undealt} onClick={handler("on/next")}>turn the next card</button>
					<button disabled={undealt} onClick={handler("on/all")}>turn them all</button>
					<button disabled={undealt} onClick={handler("on/reread")}>
						re-read this seed
					</button>
					<button class="go" onClick={handler("on/renew")}>new reading</button>
				</div>
				<p class="wait">the cards are waiting: gather entropy to deal</p>
				<div
					class={bind(
						"spread",
						(k) => (k === "cross" ? "table cross" : "table"),
					)}
					data-wave={bind("wave", (w) => (w ? "on" : "off"))}
				>
					{bind("reading", (r) => r.cards.map(card))}
				</div>
				<ul class="words">{bind("reading", (r) => r.cards.filter((c) => c.up).map(word))}</ul>
			</div>
			<p class="credit">
				The deck is the Rider–Waite–Smith tarot (1909), drawn by Pamela Colman “Pixie” Smith
				under the direction of A. E. Waite; public domain, scans from Wikimedia Commons. The
				short meanings are condensed from Waite’s The Pictorial Key to the Tarot (1910). The
				estimate of entropy is deliberately stingy: 1 bit for a move, 2 if its timing is unlike
				the last.
			</p>
		</div>
	)
}
