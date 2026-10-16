import { assert, assertEquals, assertThrows } from "@std/assert"
import { CborError, encode, type Value } from "@ermine/encoding/cbor"
import * as diag from "./diag.ts"
import { DiagError } from "./diag.ts"

/** Equal as the graph has it: the same deterministic CBOR. */
function same(a: Value, b: Value) {
	assertEquals(encode(a), encode(b))
}

const bytes = (...xs: number[]) => new Uint8Array(xs)

/** The error reading text gives. */
function refused(text: string): DiagError {
	return assertThrows(() => diag.read(text), DiagError)
}

Deno.test("write: null, booleans and numbers", () => {
	const cases: [Value, string][] = [
		[null, "null"],
		[true, "true"],
		[false, "false"],
		[0, "0.0"],
		[-0, "-0.0"],
		[1, "1.0"],
		[-2, "-2.0"],
		[100, "100.0"],
		[1.5, "1.5"],
		[0.1, "0.1"],
		[1e21, "1e+21"],
		[1e-7, "1e-7"],
		[5e-324, "5e-324"],
		[Number.MAX_VALUE, "1.7976931348623157e+308"],
		[NaN, "NaN"],
		[Infinity, "Infinity"],
		[-Infinity, "-Infinity"],
	]
	for (const [x, text] of cases) {
		assertEquals(diag.write(x), text)
		same(diag.read(text), x)
	}
})

Deno.test("write: strings with escapes", () => {
	const s = 'a"b\\c\nd\te\r\b\f\u0001\u007f café 😀  '
	const text = diag.write(s)
	assertEquals(text, '"a\\"b\\\\c\\nd\\te\\r\\b\\f\\u0001\\u007f café 😀  "')
	assertEquals(diag.read(text), s)
	assertEquals(diag.write(""), '""')
})

Deno.test("write: bytes as h'...'", () => {
	assertEquals(diag.write(bytes(0, 0xff, 0x10)), "h'00ff10'")
	assertEquals(diag.write(new Uint8Array(0)), "h''")
	assertEquals(diag.write(bytes(9, 0, 0xff, 0x10, 9).subarray(1, 4)), "h'00ff10'")
	const b = diag.read("h'00ff10'")
	assert(b instanceof Uint8Array)
	same(b, bytes(0, 0xff, 0x10))
})

Deno.test("write: each typed array as its RFC 8746 tag on its bytes", () => {
	const cases: [Value, string][] = [
		[new Uint16Array([1, 0x1234]), "69(h'01003412')"],
		[new Uint32Array([1]), "70(h'01000000')"],
		[new BigUint64Array([1n]), "71(h'0100000000000000')"],
		[new Int8Array([-1, 2]), "72(h'ff02')"],
		[new Int16Array([-2]), "77(h'feff')"],
		[new Int32Array([-1]), "78(h'ffffffff')"],
		[new BigInt64Array([-1n]), "79(h'ffffffffffffffff')"],
		[new Float32Array([1]), "85(h'0000803f')"],
		[new Float64Array([1]), "86(h'000000000000f03f')"],
		[new Float32Array([NaN, -0]), "85(h'0000c07f00000080')"],
		[new Float64Array([]), "86(h'')"],
	]
	for (const [x, text] of cases) {
		assertEquals(diag.write(x), text)
		const back = diag.read(text)
		assertEquals((back as object).constructor, (x as object).constructor)
		same(back, x)
	}
	// a view into a larger buffer is its own elements
	assertEquals(
		diag.write(new Uint16Array([7, 8, 9]).subarray(1, 2)),
		"69(h'0800')",
	)
})

Deno.test("write: lists and maps, two spaces, keys in code point order", () => {
	const x = { b: [1, { a: null }, []], a: {}, "": "empty" }
	const text = diag.write(x)
	assertEquals(
		text,
		`{
  "": "empty",
  "a": {},
  "b": [
    1.0,
    {
      "a": null
    },
    []
  ]
}`,
	)
	same(diag.read(text), x)
	assertEquals(diag.write([]), "[]")
	assertEquals(diag.write({}), "{}")
	// UTF-16 order would put the emoji, a surrogate pair, before U+FF5E
	const order = { "😀": 1, "～": 2, b: 3, B: 4 }
	assertEquals(
		diag.write(order),
		`{\n  "B": 4.0,\n  "b": 3.0,\n  "～": 2.0,\n  "😀": 1.0\n}`,
	)
})

Deno.test("write: a key named __proto__ is a key like any", () => {
	const x = diag.read('{"__proto__": 1, "a": 2}')
	assert(Object.hasOwn(x as object, "__proto__"))
	assertEquals(Object.getPrototypeOf(x), Object.prototype)
	assertEquals(diag.write(x), `{\n  "__proto__": 1.0,\n  "a": 2.0\n}`)
})

Deno.test("write: what has no encoding throws as encode does", () => {
	assertThrows(() => diag.write("\ud800"), CborError)
	assertThrows(() => diag.write(new Date() as unknown as Value), CborError)
	const loop: Value[] = []
	;(loop as Value[]).push(loop)
	assertThrows(() => diag.write(loop), CborError)
})

// a seeded random value of every kind
function random(seed: number) {
	let s = seed >>> 0 || 1
	const next = () => {
		s ^= s << 13
		s ^= s >>> 17
		s ^= s << 5
		return (s >>> 0) / 2 ** 32
	}
	const int = (n: number) => Math.floor(next() * n)
	const view = new DataView(new ArrayBuffer(8))
	const number = (): number => {
		switch (int(6)) {
			case 0:
				return [0, -0, NaN, Infinity, -Infinity, 1, -1, 0.5][int(8)]
			case 1:
				return int(2000) - 1000
			case 2:
				return Math.fround((next() - 0.5) * 2 ** int(40))
			default:
				view.setUint32(0, int(2 ** 32))
				view.setUint32(4, int(2 ** 32))
				return view.getFloat64(0)
		}
	}
	const text = () => {
		const chars = [
			"a",
			"Z",
			" ",
			'"',
			"\\",
			"\n",
			"\t",
			"\u0000",
			"/",
			"'",
			"é",
			"😀",
			"￿",
		]
		return Array.from({ length: int(6) }, () => chars[int(chars.length)]).join("")
	}
	const kinds = [
		Uint16Array,
		Uint32Array,
		Int8Array,
		Int16Array,
		Int32Array,
		Float32Array,
		Float64Array,
	]
	const value = (depth: number): Value => {
		switch (int(depth > 3 ? 7 : 9)) {
			case 0:
				return null
			case 1:
				return next() < 0.5
			case 2:
			case 3:
				return number()
			case 4:
				return text()
			case 5:
				return new Uint8Array(Array.from({ length: int(5) }, () => int(256)))
			case 6: {
				const n = int(4)
				const r = int(10)
				if (r === 0) {
					return new BigInt64Array(
						Array.from({ length: n }, () => BigInt(int(1e9))),
					)
				}
				if (r === 1) {
					return new BigUint64Array(
						Array.from({ length: n }, () => BigInt(int(1e9))),
					)
				}
				const make = kinds[int(kinds.length)]
				return new make(Array.from({ length: n }, () => number()))
			}
			case 7:
				return Array.from({ length: int(4) }, () => value(depth + 1))
			default:
				return Object.fromEntries(
					Array.from({ length: int(4) }, () => [text(), value(depth + 1)]),
				)
		}
	}
	return value(0)
}

Deno.test("write then read gives the value back, for 40 seeds", () => {
	for (let seed = 1; seed <= 40; seed++) {
		const x = random(seed)
		const text = diag.write(x)
		same(diag.read(text), x)
		assertEquals(diag.write(diag.read(text)), text)
	}
})

Deno.test("read: any spacing", () => {
	const x = { a: [1, 2], b: "c" }
	same(diag.read('{"a":[1.0,2.0],"b":"c"}'), x)
	same(diag.read(' \n\t{ "a" :\r\n [ 1.0 ,\n\n 2.0 ] , "b"\t: "c" }\n\n'), x)
})

Deno.test("read: comments between / and /", () => {
	same(
		diag.read(
			'/ a clock / {/ hour / "h": 12.0, "m": / minutes / 30.0} / done /',
		),
		{ h: 12, m: 30 },
	)
	same(diag.read("h'48 65 /He/ 6c6c\n6f /llo/'"), utf8("Hello"))
})

Deno.test("read: any key order", () => {
	same(diag.read('{"b": 1.0, "a": 2.0}'), { a: 2, b: 1 })
	same(diag.read('{"b": 1.0, "a": 2.0}'), diag.read('{"a": 2.0, "b": 1.0}'))
})

Deno.test("read: indefinite lengths", () => {
	same(diag.read("[_ 1.0, [2.0, 3.0], [_ 4.0, 5.0]]"), [1, [2, 3], [4, 5]])
	same(diag.read('{_ "a": 1.0, "b": [_ ]}'), { a: 1, b: [] })
	same(diag.read("(_ h'0102', h'03', '')"), bytes(1, 2, 3))
	same(diag.read('(_ "strea", "ming")'), "streaming")
	same(diag.read('""_'), "")
	same(diag.read("''_"), new Uint8Array(0))
	same(diag.read("85((_ h'0000', h'803f'))"), new Float32Array([1]))
})

Deno.test("read: bytes as h'', b64'' and ''", () => {
	same(diag.read("h'48656C6c6f'"), utf8("Hello"))
	same(diag.read("b64'SGVsbG8='"), utf8("Hello"))
	same(diag.read("b64'SGVsbG8'"), utf8("Hello"))
	same(diag.read("b64'+/+/'"), bytes(0xfb, 0xff, 0xbf))
	same(diag.read("b64'-_-_'"), bytes(0xfb, 0xff, 0xbf))
	same(diag.read("b64'SGVs\n bG8='"), utf8("Hello"))
	same(diag.read("'Hello'"), utf8("Hello"))
	same(diag.read("'it\\'s'"), utf8("it's"))
	same(diag.read("'café'"), utf8("café"))
	same(diag.read("85(b64'AACAPw==')"), new Float32Array([1]))
	assert(diag.read("''") instanceof Uint8Array)
})

Deno.test("read: integers and decimals as the nearest number", () => {
	const cases: [string, number][] = [
		["1", 1],
		["-5", -5],
		["0", 0],
		["-0", 0],
		["-0.0", -0],
		["0x1f", 31],
		["0X1F", 31],
		["-0x10", -16],
		["0o17", 15],
		["0b101", 5],
		["18446744073709551615", 18446744073709551615],
		["-18446744073709551617", -18446744073709551616],
		["9007199254740993", 9007199254740992],
		["1e3", 1000],
		["1.5E-3", 0.0015],
		["0.1", 0.1],
		["1e400", Infinity],
		["1.5_1", 1.5],
		["10_0", 10],
	]
	for (const [text, x] of cases) same(diag.read(text), x)
})

Deno.test("read: strings with escapes", () => {
	assertEquals(
		diag.read('"a\\"b\\\\c\\/d\\n\\t\\r\\b\\f"'),
		'a"b\\c/d\n\t\r\b\f',
	)
	assertEquals(diag.read('"\\u00e9\\ud83d\\ude00\\u{1F600}"'), "é😀😀")
	assertEquals(diag.read('"raw\nline"'), "raw\nline")
})

Deno.test("read: a last comma", () => {
	same(diag.read("[1.0, 2.0,]"), [1, 2])
	same(diag.read('{"a": 1.0,}'), { a: 1 })
})

Deno.test("read: a typed array's NaN elements are the one NaN", () => {
	// a signalling NaN and a negative NaN
	const x = diag.read("85(h'0100807f0000c0ff')")
	assertEquals(encode(x), encode(new Float32Array([NaN, NaN])))
	const y = diag.read("86(h'0100000000f0ff7f')")
	assertEquals(encode(y), encode(new Float64Array([NaN])))
})

Deno.test("read: refuses other tags, with where", () => {
	const e = refused('[1.0, 0("2013-03-21")]')
	assertEquals([e.at, e.line, e.column], [6, 1, 7])
	assert(e.message.includes("tag 0"))
	assertEquals(refused("1(1.0)").at, 0)
	assertEquals(refused("87(h'')").at, 0) // float128, which the graph has not
	assertEquals(refused("65(h'0001')").at, 0) // big-endian uint16
	assertEquals(refused("[64(h'01ff')]").at, 1) // uint8: no such kind, bytes are that
})

Deno.test("read: refuses undefined, with where", () => {
	const e = refused('{"a": undefined}')
	assertEquals([e.at, e.line, e.column], [6, 1, 7])
	assert(e.message.includes("undefined"))
	const f = refused("[\n  1.0,\n  undefined\n]")
	assertEquals([f.at, f.line, f.column], [11, 3, 3])
	assert(f.message.endsWith("at line 3, column 3"))
})

Deno.test("read: refuses other simple values, with where", () => {
	const e = refused("[simple(16)]")
	assertEquals([e.at, e.line, e.column], [1, 1, 2])
	assertEquals(refused("simple(20)").at, 0)
})

Deno.test("read: refuses a key that is not text, with where", () => {
	for (
		const text of [
			'{"a": 1.0, 1.0: 2.0}',
			"{\"a\": 1.0, h'00': 2.0}",
			'{"a": 1.0, [1.0]: 2}',
		]
	) {
		const e = refused(text)
		assertEquals([e.at, e.column], [11, 12])
		assert(e.message.includes("not text"))
	}
	assertEquals(refused("{null: 1.0}").at, 1)
})

Deno.test("read: refuses a key twice, with where", () => {
	const e = refused('{\n  "a": 1.0,\n  "b": 2.0,\n  "a": 3.0\n}')
	assertEquals([e.line, e.column], [4, 3])
	assert(e.message.includes('"a" twice'))
	// the same key however written
	assertEquals(refused('{"é": 1.0, "\\u00e9": 2.0}').at, 11)
	assertEquals(refused('{"ab": 1.0, (_ "a", "b"): 2.0}').at, 12)
})

Deno.test("read: refuses what is not notation, with where", () => {
	const cases: [string, number][] = [
		["", 0],
		["   ", 3],
		["1.0 2.0", 4],
		["[1.0 2.0]", 5],
		["[1.0,", 5],
		['{"a" 1.0}', 5],
		['"abc', 0],
		["/ open", 0],
		["'abc", 0],
		["h'abc'", 0],
		["h'0g'", 3],
		["h'00", 0],
		["b64'a'", 0],
		["b64'a!'", 5],
		["x'00'", 0],
		["truth", 0],
		["-", 0],
		[".5", 0],
		["+1", 0],
		['"\\x"', 1],
		['"\\ud800"', 0],
		["'\\udc00'", 0],
		["85(h'000000')", 0],
		["72(h'00'", 8],
		["85([1.0])", 3],
		["85(85(h''))", 3],
		["(_ )", 0],
		["(1.0)", 0],
		["(_ h'00', \"a\")", 10],
		["(_ 1.0)", 3],
		["(_ (_ h''))", 3],
		['"a"_', 3],
		["1_7", 1],
		["[" + "[".repeat(200_000), 0],
	]
	for (const [text, at] of cases) {
		const e = refused(text)
		if (text.length < 100) {
			assertEquals(e.at, at, `${diag.write(text)}: ${e.message}`)
		}
	}
})

function utf8(s: string): Uint8Array {
	return new TextEncoder().encode(s)
}
