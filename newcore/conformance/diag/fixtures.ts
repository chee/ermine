// Writes the diag scenarios to newcore/files/conformance/diag/NN-short-name.json.
//   deno run --allow-read --allow-write conformance/diag/fixtures.ts
// The texts are written by hand from FILES.tex and RFC 8949 Section 8; diag.ts is never imported.
// A value is given in JSON form (../pack/form.ts). A refused text marks the place of its fault
// with ¶ (taken out of the text): the offset, line and column are worked out from it, counting
// UTF-16 code units, lines from 1 at each newline, columns from 1.
import { Stand } from "../../encoding/ts/cbor.ts"
import { toJson } from "../pack/form.ts"

const out = new URL("../../files/conformance/diag/", import.meta.url)

type Fixture = { name: string; scenario: unknown }
const all: Fixture[] = []
const add = (name: string, scenario: unknown) => all.push({ name, scenario })

// writes as text, and the text reads back as the value
const writes = (name: string, title: string, value: unknown, text: string) =>
	add(name, { title, value: toJson(value), expect: { text } })
// reads as the value
const reads = (name: string, title: string, text: string, value: unknown) =>
	add(name, { title, text, expect: { value: toJson(value) } })
// refused, at the ¶
const refuses = (name: string, title: string, marked: string) => {
	const at = marked.indexOf("¶")
	const text = marked.replace("¶", "")
	const before = text.slice(0, at)
	const line = before.split("\n").length
	const column = at - before.lastIndexOf("\n")
	add(name, { title, text, expect: { at, line, column } })
}

const bytes = (...b: number[]) => Uint8Array.from(b).buffer
const J = JSON.stringify

// ---- writing
writes(
	"scalars",
	"null, booleans and text in a list, two-space indent, no final newline",
	[null, true, false, "x"],
	'[\n  null,\n  true,\n  false,\n  "x"\n]',
)
writes("top-number", "a number alone has its point", 42, "42.0")
writes("top-null", "null alone", null, "null")
writes("empty-containers", "[] and {} on one line", [[], {}], "[\n  [],\n  {}\n]")
writes(
	"numbers",
	"shortest decimals, as JavaScript writes them, always a point or an exponent",
	[
		0,
		-0,
		1,
		-1,
		1.5,
		0.1,
		100,
		0.30000000000000004,
		0.000001,
		1e-7,
		1.5e-10,
		4294967296,
		9007199254740992,
		123456789012345680000,
		1e21,
		1.5e300,
		5e-324,
		1.7976931348623157e308,
	],
	"[\n" + [
		"0.0",
		"-0.0",
		"1.0",
		"-1.0",
		"1.5",
		"0.1",
		"100.0",
		"0.30000000000000004",
		"0.000001",
		"1e-7",
		"1.5e-10",
		"4294967296.0",
		"9007199254740992.0",
		"123456789012345680000.0",
		"1e+21",
		"1.5e+300",
		"5e-324",
		"1.7976931348623157e+308",
	].map((s) => "  " + s).join(",\n") + "\n]",
)
writes(
	"nonfinite",
	"NaN, Infinity and -Infinity are words",
	[NaN, Infinity, -Infinity],
	"[\n  NaN,\n  Infinity,\n  -Infinity\n]",
)
writes(
	"string-escapes",
	"escapes as JSON has them, other controls and DEL as \\u00xx, the rest as is",
	'a"b\\c/\b\f\n\r\t\0\x1f\x7f\x80é😀 ',
	'"a\\"b\\\\c/\\b\\f\\n\\r\\t\\u0000\\u001f\\u007f\x80é😀 "',
)
writes("bytes", "bytes as h'' in lowercase", bytes(0, 1, 0xab, 0xff), "h'0001abff'")
writes("bytes-empty", "no bytes is h''", bytes(), "h''")
writes(
	"typed-ints",
	"a typed array as its tag on its bytes, little-endian",
	[
		Uint8Array.of(1, 2),
		Int8Array.of(-1),
		Uint16Array.of(258),
		Int16Array.of(-2),
		Uint32Array.of(1),
		Int32Array.of(-1),
		BigUint64Array.of(1n),
		BigInt64Array.of(-2n),
	],
	"[\n" + [
		"64(h'0102')",
		"72(h'ff')",
		"69(h'0201')",
		"77(h'feff')",
		"70(h'01000000')",
		"78(h'ffffffff')",
		"71(h'0100000000000000')",
		"79(h'feffffffffffffff')",
	].map((s) => "  " + s).join(",\n") + "\n]",
)
writes(
	"typed-floats",
	"float arrays, a NaN element the one NaN",
	[Float32Array.of(1, -0, Infinity, NaN), Float64Array.of(1, NaN)],
	"[\n  85(h'0000803f000000800000807f0000c07f'),\n  86(h'000000000000f03f000000000000f87f')\n]",
)
writes(
	"typed-empty",
	"an empty typed array",
	[new Uint8Array(0), new Float64Array(0)],
	"[\n  64(h''),\n  86(h'')\n]",
)
writes(
	"indent",
	"two spaces a level, in lists and maps",
	{ a: [1, { b: [] }], c: { d: {} } },
	'{\n  "a": [\n    1.0,\n    {\n      "b": []\n    }\n  ],\n  "c": {\n    "d": {}\n  }\n}',
)
{
	// code point order: "", "B", "a", "aa", "b", "é", U+FFFF, then U+1F600 (UTF-16 would put it first)
	const keys = ["", "B", "a", "aa", "b", "é", "￿", "😀"]
	const shuffled = ["b", "😀", "a", "￿", "aa", "é", "", "B"]
	writes(
		"key-order",
		"a map's keys in code point order, not UTF-16's",
		Object.fromEntries(shuffled.map((k) => [k, 1])),
		"{\n" + keys.map((k) => `  ${J(k)}: 1.0`).join(",\n") + "\n}",
	)
}
writes("key-slash", 'a key "/" is a key like any', { "/": 1 }, '{\n  "/": 1.0\n}')
writes(
	"key-proto",
	"a key __proto__ is a key like any",
	JSON.parse('{"__proto__":1}'),
	'{\n  "__proto__": 1.0\n}',
)
writes("key-escaped", "keys are quoted as strings are", { "a\nb": 1 }, '{\n  "a\\nb": 1.0\n}')

// ---- reading
reads(
	"comments",
	"comments between /, spacing of every kind, anywhere between tokens",
	" /one/ [ /two/ 1 , /three/ \t\r\n 2 /four/ ] /five/\n",
	[1, 2],
)
reads(
	"comment-content",
	"a comment may hold anything but /",
	"/ [ { ' \" ( , : # \n é / 7",
	7,
)
reads(
	"hex-bytes",
	"h'' bytes, any case, spacing and comments among the digits",
	"[h'00ff', h'0A Bc', h'0 /a comment/ 1\n02', h'']",
	[
		bytes(0, 0xff),
		bytes(0x0a, 0xbc),
		bytes(1, 2),
		bytes(),
	],
)
reads(
	"base64-bytes",
	"b64'' bytes: base64 or base64url, padded or not, spacing allowed",
	"[b64'AP8=', b64'AP8', b64'-_8', b64'+/8=', b64'AP 8\n=', b64'', b64'YQ==', b64'YWJj']",
	[
		bytes(0, 0xff),
		bytes(0, 0xff),
		bytes(0xfb, 0xff),
		bytes(0xfb, 0xff),
		bytes(0, 0xff),
		bytes(),
		bytes(0x61),
		bytes(0x61, 0x62, 0x63),
	],
)
reads(
	"quoted-bytes",
	"'' bytes are the UTF-8 of the text, with the same escapes",
	"['abc', 'é', '\\u{1f600}', '\\'\"', '', 'a\\nb']",
	[
		bytes(0x61, 0x62, 0x63),
		bytes(0xc3, 0xa9),
		bytes(0xf0, 0x9f, 0x98, 0x80),
		bytes(0x27, 0x22),
		bytes(),
		bytes(0x61, 0x0a, 0x62),
	],
)
reads(
	"string-escapes",
	"escapes: JSON's, \\' and \\u{...}; a surrogate pair of escapes is one character",
	String
		.raw`["\u0041\u{1f600}\u{41}\/\'\"\\", "\ud83d\ude00", "\u{000041}\b\f\n\r\t\u0000", "tab	raw
newline"]`,
	["A😀A/'\"\\", "😀", "A\b\f\n\r\t\0", "tab\traw\nnewline"],
)
reads(
	"integer-bases",
	"integers in 0x, 0o and 0b, any case, with a sign, leading zeros",
	"[0x10, 0XfF, 0o17, 0O7, 0b101, 0B11, -0x10, -0b1, 007, -010, 0x0]",
	[16, 255, 15, 7, 5, 3, -16, -1, 7, -10, 0],
)
reads(
	"integer-zero-sign",
	"an integer has no sign bit: -0 is 0; a decimal -0.0 is -0",
	"[-0, -0x0, -0.0, 0.0, -0e0]",
	[0, 0, -0, 0, -0],
)
reads(
	"integer-big",
	"an integer too big for a double is the nearest double",
	"[18446744073709551615, 0xffffffffffffffff, 0b" + "1".repeat(64) +
		", 9007199254740993, -9007199254740993, 0x20000000000001, 0x20000000000003, 1" +
		"0".repeat(400) + "]",
	[
		18446744073709552000,
		18446744073709552000,
		18446744073709552000,
		9007199254740992,
		-9007199254740992,
		9007199254740992,
		9007199254740996,
		Infinity,
	],
)
reads(
	"decimals",
	"decimals with a point or an exponent, as the nearest number",
	"[1.5, -2.5e3, 1E2, 1e+2, 1e-2, 0.1, 5e-324, 1e999, -1e999, 2e-400, 123456789.123456789, 0.30000000000000004, 1.7976931348623157e308]",
	[
		1.5,
		-2500,
		100,
		100,
		0.01,
		0.1,
		5e-324,
		Infinity,
		-Infinity,
		0,
		123456789.12345679,
		0.30000000000000004,
		1.7976931348623157e308,
	],
)
reads(
	"words",
	"true, false, null, NaN, Infinity, -Infinity",
	"[true, false, null, NaN, Infinity, -Infinity]",
	[true, false, null, NaN, Infinity, -Infinity],
)
reads(
	"indefinite",
	"indefinite lengths: [_ ], {_ }, and (_ ) over text or over bytes",
	`[[_ 1, 2], [_ ], {_ "a": 1}, {_ }, (_ "ab", "c", ""), (_ h'01', h'02', ''), (_ 'x'), ""_, ''_, h''_, [_ [_ ]]]`,
	[
		[1, 2],
		[],
		{ a: 1 },
		{},
		"abc",
		bytes(1, 2),
		bytes(0x78),
		"",
		bytes(),
		bytes(),
		[[]],
	],
)
reads(
	"indicators",
	"encoding indicators _0 to _3 after a number, string, bytes, word, [ and {",
	`[1_0, 1.5_1, 0x1_2, 7_3, "a"_1, 'a'_3, h'00'_2, b64'AA'_0, NaN_1, Infinity_2, -Infinity_0, [_3 1], {_0 "a": 1}, [_1], [_ ], ""_0]`,
	[
		1,
		1.5,
		1,
		7,
		"a",
		bytes(0x61),
		bytes(0),
		bytes(0),
		NaN,
		Infinity,
		-Infinity,
		[1],
		{ a: 1 },
		[],
		[],
		"",
	],
)
reads(
	"trailing-commas",
	"a last comma in lists, maps and chunks",
	`[[1,], [1, 2, ], {"a": 1,}, {"a": 1 , }]`,
	[[1], [1, 2], { a: 1 }, { a: 1 }],
)
reads("trailing-comma-chunks", "a last comma in (_ )", `(_ "a", "b",)`, "ab")
reads(
	"tags",
	"a typed array's tag over bytes: each of the ten, spacing and comments around",
	`[64(h'0102'), 69(h'0201'), 70(h'01000000'), 71(h'0100000000000000'), 72(h'ff'), 77(h'feff'), 78(h'ffffffff'), 79(h'ffffffffffffffff'), 85(h'0000803f'), 86(h'000000000000f03f'), 64 ( h'01' ), 64/c/(/c/h'02'/c/), 64_0(h'03'), 64(b64'BA'), 64('a'), 64((_ h'01', h'02')), 64(h''), 85(h'')]`,
	[
		Uint8Array.of(1, 2),
		Uint16Array.of(258),
		Uint32Array.of(1),
		BigUint64Array.of(1n),
		Int8Array.of(-1),
		Int16Array.of(-2),
		Int32Array.of(-1),
		BigInt64Array.of(-1n),
		Float32Array.of(1),
		Float64Array.of(1),
		Uint8Array.of(1),
		Uint8Array.of(2),
		Uint8Array.of(3),
		Uint8Array.of(4),
		Uint8Array.of(0x61),
		Uint8Array.of(1, 2),
		new Uint8Array(0),
		new Float32Array(0),
	],
)
reads(
	"tag-nan",
	"every NaN in a typed array reads as the one NaN",
	`[85(h'0100807f'), 85(h'0000c0ff'), 86(h'010000000000f07f'), 86(h'000000000000f8ff'), 85(h'0000c07f')]`,
	[
		Float32Array.of(NaN),
		Float32Array.of(NaN),
		Float64Array.of(NaN),
		Float64Array.of(NaN),
		Float32Array.of(NaN),
	],
)
writes(
	"stand",
	"a stand-in as its tag, 0x12345678, on its kind, any value, indented as its kind",
	[new Stand("clock"), new Stand(null), new Stand({ url: "a", w: 2 }), { s: new Stand([]) }],
	'[\n  305419896("clock"),\n  305419896(null),\n  305419896({\n    "url": "a",\n    "w": 2.0\n  }),\n  {\n    "s": 305419896([])\n  }\n]',
)
reads(
	"stand-read",
	"a stand-in's tag over any value, in any integer base, spacing and comments around",
	`[0x12345678 ( "clock" ), 305419896(85(h'0000803f')), 305419896(/ a canvas / {"w": 1})]`,
	[new Stand("clock"), new Stand(Float32Array.of(1)), new Stand({ w: 1 })],
)
refuses("refuse-stand-close", "a stand-in's kind not closed by )", `305419896("clock" ¶1)`)
reads(
	"map-keys",
	"keys in any order, as any text, and the key __proto__",
	`{"b": 1, "a"_0: 2, (_ "c", "d"): 3, "__proto__": 4, "\\u00e9": 5, "": 6}`,
	JSON.parse('{"b":1,"a":2,"cd":3,"__proto__":4,"é":5,"":6}'),
)
reads("crlf", "CR LF is spacing", '{\r\n\t"a": [\r\n\t\t1\r\n\t]\r\n}\r\n', { a: [1] })
reads("top-scalar", "a value alone, spaced", '  \n\t"x"  ', "x")
reads("negative-zero-word", "-Infinity beside -1", "[-Infinity, -1, -1.5]", [-Infinity, -1, -1.5])
reads(
	"nested",
	"a value inside values inside values",
	'{"a": [{"b": [[], {}]}, h\'01\']}',
	{ a: [{ b: [[], {}] }, bytes(1)] },
)

// ---- refusals
refuses("refuse-empty", "no value", "¶")
refuses("refuse-blank", "only spacing and a comment", "  /c/ \n ¶")
refuses("refuse-more", "more after the value", "1 ¶2")
refuses("refuse-more-bracket", "a closing bracket with nothing open", "[]¶]")
refuses("refuse-undefined", "undefined is no value", "[¶undefined]")
refuses("refuse-simple", "simple values other than false, true and null", "¶simple(3)")
refuses("refuse-word", "an unknown word", "[1, ¶foo]")
refuses("refuse-word-glued", "Infinity glued to letters is a different word", "¶Infinityx")
refuses("refuse-prefix", "bytes prefixes other than h and b64", "¶x'ab'")
refuses("refuse-tag", "a tag that is not a typed array's or a stand-in's", "¶100(h'00')")
refuses("refuse-tag-time", "tag 1 is a time, which is no value here", "¶1(1.5)")
refuses("refuse-tag-over", "a typed array's tag over what is not bytes", "64(¶1)")
refuses("refuse-tag-over-text", "a typed array's tag over text", `85(¶"abcd")`)
refuses("refuse-tag-whole", "a typed array's bytes that are not whole elements", "[¶70(h'0102')]")
refuses("refuse-tag-close", "a tag's value not closed by )", "64(h'00' ¶1)")
refuses("refuse-tag-negative", "a negative number takes no tag", "-1¶(h'00')")
refuses("refuse-tag-float", "a decimal takes no tag", "1.0¶(h'00')")
refuses("refuse-key-number", "a key that is not text", "{¶1: 2}")
refuses("refuse-key-bytes", "a key that is bytes", "{¶h'00': 1}")
refuses("refuse-key-twice", "a key twice", `{"a": 1, ¶"a": 2}`)
refuses("refuse-key-twice-escaped", "a key twice, spelled another way", `{"a": 1, ¶"\\u0061": 2}`)
refuses("refuse-key-colon", "no colon after a key", `{"a" ¶1}`)
refuses("refuse-no-comma", "no comma between items", "[1 ¶2]")
refuses("refuse-comma-first", "a comma first", "[¶,1]")
refuses("refuse-comma-twice", "two commas", "[1,¶,2]")
refuses("refuse-unclosed", "a list not closed", "[1,¶")
refuses("refuse-mismatch", "a list closed by }", "[1¶}")
refuses("refuse-comment", "a comment with no end", "[1 ¶/ abc")
refuses("refuse-comment-in-hex", "a comment with no end among hex digits", "h'01 ¶/ 02'")
refuses("refuse-string-end", "a string with no end", `¶"abc`)
refuses("refuse-escape", "an escape that means nothing", `"a¶\\x"`)
refuses("refuse-escape-end", "an escape at the end", `"a¶\\`)
refuses("refuse-unicode-short", "\\u with fewer than four digits", `"¶\\u12"`)
refuses("refuse-unicode-big", "\\u{...} past U+10FFFF", `"¶\\u{110000}"`)
refuses("refuse-unicode-long", "\\u{...} of seven digits", `"¶\\u{0000041}"`)
refuses("refuse-unicode-empty", "\\u{} with no digits", `"¶\\u{}"`)
refuses("refuse-surrogate-lone", "a lone surrogate by escape", `[¶"\\ud800"]`)
refuses("refuse-surrogate-low", "a low surrogate first", `¶"\\ude00\\ud83d"`)
refuses("refuse-surrogate-split", "a high surrogate not followed by a low", `¶"\\ud83d x"`)
refuses("refuse-surrogate-braces", "a surrogate in \\u{...} is as lone as any", `¶"\\u{d800}"`)
refuses("refuse-surrogate-raw", "a lone surrogate in the text itself", '¶"a\ud800b"')
refuses("refuse-surrogate-bytes", "a lone surrogate in a '' string", `¶'\\udc00'`)
refuses("refuse-hex-odd", "hex bytes with an odd number of digits", "¶h'abc'")
refuses("refuse-hex-digit", "a character that is no hex digit", "h'a¶g'")
refuses("refuse-hex-end", "hex bytes with no end", "¶h'ab")
refuses("refuse-b64-length", "base64 of a bad length", "¶b64'a'")
refuses("refuse-b64-char", "a character that is no base64", "b64'ab¶!'")
refuses("refuse-b64-padding", "base64 padding that is not whole", "¶b64'ab='")
refuses("refuse-b64-padding-more", "base64 with characters after its padding", "¶b64'ab==c'")
refuses("refuse-b64-end", "base64 with no end", "¶b64'abcd")
refuses("refuse-indicator-bare", "_ alone after a number", "1¶_")
refuses("refuse-indicator-four", "_4 is no indicator", "[1¶_4]")
refuses("refuse-indicator-string", "_ alone after a string with something in it", `"a"¶_`)
refuses("refuse-indicator-true", "true takes no indicator", "[true¶_1]")
refuses("refuse-chunks-bare", "( not followed by _", "¶(1)")
refuses("refuse-chunks-empty", "(_ ) with no chunks", "¶(_ )")
refuses("refuse-chunks-mixed", "text and bytes chunks together", `(_ "a", ¶'b')`)
refuses("refuse-chunks-number", "a chunk that is not text or bytes", "(_ ¶1)")
refuses("refuse-chunks-nested", "chunks inside chunks", `(_ ¶(_ "a"))`)
refuses("refuse-minus", "a - with no number", "¶-")
refuses("refuse-minus-word", "-NaN", "¶-NaN")
refuses("refuse-minus-space", "a space after -", "[¶- 1]")
refuses("refuse-hex-prefix", "0x with no digits is 0 and then an x", "0¶x")
refuses("refuse-binary-digit", "0b with a digit past 1", "0b1¶2")
refuses("refuse-point-end", "1. is not a number", "1¶.")
refuses("refuse-point-start", ".5 is not a number", "¶.5")
refuses("refuse-plus", "+1 is not a number", "¶+1")
refuses("refuse-exponent-bare", "1e is 1 and then an e", "1¶e")
refuses("refuse-hex-float", "0x1.8 is 0x1 and then a point", "0x1¶.8")
refuses("refuse-value", "a character that starts no value", "[¶)]")
refuses("refuse-line", "the line and column of a fault", "[\n  1,\n  ¶x\n]")
refuses("refuse-column", "the column counts after the last newline", '{\n  "a": ¶}')
refuses(
	"refuse-astral",
	"an offset counts UTF-16 code units, an astral character as two",
	`["😀", ¶x]`,
)
refuses("refuse-cr", "a CR is not a newline", "[\r1 ¶2]")

// JSON.stringify, but -0 written -0
const MINUS = "\u0000-0\u0000"
const pretty = (x: unknown) =>
	JSON.stringify(x, (_, v) => Object.is(v, -0) ? MINUS : v, "\t").replaceAll(
		JSON.stringify(MINUS),
		"-0",
	)

// ---- files
// the first number is the position in the file name: stable, in the order above
await Deno.mkdir(out, { recursive: true })
for await (const f of Deno.readDir(out)) {
	if (f.name.endsWith(".json")) await Deno.remove(new URL(f.name, out))
}
const width = String(all.length).length
all.forEach(({ name, scenario }, i) => {
	const file = `${String(i + 1).padStart(Math.max(2, width), "0")}-${name}.json`
	Deno.writeTextFileSync(new URL(file, out), pretty(scenario) + "\n")
})
console.log(`${all.length} scenarios`)
