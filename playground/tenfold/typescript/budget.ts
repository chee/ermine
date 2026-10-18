// budget: a letter's source with a check in every loop, so one that never ends is ended. a while's
// or do-while's condition, and a three-part for's, is TICK() && (it) (an empty one: TICK()); a
// for-of's iterable goes through EACH(it), a check an item; a for-in's keys end, so it is left as
// it is, and so is a for await (a letter draws at once). what TICK and EACH are is the runner's
// (letter.ts): the budget is its, not the source's. comments, strings, templates (what is inside
// their ${} too) and regular expressions are passed over as they are; a loop inside a loop's head
// is checked. the rest of the source is untouched, so lines keep their numbers
//
//   instrument("while (true) x++")         // "while (__tick() && (true)) x++"
//   instrument("for (;;) {}")              // "for (; __tick();) {}"
//   instrument("for (const v of vs) {}")   // "for (const v of __each(vs)) {}"
//
// this is the den's compiler loop-budget (tenfold.ts): source in, source out, the same form apart
// from the checks. not a parser: a / after a word that is no keyword is division, after ) ] or }
// it is division too
export const TICK = "__tick"
export const EACH = "__each"

const WORD = /[A-Za-z0-9_$]/
const SPACE = /\s/
// words a regular expression may follow
const BEFORE = new Set([
	"return",
	"typeof",
	"instanceof",
	"in",
	"of",
	"new",
	"delete",
	"void",
	"throw",
	"case",
	"do",
	"else",
	"yield",
	"await",
])

const isWord = (c: string | undefined) => c !== undefined && WORD.test(c)

// the last index before i that is no space; none: -1
function back(src: string, i: number): number {
	let j = i - 1
	while (j >= 0 && SPACE.test(src[j])) j--
	return j
}

// the first index from i that is no space
function ahead(src: string, i: number): number {
	while (i < src.length && SPACE.test(src[i])) i++
	return i
}

// a / at i starts a regular expression: what is before it cannot end a value
function regexAt(src: string, i: number): boolean {
	const j = back(src, i)
	if (j < 0) return true
	if (")]}".includes(src[j])) return false
	if (!isWord(src[j])) return true
	let k = j
	while (k >= 0 && isWord(src[k])) k--
	return BEFORE.has(src.slice(k + 1, j + 1))
}

function quoted(src: string, i: number): number {
	for (let j = i + 1; j < src.length; j++) {
		if (src[j] === "\\") j++
		else if (src[j] === src[i] || src[j] === "\n") return j + 1
	}
	return src.length
}

function template(src: string, i: number): number {
	for (let j = i + 1; j < src.length; j++) {
		if (src[j] === "\\") j++
		else if (src[j] === "`") return j + 1
		else if (src[j] === "$" && src[j + 1] === "{") j = shut(src, j + 1)
	}
	return src.length
}

function regex(src: string, i: number): number {
	let set = false
	for (let j = i + 1; j < src.length; j++) {
		const c = src[j]
		if (c === "\\") j++
		else if (c === "\n") return j
		else if (c === "[") set = true
		else if (c === "]") set = false
		else if (c === "/" && !set) {
			j++
			while (isWord(src[j])) j++
			return j
		}
	}
	return src.length
}

// the index past the comment, string, template or regular expression at i; none there: i
function past(src: string, i: number): number {
	const c = src[i], d = src[i + 1]
	if (c === "/" && d === "/") {
		const n = src.indexOf("\n", i)
		return n === -1 ? src.length : n
	}
	if (c === "/" && d === "*") {
		const n = src.indexOf("*/", i + 2)
		return n === -1 ? src.length : n + 2
	}
	if (c === '"' || c === "'") return quoted(src, i)
	if (c === "`") return template(src, i)
	if (c === "/" && regexAt(src, i)) return regex(src, i)
	return i
}

// the index of the bracket closing the one at i; none: the end
function shut(src: string, i: number): number {
	let depth = 0
	for (let j = i; j < src.length;) {
		const n = past(src, j)
		if (n > j) {
			j = n
			continue
		}
		if ("([{".includes(src[j])) depth++
		else if (")]}".includes(src[j]) && --depth === 0) return j
		j++
	}
	return src.length
}

// each index of src outside brackets, comments, strings and the like, in order
function* level(src: string): Generator<number> {
	let depth = 0
	for (let i = 0; i < src.length;) {
		const n = past(src, i)
		if (n > i) {
			i = n
			continue
		}
		if ("([{".includes(src[i])) depth++
		else if (")]}".includes(src[i])) depth--
		else if (depth === 0) yield i
		i++
	}
}

const condition = (c: string) => c.trim() === "" ? ` ${TICK}()` : `${TICK}() && (${instrument(c)})`

// a for's head: three parts, or a for-of (its iterable through EACH), or a for-in (as it is)
function head(h: string): string {
	const semis = [...level(h)].filter((i) => h[i] === ";")
	if (semis.length === 2) {
		const [a, b] = semis
		const c = h.slice(a + 1, b)
		return `${instrument(h.slice(0, a))};${condition(c)};${instrument(h.slice(b + 1))}`
	}
	for (const i of level(h)) {
		if (!h.startsWith("of", i) || isWord(h[i - 1]) || isWord(h[i + 2])) continue
		// `const of of xs`: the first of is a name
		if (/(^|\W)(const|let|var)\s+$/.test(h.slice(0, i))) continue
		return `${instrument(h.slice(0, i + 2))} ${EACH}(${instrument(h.slice(i + 2).trim())})`
	}
	return instrument(h)
}

export function instrument(src: string): string {
	let out = "", from = 0
	for (let i = 0; i < src.length;) {
		const n = past(src, i)
		if (n > i) {
			i = n
			continue
		}
		if (!isWord(src[i])) {
			i++
			continue
		}
		let j = i
		while (isWord(src[j])) j++
		const name = src.slice(i, j)
		const loop = (name === "while" || name === "for") && src[back(src, i)] !== "."
		const k = ahead(src, j)
		if (loop && src[k] === "(") {
			const end = shut(src, k)
			const h = src.slice(k + 1, end)
			out += src.slice(from, k + 1) + (name === "while" ? condition(h) : head(h))
			from = end
			i = end
			continue
		}
		i = j
	}
	return out + src.slice(from)
}
