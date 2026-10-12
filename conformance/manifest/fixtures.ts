// Writes the manifest scenarios to newcore/files/conformance/manifest/NN-short-name.json.
//   deno run --allow-read --allow-write conformance/manifest/fixtures.ts
// Oracles: a hash is BLAKE3 of cbor.encode; a record, a frame and a kept cbor file are cbor.encode
// of the object written out here; a typed array's file is its elements little-endian, each NaN the
// quiet one with no payload; a cbor value's file is its diagnostic notation, written out by hand.
// manifest.ts is never imported. The protocol is harness.ts's; a scenario's open is given its dir
// by manifest_test.ts.
// deno-lint-ignore no-import-prefix
import { blake3 } from "npm:@noble/hashes@1.8.0/blake3"
import { encode, Stand, type Value } from "@ermine/encoding/cbor"
import { toJson } from "../pack/form.ts"

const out = new URL("../../playground/files/conformance/manifest/", import.meta.url)
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))
const utf8 = new TextEncoder()
const t = (s: string) => hex(utf8.encode(s))
const buf = (...b: number[]) => Uint8Array.from(b)
const cat = (...xs: Uint8Array[]) => {
	const o = new Uint8Array(xs.reduce((n, x) => n + x.length, 0))
	let at = 0
	for (const x of xs) o.set(x, at), at += x.length
	return o
}

/** A value's hash. */
const H = (v: unknown) => hex(blake3(encode(v as Value)))
/** A hash's 32 bytes, as a record holds them. */
const B = (h: string) => unhex(h)
const J = toJson
const NULL = H(null)

/** A frame: 4 bytes big-endian of the length, then the CBOR of a map of bytes or null. */
function frame(entries: [string, Uint8Array | null][]): Uint8Array {
	return framed(encode(Object.fromEntries(entries)))
}
function framed(body: Uint8Array): Uint8Array {
	const o = new Uint8Array(4 + body.length)
	new DataView(o.buffer).setUint32(0, body.length)
	o.set(body, 4)
	return o
}
const r = (s: string) => utf8.encode(s)

type Request = Record<string, unknown> & { op: string }
type Step = { request: Request; expect: unknown }
const all: { name: string; scenario: unknown }[] = []
const add = (name: string, title: string, steps: Step[]) =>
	all.push({ name, scenario: { title, steps } })
const s = (request: Request, expect: unknown = {}): Step => ({ request, expect })
const STORE = { code: "store" }
const FORM = { code: "form" }

// ---- values

const site = { file: "manifest_test.ts", line: 1, column: 1 }
const KINDS: [string, unknown][] = [
	["int8", new Int8Array([-1, 127])],
	["int16", new Int16Array([-2])],
	["uint16", new Uint16Array([0x0102])],
	["int32", new Int32Array([-(2 ** 31)])],
	["uint32", new Uint32Array([2 ** 32 - 1])],
	["int64", new BigInt64Array([-5n, 1n << 62n])],
	["uint64", new BigUint64Array([2n ** 64n - 1n])],
	["float32", new Float32Array([1, NaN])],
	["float64", new Float64Array([-0, NaN, Infinity, 1e300])],
]
const CBORS: unknown[] = [
	null,
	true,
	false,
	1,
	-0,
	1.5,
	[],
	{},
	{ a: "x" },
	["x"],
	new Stand("clock"),
]

add("form", "a string is txt, bytes bin, a typed array its kind, anything else cbor", [
	s({ op: "form", value: "hi" }, { form: "txt" }),
	s({ op: "form", value: "" }, { form: "txt" }),
	s({ op: "form", value: J(buf(1, 2)) }, { form: "bin" }),
	s({ op: "form", value: J(buf()) }, { form: "bin" }),
	...KINDS.map(([k, v]) => s({ op: "form", value: J(v) }, { form: k })),
	...CBORS.map((v) => s({ op: "form", value: J(v) }, { form: "cbor" })),
])

/** A typed array's elements little-endian, each NaN the quiet NaN with no payload. */
function elements(v: ArrayBufferView): string {
	const a = v as unknown as ArrayLike<number | bigint>
	const size = (v as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT
	const o = new DataView(new ArrayBuffer(a.length * size))
	for (let i = 0; i < a.length; i++) {
		const x = a[i], at = i * size
		if (v instanceof Float32Array) {
			Number.isNaN(x) ? o.setUint32(at, 0x7fc00000, true) : o.setFloat32(at, x as number, true)
		} else if (v instanceof Float64Array) {
			Number.isNaN(x)
				? o.setBigUint64(at, 0x7ff8000000000000n, true)
				: o.setFloat64(at, x as number, true)
		} else if (v instanceof BigInt64Array) o.setBigInt64(at, x as bigint, true)
		else if (v instanceof BigUint64Array) o.setBigUint64(at, x as bigint, true)
		else if (size === 1) o.setUint8(at, (x as number) & 0xff)
		else if (size === 2) o.setUint16(at, (x as number) & 0xffff, true)
		else o.setUint32(at, (x as number) >>> 0, true)
	}
	return hex(new Uint8Array(o.buffer))
}

const TEXT = "﻿café 🐈\n"
const PNG = buf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6)
add(
	"render-txt-bin",
	"a string's file is its UTF-8, a byte order mark kept; bytes are as they are",
	[
		s({ op: "render", value: TEXT, form: "txt" }, { bytes: t(TEXT) }),
		s({ op: "render", value: "", form: "txt" }, { bytes: "" }),
		s({ op: "render", value: J(PNG), form: "bin" }, { bytes: hex(PNG) }),
		s({ op: "render", value: J(buf()), form: "bin" }, { bytes: "" }),
	],
)
add("render-typed", "a typed array's file is its elements little-endian, NaN the one NaN", [
	...KINDS.map(([k, v]) =>
		s({ op: "render", value: J(v), form: k }, { bytes: elements(v as ArrayBufferView) })
	),
	s({ op: "render", value: J(new Int8Array()), form: "int8" }, { bytes: "" }),
	s({ op: "render", value: J(new Float32Array([1])), form: "float32" }, { bytes: "0000803f" }),
	s({ op: "render", value: J(new Float64Array([NaN])), form: "float64" }, {
		bytes: "000000000000f87f",
	}),
])

// diagnostic notation: two spaces, keys in code point order, numbers with a point or an
// exponent, bytes h'', a typed array its tag on its bytes, no final newline
const DIAG: [unknown, string][] = [
	[null, "null"],
	[true, "true"],
	[1, "1.0"],
	[-0, "-0.0"],
	[0.1, "0.1"],
	[1e21, "1e+21"],
	[NaN, "NaN"],
	[-Infinity, "-Infinity"],
	[['a"\\\n\t\u0001é'], '[\n  "a\\"\\\\\\n\\t\\u0001é"\n]'],
	[[], "[]"],
	[{}, "{}"],
	[[1, "two", null], '[\n  1.0,\n  "two",\n  null\n]'],
	[
		{ theme: "dark", n: -0, b: buf(0, 0) },
		'{\n  "b": h\'0000\',\n  "n": -0.0,\n  "theme": "dark"\n}',
	],
	[{ a: [1, { b: [] }] }, '{\n  "a": [\n    1.0,\n    {\n      "b": []\n    }\n  ]\n}'],
	[{ t: new Float32Array([1]) }, "{\n  \"t\": 85(h'0000803f')\n}"],
	[[new Int8Array([1, 2])], "[\n  72(h'0102')\n]"],
	// a stand-in as its tag on its kind, so its file reads back as it
	[new Stand("clock"), '305419896("clock")'],
	[{ c: new Stand({ w: 1 }) }, '{\n  "c": 305419896({\n    "w": 1.0\n  })\n}'],
]
add(
	"render-cbor",
	"any other value's file is its diagnostic notation",
	DIAG.map(([v, d]) => s({ op: "render", value: J(v), form: "cbor" }, { bytes: t(d) })),
)

const WRONG = { code: "wrong-form" }
add("render-wrong", "a value is rendered only in its own form", [
	s({ op: "render", value: 5, form: "txt" }, WRONG),
	s({ op: "render", value: "x", form: "bin" }, WRONG),
	s({ op: "render", value: "x", form: "cbor" }, WRONG),
	s({ op: "render", value: J(buf(1)), form: "cbor" }, WRONG),
	s({ op: "render", value: J(new Int8Array([1])), form: "bin" }, WRONG),
	s({ op: "render", value: J(new Int8Array([1])), form: "cbor" }, WRONG),
	s({ op: "render", value: J(new Float32Array([1])), form: "float64" }, WRONG),
	s({ op: "render", value: J(new Int8Array([1])), form: "int16" }, WRONG),
	s({ op: "render", value: {}, form: "int16" }, WRONG),
	s({ op: "render", value: "x", form: "int16" }, WRONG),
	// no uint8 form: bytes are bin (the designer, 10-12)
	s({ op: "render", value: J(new Uint8Array([1, 2])), form: "uint8" }, WRONG),
])

add("parse", "a file reads back as the value in its form", [
	s({ op: "parse", bytes: t(TEXT), form: "txt" }, { value: TEXT }),
	s({ op: "parse", bytes: "", form: "txt" }, { value: "" }),
	s({ op: "parse", bytes: hex(PNG), form: "bin" }, { value: J(PNG) }),
	s({ op: "parse", bytes: "", form: "bin" }, { value: J(buf()) }),
	...KINDS.map(([k, v]) =>
		s({ op: "parse", bytes: elements(v as ArrayBufferView), form: k }, { value: J(v) })
	),
	// a NaN with a payload reads as NaN
	s({ op: "parse", bytes: "0100c07f", form: "float32" }, { value: J(new Float32Array([NaN])) }),
	s({ op: "parse", bytes: "", form: "int64" }, { value: J(new BigInt64Array()) }),
	...DIAG.map(([v, d]) => s({ op: "parse", bytes: t(d), form: "cbor" }, { value: J(v) })),
	// notation read loosely: any spacing, comments, any key order, integers
	s({ op: "parse", bytes: t('{ "b": h\'0000\', /c/ "a": 1 }'), form: "cbor" }, {
		value: J({ a: 1, b: buf(0, 0) }),
	}),
])

add("parse-errors", "a file that does not read as its form is a form error", [
	s({ op: "parse", bytes: "ff", form: "txt" }, FORM),
	s({ op: "parse", bytes: "c328", form: "cbor" }, FORM),
	s({ op: "parse", bytes: t('{"a": '), form: "cbor" }, FORM),
	s({ op: "parse", bytes: t("1(2)"), form: "cbor" }, FORM),
	s({ op: "parse", bytes: t('{"a": 1, "a": 2}'), form: "cbor" }, FORM),
	s({ op: "parse", bytes: "000000", form: "float32" }, FORM),
	s({ op: "parse", bytes: "000000000000000000", form: "int64" }, FORM),
	s({ op: "parse", bytes: "00", form: "uint16" }, FORM),
	s({ op: "parse", bytes: "000000", form: "int32" }, FORM),
])

const HASHED: unknown[] = [
	"hi",
	"",
	null,
	{ a: [1, 2] },
	new Float32Array([1, NaN]),
	buf(1, 2, 3),
	new Stand("clock"),
	-0,
	2 ** 53,
]
add("hash", "a value's hash is the BLAKE3 of its deterministic CBOR; null's is NULL", [
	...HASHED.map((v) => s({ op: "hash", value: J(v) }, { hash: H(v) })),
	// key order does not matter
	s({ op: "hash", value: { b: 2, a: 1 } }, { hash: H({ a: 1, b: 2 }) }),
	s({ op: "null" }, { hash: NULL }),
	s({ op: "digest", bytes: "" }, { hash: hex(blake3(new Uint8Array())) }),
	s({ op: "digest", bytes: t("abc") }, { hash: hex(blake3(utf8.encode("abc"))) }),
	s({ op: "digest", bytes: "f6" }, { hash: NULL }),
])

add(
	"kept",
	"a content is kept as its hash and form",
	[...HASHED, ...KINDS.map(([, v]) => v)].map((v) =>
		s({ op: "kept", value: J(v) }, {
			kept: [
				H(v),
				typeof v === "string"
					? "txt"
					: v instanceof Uint8Array
					? "bin"
					: ArrayBuffer.isView(v)
					? KINDS.find(([, x]) => (x as object).constructor === v.constructor)![0]
					: "cbor",
			],
		})
	),
)

// ---- node records

const change = (n: number) => ({ time: n, actor: "host", node: "n", site })
const F32 = new Float32Array([1.5, NaN])
const BIG = { a: [1, null, true], n: -0 }
/** A node in the pack harness's form, with every kind of field; value 2 is made live. */
const sample = {
	id: "n",
	value: [
		{ content: "12:00", change: J(change(1)) },
		{ content: J(F32), change: J(change(2)), because: { layer: "sync", place: 1 } },
		{ content: "live", change: J(change(3)) },
	],
	info: [
		["color", [{ content: "red", change: J(change(4)) }]],
		["big", [{ content: J(BIG), change: J(change(5)) }, { content: 5, change: J(change(6)) }]],
		["none", []],
	],
	children: [
		["docs", [
			{ content: ["d1", { symbol: "x" }, "e1", "d2"], change: J(change(7)) },
			{ content: ["d3"], change: J(change(8)) },
		]],
		["empty", [{ content: [], change: J(change(9)) }]],
	],
	header: { time: 1, actor: "host", site },
}
const kept = (v: unknown, f: string) => [B(H(v)), f]
const sampleRecord = (docs: string[]) =>
	encode({
		id: "n",
		value: [
			{ kept: kept("12:00", "txt"), change: change(1) },
			{ kept: kept(F32, "float32"), change: change(2), because: { layer: "sync", place: 1 } },
		],
		info: [
			["color", [{ kept: kept("red", "txt"), change: change(4) }]],
			["big", [{ kept: kept(BIG, "cbor"), change: change(5) }, {
				kept: kept(5, "cbor"),
				change: change(6),
			}]],
			["none", []],
		],
		children: [
			["docs", [{ content: docs, change: change(7) }, { content: ["d3"], change: change(8) }]],
			["empty", [{ content: [], change: change(9) }]],
		],
		header: { time: 1, actor: "host", site },
	} as never)
const sampleValues = ([["12:00"], [F32], ["red"], [BIG], [5]] as unknown[][])
	.map(([v]) => [H(v), J(v)] as [string, unknown])
	.sort((a, b) => a[0] < b[0] ? -1 : 1)
const sampleShape = (docs: string[]) => ({
	kept: [H("12:00"), "txt"],
	sides: [[H(F32), "float32"]],
	info: [["color", H("red"), "txt"], ["big", H(BIG), "cbor"]],
	directory: [["docs", docs]],
})
const LIVE = [["value", 2, "content"]]

add("save", "a node's record is as pack writes it, each content kept by its hash", [
	s({ op: "save", node: sample, skip: ["e1"], live: LIVE }, {
		record: hex(sampleRecord(["d1", "d2"])),
		values: sampleValues,
		shape: sampleShape(["d1", "d2"]),
	}),
	// a symbol always goes; an id only when skip says so
	s({ op: "save", node: sample, live: LIVE }, {
		record: hex(sampleRecord(["d1", "e1", "d2"])),
		values: sampleValues,
		shape: sampleShape(["d1", "e1", "d2"]),
	}),
])

add("save-empty", "a node with nothing keeps nothing, and shows null's hash", [
	s({ op: "save", node: { id: "e", value: [], info: [], children: [], header: {} } }, {
		record: hex(encode({ id: "e", value: [], info: [], children: [], header: {} })),
		values: [],
		shape: { kept: [NULL, "cbor"], sides: [], info: [], directory: [] },
	}),
])

const SHORT = buf(1, 2, 3)
add("save-bin", "a bin value's shape has its first 12 bytes, a side's too", [
	s({
		op: "save",
		node: {
			id: "b",
			value: [{ content: J(PNG), change: null }, { content: J(SHORT), change: null }],
			info: [],
			children: [],
			header: {},
		},
	}, {
		record: hex(encode({
			id: "b",
			value: [{ kept: kept(PNG, "bin"), change: null }, {
				kept: kept(SHORT, "bin"),
				change: null,
			}],
			info: [],
			children: [],
			header: {},
		})),
		values: [[H(PNG), J(PNG)], [H(SHORT), J(SHORT)]].sort((a, b) =>
			(a[0] as string) < (b[0] as string) ? -1 : 1
		),
		shape: {
			kept: [H(PNG), "bin"],
			sides: [[H(SHORT), "bin", "010203"]],
			info: [],
			directory: [],
			head: hex(PNG.slice(0, 12)),
		},
	}),
])

add("save-once", "a content in several versions is kept once; a stand-in is kept as cbor", [
	s({
		op: "save",
		node: {
			id: "o",
			value: [{ content: "x", change: 1 }, { content: J(new Stand("clock")), change: 2 }],
			info: [["a", [{ content: "x", change: 3 }]]],
			children: [],
			header: { actor: "a" },
		},
	}, {
		record: hex(encode({
			id: "o",
			value: [{ kept: kept("x", "txt"), change: 1 }, {
				kept: kept(new Stand("clock"), "cbor"),
				change: 2,
			}],
			info: [["a", [{ kept: kept("x", "txt"), change: 3 }]]],
			children: [],
			header: { actor: "a" },
		})),
		values: [["x", "x"], [new Stand("clock"), J(new Stand("clock"))]]
			.map(([v, j]) => [H(v), j])
			.sort((a, b) => (a[0] as string) < (b[0] as string) ? -1 : 1),
		shape: {
			kept: [H("x"), "txt"],
			sides: [[H(new Stand("clock")), "cbor"]],
			info: [["a", H("x"), "txt"]],
			directory: [],
		},
	}),
])

const one = (more: Record<string, unknown> = {}) => ({
	id: "l",
	value: [{ content: "v", change: 1, because: 2 }],
	info: [["i", [{ content: "w", change: 3 }, { content: "z", change: 4 }]]],
	children: [["c", [{ content: ["a"], change: 5 }]]],
	header: { actor: "a", cause: "c" },
	...more,
})
add("save-live", "a live content is left out; a live change, because or header cannot be saved", [
	s({ op: "save", node: one(), live: [["info", 0, 1, 0, "content"]] }, {
		record: hex(encode({
			id: "l",
			value: [{ kept: kept("v", "txt"), change: 1, because: 2 }],
			info: [["i", [{ kept: kept("z", "txt"), change: 4 }]]],
			children: [["c", [{ content: ["a"], change: 5 }]]],
			header: { actor: "a", cause: "c" },
		})),
		values: [["v", "v"], ["z", "z"]].map(([v, j]) => [H(v), j]).sort((a, b) =>
			a[0] < b[0] ? -1 : 1
		),
		shape: {
			kept: [H("v"), "txt"],
			sides: [],
			info: [["i", H("z"), "txt"]],
			directory: [["c", ["a"]]],
		},
	}),
	s({ op: "save", node: one(), live: [["value", 0, "change"]] }, STORE),
	s({ op: "save", node: one(), live: [["value", 0, "because"]] }, STORE),
	s({ op: "save", node: one(), live: [["info", 0, 1, 1, "change"]] }, STORE),
	s({ op: "save", node: one(), live: [["children", 0, 1, 0, "change"]] }, STORE),
	s({ op: "save", node: one(), live: [["header", "actor"]] }, STORE),
	s({ op: "save", node: one(), live: [["header", "cause"]] }, STORE),
])

const rec = (x: unknown) => hex(encode(x as Value))
const base = { id: "n", value: [], info: [], children: [], header: {} }
add("kepts", "each [hash, form] a record keeps: its value's versions, then each info's", [
	s({ op: "kepts", record: hex(sampleRecord(["d1"])) }, {
		kepts: [
			[H("12:00"), "txt"],
			[H(F32), "float32"],
			[H("red"), "txt"],
			[H(BIG), "cbor"],
			[H(5), "cbor"],
		],
	}),
	s({ op: "kepts", record: rec(base) }, { kepts: [] }),
	// what is not a record of a node is a store error
	s({ op: "kepts", record: "ff" }, STORE),
	s({ op: "kepts", record: rec([1]) }, STORE),
	s({ op: "kepts", record: rec({ ...base, value: [{ content: "x" }] }) }, STORE),
	s(
		{ op: "kepts", record: rec({ ...base, value: [{ kept: [new Uint8Array(31), "txt"] }] }) },
		STORE,
	),
	s({ op: "kepts", record: rec({ ...base, value: [{ kept: [H("x"), "txt"] }] }) }, STORE),
	s({ op: "kepts", record: rec({ ...base, value: [{ kept: [B(H("x")), "json"] }] }) }, STORE),
	s({ op: "kepts", record: rec({ ...base, value: [{ kept: [B(H("x"))] }] }) }, STORE),
	s({ op: "kepts", record: rec({ ...base, value: "x" }) }, STORE),
	s({ op: "kepts", record: rec({ ...base, info: {} }) }, STORE),
	s({ op: "kepts", record: rec({ ...base, info: [["a"]] }) }, STORE),
	s({ op: "kepts", record: rec({ ...base, info: [["a", "x"]] }) }, STORE),
])

const shownChange = (n: number) => J(change(n))
add("restore", "a record gives its node back, each content from its hash", [
	s({ op: "restore", record: hex(sampleRecord(["d1", "d2"])), values: sampleValues }, {
		node: {
			id: "n",
			value: [
				{ content: "12:00", change: shownChange(1) },
				{ content: J(F32), change: shownChange(2), because: { layer: "sync", place: 1 } },
			],
			info: [
				["color", [{ content: "red", change: shownChange(4) }]],
				["big", [{ content: J(BIG), change: shownChange(5) }, {
					content: 5,
					change: shownChange(6),
				}]],
				["none", []],
			],
			children: [
				["docs", [{ content: ["d1", "d2"], change: shownChange(7) }, {
					content: ["d3"],
					change: shownChange(8),
				}]],
				["empty", [{ content: [], change: shownChange(9) }]],
			],
			header: { time: 1, actor: "host", site },
		},
	}),
	s({ op: "restore", record: rec(base), values: [] }, { node: base }),
	s({ op: "restore", record: "ff", values: [] }, STORE),
	s({ op: "restore", record: rec({ ...base, id: 1 }), values: [] }, STORE),
	s({
		op: "restore",
		record: rec({ ...base, value: [{ kept: [new Uint8Array(31), "txt"] }] }),
		values: [],
	}, STORE),
])

const H1 = H("a"), H2 = H("b"), H3 = H("c")
add(
	"shape",
	"a shape: the first value or null's, each later version, each info's first, each first list",
	[
		s({
			op: "shape",
			record: rec({
				id: "s",
				value: [{ kept: [B(H1), "bin"] }, { kept: [B(H2), "txt"] }, { kept: [B(H3), "bin"] }],
				info: [["x", []], ["y", [{ kept: [B(H2), "cbor"] }, { kept: [B(H1), "txt"] }]]],
				children: [
					["a", [{ content: [] }, { content: ["z"] }]],
					["b", []],
					["c", [{ content: ["p", "q"] }, { content: ["r"] }]],
				],
				header: {},
			}),
			// a head for H1, none for H3
			heads: [[H1, "0102"]],
		}, {
			shape: {
				kept: [H1, "bin"],
				head: "0102",
				sides: [[H2, "txt"], [H3, "bin"]],
				info: [["y", H2, "cbor"]],
				directory: [["c", ["p", "q"]]],
			},
		}),
		s({ op: "shape", record: rec(base), heads: [] }, {
			shape: { kept: [NULL, "cbor"], sides: [], info: [], directory: [] },
		}),
		s({ op: "shape", record: rec({ ...base, children: {} }), heads: [] }, STORE),
		s({ op: "shape", record: rec({ ...base, children: [["a"]] }), heads: [] }, STORE),
		s({ op: "shape", record: rec({ ...base, children: [[1, []]] }), heads: [] }, STORE),
		s({ op: "shape", record: rec({ ...base, children: [["a", {}]] }), heads: [] }, STORE),
		s(
			{
				op: "shape",
				record: rec({ ...base, children: [["a", [{ content: [1] }]]] }),
				heads: [],
			},
			STORE,
		),
		s({ op: "shape", record: rec({ ...base, children: [["a", ["x"]]] }), heads: [] }, STORE),
		s({ op: "shape", record: rec({ ...base, value: [{}] }), heads: [] }, STORE),
	],
)

// ---- the other records

const codec = (c: string, record: unknown, bytes: Uint8Array): Step[] => [
	s({ op: "encode", codec: c, record }, { bytes: hex(bytes) }),
	s({ op: "decode", codec: c, bytes: hex(bytes) }, { record }),
]
const refused = (c: string, x: unknown) => s({ op: "decode", codec: c, bytes: rec(x) }, STORE)

add("meta", "meta: the root and the time", [
	...codec("meta", { root: "r", time: 6 }, encode({ root: "r", time: 6 })),
	...codec("meta", { root: "", time: 1.5 }, encode({ root: "", time: 1.5 })),
	s({ op: "decode", codec: "meta", bytes: "ff" }, STORE),
	refused("meta", ["r", 6]),
	refused("meta", { root: 1, time: 6 }),
	refused("meta", { root: "r", time: "6" }),
	refused("meta", { root: "r" }),
])

const LAID = {
	entries: { clock: "clock" },
	file: "apps.text",
	folder: true,
	home: ["r", "apps", 0],
	laid: H1,
}
const EVERY = {
	home: ["r", "docs", 1.5],
	file: "2 cat.png",
	laid: H1,
	was: H2,
	sides: ["2 cat 2.png", "2 cat 3.png"],
	folder: true,
	entries: { docs: ["docs", "1", "2 cat"], "a/b": "a:b" },
	left: ["docs/x"],
	away: true,
}
add("shown", "a layout record holds only what is there, hashes as 32 bytes", [
	...codec("shown", LAID, encode({ ...LAID, laid: B(H1) })),
	...codec("shown", EVERY, encode({ ...EVERY, laid: B(H1), was: B(H2) })),
	...codec("shown", {}, encode({})),
	...codec("shown", { away: true }, encode({ away: true })),
	...codec("shown", { entries: {} }, encode({ entries: {} })),
	// no sides is none written
	s({ op: "encode", codec: "shown", record: { sides: [] } }, { bytes: rec({}) }),
	s({ op: "encode", codec: "shown", record: { laid: "zz" } }, STORE),
	s({ op: "encode", codec: "shown", record: { was: H1.toUpperCase() } }, STORE),
])
add("shown-refused", "a layout record that is not one is a store error", [
	s({ op: "decode", codec: "shown", bytes: "1f" }, STORE),
	...[
		["home"],
		{ home: ["r", "x"] },
		{ home: ["r", "x", "0"] },
		{ home: [1, "x", 0] },
		{ file: 1 },
		{ laid: new Uint8Array(31) },
		{ laid: H1 },
		{ was: new Uint8Array(33) },
		{ sides: ["x", 1] },
		{ folder: false },
		{ entries: { a: 1 } },
		{ entries: { a: [] } },
		{ entries: { a: ["x", 2] } },
		{ entries: [] },
		{ left: "x" },
		{ away: null },
		{ extra: 1 },
	].map((x) => refused("shown", x)),
])

const STEPS = [
	{
		number: 1,
		what: "file",
		to: "clock.txt",
		before: { file: H1 },
		after: { file: H2 },
		id: "c",
		form: "txt",
	},
	{
		number: 2,
		what: "folder",
		to: "docs",
		before: null,
		after: { folder: null },
		slot: ["r", "docs"],
	},
	{
		number: 3,
		what: "rename",
		from: "docs.txt",
		to: "docs/1.txt",
		before: { file: H1 },
		after: { file: H1 },
		id: "d1",
	},
	{
		number: 4,
		what: "link",
		to: "Notes",
		before: null,
		after: { link: ".ermine/id/x9" },
		id: "x9",
	},
	{ number: 5, what: "remove", from: "apps", before: { folder: 1234567 }, after: null },
	{
		number: 6,
		what: "info",
		to: "a.txt",
		before: { file: H1 },
		after: { file: H1 },
		info: [["color", H3, "txt"], ["big", H2, "cbor"]],
	},
	{
		number: 7,
		what: "file",
		to: "a 2.txt",
		before: null,
		after: { file: H2 },
		id: "a",
		form: "float32",
		side: 1,
	},
]
const where = (f: unknown) =>
	f && typeof f === "object" && "file" in f ? { file: B((f as { file: string }).file) } : f
const planned = (steps: typeof STEPS) =>
	encode(
		steps.map((x) => {
			const o: Record<string, unknown> = { ...x, before: where(x.before), after: where(x.after) }
			if (x.info) o.info = x.info.map(([n, h, f]) => [n, B(h), f])
			return o
		}) as never,
	)
const step = (more: Record<string, unknown>) => [{
	number: 1,
	what: "file",
	before: null,
	after: null,
	...more,
}]
add("plan", "a plan: each step's places as hashes, targets and file ids", [
	...codec("plan", STEPS, planned(STEPS)),
	...codec("plan", [], encode([])),
	s({ op: "decode", codec: "plan", bytes: "ff" }, STORE),
	...[
		{},
		[1],
		[{ number: 1, what: "copy", before: null, after: null }],
		[{ number: 1, what: "file", after: null }],
		step({ before: { file: H1 } }),
		step({ before: { file: B(H1), link: "x" } }),
		step({ before: { link: 1 } }),
		step({ before: { folder: "1" } }),
		step({ before: { other: 1 } }),
		step({ before: 1 }),
		step({ slot: ["r"] }),
		step({ slot: ["r", 1] }),
		step({ form: "json" }),
		step({ number: "1" }),
		step({ from: 1 }),
		step({ to: 1 }),
		step({ id: 1 }),
		step({ side: "1" }),
		step({ info: [["a", B(H1)]] }),
		step({ info: [["a", B(H1), "json"]] }),
		step({ info: [[1, B(H1), "txt"]] }),
		step({ extra: 1 }),
	].map((x) => refused("plan", x)),
	s({ op: "encode", codec: "plan", record: step({ after: { file: "x" } }) }, STORE),
])

add("state", "the store record: format 1, done and pass", [
	...codec(
		"state",
		{ format: 1, done: 6, pass: [".DS_Store", "*~"] },
		encode({ format: 1, done: 6, pass: [".DS_Store", "*~"] }),
	),
	...codec("state", { format: 1, done: 0, pass: [] }, encode({ format: 1, done: 0, pass: [] })),
	refused("state", { format: 2, done: 6, pass: [] }),
	refused("state", { format: "1", done: 6, pass: [] }),
	refused("state", { done: 6, pass: [] }),
	refused("state", { format: 1, done: 6 }),
	refused("state", { format: 1, pass: [] }),
	refused("state", { format: 1, done: 6, pass: [1] }),
	refused("state", { format: 1, done: 6, pass: [], extra: 1 }),
	refused("state", [1]),
])

// a node record keeping v and w; a plan expecting files p, q and info i
const nodeOf = (id: string, ...vs: unknown[]) =>
	encode({
		id,
		value: vs.slice(0, 1).map((v) => ({ kept: kept(v, "txt") })),
		info: vs.slice(1).map((v, i) => [`i${i}`, [{ kept: kept(v, "txt") }]]),
		children: [],
		header: {},
	} as never)
const PLANNED = planned([
	{ number: 1, what: "file", to: "x", before: { file: H("p") }, after: { file: H("q") } },
	{ number: 2, what: "info", to: "x", before: null, after: null, info: [["c", H("i"), "txt"]] },
] as never)
add(
	"named",
	"the hashes the records name: each node's kept values, each file and info a plan has",
	[
		s({
			op: "named",
			records: [
				["meta", rec({ root: "r", time: 1 })],
				["node:r", hex(nodeOf("r", "v", "w"))],
				["node:s", hex(nodeOf("s", "v"))],
				["plan", hex(PLANNED)],
				["shown:r", rec({ laid: B(H("laid")) })],
				["store", rec({ format: 1, done: 1, pass: [] })],
				["node", "ff"],
				["sync:host", "ff"],
			],
		}, { hashes: [H("v"), H("w"), H("p"), H("q"), H("i")].sort() }),
		s({ op: "named", records: [] }, { hashes: [] }),
		s({ op: "named", records: [["node:r", "ff"]] }, STORE),
		s({ op: "named", records: [["plan", rec({})]] }, STORE),
	],
)

// ---- the folder

const open = (slack?: number): Request =>
	slack === undefined ? { op: "open" } : { op: "open", slack }
const FOLDERS = ["id", "tmp", "values"]
const files = (fs: [string, Uint8Array | string][], folders = FOLDERS) =>
	s({ op: "files" }, {
		folders,
		files: fs.map(([p, b]) => [p, typeof b === "string" ? b : hex(b)]).sort((a, b) =>
			a[0] < b[0] ? -1 : 1
		),
	})
const records = (rs: [string, string][]) => ({
	records: rs.map(([k, v]) => [k, t(v)]).sort((a, b) => a[0] < b[0] ? -1 : 1),
})
const append = (fr: [string, string | null][], synced = ["manifest"]) =>
	s({ op: "append", frame: fr.map(([k, v]) => [k, v === null ? null : t(v)]) }, { synced })
const raw = (fr: [string, string | null][]) =>
	frame(fr.map(([k, v]) => [k, v === null ? null : r(v)]))
const write = (path: string, bytes: Uint8Array, more: Record<string, unknown> = {}) =>
	s({ op: "write", path, bytes: hex(bytes), ...more })

add("make", "make makes values, tmp and id; no manifest reads as no records", [
	s(open()),
	s({ op: "make" }),
	files([]),
	s({ op: "exists" }, { exists: false }),
	s({ op: "read" }, { records: [] }),
	s({ op: "grown" }, { grown: false }),
	// again changes nothing
	s({ op: "make" }),
	files([]),
])

const A1 = raw([["a", "1"]])
const A2 = raw([["b", "2"], ["a", null]])
add("append", "each append is one frame at the log's end; a new log's folder is synced too", [
	s(open()),
	s({ op: "make" }),
	append([["a", "1"]], ["manifest", "."]),
	s({ op: "exists" }, { exists: true }),
	files([["manifest", A1]]),
	append([["b", "2"], ["a", null]]),
	files([["manifest", cat(A1, A2)]]),
	s({ op: "read" }, records([["b", "2"]])),
	s(open()),
	s({ op: "read" }, records([["b", "2"]])),
])

const F3: [string, string | null][][] = [
	[["a", "1"], ["b", "2"]],
	[["a", null], ["c", "3"], ["é", "4"], ["", "5"], ["aa", "6"]],
	[],
	[["zz", null]],
]
add("frames", "frames read back folded into records, a null key gone, an empty frame nothing", [
	s(open()),
	s({ op: "make" }),
	append(F3[0], ["manifest", "."]),
	append(F3[1]),
	append(F3[2]),
	append(F3[3]),
	files([["manifest", cat(...F3.map(raw))]]),
	s({ op: "read" }, records([["b", "2"], ["c", "3"], ["é", "4"], ["", "5"], ["aa", "6"]])),
])

add("read-written", "a log written by hand reads as its records", [
	s(open()),
	write("manifest", cat(raw([["x", "1"], ["y", "2"]]), raw([["x", "3"]]), raw([["y", null]]))),
	s(open()),
	s({ op: "exists" }, { exists: true }),
	s({ op: "read" }, records([["x", "3"]])),
	// keys given in any order; a key going that was never there
	write("manifest", raw([["bb", "1"], ["a", "2"], ["c", null]])),
	s(open()),
	s({ op: "read" }, records([["a", "2"], ["bb", "1"]])),
])

// cut short: a last frame not whole, or whole in length but not decoding, is dropped, read
// changes nothing, and the next append cuts it off
const C1 = raw([["a", "1"]])
const C2 = raw([["a", "2"], ["b", "2"]])
const CC = raw([["c", "3"]])
const whole = cat(C1, C2)
for (
	const [name, end] of [
		["inside-length", C1.length + 2],
		["only-length", C1.length + 4],
		["inside-body", C1.length + 7],
		["one-short", whole.length - 1],
	] as const
) {
	const short = whole.slice(0, end)
	add(`cut-${name}`, `a last frame cut short (${name}) is dropped and cut off by an append`, [
		s(open()),
		write("manifest", short),
		s(open()),
		s({ op: "read" }, records([["a", "1"]])),
		files([["manifest", short]], []),
		append([["c", "3"]]),
		files([["manifest", cat(C1, CC)]], []),
		s(open()),
		s({ op: "read" }, records([["a", "1"], ["c", "3"]])),
	])
}
const tail = [
	["undecodable", Uint8Array.from([0, 0, 0, 3, 0xff, 0xff, 0xff])],
	// a whole value, then a byte more
	["trailing", framed(cat(encode({ d: buf(1) }), Uint8Array.of(0)))],
	// keys not in canonical order: not deterministic CBOR
	["unsorted", framed(Uint8Array.from([0xa2, 0x61, 0x62, 0x41, 0x01, 0x61, 0x61, 0x41, 0x02]))],
	// an integer not in its shortest form
	["long-integer", framed(Uint8Array.from([0x18, 0x01]))],
] as const
for (const [name, last] of tail) {
	add(
		`cut-${name}`,
		`a last frame whole in length that is not deterministic CBOR (${name}) is cut short`,
		[
			s(open()),
			write("manifest", cat(C1, last)),
			s(open()),
			s({ op: "read" }, records([["a", "1"]])),
			// an append with no read first cuts it off too
			s(open()),
			append([["c", "3"]]),
			files([["manifest", cat(C1, CC)]], []),
		],
	)
}
add("cut-all", "a log of less than one length is no frames; a log there is not synced's folder", [
	s(open()),
	write("manifest", Uint8Array.from([0, 0, 9])),
	s(open()),
	s({ op: "exists" }, { exists: true }),
	s({ op: "read" }, records([])),
	append([["a", "1"]]),
	files([["manifest", C1]], []),
])
add("empty-log", "an empty log exists, holds nothing, and its folder is not synced on append", [
	s(open()),
	write("manifest", new Uint8Array()),
	s(open()),
	s({ op: "exists" }, { exists: true }),
	s({ op: "read" }, records([])),
	append([["a", "1"]]),
	files([["manifest", C1]], []),
])
// a length reaching past the end can only be read as cut short, wherever it is
add("cut-long-length", "a frame whose length runs past the log's end ends it", [
	s(open()),
	write("manifest", cat(C1, Uint8Array.from([0, 0, 0xff, 0xff]), CC)),
	s(open()),
	s({ op: "read" }, records([["a", "1"]])),
])

// broken: a frame before the last that does not decode, or any frame that decodes to what is not
// a map of bytes or null, makes the store invalid; nothing is changed
const B1 = raw([["a", "1"]]), B2 = raw([["b", "2"]]), B3 = raw([["c", "3"]])
const broken = cat(B1, B2, B3)
broken[B1.length + 4] = 0xff
add(
	"broken-middle",
	"a frame before the last that does not decode is a store error",
	[
		s(open()),
		write("manifest", broken),
		s(open()),
		s({ op: "read" }, STORE),
		s(open()),
		append([["d", "4"]]),
		files([["manifest", broken]], []),
	].map((x) => x.request.op === "append" ? s(x.request, STORE) : x),
)
add("broken-unsorted", "a frame before the last that is not deterministic CBOR is a store error", [
	s(open()),
	write("manifest", cat(B1, tail[2][1], B3)),
	s(open()),
	s({ op: "read" }, STORE),
])
const odd: [string, unknown][] = [
	["text", "x"],
	["list", [1]],
	["text-value", { a: "text" }],
	["number-value", { a: 1 }],
	["typed-value", { a: new Int8Array([1]) }],
]
add(
	"broken-not-a-map",
	"a frame, last or not, that is not a map of bytes or null is a store error",
	odd.flatMap(([, x]) => [
		s(open()),
		write("manifest", cat(B1, framed(encode(x as Value)), B3)),
		s(open()),
		s({ op: "read" }, STORE),
		s(open()),
		write("manifest", cat(B1, framed(encode(x as Value)))),
		s(open()),
		s({ op: "read" }, STORE),
	]),
)

// grown: past four times what it holds (each record's key, its bytes, and 4) and slack
const BIG100 = new Uint8Array(100)
const bigFrame = (k: string) => frame([[k, BIG100]])
{
	const steps: Step[] = [s(open(0)), s({ op: "make" }), s({ op: "grown" }, { grown: false })]
	steps.push(s({ op: "read" }, { records: [] }), s({ op: "grown" }, { grown: false }))
	let size = 0
	const held = 1 + 100 + 4
	for (let i = 0; i < 5; i++) {
		size += bigFrame("a").length
		steps.push(s({ op: "append", frame: [["a", hex(BIG100)]] }, {
			synced: i ? ["manifest"] : ["manifest", "."],
		}))
		steps.push(s({ op: "grown" }, { grown: size > 4 * held }))
	}
	// a key gone holds nothing
	steps.push(s({ op: "append", frame: [["b", t("12")]] }, { synced: ["manifest"] }))
	steps.push(s({ op: "grown" }, { grown: size + raw([["b", "12"]]).length > 4 * (held + 7) }))
	steps.push(s({ op: "append", frame: [["a", null]] }, { synced: ["manifest"] }))
	steps.push(s({ op: "grown" }, { grown: true }))
	// unread, nothing has grown; slack counts
	steps.push(s(open(0)), s({ op: "grown" }, { grown: false }))
	steps.push(
		s(open(1 << 20)),
		s({ op: "read" }, records([["b", "12"]])),
		s({ op: "grown" }, { grown: false }),
	)
	add("grown", "a log has grown past four times what it holds, and slack", steps)
}

// kept values
const PUT: unknown[] = [
	"12:00",
	PNG,
	new Float32Array([1, NaN]),
	new BigInt64Array([-5n]),
	{ theme: "dark" },
	null,
	new Stand("clock"),
]
const formOf = (v: unknown) =>
	typeof v === "string"
		? "txt"
		: v instanceof Uint8Array
		? "bin"
		: ArrayBuffer.isView(v)
		? KINDS.find(([, x]) => (x as object).constructor === v.constructor)![0]
		: "cbor"
const fileOf = (v: unknown) => {
	const f = formOf(v)
	return f === "txt"
		? t(v as string)
		: f === "bin"
		? hex(v as Uint8Array)
		: f === "cbor"
		? hex(encode(v as Value))
		: elements(v as ArrayBufferView)
}
add("put", "a value is kept once, by its hash, through tmp, synced, then its folder", [
	s(open()),
	s({ op: "make" }),
	...PUT.flatMap((v) => [
		s({ op: "put", value: J(v) }, { kept: [H(v), formOf(v)], synced: [`tmp/${H(v)}`, "values"] }),
		s({ op: "get", hash: H(v), form: formOf(v) }, { value: J(v) }),
	]),
	// already kept: nothing written
	s({ op: "put", value: "12:00" }, { kept: [H("12:00"), "txt"], synced: [] }),
	files(PUT.map((v) => [`values/${H(v)}`, fileOf(v)])),
])
add("put-hash", "a hash given is trusted; the file then does not hash to its name", [
	s(open()),
	s({ op: "make" }),
	s({ op: "put", value: "x", hash: H("y") }, {
		kept: [H("y"), "txt"],
		synced: [`tmp/${H("y")}`, "values"],
	}),
	files([[`values/${H("y")}`, t("x")]]),
	s({ op: "get", hash: H("y"), form: "txt" }, STORE),
])
add("get-refused", "a kept value missing, misnamed or not hashing to its name is a store error", [
	s(open()),
	s({ op: "make" }),
	s({ op: "put", value: "12:00" }, {
		kept: [H("12:00"), "txt"],
		synced: [`tmp/${H("12:00")}`, "values"],
	}),
	s({ op: "get", hash: H("other"), form: "txt" }, STORE),
	s({ op: "get", hash: "./.", form: "txt" }, STORE),
	s({ op: "get", hash: H("12:00").toUpperCase(), form: "txt" }, STORE),
	s({ op: "get", hash: H("12:00"), form: "json" }, STORE),
	// the file read in another form
	s({ op: "get", hash: H("12:00"), form: "bin" }, STORE),
	s({ op: "get", hash: H("12:00"), form: "cbor" }, STORE),
	write(`values/${H("12:00")}`, r("12:30")),
	s({ op: "get", hash: H("12:00"), form: "txt" }, STORE),
	write(`values/${H({ a: 1 })}`, Uint8Array.of(0xff)),
	s({ op: "get", hash: H({ a: 1 }), form: "cbor" }, STORE),
	write(`values/${H(new Float64Array([1]))}`, new Uint8Array(7)),
	s({ op: "get", hash: H(new Float64Array([1])), form: "float64" }, STORE),
	write(`values/${H("bad")}`, Uint8Array.of(0xff)),
	s({ op: "get", hash: H("bad"), form: "txt" }, STORE),
])

// a fold: one frame through tmp, then the kept files no record names go
{
	const nodeR = nodeOf("r", "node's")
	const plan = planned([
		{
			number: 1,
			what: "file",
			to: "x.txt",
			before: null,
			after: { file: H("plan's") },
			form: "txt",
		},
		{
			number: 2,
			what: "info",
			to: "x.txt",
			before: null,
			after: null,
			info: [["c", H("info's"), "txt"]],
		},
	] as never)
	const recs: [string, Uint8Array][] = [
		["meta", encode({ root: "r", time: 6 })],
		["node:r", nodeR],
		["shown:r", encode({ folder: true, laid: B(H("nobody's")) })],
		["store", encode({ format: 1, done: 6, pass: [] })],
		["plan", plan],
		["sync:host", r("theirs")],
	]
	const UPPER = H("upper").toUpperCase()
	const steps: Step[] = [s(open(0)), s({ op: "make" })]
	for (const v of ["node's", "plan's", "info's", "nobody's"]) {
		steps.push(
			s({ op: "put", value: v }, { kept: [H(v), "txt"], synced: [`tmp/${H(v)}`, "values"] }),
		)
	}
	steps.push(write("values/notes", r("mine")), write(`values/${UPPER}`, r("upper")))
	const log: Uint8Array[] = []
	for (let i = 0; i < 3; i++) {
		const fr: [string, Uint8Array | null][] = [["node:r", nodeR], ["x", r(`${i}`)]]
		steps.push(s({ op: "append", frame: fr.map(([k, v]) => [k, v && hex(v)]) }, {
			synced: i ? ["manifest"] : ["manifest", "."],
		}))
		log.push(frame(fr))
	}
	// appends remove nothing
	steps.push(files([
		["manifest", cat(...log)],
		...["node's", "plan's", "info's", "nobody's"].map((v) =>
			[`values/${H(v)}`, t(v)] as [string, string]
		),
		["values/notes", t("mine")],
		[`values/${UPPER}`, t("upper")],
	]))
	const folded = frame(recs)
	steps.push(
		s({ op: "fold", records: recs.map(([k, v]) => [k, hex(v)]) }, {
			synced: ["tmp/manifest", "."],
		}),
	)
	steps.push(s({ op: "grown" }, { grown: false }))
	const after: [string, string][] = [
		["manifest", hex(folded)],
		...["node's", "plan's", "info's"].map((v) => [`values/${H(v)}`, t(v)] as [string, string]),
		["values/notes", t("mine")],
		[`values/${UPPER}`, t("upper")],
	]
	steps.push(files(after))
	steps.push(
		s(open()),
		s({ op: "read" }, {
			records: recs.map(([k, v]) => [k, hex(v)]).sort((a, b) => a[0] < b[0] ? -1 : 1),
		}),
	)
	// appends go on after a fold
	steps.push(append([["y", "1"]]))
	after[0] = ["manifest", hex(cat(folded, raw([["y", "1"]])))]
	steps.push(files(after))
	add("fold", "a fold is one frame through tmp, then removes the kept files nothing names", steps)
}
add("fold-cut", "a fold replaces a last frame cut short", [
	s(open()),
	s({ op: "make" }),
	append([["a", "1"]], ["manifest", "."]),
	write("manifest", Uint8Array.from([0, 0, 9]), { append: true }),
	s({ op: "read" }, records([["a", "1"]])),
	s({ op: "fold", records: [["a", t("1")]] }, { synced: ["tmp/manifest", "."] }),
	append([["b", "2"]]),
	files([["manifest", cat(C1, raw([["b", "2"]]))]]),
])
add("fold-unmade", "a fold makes tmp/ when it is missing; no values/ is nothing to remove", [
	s(open()),
	s({ op: "fold", records: [] }, { synced: ["tmp/manifest", "."] }),
	files([["manifest", framed(encode({}))]], ["tmp"]),
	s({ op: "read" }, { records: [] }),
])

// ---- write: JSON, with -0 written -0
const MINUS = "\u0000-0\u0000"
for await (const f of Deno.readDir(out)) {
	if (f.name.endsWith(".json")) await Deno.remove(new URL(f.name, out))
}
all.forEach(({ name, scenario }, i) => {
	const file = `${String(i + 1).padStart(2, "0")}-${name}.json`
	const text = JSON.stringify(scenario, (_, v) => Object.is(v, -0) ? MINUS : v, "\t")
		.replaceAll(JSON.stringify(MINUS), "-0")
	Deno.writeTextFileSync(new URL(file, out), text + "\n")
})
console.log(`${all.length} scenarios`)
