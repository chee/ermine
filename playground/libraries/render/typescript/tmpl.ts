// @ermine/render/tmpl: views as a tagged template, as developit's htm (and no dependency):
// html`<div class=${c}>${kid}</div>` makes what h("div", { class: c }, kid) makes. a template is
// parsed once, by its strings; each call builds views from that and its values. it adds nothing of
// its own to h: a function tag is whatever h makes of it
//   tags      <div>, or <${X}>: X handed to h as the tag, as it is. closed by </div>, </${X}> or
//             <//>, or by <x/>; html's void elements (h's VOID) close
//             themselves. a tag left open, or closed by another, throws
//   props     a="x", a='x' and a=x: strings. a=${v}: v as it is. a: true. ...${o}: o's props, in
//             order with the others (a later one wins). text mixed with ${} ("a ${b}") joins
//             strings and numbers; any other value there (a bind, a handler) throws
//   kids      text, tags and ${v} (any child, as it is). a text's whitespace run with a newline in
//             it is dropped at the start and end (as htm's), so a text of only that is dropped
//   text      <!-- comments --> are dropped. &#60; &#x3c; &amp; &lt; &gt; &quot; &apos; &nbsp; are
//             decoded in text and in props written out (a value is never), other &names; stay
//   roots     one: that view. several: an array. only text or a value: that
//   deno fmt  rewrites a template tagged html (or svg), whitespace and all: import it by another
//             name, or put // deno-fmt-ignore above
import { type Child, type Component, h, isBound, isHandler, isView, VOID } from "./h.ts"

const PREFIX = "@ermine/render/tmpl: "

// a template as parsed: a text, a value (its index), or a tag
type Shape = string | number | Tag
type Tag = {
	// its name, or the index of the value that is it
	readonly tag: string | number
	readonly props: Prop[]
	readonly kids: Shape[]
	// the index of the value closing it (</${X}>), when a value opens it: checked on each call
	close?: number
}
// ...${o}, or a name and its value: true (bare), a string, a value's index (as it is), or the
// text and values to join
type Prop =
	| { readonly spread: number }
	| {
		readonly name: string
		readonly value: true | string | number | readonly (string | number)[]
	}

// where the reader is: in text, a comment, a tag's name, a closing tag, between a tag's props,
// a prop's name, after it (to an =), after the = (to its value), and a value quoted or not
type Mode =
	| "text"
	| "comment"
	| "tag"
	| "close"
	| "attrs"
	| "name"
	| "equals"
	| "value"
	| "quoted"
	| "bare"

// a whitespace character: " " matches, "x" doesn't
const SPACE = /\s/
// a whitespace run with a newline in it, at the start or the end of a text: "\n  a b \n" matches
// its two ends, "a  b" nothing
const TRIM = /^\s*\n\s*|\s*\n\s*$/g
// a letter: "d" matches (a tag's name starts), " " doesn't (a < in text)
const LETTER = /[a-z]/i

// the last code point, and the surrogates (halves of one: no character alone)
const LAST_CODE_POINT = 0x10ffff
const FIRST_SURROGATE = 0xd800
const LAST_SURROGATE = 0xdfff
const COMMENT_OPEN = "!--"
const COMMENT_CLOSE = "-->"
const NAMED: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: "\u00a0",
}
// the references in a text, decoded in one pass ("&amp;lt;" is "&lt;"); one that is no character
// stays as written. a reference: "&#60;", "&#x3c;" and "&amp;" match, "&copy;" and "&amp" don't
const decode = (s: string) =>
	s.replace(
		/&(?:#(\d+)|#[xX]([\da-fA-F]+)|(amp|lt|gt|quot|apos|nbsp));/g,
		(written, dec?: string, hex?: string, name?: string) => {
			if (name !== undefined) return NAMED[name]
			const code = dec !== undefined ? parseInt(dec, 10) : parseInt(hex!, 16)
			const none = code > LAST_CODE_POINT || (code >= FIRST_SURROGATE && code <= LAST_SURROGATE)
			return none ? written : String.fromCodePoint(code)
		},
	)

// a value as a message says it
const named = (v: unknown) => typeof v === "function" ? v.name || "anonymous" : String(v)
const KINDS: readonly (readonly [is: (v: unknown) => boolean, kind: string])[] = [
	[isBound, "a bind"],
	[isHandler, "a handler"],
	[isView, "a view"],
	[(v) => v === null, "null"],
]
const kind = (v: unknown) => KINDS.find(([is]) => is(v))?.[1] ?? typeof v

function parse(strings: readonly string[], values: readonly unknown[]): Shape[] {
	const roots: Shape[] = []
	// the tags open, the innermost last, and where the next kid goes
	const open: Tag[] = []
	let kids = roots
	let mode: Mode = "text"
	// a text, a name, or the static part of a value, as read so far
	let buf = ""
	// the tag being opened; the value closing one; a prop's name, quote and parts so far
	let tag!: Tag
	let closer: number | undefined
	let name = ""
	let quote = ""
	let parts: (string | number)[] = []

	const nameOf = (t: string | number) => typeof t === "number" ? named(values[t]) : t

	const text = () => {
		const t = buf.replace(TRIM, "")
		if (t !== "") kids.push(decode(t))
		buf = ""
	}
	// the tag is read: put in its parent, and open unless it closed itself (/>) or is void
	const opened = (selfClosed: boolean) => {
		kids.push(tag)
		if (!selfClosed && !(typeof tag.tag === "string" && VOID.has(tag.tag))) {
			open.push(tag)
			kids = tag.kids
		}
		mode = "text"
	}
	// a closing tag is read: it must close the innermost open tag
	const closed = () => {
		const end = buf.trim()
		const written = closer === undefined ? end : nameOf(closer)
		const t = open.pop()
		if (t === undefined) throw new Error(`${PREFIX}</${written}> closes nothing`)
		// <//> closes whichever is open; </${X}> a tag a value opened (checked with the values on
		// each call); </div> a tag by that name
		const fits = end === "/" || (closer === undefined ? t.tag === end : typeof t.tag === "number")
		if (!fits) throw new Error(`${PREFIX}</${written}> does not close <${nameOf(t.tag)}>`)
		if (closer !== undefined) t.close = closer
		kids = open.at(-1)?.kids ?? roots
		buf = ""
		closer = undefined
		mode = "text"
	}
	// a prop's value is read: all text is a string, one value is that, else the parts to join
	const valued = (quoted: boolean) => {
		if (buf !== "") parts.push(decode(buf))
		if (parts.length === 0 && !quoted) {
			throw new Error(`${PREFIX}${name} in <${nameOf(tag.tag)}> has no value`)
		}
		tag.props.push({ name, value: parts.length > 1 ? parts : parts[0] ?? "" })
		buf = ""
		parts = []
		mode = "attrs"
	}
	// a value between two of the strings, by where the reader is
	const hole = (n: number) => {
		switch (mode) {
			case "text":
				text()
				kids.push(n)
				break
			case "tag":
				if (buf !== "") throw new Error(`${PREFIX}a value inside the tag name <${buf}>`)
				tag = { tag: n, props: [], kids: [] }
				mode = "attrs"
				break
			case "close":
				if (buf.trim() !== "" || closer !== undefined) {
					throw new Error(`${PREFIX}a value inside a closing tag's name`)
				}
				closer = n
				break
			case "name":
				if (buf !== "...") {
					throw new Error(
						`${PREFIX}a value inside the prop name ${buf} in <${nameOf(tag.tag)}>`,
					)
				}
				tag.props.push({ spread: n })
				buf = ""
				mode = "attrs"
				break
			case "value":
			case "quoted":
			case "bare":
				if (mode === "value") mode = "bare"
				if (buf !== "") parts.push(decode(buf))
				buf = ""
				parts.push(n)
				break
			case "comment":
				break
			default:
				throw new Error(
					`${PREFIX}a value in <${
						nameOf(tag.tag)
					}> is a prop's (a=\${v}) or a spread (...\${o})`,
				)
		}
	}

	for (let s = 0; s < strings.length; s++) {
		const str = strings[s]
		if (str === undefined) throw new Error(`${PREFIX}the template has an invalid escape`)
		let i = 0
		// a character is read as soon as it is looked at; i-- reads it again in the next mode
		while (i < str.length) {
			const c = str[i++]
			switch (mode) {
				case "text":
					if (c !== "<") {
						buf += c
						break
					}
					text()
					if (str.startsWith(COMMENT_OPEN, i)) {
						mode = "comment"
						i += COMMENT_OPEN.length
					} else if (str[i] === "/") {
						mode = "close"
						i++
					} else if (LETTER.test(str[i] ?? "") || (i === str.length && s < values.length)) {
						mode = "tag"
					} else throw new Error(`${PREFIX}a < that starts no tag (&lt; is the character)`)
					break
				case "comment": {
					const end = str.indexOf(COMMENT_CLOSE, --i)
					if (end < 0) i = str.length
					else {
						i = end + COMMENT_CLOSE.length
						mode = "text"
					}
					break
				}
				case "tag":
					if (c === ">" || c === "/" || SPACE.test(c)) {
						tag = { tag: buf, props: [], kids: [] }
						buf = ""
						mode = "attrs"
						i--
					} else buf += c
					break
				case "close":
					if (c === ">") closed()
					else if (closer !== undefined && !SPACE.test(c)) {
						throw new Error(`${PREFIX}${c} after </${nameOf(closer)}`)
					} else buf += c
					break
				case "attrs":
					if (SPACE.test(c)) break
					if (c === ">") opened(false)
					else if (c === "/" && str[i] === ">") {
						i++
						opened(true)
					} else if (c === "/" || c === "=" || c === '"' || c === "'") {
						throw new Error(`${PREFIX}${c} where a prop's name goes, in <${nameOf(tag.tag)}>`)
					} else {
						mode = "name"
						i--
					}
					break
				case "name":
					if (c === "=" || SPACE.test(c)) {
						name = buf
						buf = ""
						mode = c === "=" ? "value" : "equals"
					} else if (c === ">" || (c === "/" && str[i] === ">")) {
						tag.props.push({ name: buf, value: true })
						buf = ""
						mode = "attrs"
						i--
					} else buf += c
					break
				case "equals":
					if (c === "=") mode = "value"
					else if (!SPACE.test(c)) {
						tag.props.push({ name, value: true })
						mode = "attrs"
						i--
					}
					break
				case "value":
					if (SPACE.test(c)) break
					if (c === '"' || c === "'") {
						quote = c
						mode = "quoted"
					} else {
						mode = "bare"
						i--
					}
					break
				case "quoted":
					if (c === quote) valued(true)
					else buf += c
					break
				case "bare":
					if (c === ">" || SPACE.test(c) || (c === "/" && str[i] === ">")) {
						valued(false)
						i--
					} else buf += c
					break
			}
		}
		if (s < values.length) hole(s)
	}
	if (mode === "text") text()
	else if (mode === "comment") throw new Error(`${PREFIX}a comment is never closed`)
	else throw new Error(`${PREFIX}a tag is never finished (its >)`)
	if (open.length > 0) throw new Error(`${PREFIX}<${nameOf(open.at(-1)!.tag)}> is never closed`)
	return roots
}

// a prop's value from the values
function valueOf(
	name: string,
	value: Exclude<Prop, { spread: number }>["value"],
	values: readonly unknown[],
) {
	if (typeof value === "number") return values[value]
	if (!Array.isArray(value)) return value
	let joined = ""
	for (const part of value) {
		const v = typeof part === "number" ? values[part] : part
		if (typeof v !== "string" && typeof v !== "number") {
			throw new Error(
				`${PREFIX}${name}: a value mixed with text must be a string or a number, not ${
					kind(v)
				}`,
			)
		}
		joined += v
	}
	return joined
}

function build(shape: Shape, values: readonly unknown[]): Child {
	if (typeof shape === "string") return shape
	if (typeof shape === "number") return values[shape] as Child
	const tag = typeof shape.tag === "number" ? values[shape.tag] : shape.tag
	if (shape.close !== undefined && values[shape.close] !== tag) {
		throw new Error(`${PREFIX}</${named(values[shape.close])}> does not close <${named(tag)}>`)
	}
	const props: Record<string, unknown> = {}
	for (const prop of shape.props) {
		if ("spread" in prop) Object.assign(props, values[prop.spread])
		else props[prop.name] = valueOf(prop.name, prop.value, values)
	}
	return h(tag as string | Component, props, ...shape.kids.map((kid) => build(kid, values)))
}

const parsed = new WeakMap<readonly string[], Shape[]>()

export default function html(strings: TemplateStringsArray, ...values: unknown[]): Child {
	let roots = parsed.get(strings)
	if (roots === undefined) parsed.set(strings, roots = parse(strings, values))
	const made = roots.map((root) => build(root, values))
	return made.length === 1 ? made[0] : made
}
