// JSON read as the harness protocol has it (conformance/run.ts), for the side that asks: a map's
// keys in the order they came, every key; lone surrogates (\udxxx) and NUL in strings and keys;
// -0; whole numbers exactly: digits alone (no fraction, no exponent) past 2^53 - 1 are a bigint,
// the rest doubles. JSON.parse keeps all of that but whole numbers past 2^53 and key
// order: a JS object lists array-index keys ("0", "2", "4294967294"; not "01", "-1", "4294967295")
// first, ascending, then the rest as they came.
//
// a map whose keys JS would list out of order is a Proxy of a plain object that lists them in
// order (Object.keys, Object.entries, JSON.stringify, line and spread all see it); any other map is
// a plain object. a key put in it goes last, one taken out leaves the order. read by key as ever:
// models index it as any map. a copy made by entries (Object.fromEntries, structuredClone) is a
// plain object again, in JS order: ordered makes one that keeps it
//
// requests written with JSON.stringify (form.ts line) go out in the map's order

const isIndex = (k: string) => /^(?:0|[1-9][0-9]{0,9})$/.test(k) && Number(k) < 2 ** 32 - 1

// a map of these entries in this order ("__proto__" a key like any). the last of a key twice
// wins, at the first one's place, as JSON.parse has it
export function ordered(
	entries: Iterable<readonly [string, unknown]>,
): Record<string, unknown> {
	const o: Record<string, unknown> = {}
	const keys: string[] = []
	// JS's order is this one while every index comes before the rest, ascending
	let jumps = false, other = false, top = -1
	for (const [k, v] of entries) {
		if (!Object.hasOwn(o, k)) {
			if (!isIndex(k)) other = true
			else if (other || Number(k) < top) jumps = true
			else top = Number(k)
			keys.push(k)
		}
		Object.defineProperty(o, k, {
			value: v,
			enumerable: true,
			writable: true,
			configurable: true,
		})
	}
	if (!jumps) return o
	return new Proxy(o, {
		ownKeys: (t) => [...keys, ...Object.getOwnPropertySymbols(t)],
		defineProperty(t, k, d) {
			const fresh = typeof k === "string" && !Object.hasOwn(t, k)
			const ok = Reflect.defineProperty(t, k, d)
			if (ok && fresh) keys.push(k as string)
			return ok
		},
		deleteProperty(t, k) {
			const ok = Reflect.deleteProperty(t, k)
			const i = typeof k === "string" ? keys.indexOf(k) : -1
			if (ok && i >= 0) keys.splice(i, 1)
			return ok
		},
	})
}

// digits alone past 2^53 - 1: a bigint, exactly (JSON.parse would round them)
const long = /[0-9]{16}/
const exact = (_: string, v: unknown, context?: { source?: string }) =>
	typeof v === "number" && Number.isInteger(v) && !Number.isSafeInteger(v) &&
		context?.source !== undefined && /^-?[0-9]+$/.test(context.source)
		? BigInt(context.source)
		: v
// JSON.parse, whole numbers exact
export function parse(text: string): unknown {
	return long.test(text) ? JSON.parse(text, exact as never) : JSON.parse(text)
}

// a line that may have a key JS would list out of order: a string token that begins with a digit,
// or its escape. the rest are read by JSON.parse, which keeps them as they are
const risky = /"(?:[0-9]|\\u003[0-9])/

// the JSON value of text; a SyntaxError if it is none
export function read(text: string): unknown {
	if (!risky.test(text)) return parse(text)
	let i = 0
	const fail = (): never => {
		throw new SyntaxError(`not JSON at ${i}: ${text.slice(i, i + 20)}`)
	}
	const space = () => {
		while (i < text.length && " \t\n\r".includes(text[i])) i++
	}
	const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y
	const string = (): string => {
		const from = i++
		let plain = true
		while (i < text.length && text[i] !== '"') {
			const c = text.charCodeAt(i)
			if (c === 92) plain = false, i += 2
			else if (c < 32) plain = false, i++
			else i++
		}
		if (i >= text.length) fail()
		i++
		return plain ? text.slice(from + 1, i - 1) : JSON.parse(text.slice(from, i))
	}
	const value = (): unknown => {
		space()
		const c = text[i]
		if (c === "{") {
			i++
			const entries: [string, unknown][] = []
			space()
			if (text[i] === "}") return i++, {}
			for (;;) {
				space()
				if (text[i] !== '"') fail()
				const k = string()
				space()
				if (text[i++] !== ":") fail()
				entries.push([k, value()])
				space()
				if (text[i] === ",") i++
				else if (text[i] === "}") return i++, ordered(entries)
				else fail()
			}
		}
		if (c === "[") {
			i++
			const out: unknown[] = []
			space()
			if (text[i] === "]") return i++, out
			for (;;) {
				out.push(value())
				space()
				if (text[i] === ",") i++
				else if (text[i] === "]") return i++, out
				else fail()
			}
		}
		if (c === '"') return string()
		for (const [word, v] of [["true", true], ["false", false], ["null", null]] as const) {
			if (text.startsWith(word, i)) return i += word.length, v
		}
		number.lastIndex = i
		const m = number.exec(text)
		if (!m) fail()
		i += m![0].length
		const n = Number(m![0])
		// digits alone past 2^53 - 1: exact, however long (Number gives Infinity at 309 digits)
		return !Number.isSafeInteger(n) && /^-?[0-9]+$/.test(m![0]) ? BigInt(m![0]) : n
	}
	const out = value()
	space()
	if (i !== text.length) fail()
	return out
}
