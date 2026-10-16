import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert"
import { decode, encode, type Value } from "@ermine/encoding/cbor"
import createNode, { type Node as Saved } from "./saved.ts"
import * as pack from "./saved.ts"
import * as diag from "./diag.ts"
import * as manifest from "./manifest.ts"
import { digest, META, NODE } from "./manifest.ts"
import type { Sys } from "./sys.ts"
import { FormError, type Layout, type State, type Step, StoreError } from "./types.ts"

// a run that may not write or call the system, as newcore's own deno task test, skips what needs to
const granted = (["write", "ffi"] as const).every((name) =>
	Deno.permissions.querySync({ name }).state === "granted"
)
/** A test that writes a temporary folder. */
const disk = (name: string, fn: () => Promise<void>) => Deno.test({ name, ignore: !granted, fn })

type Json = Value
const site = { file: "manifest_test.ts", line: 1, column: 1 }
const utf8 = new TextEncoder()
const b = (s: string) => utf8.encode(s)

/** Two values are the same when their deterministic CBOR is. */
function same(a: unknown, x: unknown) {
	assertEquals(encode(a as Value), encode(x as Value))
}

/** A hash's 32 bytes, as a record holds them. */
function bytes(h: string): Uint8Array {
	return new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)))
}

/** The platform calls a manifest makes: only syncs, recorded. Nothing here reaches a Trash. */
function calls(): Sys & { synced: string[] } {
	const synced: string[] = []
	const no = () => Promise.reject(new Error("not a manifest's call"))
	return {
		synced,
		get: no,
		set: no,
		unset: no,
		names: no,
		swap: no,
		rename: no,
		clone: no,
		id: no,
		trash: no,
		sync: (path) => {
			synced.push(path)
			return Promise.resolve()
		},
	}
}

/** A temporary .ermine, made, removed after fn. */
async function within(
	fn: (dir: string, sys: ReturnType<typeof calls>) => Promise<void>,
): Promise<void> {
	const root = await Deno.makeTempDir()
	const dir = `${root}/.ermine`
	try {
		const sys = calls()
		await manifest.manifest(dir, sys).make()
		await fn(dir, sys)
	} finally {
		await Deno.remove(root, { recursive: true })
	}
}

const listing = async (path: string) =>
	(await Array.fromAsync(Deno.readDir(path))).map((e) => e.name).sort()

// values

Deno.test("a value's form is txt, bin, its kind, or cbor", () => {
	assertEquals(manifest.form("hi"), "txt")
	assertEquals(manifest.form(new Uint8Array(2)), "bin")
	assertEquals(manifest.form(new Uint8Array(4).subarray(1, 3)), "bin")
	assertEquals(manifest.form(new Int8Array(2)), "int8")
	assertEquals(manifest.form(new Float32Array(1)), "float32")
	assertEquals(manifest.form(new BigInt64Array(1)), "int64")
	for (const v of [null, true, 1, -0, [], {}, { a: "x" }, ["x"]]) {
		assertEquals(manifest.form(v as Value), "cbor")
	}
})

Deno.test("a file holds a string's UTF-8, bytes as they are, and a typed array's elements", () => {
	const text = "﻿café 🐈\n"
	assertEquals(manifest.render(text, "txt"), b(text))
	assertEquals(manifest.parse(b(text), "txt"), text)
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
	assertEquals(manifest.render(png, "bin"), png)
	same(manifest.parse(png, "bin"), png)
	// a view's own bytes; parsed, fresh
	assertEquals(manifest.render(new Uint8Array([9, ...png, 9]).subarray(1, 5), "bin"), png)
	assert(manifest.parse(png, "bin") !== png)
	assertEquals(
		manifest.render(new Float32Array([1]), "float32"),
		new Uint8Array([0, 0, 0x80, 0x3f]),
	)
	assertEquals(manifest.render(new Uint16Array([0x0102]), "uint16"), new Uint8Array([2, 1]))
	for (
		const v of [
			new Float64Array([-0, NaN, Infinity, 1e300]),
			new BigInt64Array([-5n, 1n << 62n]),
			new BigUint64Array([2n ** 64n - 1n]),
			new Int8Array([-1, 127]),
			new Uint16Array([]),
			new Int32Array([-(2 ** 31)]),
		]
	) {
		const f = manifest.form(v)
		same(manifest.parse(manifest.render(v, f), f), v)
	}
})

Deno.test("a file that does not read as its form is a form error", () => {
	assertThrows(() => manifest.parse(new Uint8Array([0xff]), "txt"), FormError)
	assertThrows(() => manifest.parse(new Uint8Array([0xc3, 0x28]), "cbor"), FormError)
	assertThrows(() => manifest.parse(new Uint8Array(3), "float32"), FormError)
	assertThrows(() => manifest.parse(new Uint8Array(9), "int64"), FormError)
})

Deno.test("a value is rendered only in its own form", () => {
	assertThrows(() => manifest.render(5, "txt"))
	assertThrows(() => manifest.render("x", "bin"))
	assertThrows(() => manifest.render("x", "cbor"))
	assertThrows(() => manifest.render(new Float32Array(1), "float64"))
})

Deno.test("a cbor value's file is its diagnostic notation", () => {
	for (
		const v of [null, true, 1, [1, "two", null], { theme: "dark", n: -0, b: new Uint8Array(2) }]
	) {
		const text = manifest.render(v, "cbor")
		assertEquals(new TextDecoder().decode(text), diag.write(v as Value))
		same(manifest.parse(text, "cbor"), v)
	}
	const e = assertThrows(() => manifest.parse(b('{"a": '), "cbor"), FormError)
	assert(typeof e.at === "number")
})

Deno.test("a value's hash is the BLAKE3 of its deterministic CBOR", () => {
	for (const v of ["hi", null, { a: [1, 2] }, new Float32Array([1, NaN])]) {
		const h = manifest.hash(v)
		assertEquals(h, digest(encode(v as Value)))
		assert(/^[0-9a-f]{64}$/.test(h))
	}
	assertEquals(manifest.hash({ a: 1, b: 2 }), manifest.hash({ b: 2, a: 1 }))
})

// node records

/** A node as newcore makes one, with every kind of field. */
function sample(): Saved<unknown, unknown> {
	const change = (t: number) => ({ time: t, actor: "host", node: "n", site })
	return createNode<unknown, unknown>("n", {
		value: [
			{ content: "12:00", change: change(1) },
			{
				content: new Float32Array([1.5, NaN]),
				change: change(2),
				because: { layer: "sync", place: 1 },
			},
			{ content: () => 1, change: change(3) },
		],
		attributes: [
			["color", [{ content: "red", change: change(4) }]],
			["big", [{ content: { a: [1, null, true], n: -0 }, change: change(5) }, {
				content: 5,
				change: change(6),
			}]],
			["none", []],
		],
		children: [
			["docs", [{ content: ["d1", Symbol("x"), "e1", "d2"], change: change(7) }, {
				content: ["d3"],
				change: change(8),
			}]],
			["empty", [{ content: [], change: change(9) }]],
		],
	}, { header: { time: 1, actor: "host", site } })
}

Deno.test("a node's record is as pack writes it, each content kept by its hash", () => {
	const n = sample()
	const s = manifest.save(n, (id) => id === "e1")
	const r = decode(s.record) as { [k: string]: Value }
	const v = r.value as { [k: string]: Value }[]
	// the live value is left out
	assertEquals(v.length, 2)
	same(v[0].kept, [bytes(manifest.hash("12:00")), "txt"])
	assert(!("content" in v[0]))
	same(v[1].because, { layer: "sync", place: 1 })
	// a symbol and an ephemeral id are left out of a list
	same((r.children as Value[])[0], [
		"docs",
		[{ content: ["d1", "d2"], change: { time: 7, actor: "host", node: "n", site } }, {
			content: ["d3"],
			change: { time: 8, actor: "host", node: "n", site },
		}],
	])
	assertEquals(s.values.size, 5)
	assertEquals(manifest.kepts(s.record).map(([, f]) => f), [
		"txt",
		"float32",
		"txt",
		"cbor",
		"cbor",
	])
	// and back
	const back = manifest.restore(s.record, (h) => s.values.get(h)!)
	same(
		pack.encode(back),
		pack.encode(createNode<unknown, unknown>("n", {
			value: n.value.slice(0, 2),
			attributes: n.attributes,
			children: [
				["docs", [
					{ ...n.children.get("docs")![0], content: ["d1", "d2"] },
					n.children.get("docs")![1],
				]],
				["empty", n.children.get("empty")!],
			],
		}, { header: n.change })),
	)
})

Deno.test("a node's shape: its first value, its sides, its info's first versions, its first lists", () => {
	const s = manifest.save(sample())
	const x = s.shape
	assertEquals(x.kept, [manifest.hash("12:00"), "txt"])
	assertEquals(x.sides.map(([h, f]) => [h, f]), [[
		manifest.hash(new Float32Array([1.5, NaN])),
		"float32",
	]])
	assertEquals(x.info, [
		["color", manifest.hash("red"), "txt"],
		["big", manifest.hash({ a: [1, null, true], n: -0 }), "cbor"],
	])
	assertEquals([...x.directory], [["docs", ["d1", "e1", "d2"]]])
	// no value shows as null; a bin value has its first bytes
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6])
	assertEquals(manifest.save(createNode<unknown, unknown>("e")).shape.kept, [
		manifest.NULL,
		"cbor",
	])
	const b = manifest.save(
		createNode<unknown, unknown>("b", { value: [{ content: png, change: undefined }] }),
	).shape
	assertEquals(b.head, new Uint8Array(png.slice(0, 12)))
})

Deno.test("a change that cannot be saved is a store error; a record that is not one too", () => {
	assertThrows(
		() =>
			manifest.save(
				createNode<unknown, unknown>("n", { value: [{ content: 1, change: { f: () => 1 } }] }),
			),
		StoreError,
	)
	assertThrows(() => manifest.kepts(new Uint8Array([0xff])), StoreError)
	assertThrows(() => manifest.kepts(encode({ value: [{ content: "x" }], info: [] })), StoreError)
	assertThrows(
		() => manifest.kepts(encode({ value: [{ kept: [new Uint8Array(31), "txt"] }], info: [] })),
		StoreError,
	)
	assertThrows(
		() => manifest.kepts(encode({ value: [{ kept: [new Uint8Array(32), "json"] }], info: [] })),
		StoreError,
	)
	const bad = encode({ id: 1, value: [], info: [], children: [], header: {} })
	assertThrows(() => manifest.restore(bad, () => null), StoreError)
})

// the other records

const h1 = manifest.hash("a")
const h2 = manifest.hash("b")

Deno.test("a layout record is the paper's", () => {
	const a: Layout = {
		entries: new Map([["clock", "clock"]]),
		file: "apps.text",
		folder: true,
		home: ["r", "apps", 0],
		laid: h1,
	}
	assertEquals(
		manifest.shown.encode(a),
		encode({
			entries: { clock: "clock" },
			file: "apps.text",
			folder: true,
			home: ["r", "apps", 0],
			laid: bytes(h1),
		}),
	)
	const all: Layout = {
		home: ["r", "docs", 1],
		file: "2 cat.png",
		laid: h1,
		was: h2,
		folder: true,
		entries: new Map<string, string | string[]>([["docs", ["docs", "1", "2 cat"]], [
			"a/b",
			"a:b",
		]]),
		left: ["docs/x"],
		away: true,
	}
	for (const x of [a, all, {}, { away: true as const }]) {
		assertEquals(manifest.shown.decode(manifest.shown.encode(x)), x)
	}
})

Deno.test("a layout record that is not one is a store error", () => {
	for (
		const r of [
			["home"],
			{ home: ["r", "x"] },
			{ home: ["r", "x", "0"] },
			{ file: 1 },
			{ laid: new Uint8Array(31) },
			{ laid: h1 },
			{ folder: false },
			{ entries: { a: 1 } },
			{ entries: { a: [] } },
			{ left: "x" },
			{ away: null },
			{ extra: 1 },
		]
	) assertThrows(() => manifest.shown.decode(encode(r as Value)), StoreError)
	assertThrows(() => manifest.shown.decode(new Uint8Array([0x1f])), StoreError)
})

Deno.test("a plan round trips, each step's places as hashes, targets and file ids", () => {
	const steps: Step[] = [
		{
			number: 1,
			what: "file",
			to: "clock.txt",
			before: { file: h1 },
			after: { file: h2 },
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
			before: { file: h1 },
			after: { file: h1 },
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
	]
	assertEquals(manifest.plan.decode(manifest.plan.encode(steps)), steps)
	assertEquals(manifest.plan.decode(manifest.plan.encode([])), [])
	same(decode(manifest.plan.encode([steps[0]])), [
		{
			number: 1,
			what: "file",
			to: "clock.txt",
			before: { file: bytes(h1) },
			after: { file: bytes(h2) },
			id: "c",
			form: "txt",
		},
	])
	for (
		const r of [
			{},
			[{ number: 1, what: "copy", before: null, after: null }],
			[{ number: 1, what: "file", after: null }],
			[{ number: 1, what: "file", before: { file: h1 }, after: null }],
			[{ number: 1, what: "file", before: { file: bytes(h1), link: "x" }, after: null }],
			[{ number: 1, what: "file", before: null, after: null, slot: ["r"] }],
			[{ number: 1, what: "file", before: null, after: null, form: "json" }],
			[{ number: "1", what: "file", before: null, after: null }],
		]
	) assertThrows(() => manifest.plan.decode(encode(r as Value)), StoreError)
})

Deno.test("the store record has format 1, done and pass", () => {
	const s: State = { format: 1, done: 6, pass: [".DS_Store", "*~"] }
	assertEquals(manifest.state.encode(s), encode({ done: 6, format: 1, pass: [".DS_Store", "*~"] }))
	assertEquals(manifest.state.decode(manifest.state.encode(s)), s)
	assertThrows(() => manifest.state.decode(encode({ format: 2, done: 6, pass: [] })), StoreError)
	assertThrows(() => manifest.state.decode(encode({ format: 1, done: 6 })), StoreError)
	assertThrows(() => manifest.state.decode(encode({ format: 1, done: 6, pass: [1] })), StoreError)
})

// the folder

disk("make makes values, tmp and id; a manifest exists once a frame is appended", async () => {
	await within(async (dir, sys) => {
		assertEquals(await listing(dir), ["id", "tmp", "values"])
		const m = manifest.manifest(dir, sys)
		assert(!(await m.exists()))
		assertEquals(await m.read(), new Map())
		await m.append(new Map([["a", b("1")]]))
		assert(await m.exists())
		// a new log is synced, then its folder
		assertEquals(sys.synced, [`${dir}/manifest`, dir])
	})
})

disk("frames are read back folded into records, deletes applied", async () => {
	await within(async (dir, sys) => {
		const m = manifest.manifest(dir, sys)
		await m.append(new Map([["a", b("1")], ["b", b("2")]]))
		await m.append(new Map([["a", null], ["c", b("3")], ["__proto__", b("4")]]))
		await m.append(new Map())
		const again = await manifest.manifest(dir, sys).read()
		assertEquals(again, new Map([["b", b("2")], ["c", b("3")], ["__proto__", b("4")]]))
		// each frame is a length, then the CBOR of a map of bytes
		const log = await Deno.readFile(`${dir}/manifest`)
		const n = new DataView(log.buffer).getUint32(0)
		same(decode(log.subarray(4, 4 + n)), { a: b("1"), b: b("2") })
	})
})

disk(
	"a last frame cut short is dropped, read changes nothing, and append cuts it off",
	async () => {
		await within(async (dir, sys) => {
			const path = `${dir}/manifest`
			const m = manifest.manifest(dir, sys)
			await m.append(new Map([["a", b("1")]]))
			const first = (await Deno.readFile(path)).length
			await m.append(new Map([["a", b("2")], ["b", b("2")]]))
			const whole = await Deno.readFile(path)
			// inside the length, inside the body, and one byte short
			for (const end of [first + 2, first + 4, first + 7, whole.length - 1]) {
				const short = whole.slice(0, end)
				await Deno.writeFile(path, short)
				const fresh = manifest.manifest(dir, sys)
				assertEquals(await fresh.read(), new Map([["a", b("1")]]))
				assertEquals(await Deno.readFile(path), short)
				await fresh.append(new Map([["c", b("3")]]))
				assertEquals(
					await manifest.manifest(dir, sys).read(),
					new Map([["a", b("1")], ["c", b("3")]]),
				)
				assertEquals((await Deno.readFile(path)).subarray(0, first), whole.subarray(0, first))
			}
			// a last frame whole in length that does not decode is cut short too
			await Deno.writeFile(path, whole.slice(0, first))
			await Deno.writeFile(path, new Uint8Array([0, 0, 0, 3, 0xff, 0xff, 0xff]), {
				append: true,
			})
			assertEquals(await manifest.manifest(dir, sys).read(), new Map([["a", b("1")]]))
			// and an append with no read first still cuts it off
			await manifest.manifest(dir, sys).append(new Map([["d", b("4")]]))
			assertEquals(
				await manifest.manifest(dir, sys).read(),
				new Map([["a", b("1")], ["d", b("4")]]),
			)
		})
	},
)

disk("a broken frame before the last makes the store invalid", async () => {
	await within(async (dir, sys) => {
		const path = `${dir}/manifest`
		const m = manifest.manifest(dir, sys)
		await m.append(new Map([["a", b("1")]]))
		const first = (await Deno.readFile(path)).length
		await m.append(new Map([["b", b("2")]]))
		await m.append(new Map([["c", b("3")]]))
		const whole = await Deno.readFile(path)
		// the middle frame's map head made a byte that is no CBOR
		const broken = whole.slice()
		broken[first + 4] = 0xff
		await Deno.writeFile(path, broken)
		await assertRejects(() => manifest.manifest(dir, sys).read(), StoreError)
		await assertRejects(() => manifest.manifest(dir, sys).append(new Map()), StoreError)
		assertEquals(await Deno.readFile(path), broken)
		// a frame that decodes to something not a map of bytes, anywhere, is broken too
		const odd = (x: Value) => {
			const body = encode(x)
			const out = new Uint8Array(4 + body.length)
			new DataView(out.buffer).setUint32(0, body.length)
			out.set(body, 4)
			return out
		}
		for (const x of ["x", { a: "text" }, [1]]) {
			await Deno.writeFile(path, whole.slice(0, first))
			await Deno.writeFile(path, odd(x), { append: true })
			await assertRejects(() => manifest.manifest(dir, sys).read(), StoreError)
		}
	})
})

disk("a manifest has grown past four times what it holds and slack", async () => {
	await within(async (dir, sys) => {
		const m = manifest.manifest(dir, sys, { slack: 0 })
		assert(!m.grown())
		await m.read()
		assert(!m.grown())
		const big = new Uint8Array(100)
		await m.append(new Map([["a", big]]))
		assert(!m.grown())
		for (let i = 0; i < 4; i++) await m.append(new Map([["a", big]]))
		assert(m.grown())
		const roomy = manifest.manifest(dir, sys, { slack: 1 << 20 })
		await roomy.read()
		assert(!roomy.grown())
	})
})

disk("values are kept once, through tmp, synced, by their hash", async () => {
	await within(async (dir, sys) => {
		const m = manifest.manifest(dir, sys)
		const values: Json[] = [
			"12:00",
			new Uint8Array([0x89, 0x50]),
			new Float32Array([1, NaN]),
			{ theme: "dark" },
			null,
		]
		for (const v of values) {
			sys.synced.length = 0
			const [h, f] = await m.put(v)
			assertEquals([h, f], [manifest.hash(v), manifest.form(v)])
			const file = await Deno.readFile(`${dir}/values/${h}`)
			assertEquals(file, f === "cbor" ? encode(v as Value) : manifest.render(v, f))
			same(await m.get(h, f), v)
			assertEquals(sys.synced, [`${dir}/tmp/${h}`, `${dir}/values`])
		}
		assertEquals(await listing(`${dir}/tmp`), [])
		// a value already kept, or being kept, is written once
		sys.synced.length = 0
		await m.put("12:00")
		assertEquals(sys.synced, [])
		await Promise.all([m.put("once"), m.put("once"), m.put("once")])
		assertEquals(sys.synced.length, 2)
		assertEquals((await listing(`${dir}/values`)).length, values.length + 1)
	})
})

disk("a kept value missing or not hashing to its name is a store error", async () => {
	await within(async (dir, sys) => {
		const m = manifest.manifest(dir, sys)
		const [h, f] = await m.put("12:00")
		await assertRejects(() => m.get(manifest.hash("other"), "txt"), StoreError)
		await assertRejects(() => m.get("../manifest", "txt"), StoreError)
		await assertRejects(() => m.get(h, "json" as never), StoreError)
		await Deno.writeFile(`${dir}/values/${h}`, b("12:30"))
		await assertRejects(() => m.get(h, f), StoreError)
		const [g] = await m.put({ a: 1 })
		await Deno.writeFile(`${dir}/values/${g}`, new Uint8Array([0x01]))
		await assertRejects(() => m.get(g, "cbor"), StoreError)
		const [t] = await m.put(new Float64Array([1]))
		await Deno.writeFile(`${dir}/values/${t}`, new Uint8Array(7))
		await assertRejects(() => m.get(t, "float64"), StoreError)
	})
})

disk("a fold is one frame, through tmp, and then removes the values nothing names", async () => {
	await within(async (dir, sys) => {
		const m = manifest.manifest(dir, sys, { slack: 0 })
		const [n1] = await m.put("node's")
		const [p1] = await m.put("plan's")
		const [o1] = await m.put("nobody's")
		const node = manifest.save(
			createNode<unknown, unknown>("r", { value: [{ content: "node's", change: null }] }),
		).record
		const records = new Map<string, Uint8Array>([
			[META, encode({ root: "r", time: 6 })],
			[NODE + "r", node],
			[manifest.SHOWN + "r", manifest.shown.encode({ folder: true, laid: o1 })],
			[manifest.STORE, manifest.state.encode({ format: 1, done: 6, pass: [] })],
			[
				manifest.PLAN,
				manifest.plan.encode([{
					number: 1,
					what: "file",
					to: "x.txt",
					before: null,
					after: { file: p1 },
					form: "txt",
				}]),
			],
			["sync:host", b("theirs")],
		])
		for (let i = 0; i < 40; i++) await m.append(new Map([[NODE + "r", node], ["x", b(`${i}`)]]))
		await m.append(new Map([["x", null]]))
		await m.append(records)
		assert(m.grown())
		sys.synced.length = 0
		await m.fold(records)
		assert(!m.grown())
		assertEquals(sys.synced, [`${dir}/tmp/manifest`, dir])
		const log = await Deno.readFile(`${dir}/manifest`)
		assertEquals(new DataView(log.buffer).getUint32(0), log.length - 4)
		assertEquals(await manifest.manifest(dir, sys).read(), records)
		assertEquals(await listing(`${dir}/tmp`), [])
		assertEquals(await listing(`${dir}/values`), [n1, p1].sort())
		assert(!(await listing(`${dir}/values`)).includes(o1))
		// appends go on after a fold
		await m.append(new Map([["y", b("1")]]))
		assertEquals((await manifest.manifest(dir, sys).read()).get("y"), b("1"))
	})
})

disk("a fold replaces a last frame cut short", async () => {
	await within(async (dir, sys) => {
		const path = `${dir}/manifest`
		const m = manifest.manifest(dir, sys)
		await m.append(new Map([["a", b("1")]]))
		await Deno.writeFile(path, new Uint8Array([0, 0, 9]), { append: true })
		const records = await m.read()
		await m.fold(records)
		await m.append(new Map([["b", b("2")]]))
		assertEquals(
			await manifest.manifest(dir, sys).read(),
			new Map([["a", b("1")], ["b", b("2")]]),
		)
	})
})

/** A small seeded random number generator: mulberry32. */
function random(seed: number) {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

disk("for a few dozen seeds, appends, cuts and folds read back as the records", async () => {
	await within(async (dir, sys) => {
		const path = `${dir}/manifest`
		for (let seed = 1; seed <= 30; seed++) {
			const r = random(seed)
			await Deno.remove(path).catch(() => {})
			let m = manifest.manifest(dir, sys, { slack: 64 })
			const model = new Map<string, Uint8Array>()
			let before = new Map<string, Uint8Array>()
			let start = 0
			const frames = 1 + Math.floor(r() * 8)
			for (let i = 0; i < frames; i++) {
				const batch = new Map<string, Uint8Array | null>()
				for (let j = Math.floor(r() * 4); j >= 0; j--) {
					const k = `k${Math.floor(r() * 5)}`
					batch.set(
						k,
						r() < 0.25 ? null : new Uint8Array(Math.floor(r() * 40)).map(() => r() * 256),
					)
				}
				before = new Map(model)
				start = (await Deno.stat(path).catch(() => ({ size: 0 }))).size
				await m.append(batch)
				for (const [k, v] of batch) v === null ? model.delete(k) : model.set(k, v)
				if (r() < 0.2 && m.grown()) {
					await m.fold(model)
					before = new Map(model)
					start = (await Deno.stat(path)).size
				}
			}
			assertEquals(await manifest.manifest(dir, sys).read(), model)
			// cut the log anywhere in its last frame: it reads as before that frame
			const whole = await Deno.readFile(path)
			if (whole.length > start) {
				const end = start + Math.floor(r() * (whole.length - start))
				await Deno.writeFile(path, whole.slice(0, end))
				m = manifest.manifest(dir, sys, { slack: 64 })
				assertEquals(await m.read(), before)
				await m.append(new Map([["after", b(`${seed}`)]]))
				before.set("after", b(`${seed}`))
				assertEquals(await manifest.manifest(dir, sys).read(), before)
			}
		}
	})
})

Deno.test("a text's and a bytes' hash is its CBOR's, at every head size", () => {
	const sizes = new Set<number>()
	for (let n = 0; n <= 300; n++) sizes.add(n)
	for (const edge of [23, 24, 255, 256, 65535, 65536]) {
		for (let n = edge - 3; n <= edge + 3; n++) sizes.add(n)
	}
	for (const n of sizes) {
		// text: of characters of one, two, three and four UTF-8 bytes
		for (const c of ["a", "é", "€", "\u{1f600}"]) {
			const s = c.repeat(Math.ceil(n / c.length)).slice(0, n)
			if (!s.isWellFormed()) continue
			assertEquals(manifest.hash(s), digest(encode(s)), `text of ${n} ${c}`)
		}
		const bin = new Uint8Array(n).map((_, i) => (i * 7 + 3) & 0xff)
		assertEquals(manifest.hash(bin), digest(encode(bin)), `${n} bytes`)
	}
	assertEquals(manifest.hash(""), digest(encode("")))
	assertEquals(manifest.hash(new Uint8Array(0)), digest(encode(new Uint8Array(0))))
	const view = new Uint8Array([1, 2, 3, 4]).subarray(1, 3)
	assertEquals(manifest.hash(view), digest(encode(new Uint8Array([2, 3]))))
	assertThrows(() => manifest.hash("a\ud800"), Error, "lone surrogate")
	assertThrows(() => manifest.hash("x".repeat(30) + "\udc00"), Error, "lone surrogate")
})

Deno.test("a saving's shape is built when asked, and a record opened gives the same", () => {
	const s = manifest.save(sample())
	assertEquals(s.shape, manifest.shape(s.record, () => undefined))
	assert(s.shape === s.shape)
	const r = manifest.opened(s.record)
	assertEquals(manifest.kepts(r), manifest.kepts(s.record))
	assertEquals(manifest.shape(r, () => undefined), s.shape)
})
