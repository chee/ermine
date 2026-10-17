// readline.ts: emacs-key text editing on a field, a value the program keeps in its nodes
//
//   {text, pos, mark?, ring?, undo?, yank?, last?, goal?}
//   pos: cursor offset (UTF-16)  mark: the selection's other end, or null  ring: kills, newest last
//   undo: [{text, pos}] before each change  yank: what the last C-y put in  goal: up/down's column
//   last: what the key before did ("kill", "yank"), so kills in a row are one
//
// each call answers a new field, or null for a key that is not an editing key (the program's own).
// keys: chords as /etc/keys writes them (chord(record)): modifiers A C H S s, then the key
//
//   C-a C-e home end s-left s-right   the line's start, its end
//   C-b C-f left right                a character back, on
//   A-b A-f A-left A-right C-left C-right   a word back, on
//   C-p C-n up down                   a line up, down (lines only, else null)
//   s-up s-down                       the start of the text, its end
//   backspace C-h   delete C-d        the character before, after
//   A-d   A-backspace   C-w           kill a word on, back, back to white space
//   C-k   C-u s-backspace             kill to the line's end (at its end the newline), to its start
//   C-y   A-y                         the newest kill, then the one before it in its place
//   C-t   A-t                         swap the characters, the words, either side
//   A-u A-l A-c                       the word upper case, lower case, capitalised
//   C-_ C-slash C-S-minus   A-r       undo; the text as before any change
//   A-backslash                       the spaces around the cursor, gone
//   s-a                               select all
//   s-c s-x s-v                       copy, cut, paste: /dev/clip/text, through {api}
//
// {select: true}: shift and a move selects; typing, a paste or a delete replaces the selection
// {lines: true}: up/down keep the column; C-a, C-e per line; C-k at a line's end joins the next.
//   without it a paste's lines are joined by spaces
// {api}: s-c s-x s-v reach the clipboard; without it they are not editing keys

import { type Api as KitApi, val, whole as wholly } from "./kit.ts"
export type Field = {
	text: string
	pos: number
	mark?: number | null
	ring?: string[]
	undo?: { text: string; pos: number }[]
	yank?: { i: number; at: number; length: number } | null
	last?: string
	goal?: number | null
}
type Api = KitApi
export type Options = { lines?: boolean; select?: boolean; api?: Api }
const CLIP = ["/", "dev", "clip", "text"]
type Record_ = {
	key?: string
	mods?: string[]
	text?: string
	down?: boolean
	event?: string
	replace?: [number, number]
}

const NAMES: { [key: string]: string } = {
	Enter: "return",
	Tab: "tab",
	Space: "space",
	" ": "space",
	Backspace: "backspace",
	Escape: "escape",
	Delete: "delete",
	ArrowLeft: "left",
	ArrowRight: "right",
	ArrowUp: "up",
	ArrowDown: "down",
	Home: "home",
	End: "end",
	PageUp: "pageup",
	PageDown: "pagedown",
	".": "period",
	",": "comma",
	"-": "minus",
	"=": "equal",
	"/": "slash",
	"\\": "backslash",
	";": "semicolon",
	"'": "quote",
	"`": "grave",
	"[": "bracketleft",
	"]": "bracketright",
}
// the modifiers, as Emacs writes them and in its order: A alt, C control, H hyper (fn), S shift, s super (cmd)
const MODS: [string, string][] = [["alt", "A"], ["ctrl", "C"], ["fn", "H"], ["shift", "S"], [
	"cmd",
	"s",
]]

/** a key's name in a chord: a letter lower case, a special by its name */
export function keyName(key: string): string {
	return NAMES[key] ?? (key.length === 1 ? key.toLowerCase() : key.toLowerCase())
}

/** a key record as a chord, as /etc/keys writes them: "C-a", "A-S-left", "s-return" */
export function chord(r: Record_): string {
	const mods = MODS.filter(([m]) => r.mods?.includes(m)).map(([, c]) => c)
	return [...mods, keyName(String(r.key ?? ""))].join("-")
}

/** a chord as written by a person, its modifiers in any order, made the one way chord() writes it;
 * m, meta, the modifier the setup chooses: meta says which (/dev/display/mode's takeover: s, cmd,
 * while ermineOS takes the Mac over; else A, alt); M, as chords were once written, is s */
export function normal(text: string, meta = "A"): string {
	const parts = String(text).trim().split("-")
	// a chord whose key is the minus sign: "C-minus", or "C--"
	let key = parts.pop() ?? ""
	if (key === "" && parts.length && parts.at(-1) === "") {
		parts.pop()
		key = "-"
	}
	const mods = new Set(
		parts.map((
			p,
		) => (p === "m" ? meta : p === "M" || p === "s" ? "s" : p === "S" ? "S" : p.toUpperCase())),
	)
	return [...MODS.map(([, c]) => c).filter((c) => mods.has(c)), keyName(key)].join("-")
}

const isWord = (c: string | undefined) => /[\w]/.test(c ?? "")
const wordBack = (t: string, i: number) => {
	while (i > 0 && !isWord(t[i - 1])) i--
	while (i > 0 && isWord(t[i - 1])) i--
	return i
}
const wordOn = (t: string, i: number) => {
	while (i < t.length && !isWord(t[i])) i++
	while (i < t.length && isWord(t[i])) i++
	return i
}
const lineStart = (t: string, i: number) => t.lastIndexOf("\n", i - 1) + 1
const lineEnd = (t: string, i: number) => {
	const e = t.indexOf("\n", i)
	return e < 0 ? t.length : e
}

/** a field made whole: what a program kept, with what it did not */
function whole(f: Field): Required<Field> {
	const text = String(f.text ?? "")
	return {
		text,
		pos: Math.max(0, Math.min(text.length, f.pos ?? text.length)),
		mark: f.mark ?? null,
		ring: [...(f.ring ?? [])],
		undo: [...(f.undo ?? [])],
		yank: f.yank ?? null,
		last: "",
		goal: f.goal ?? null,
	}
}

/** the text changed, what it was kept to undo */
function change(f: Required<Field>, text: string, pos: number): Required<Field> {
	const top = f.undo.at(-1)
	if (text !== f.text && (!top || top.text !== f.text)) f.undo.push({ text: f.text, pos: f.pos })
	if (f.undo.length > 200) f.undo.shift()
	f.text = text
	f.pos = Math.max(0, Math.min(text.length, pos))
	f.mark = null
	return f
}

/** what lies between a and b, gone, kept to yank: kills in a row are one, the earlier text first */
function kill(f: Required<Field>, a: number, b: number, was: string): Required<Field> {
	if (a === b) return f
	const text = f.text.slice(a, b)
	if (was === "kill" && f.ring.length) {
		f.ring[f.ring.length - 1] = a < f.pos ? text + f.ring.at(-1) : f.ring.at(-1) + text
	} else f.ring.push(text)
	if (f.ring.length > 60) f.ring.shift()
	f.last = "kill"
	return change(f, f.text.slice(0, a) + f.text.slice(b), a)
}

/** the selection, first end first, or null */
export function selection(f: Field): [number, number] | null {
	if (f.mark === null || f.mark === undefined || f.mark === f.pos) return null
	return f.mark < f.pos ? [f.mark, f.pos] : [f.pos, f.mark]
}

/** text put in at the cursor, over the selection if there is one */
export function insert(field: Field, text: string): Field {
	const f = whole(field)
	const sel = selection(f)
	const [a, b] = sel ?? [f.pos, f.pos]
	f.goal = null
	return change(f, f.text.slice(0, a) + text + f.text.slice(b), a + text.length)
}

/** the key, a chord, done to the field: a new field, or null for a key that is not an editing key */
export function key(field: Field, k: string, o: Options = {}): Field | null {
	const f = whole(field)
	const was = field.last ?? ""
	const t = f.text, p = f.pos
	let c = normal(k)
	// shift and a move selects, where the field selects; elsewhere it is the move
	const shifted = /(^|-)S-/.test(c)
	const bare = c.replace(/(^|-)S-/, "$1")
	const MOVES = [
		"left",
		"right",
		"up",
		"down",
		"home",
		"end",
		"A-left",
		"A-right",
		"C-left",
		"C-right",
		"s-left",
		"s-right",
		"s-up",
		"s-down",
		"C-a",
		"C-e",
		"C-b",
		"C-f",
		"A-b",
		"A-f",
		"C-p",
		"C-n",
	]
	if (shifted && MOVES.includes(bare)) c = bare
	const move = (to: number, vertical = false): Field => {
		if (shifted && o.select) f.mark = f.mark ?? p
		else f.mark = null
		if (!vertical) f.goal = null
		f.pos = Math.max(0, Math.min(t.length, to))
		return f
	}
	const vertical = (dir: number): Field | null => {
		if (!o.lines) return null
		const s = lineStart(t, p), col = f.goal ?? p - s
		f.goal = col
		if (dir < 0) {
			if (s === 0) return move(0, true)
			const ps = lineStart(t, s - 1)
			return move(Math.min(ps + col, s - 1), true)
		}
		const e = lineEnd(t, p)
		if (e >= t.length) return move(t.length, true)
		return move(Math.min(e + 1 + col, lineEnd(t, e + 1)), true)
	}
	// with a selection, a delete takes it
	const sel = selection(f)
	if (sel && o.select && ["backspace", "delete", "C-d", "C-h"].includes(c)) {
		return change(f, t.slice(0, sel[0]) + t.slice(sel[1]), sel[0])
	}
	switch (c) {
		case "C-a":
		case "home":
		case "s-left":
			return move(o.lines ? lineStart(t, p) : 0)
		case "C-e":
		case "end":
		case "s-right":
			return move(o.lines ? lineEnd(t, p) : t.length)
		case "C-b":
		case "left":
			return move(sel && !shifted && o.select ? sel[0] : p - 1)
		case "C-f":
		case "right":
			return move(sel && !shifted && o.select ? sel[1] : p + 1)
		case "A-b":
		case "A-left":
		case "C-left":
			return move(wordBack(t, p))
		case "A-f":
		case "A-right":
		case "C-right":
			return move(wordOn(t, p))
		case "C-p":
		case "up":
			return vertical(-1)
		case "C-n":
		case "down":
			return vertical(1)
		case "s-up":
			return move(0)
		case "s-down":
			return move(t.length)
		case "backspace":
		case "C-h":
			return p > 0 ? change(f, t.slice(0, p - 1) + t.slice(p), p - 1) : f
		case "delete":
		case "C-d":
			return p < t.length ? change(f, t.slice(0, p) + t.slice(p + 1), p) : f
		case "A-d":
			return kill(f, p, wordOn(t, p), was)
		case "A-backspace":
			return kill(f, wordBack(t, p), p, was)
		case "C-w": {
			// back to white space, as readline's unix-word-rubout
			let i = p
			while (i > 0 && t[i - 1] === " ") i--
			while (i > 0 && t[i - 1] !== " " && !(o.lines && t[i - 1] === "\n")) i--
			return kill(f, i, p, was)
		}
		case "C-k": {
			const e = o.lines ? lineEnd(t, p) : t.length
			return kill(f, p, e === p && e < t.length ? e + 1 : e, was)
		}
		case "C-u":
		case "s-backspace":
			return kill(f, o.lines ? lineStart(t, p) : 0, p, was)
		case "C-y": {
			if (!f.ring.length) return f
			const text = f.ring.at(-1)!
			const out = change(f, t.slice(0, p) + text + t.slice(p), p + text.length)
			out.yank = { i: f.ring.length - 1, at: p, length: text.length }
			out.last = "yank"
			return out
		}
		case "A-y": {
			if (!f.ring.length || was !== "yank" || !f.yank) return f
			const i = (f.yank.i - 1 + f.ring.length) % f.ring.length, text = f.ring[i], at = f.yank.at
			const out = change(
				f,
				t.slice(0, at) + text + t.slice(at + f.yank.length),
				at + text.length,
			)
			out.yank = { i, at, length: text.length }
			out.last = "yank"
			return out
		}
		case "C-t": {
			// the characters either side of the cursor swap, the cursor past them
			if (t.length < 2 || p === 0) return f
			const q = p === t.length ? p - 1 : p
			return change(f, t.slice(0, q - 1) + t[q] + t[q - 1] + t.slice(q + 1), q + 1)
		}
		case "A-t": {
			// the word before the cursor and the one after it swap, the cursor past both; at the end, the last two
			let e2 = wordOn(t, p)
			if (e2 === p) {
				e2 = wordBack(t, t.length) === t.length ? t.length : wordOn(t, wordBack(t, t.length))
			}
			const s2 = wordBack(t, e2), s1 = wordBack(t, s2), e1 = wordOn(t, s1)
			if (s1 === s2 || e1 > s2) return f
			return change(
				f,
				t.slice(0, s1) + t.slice(s2, e2) + t.slice(e1, s2) + t.slice(s1, e1) + t.slice(e2),
				e2,
			)
		}
		case "A-u":
		case "A-l":
		case "A-c": {
			// the word at or after the cursor, the cursor past it
			let a = p
			while (a < t.length && !isWord(t[a])) a++
			const b = wordOn(t, a)
			if (a === b) return f
			const w = t.slice(a, b)
			const to = c === "A-u"
				? w.toUpperCase()
				: c === "A-l"
				? w.toLowerCase()
				: w[0].toUpperCase() + w.slice(1).toLowerCase()
			return change(f, t.slice(0, a) + to + t.slice(b), b)
		}
		case "C-_":
		case "C-slash":
		case "C-S-minus": {
			const top = f.undo.pop()
			if (!top) return f
			Object.assign(f, {
				text: top.text,
				pos: Math.min(top.pos, top.text.length),
				mark: null,
				goal: null,
			})
			return f
		}
		case "A-r": {
			// the text as it was before any change
			if (!f.undo.length) return f
			Object.assign(f, {
				text: f.undo[0].text,
				pos: f.undo[0].text.length,
				undo: [],
				mark: null,
				goal: null,
			})
			return f
		}
		case "A-backslash": {
			let a = p, b = p
			while (a > 0 && t[a - 1] === " ") a--
			while (b < t.length && t[b] === " ") b++
			return a === b ? f : change(f, t.slice(0, a) + t.slice(b), a)
		}
		case "s-a":
			return Object.assign(f, { mark: 0, pos: t.length, goal: null })
		case "s-c":
		case "s-x": {
			if (!o.api) return null
			if (!sel) return f
			o.api.write(CLIP, wholly({ text: t.slice(sel[0], sel[1]) }))
			return c === "s-x" ? change(f, t.slice(0, sel[0]) + t.slice(sel[1]), sel[0]) : f
		}
		case "s-v": {
			if (!o.api) return null
			let text = (val(o.api, CLIP) as { text?: unknown } | undefined)?.text as string
			if (typeof text !== "string") return f
			text = text.replace(/\r\n?/g, "\n")
			if (!o.lines) text = text.trim().replace(/\s*\n\s*/g, " ")
			return insert(f, text)
		}
	}
	return null
}

/**
 * a key record (the window manager's: {key, mods, text, down} or an input
 * method's commit) done to the field: typed text put in, an editing chord
 * done; null for one that is neither, the program's own (and for a key up)
 */
export function type(field: Field, r: Record_, o: Options = {}): Field | null {
	if (r.event === "commit") {
		if (!r.replace) return insert(field, r.text ?? "")
		// a press-and-hold accent: the letter held, just before the cursor, replaced
		const f = whole(field)
		const n = Math.max(0, r.replace[1] - r.replace[0])
		return change(
			f,
			f.text.slice(0, Math.max(0, f.pos - n)) + (r.text ?? "") + f.text.slice(f.pos),
			Math.max(0, f.pos - n) + (r.text ?? "").length,
		)
	}
	if (!r.down) return null
	const c = chord(r)
	// a key with only shift, or none, that types: the text it typed (cmd and a letter is a chord)
	// deno-lint-ignore no-control-regex
	const typing = r.text && !/[\x00-\x1f\x7f\uf700-\uf8ff]/.test(r.text) &&
		!/(^|-)[MCAs]-/.test(c) && r.key !== "Enter" && r.key !== "Tab"
	if (typing) return insert(field, r.text!)
	return key(field, c, o)
}
