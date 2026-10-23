// CBOR's diagnostic notation (RFC 8949, Section 8), for .text files
// (FILES.tex, Other values are CBOR's diagnostic notation).
//
// write: two-space indentation, a map's keys in code point order, bytes as
// h'...', a typed array as its tag on its bytes, 85(h'0000803f'), a
// stand-in as its tag on its kind, 305419896("clock"), a whole number as an
// integer, its exact digits (1, -1, 0, 9007199254740992), and any other number
// as the shortest decimal that reads back as it, with a point or an exponent
// (1.5, 1e-7), or NaN, Infinity, -Infinity. No final newline.
//
// read: any spacing, comments as RFC 8610 Appendix G writes them, any key
// order, indefinite lengths, bytes as h'', b64'' or '', an integer as its
// exact value (a bigint past 2^53 - 1, however big), and a decimal with a
// point or an exponent as the nearest number, a bigint when that is whole and
// past 2^53 - 1 (whole numbers are integers). It refuses a tag other than a
// typed array's or a stand-in's (64 among them: no uint8 kind, bytes are
// that), undefined, other simple values, a key that is not text, and a key
// twice.
//
// Reading also takes what RFC 8949 and RFC 8610 allow beside these: integers
// in 0x, 0o and 0b, encoding indicators (_0 to _3), ''_ and ""_, \u{...}, a
// last comma, and spacing and comments inside h''. Zero has no sign, so -0
// and -0.0 are 0. A typed array's NaN elements read as the one NaN.

import { CborError, decode, encode, Stand, type Value } from "@ermine/encoding/cbor"

/** A stand-in's tag (ENCODING.tex). */
const STAND = 0x12345678

/** Text that is not diagnostic notation of a value; at is the offset, line and column from 1. */
export class DiagError extends Error {
	override name = "DiagError"
	constructor(
		message: string,
		readonly at: number,
		readonly line: number,
		readonly column: number,
	) {
		super(message)
	}
}

// writing --------------------------------------------------------------------

/** A value as diagnostic notation, for people. */
export function write(value: Value): string {
	encode(value) // what has no encoding throws, as there
	return show(value, "")
}

function show(x: Value, indent: string): string {
	if (x === null || typeof x === "boolean") return String(x)
	if (typeof x === "number") return decimal(x)
	if (typeof x === "bigint") return String(x)
	if (typeof x === "string") return quote(x)
	if (x instanceof Uint8Array) return hex(x)
	if (x instanceof Stand) return `${STAND}(${show(x.kind, indent)})`
	if (ArrayBuffer.isView(x)) {
		// its encoding is d8, the tag, then its elements as bytes
		const b = encode(x)
		return `${b[1]}(${hex(decode(b.subarray(2)) as Uint8Array)})`
	}
	const inner = indent + "  "
	if (Array.isArray(x)) {
		if (x.length === 0) return "[]"
		return `[\n${x.map((v) => inner + show(v, inner)).join(",\n")}\n${indent}]`
	}
	const map = x as { readonly [key: string]: Value }
	const keys = Object.keys(map).sort(order)
	if (keys.length === 0) return "{}"
	const lines = keys.map((k) => `${inner}${quote(k)}: ${show(map[k], inner)}`)
	return `{\n${lines.join(",\n")}\n${indent}}`
}

/** A whole number's exact digits (zero has no sign); else the shortest decimal that reads back as x. */
function decimal(x: number): string {
	if (Number.isInteger(x)) return String(BigInt(x))
	return String(x) // NaN, Infinity, -Infinity, or the fewest digits, with a point or an exponent
}

const ESCAPE = new Map([
	['"', '\\"'],
	["\\", "\\\\"],
	["\b", "\\b"],
	["\f", "\\f"],
	["\n", "\\n"],
	["\r", "\\r"],
	["\t", "\\t"],
])

function quote(s: string): string {
	let out = '"'
	for (const c of s) {
		const n = c.charCodeAt(0)
		out += ESCAPE.get(c) ??
			(n < 0x20 || n === 0x7f ? "\\u" + n.toString(16).padStart(4, "0") : c)
	}
	return out + '"'
}

const hex = (b: Uint8Array) => `h'${b.toHex()}'`

/** Code point order: UTF-16's, but with surrogates after U+E000 to U+FFFF. */
function order(a: string, b: string): number {
	const n = Math.min(a.length, b.length)
	for (let i = 0; i < n; i++) {
		const x = a.charCodeAt(i),
			y = b.charCodeAt(i)
		if (x !== y) return point(x) - point(y)
	}
	return a.length - b.length
}

const point = (u: number) => u >= 0xe000 ? u - 0x800 : u >= 0xd800 ? u + 0x2000 : u

// reading --------------------------------------------------------------------

/** The value diagnostic notation gives; throws DiagError, with its position, for anything else. */
export function read(text: string): Value {
	const r = new Reader(text)
	try {
		r.space()
		const x = r.value()
		r.space()
		if (r.at < text.length) r.fail("more after the value")
		return x
	} catch (e) {
		if (e instanceof RangeError) r.fail("a value nested too deep") // the stack ran out
		throw e
	}
}

// typed arrays' tags (RFC 8746); never 64: no uint8 kind
const TAGS = new Set([69, 70, 71, 72, 77, 78, 79, 85, 86])
const NUMBER = /-?(?:0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/y
const WORD = /[A-Za-z][A-Za-z0-9]*/y
const WORDS = new Map<string, Value>([
	["false", false],
	["true", true],
	["null", null],
	["NaN", NaN],
	["Infinity", Infinity],
])
const UNESCAPE = new Map([
	['"', '"'],
	["'", "'"],
	["\\", "\\"],
	["/", "/"],
	["b", "\b"],
	["f", "\f"],
	["n", "\n"],
	["r", "\r"],
	["t", "\t"],
])
const RUN = { '"': /[^"\\]+/y, "'": /[^'\\]+/y }
const utf8 = new TextEncoder()

class Reader {
	at = 0
	constructor(readonly text: string) {}

	fail(why: string, at = this.at): never {
		const before = this.text.slice(0, at)
		const line = before.split("\n").length
		const column = at - before.lastIndexOf("\n")
		throw new DiagError(
			`${why}, at line ${line}, column ${column}`,
			at,
			line,
			column,
		)
	}

	/** What is at the reader, for a message. */
	here(): string {
		return this.at < this.text.length ? quote(this.text[this.at]) : "the end"
	}

	/** Skips spacing and comments, / to /. */
	space() {
		const t = this.text
		while (this.at < t.length) {
			const c = t[this.at]
			if (c === " " || c === "\t" || c === "\n" || c === "\r") this.at++
			else if (c === "/") {
				const end = t.indexOf("/", this.at + 1)
				if (end < 0) this.fail("a comment with no end")
				this.at = end + 1
			} else break
		}
	}

	/** Skips an encoding indicator, _0 to _3, or _ alone where open allows it. */
	indicator(open: boolean) {
		const t = this.text
		if (t[this.at] !== "_") return
		if (/[0-3]/.test(t[this.at + 1] ?? "")) this.at += 2
		else if (open) this.at++
		else this.fail("an encoding indicator that is not _0 to _3")
	}

	/** Items up to close, separated by commas, a last comma allowed. */
	items(close: string, item: () => void) {
		const t = this.text
		this.space()
		while (t[this.at] !== close) {
			item()
			this.space()
			if (t[this.at] === ",") {
				this.at++
				this.space()
			} else if (t[this.at] !== close) {
				this.fail(`${this.here()} where , or ${close} should be`)
			}
		}
		this.at++
	}

	value(): Value {
		const t = this.text,
			start = this.at,
			c = t[start]
		if (start >= t.length) this.fail("the end where a value should be")
		if (c === "[") return this.list()
		if (c === "{") return this.map()
		if (c === "(") return this.chunks()
		if (c === '"') {
			const s = this.string('"')
			this.indicator(s === "")
			return s
		}
		if (c === "'") {
			const b = utf8.encode(this.string("'"))
			this.indicator(b.length === 0)
			return b
		}
		if (c === "-" && t.startsWith("-Infinity", start)) {
			this.at += "-Infinity".length
			this.indicator(false)
			return -Infinity
		}
		if (c === "-" || (c >= "0" && c <= "9")) return this.number()
		if (/[A-Za-z]/.test(c)) return this.word()
		this.fail(`${this.here()} where a value should be`)
	}

	list(): Value {
		this.at++
		this.indicator(true) // [_ is an indefinite length
		const items: Value[] = []
		this.items("]", () => items.push(this.value()))
		return items
	}

	map(): Value {
		this.at++
		this.indicator(true)
		const entries = new Map<string, Value>()
		this.items("}", () => {
			const at = this.at
			const key = this.value()
			if (typeof key !== "string") this.fail("a key that is not text", at)
			if (entries.has(key)) this.fail(`the key ${quote(key)} twice`, at)
			this.space()
			if (this.text[this.at] !== ":") {
				this.fail(`${this.here()} where : should be`)
			}
			this.at++
			this.space()
			entries.set(key, this.value())
		})
		return Object.fromEntries(entries) // so "__proto__" is a key like any
	}

	/** An indefinite-length string, (_ chunk, ...), all text or all bytes. */
	chunks(): Value {
		const t = this.text,
			start = this.at
		this.at++
		if (t[this.at] !== "_") this.fail("a ( that does not start (_", start)
		this.at++
		const parts: (string | Uint8Array)[] = []
		this.items(")", () => {
			const at = this.at
			if (t[at] === "(") this.fail("chunks inside chunks", at)
			const part = this.value()
			if (typeof part !== "string" && !(part instanceof Uint8Array)) {
				this.fail("a chunk that is not text or bytes", at)
			}
			if (parts.length > 0 && typeof part !== typeof parts[0]) {
				this.fail("text and bytes chunks together", at)
			}
			parts.push(part)
		})
		if (parts.length === 0) {
			this.fail(`(_ ) with no chunks; write ""_ or ''_`, start)
		}
		if (typeof parts[0] === "string") return parts.join("")
		const all = new Uint8Array(
			parts.reduce((n, p) => n + (p as Uint8Array).length, 0),
		)
		let n = 0
		for (const p of parts as Uint8Array[]) {
			all.set(p, n)
			n += p.length
		}
		return all
	}

	/** A quoted string, q its quote, with JSON's escapes, \' and \u{...}. */
	string(q: '"' | "'"): string {
		const t = this.text,
			start = this.at,
			run = RUN[q]
		let out = ""
		this.at++
		for (;;) {
			run.lastIndex = this.at
			if (run.test(t)) {
				out += t.slice(this.at, run.lastIndex)
				this.at = run.lastIndex
			}
			if (this.at >= t.length) this.fail("a string with no end", start)
			if (t[this.at] === q) break
			out += this.escape()
		}
		this.at++
		if (!out.isWellFormed()) {
			this.fail("a string with a lone surrogate, which is no value", start)
		}
		return out
	}

	escape(): string {
		const t = this.text,
			at = this.at,
			e = t[at + 1]
		const plain = UNESCAPE.get(e)
		if (plain !== undefined) {
			this.at += 2
			return plain
		}
		if (e === "u") {
			const m = /\{([0-9a-fA-F]{1,6})\}|[0-9a-fA-F]{4}/y
			m.lastIndex = at + 2
			const found = m.exec(t)
			const n = found ? parseInt(found[1] ?? found[0], 16) : -1
			if (found && n <= 0x10ffff) {
				this.at = m.lastIndex
				return String.fromCodePoint(n)
			}
		}
		this.fail(`the escape ${t.slice(at, at + 2)}, which means nothing here`, at)
	}

	number(): Value {
		const t = this.text,
			start = this.at
		NUMBER.lastIndex = start
		const found = NUMBER.exec(t)
		if (!found) this.fail("a - with no number after it")
		this.at = NUMBER.lastIndex
		const s = found[0],
			negative = s[0] === "-",
			body = negative ? s.slice(1) : s
		if (!/^0[xob]/i.test(body) && /[.e]/i.test(body)) {
			this.indicator(false)
			return exact(Number(s)) // the nearest, as JavaScript reads a decimal
		}
		const n = BigInt(body)
		this.indicator(false)
		if (!negative) {
			const after = this.at
			this.space()
			if (t[this.at] === "(") return this.tag(n, start)
			this.at = after
		}
		return exact(negative ? -n : n)
	}

	/** A tag: a typed array's over bytes, or a stand-in's over its kind. */
	tag(n: bigint, start: number): Value {
		const tag = Number(n)
		if (!TAGS.has(tag) && tag !== STAND) {
			this.fail(`the tag ${n}, which is not a typed array's or a stand-in's`, start)
		}
		this.at++
		this.space()
		const at = this.at
		const bytes = this.value()
		this.space()
		if (this.text[this.at] !== ")") {
			this.fail(`${this.here()} where ) should be`)
		}
		this.at++
		if (tag === STAND) return new Stand(bytes)
		if (!(bytes instanceof Uint8Array)) {
			this.fail("a typed array's tag over what is not bytes", at)
		}
		return (
			typed(tag, bytes) ??
				this.fail("a typed array's bytes that are not whole elements", start)
		)
	}

	word(): Value {
		const t = this.text,
			start = this.at
		WORD.lastIndex = start
		const w = WORD.exec(t)![0]
		this.at = WORD.lastIndex
		if (t[this.at] === "'") {
			if (w !== "h" && w !== "b64") {
				this.fail(`bytes as ${w}'', not h'', b64'' or ''`, start)
			}
			const b = w === "h" ? this.hex(start) : this.base64(start)
			this.indicator(b.length === 0)
			return b
		}
		if (WORDS.has(w)) {
			const x = WORDS.get(w)!
			if (typeof x === "number") this.indicator(false)
			return x
		}
		if (w === "undefined") this.fail("undefined, which is no value", start)
		if (w === "simple") {
			this.fail("a simple value other than false, true and null", start)
		}
		this.fail(`${quote(w)}, which is no value`, start)
	}

	/** h'...', spacing and comments allowed among its digits. */
	hex(start: number): Uint8Array {
		const t = this.text
		let digits = ""
		this.at++
		for (;;) {
			this.space()
			if (this.at >= t.length) this.fail("bytes with no end", start)
			const c = t[this.at]
			if (c === "'") break
			if (!/[0-9a-fA-F]/.test(c)) this.fail(`${quote(c)} in hex bytes`)
			digits += c
			this.at++
		}
		this.at++
		if (digits.length % 2) {
			this.fail("hex bytes with an odd number of digits", start)
		}
		return Uint8Array.fromHex(digits)
	}

	/** b64'...', base64 or base64url, padded or not, spacing allowed. */
	base64(start: number): Uint8Array {
		const t = this.text
		let digits = ""
		this.at++
		for (;;) {
			if (this.at >= t.length) this.fail("bytes with no end", start)
			const c = t[this.at]
			if (c === "'") break
			if (!/[\sA-Za-z0-9+/=_-]/.test(c)) {
				this.fail(`${quote(c)} in base64 bytes`)
			}
			if (!/\s/.test(c)) digits += c
			this.at++
		}
		this.at++
		try {
			return Uint8Array.fromBase64(
				digits.replaceAll("-", "+").replaceAll("_", "/"),
			)
		} catch {
			this.fail("base64 bytes that do not decode", start)
		}
	}
}

/** A whole number as a number while it is safe, a bigint past that, and -0 as 0; any other as it is. */
function exact(n: number | bigint): number | bigint {
	if (typeof n === "number" && !Number.isInteger(n)) return n // a fraction, NaN, an infinity
	const b = BigInt(n)
	return b >= -SAFE && b <= SAFE ? Number(b) : b
}

const SAFE = BigInt(Number.MAX_SAFE_INTEGER)

/** A typed array from its tag and its bytes, each NaN the one NaN; undefined if not whole elements. */
function typed(tag: number, bytes: Uint8Array): Value | undefined {
	if (tag === 85 || tag === 86) {
		const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
			size = tag === 85 ? 4 : 8
		for (let i = 0; i + size <= bytes.length; i += size) {
			if (
				!Number.isNaN(
					size === 4 ? v.getFloat32(i, true) : v.getFloat64(i, true),
				)
			) {
				continue
			}
			if (size === 4) v.setUint32(i, 0x7fc00000, true)
			else v.setBigUint64(i, 0x7ff8000000000000n, true)
		}
	}
	const head = encode(bytes),
		b = new Uint8Array(head.length + 2)
	b.set([0xd8, tag])
	b.set(head, 2)
	try {
		return decode(b)
	} catch (e) {
		if (e instanceof CborError) return undefined
		throw e
	}
}
