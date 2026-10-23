import { assert, assertEquals, assertRejects } from "@std/assert"
import { decode, type Value } from "@ermine/encoding/cbor"
import createNode, { type List, type Node as Saved } from "./saved.ts"
import * as pack from "./saved.ts"
import * as manifest from "./manifest.ts"
import * as names from "./names.ts"
import { type Restored, type Store, store as make } from "./store.ts"
import { attr, fake, type Sys, system, type Trash } from "./sys.ts"
import { type Id, type Listed, type Options, StoreError } from "./types.ts"

type Json = Value
type N = Saved<unknown, unknown>

// Every test works in a folder of its own from Deno.makeTempDir, and sends
// to a fake Trash there: the real Trash is never asked.

// a run that may not write or call the system, as newcore's own deno task test, skips what needs to
const granted = (["write", "ffi"] as const).every((name) =>
	Deno.permissions.querySync({ name }).state === "granted"
)
const mac = Deno.build.os === "darwin" && granted
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const utf8 = new TextEncoder()
const text = new TextDecoder()

/** A store whose home is a folder beside it, never the person's. */
const store = (folder: string, options: Options = {}) =>
	make(folder, { home: `${folder}/../Home`, ...options })

/** The platform's calls, but a Trash that refuses: a test always gives the fake one. */
function safe(): Sys {
	return {
		...system(),
		trash: () => Promise.reject(new Error("a test never uses the real Trash")),
	}
}

/** As safe, but a sync does nothing: for tests that make many batches and do not test durability. */
function quick(): Sys {
	return { ...safe(), sync: () => Promise.resolve() }
}

/** A store's folder and a Trash beside it, removed after fn. */
async function within(fn: (store: string, bin: string) => Promise<void>) {
	const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "ermine-store-" }))
	try {
		await fn(`${dir}/Store`, `${dir}/Trash`)
	} finally {
		await Deno.remove(dir, { recursive: true })
	}
}

/** Where an id goes in a list: at position, or at the end. */
function placed(list: readonly Id[], id: Id, position?: number): Id[] {
	const out = list.filter((x) => x !== id)
	out.splice(position ?? out.length, 0, id)
	return out
}

/** A graph of newcore nodes, changed by hand as a host's table would hold it. */
class Model {
	time = 0
	nodes = new Map<Id, N>()
	constructor(readonly root = "r") {
		this.nodes.set(root, createNode<unknown, unknown>(root))
	}
	#change(node: Id) {
		return { time: this.time, actor: "host", node }
	}
	#list(at: Id, name: string): Id[] {
		const v = this.nodes.get(at)!.children.get(name)?.[0]
		return (v?.content ?? []).filter((x): x is Id => typeof x === "string")
	}
	#set(at: Id, name: string, list: List) {
		this.nodes.get(at)!.children.set(name, [{ content: list, change: this.#change(at) }])
	}
	place(at: Id, name: string, id: Id, value?: Json, position?: number) {
		this.time++
		if (value !== undefined) {
			this.nodes.set(
				id,
				createNode<unknown, unknown>(id, {
					value: [{ content: value, change: this.#change(id) }],
				}),
			)
		}
		this.#set(at, name, placed(this.#list(at, name), id, position))
	}
	unplace(at: Id, name: string, id: Id) {
		this.time++
		this.#set(at, name, this.#list(at, name).filter((x) => x !== id))
	}
	write(id: Id, value: Json) {
		this.time++
		const n = this.nodes.get(id)!
		n.value = [{ content: value, change: this.#change(id) }, ...n.value.slice(1)]
	}
	/** Every version after the first: sides. */
	sides(id: Id, values: Json[]) {
		this.time++
		const n = this.nodes.get(id)!
		n.value = [n.value[0], ...values.map((content) => ({ content, change: this.#change(id) }))]
	}
	info(id: Id, name: string, value?: Json) {
		this.time++
		const n = this.nodes.get(id)!
		if (value === undefined) n.attributes.delete(name)
		else n.attributes.set(name, [{ content: value, change: this.#change(id) }])
	}
	/** A change that keeps nothing, as an ephemeral one: only the time. */
	tick() {
		this.time++
	}
	saving(ephemeral?: (id: Id) => boolean) {
		return { root: this.root, get: (id: Id) => this.nodes.get(id), time: this.time, ephemeral }
	}
	/** The graph from its root, as loading should give it, in a form to compare. */
	kept() {
		return snap({
			root: this.root,
			time: this.time,
			nodes: pack.walk(this.root, (id) => this.nodes.get(id)).nodes,
		})
	}
}

/** A graph's root, time and reachable nodes, in a form to compare. */
function snap(g: Pick<Restored, "root" | "time" | "nodes"> | undefined) {
	if (!g) return undefined
	const nodes = g.nodes.map((n) => [n.id, [...pack.encode(n)]] as const)
		.sort(([a], [b]) => (a < b ? -1 : 1))
	return { root: g.root, time: g.time, nodes }
}

/** What a store loads, in a form to compare. */
const kept = async (t: Store) => snap(await t.read())

/** Every entry under a folder, by path: a file's text, a link's target, a folder's "/". */
async function listing(dir: string, skip = new Set([".ermine"])) {
	const out: { [path: string]: string } = {}
	const walk = async (at: string, prefix: string) => {
		for await (const e of Deno.readDir(at)) {
			if (!prefix && skip.has(e.name)) continue
			const p = prefix + e.name
			if (e.isSymlink) out[p] = "-> " + await Deno.readLink(`${at}/${e.name}`)
			else if (e.isDirectory) {
				out[p] = "/"
				await walk(`${at}/${e.name}`, p + "/")
			} else out[p] = text.decode(await Deno.readFile(`${at}/${e.name}`))
		}
	}
	await walk(dir, "")
	return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)))
}

/** The contents of every file under some folders, to find a person's work in. */
async function contents(...dirs: string[]): Promise<string[]> {
	const out: string[] = []
	const walk = async (at: string) => {
		let all: Deno.DirEntry[]
		try {
			all = await Array.fromAsync(Deno.readDir(at))
		} catch {
			return
		}
		for (const e of all) {
			if (e.isDirectory) await walk(`${at}/${e.name}`)
			else if (e.isFile) out.push(text.decode(await Deno.readFile(`${at}/${e.name}`)))
		}
	}
	for (const d of dirs) await walk(d)
	return out
}

const attribute = async (sys: Sys, path: string, name: string) => {
	const b = await sys.get(path, name)
	return b && text.decode(b)
}

/** A Sys whose calls can be made to throw from the n-th on, as a crash, or run a hook first. */
class Crash extends Error {}
function crashing(base: Sys, trash: Trash) {
	let count = 0
	let at = Infinity
	let hook: ((call: string, args: string[]) => Promise<void>) | undefined
	const tick = async (call: string, args: unknown[]) => {
		count++
		if (count >= at) throw new Crash(`a crash at call ${at}`)
		if (hook) await hook(call, args.filter((a) => typeof a === "string") as string[])
	}
	const wrap = <F extends (...a: never[]) => Promise<unknown>>(call: string, f: F) =>
		(async (...a: Parameters<F>) => {
			await tick(call, a)
			return await f(...a)
		}) as unknown as F
	const sys: Sys = {
		get: wrap("get", base.get),
		set: wrap("set", base.set),
		unset: wrap("unset", base.unset),
		names: wrap("names", base.names),
		swap: wrap("swap", base.swap),
		rename: wrap("rename", base.rename),
		clone: wrap("clone", base.clone),
		sync: wrap("sync", base.sync),
		id: wrap("id", base.id),
		trash: wrap("trash", trash),
	}
	return {
		sys,
		arm(n: number) {
			count = 0
			at = n
		},
		hook(fn?: (call: string, args: string[]) => Promise<void>) {
			hook = fn
		},
		get count() {
			return count
		},
	}
}

/** The paper's example, one batch for each change. */
async function example(t: Store) {
	const m = new Model()
	await t.read()
	const steps: (() => void)[] = [
		() => m.place("r", "apps", "a", { theme: "dark" }),
		() => m.place("a", "clock", "c", "12:00"),
		() => m.place("r", "docs", "d1", "hello"),
		() => m.place("r", "docs", "d2", PNG),
		() => m.place("r", "pinned", "d1"),
		() => m.place("r", "Notes", "x9"),
	]
	for (const s of steps) {
		s()
		await t.write(m.saving())
	}
	return m
}

Deno.test({
	name: "the paper's example is saved as the paper shows it",
	ignore: !mac,
	fn: () =>
		within(async (folder, bin) => {
			const sys = safe()
			const t = store(folder, { sys, trash: fake(bin) })
			await example(t)
			assertEquals(await listing(folder), {
				"Notes": "-> .ermine/id/x9",
				"apps": "/",
				"apps.text": '{\n  "theme": "dark"\n}',
				"apps/clock.txt": "12:00",
				"docs": "/",
				"docs/1.txt": "hello",
				"docs/2.png": text.decode(PNG),
				"pinned.txt": "-> docs/1.txt",
			})
			assertEquals(await Array.fromAsync(Deno.readDir(`${folder}/.ermine/tmp`)), [])
			assertEquals(await Array.fromAsync(Deno.readDir(`${folder}/.ermine/id`)), [])
			// ids and slots in attributes
			assertEquals(await attribute(sys, folder, attr.id), "r")
			assert(await attribute(sys, folder, attr.store))
			for (
				const [p, id] of [["apps.text", "a"], ["apps", "a"], ["apps/clock.txt", "c"], [
					"pinned.txt",
					"d1",
				]]
			) {
				assertEquals(await attribute(sys, `${folder}/${p}`, attr.id), id, p)
			}
			assertEquals(decode((await sys.get(`${folder}/docs`, attr.slot))!), ["r", "docs"])
			// the manifest
			const records = await t.manifest.read()
			assertEquals(manifest.state.decode(records.get("store")!), {
				format: 1,
				done: 6,
				pass: [...names.PASS],
			})
			assertEquals(manifest.kepts(records.get("node:a")!), [[
				manifest.hash({ theme: "dark" }),
				"cbor",
			]])
			assertEquals(manifest.kepts(records.get("node:d2")!), [[manifest.hash(PNG), "bin"]])
			// the root has no value: nothing kept
			assertEquals(manifest.kepts(records.get("node:r")!), [])
			assertEquals(manifest.shown.decode(records.get("shown:d2")!), {
				file: "2.png",
				home: ["r", "docs", 1],
				laid: manifest.hash(PNG),
			})
			assert(!records.has("plan"))
			const values = await Array.fromAsync(Deno.readDir(`${folder}/.ermine/values`))
			assertEquals(values.length, 4)
			assertEquals(await t.differences(), [])
		}),
})

Deno.test({
	name: "a store loads back as the host had it, and changes after it are laid out",
	ignore: !mac,
	fn: () =>
		within(async (folder, bin) => {
			const m = await example(store(folder, { sys: safe(), trash: fake(bin) }))
			const again = store(folder, { sys: safe(), trash: fake(bin) })
			const loaded = await again.read()
			assertEquals(snap(loaded), m.kept())
			assertEquals(loaded!.missing, ["x9"])
			assertEquals(loaded!.others, [])
			assertEquals(again.missed, [])
			// an ephemeral change: one frame of meta and store
			const size = (await Deno.stat(`${folder}/.ermine/manifest`)).size
			m.tick()
			await again.write(m.saving())
			const grown = (await Deno.readFile(`${folder}/.ermine/manifest`)).slice(size)
			const frame = decode(grown.slice(4)) as { [k: string]: Value }
			assertEquals(Object.keys(frame).sort(), ["meta", "store"])
			// nothing changed: nothing written
			const size2 = (await Deno.stat(`${folder}/.ermine/manifest`)).size
			await again.write(m.saving())
			assertEquals((await Deno.stat(`${folder}/.ermine/manifest`)).size, size2)
			// the link goes; then the union of one is a file again, and d2 is away but kept
			m.unplace("r", "pinned", "d1")
			await again.write(m.saving())
			m.unplace("r", "docs", "d2")
			await again.write(m.saving())
			const l = await listing(folder)
			assertEquals(Object.keys(l), ["Notes", "apps", "apps.text", "apps/clock.txt", "docs.txt"])
			assertEquals(l["docs.txt"], "hello")
			assertEquals(again.layout.get("d2")?.away, true)
			assertEquals(await again.differences(), [])
			const third = store(folder, { sys: safe(), trash: fake(bin) })
			const back = await third.read()
			assertEquals(back!.others.map((n) => n.id), ["d2"])
			// placing it again shows it again
			m.place("r", "back", "d2")
			await third.write(m.saving())
			assertEquals(await Deno.readFile(`${folder}/back.png`), new Uint8Array(PNG))
		}),
})

Deno.test({
	name: "later versions are sides beside the file; info is in extended attributes",
	ignore: !mac,
	fn: () =>
		within(async (folder, bin) => {
			const sys = safe()
			const listed: Listed[] = []
			const t = store(folder, { sys, trash: fake(bin), list: (l) => listed.push(l) })
			const m = new Model()
			await t.read()
			m.place("r", "clock", "c", "12:00")
			m.place("c", "inner", "i", 1)
			m.sides("c", ["13:00", { at: 14 }])
			m.info("c", "color", "red")
			m.info("c", "shape", { round: true })
			await t.write(m.saving())
			assertEquals(await listing(folder), {
				"clock": "/",
				"clock.FINAL.txt": "13:00",
				"clock.FINAL.FINAL.text": '{\n  "at": 14\n}',
				"clock.txt": "12:00",
				"clock/inner.text": "1",
			})
			assertEquals(await attribute(sys, `${folder}/clock.FINAL.txt`, attr.side), "1")
			assertEquals(await attribute(sys, `${folder}/clock.FINAL.txt`, attr.id), "c")
			for (const p of ["clock.txt", "clock"]) {
				assertEquals(await attribute(sys, `${folder}/${p}`, attr.info + "color"), "red")
				assertEquals(
					await attribute(sys, `${folder}/${p}`, attr.info + "shape"),
					'{\n  "round": true\n}',
				)
			}
			// a Finder tag on the file stays when its value is written again
			const TAG = "com.apple.metadata:_kMDItemUserTags"
			await sys.set(`${folder}/clock.txt`, TAG, utf8.encode("Red"))
			m.write("c", "12:01")
			m.info("c", "color")
			m.info("c", "size", 3)
			await t.write(m.saving())
			assertEquals(await Deno.readTextFile(`${folder}/clock.txt`), "12:01")
			assertEquals(await attribute(sys, `${folder}/clock.txt`, TAG), "Red")
			for (const p of ["clock.txt", "clock"]) {
				assertEquals(await attribute(sys, `${folder}/${p}`, attr.info + "color"), null)
				assertEquals(await attribute(sys, `${folder}/${p}`, attr.info + "size"), "3")
			}
			// a side that goes is removed
			m.sides("c", ["13:30"])
			await t.write(m.saving())
			assertEquals(Object.keys(await listing(folder)), [
				"clock",
				"clock.FINAL.txt",
				"clock.txt",
				"clock/inner.text",
			])
			assertEquals(await t.differences(), [])
			assertEquals(listed, [])
			// info that does not fit an attribute is listed, and the rest is laid
			m.info("c", "x".repeat(200), "too long a name")
			await t.write(m.saving())
			assert(listed.some((l) => l.why.includes("does not fit")))
			assertEquals(snap(await store(folder, { sys, trash: fake(bin) }).read()), m.kept())
		}),
})

Deno.test({
	name: "ephemeral nodes and live values are never saved",
	ignore: !mac,
	fn: () =>
		within(async (folder, bin) => {
			const t = store(folder, { sys: safe(), trash: fake(bin) })
			const m = new Model()
			await t.read()
			m.place("r", "a", "a", "one")
			m.place("r", "a", "e", "ephemeral")
			m.place("r", "f", "f", "x")
			m.write("f", (() => 1) as unknown as Json)
			await t.write(m.saving((id) => id === "e"))
			const records = await t.manifest.read()
			assert(!records.has("node:e"))
			assertEquals(manifest.kepts(records.get("node:f")!), [])
			// a node with no value shows null
			assertEquals(await listing(folder), { "a.txt": "one", "f.text": "null" })
		}),
})

Deno.test({
	name: "a person's file put where the store lays one keeps its place; the store's goes elsewhere",
	ignore: !mac,
	fn: () =>
		within(async (folder, bin) => {
			const c = crashing(safe(), fake(bin))
			const listed: Listed[] = []
			const t = store(folder, { sys: c.sys, trash: c.sys.trash, list: (l) => listed.push(l) })
			const m = new Model()
			await t.read()
			m.place("r", "a", "a", "first")
			await t.write(m.saving())
			// a person saves b.txt just as the store renames its own into place
			c.hook(async (call, [, to]) => {
				if (call === "rename" && to === `${folder}/b.txt`) {
					await Deno.writeTextFile(to, "mine")
					c.hook()
				}
			})
			m.place("r", "b", "b", "second")
			await t.write(m.saving())
			assertEquals(await Deno.readTextFile(`${folder}/b.txt`), "mine")
			assertEquals(listed.map((l) => l.path), ["b.txt"])
			assertEquals(t.layout.get("r")!.left, ["b.txt"])
			// the next batch lays it under a name found then
			m.place("r", "c", "c", "third")
			await t.write(m.saving())
			assertEquals(await Deno.readTextFile(`${folder}/b.FINAL.txt`), "second")
			assertEquals(await Deno.readTextFile(`${folder}/b.txt`), "mine")
			assertEquals(t.layout.get("r")!.left, undefined)
			const d = await t.differences()
			assertEquals(d.map((x) => [x.path, x.was?.kind ?? null, x.now?.kind ?? null]), [[
				"b.txt",
				null,
				"file",
			]])
		}),
})

Deno.test({
	name: "an edit swapped out mid-batch is put back, for the files program to take in",
	ignore: !mac,
	fn: () =>
		within(async (folder, bin) => {
			const c = crashing(safe(), fake(bin))
			const t = store(folder, { sys: c.sys, trash: c.sys.trash, files: true })
			const m = new Model()
			await t.read()
			m.place("r", "clock", "c", "12:00")
			await t.write(m.saving())
			// a person saves 12:30 just before the store swaps 13:00 in
			c.hook(async (call, [, b]) => {
				if (call === "swap" && b === `${folder}/clock.txt`) {
					await Deno.writeTextFile(b, "12:30")
					c.hook()
				}
			})
			m.write("c", "13:00")
			await t.write(m.saving())
			assertEquals(await Deno.readTextFile(`${folder}/clock.txt`), "12:30")
			// what the store laid is what the person saw: their edit is a difference
			assertEquals(t.layout.get("c")!.laid, manifest.hash("12:00"))
			const [d, ...rest] = await t.differences()
			assertEquals(rest, [])
			assertEquals(d.path, "clock.txt")
			assertEquals(d.now?.kind === "file" && d.now.value, "12:30")
			assertEquals(await Array.fromAsync(Deno.readDir(`${folder}/.ermine/tmp`)), [])
			// and the graph has 13:00
			const again = store(folder, { sys: safe(), trash: fake(bin), files: true })
			const loaded = await again.read()
			assertEquals(loaded!.nodes.find((n) => n.id === "c")!.value[0].content, "13:00")
			assertEquals(again.missed.map((x) => x.path), ["clock.txt"])
		}),
})

/**
 * The crash scenario: a graph, a person's work around it, and a batch that
 * writes, makes a union, removes a folder holding a person's file, changes
 * a value's form, moves a node with a folder, mounts, adds a side and info.
 */
async function scene(folder: string, sys: Sys, trash: Trash) {
	const m = new Model()
	const t = store(folder, { sys, trash })
	await t.read()
	m.place("r", "apps", "a", { theme: "dark" })
	m.place("a", "clock", "c", "12:00")
	m.place("r", "docs", "d1", "hello")
	m.place("r", "pinned", "d1")
	m.place("r", "gone", "g", "bye")
	m.place("g", "child", "k", PNG)
	m.place("r", "old", "x", new Float32Array([1, 2]))
	m.place("x", "inner", "i", [1, 2])
	m.sides("d1", ["hullo"])
	await t.write(m.saving())
	const before = m.kept()
	// a person's work: an edit, a file of their own, a file in a folder the batch removes
	await Deno.writeTextFile(`${folder}/apps/clock.txt`, "12:30")
	await Deno.writeTextFile(`${folder}/mine.txt`, "mine")
	await Deno.writeTextFile(`${folder}/gone/notes.txt`, "notes")
	m.write("c", "13:00")
	m.place("r", "docs", "d2", PNG)
	m.unplace("r", "gone", "g")
	m.unplace("r", "pinned", "d1")
	m.write("a", "now a string")
	m.place("r", "new", "x")
	m.unplace("r", "old", "x")
	m.place("r", "Notes", "x9")
	m.sides("d1", ["hullo", "hallo"])
	m.info("x", "color", "red")
	return { t, saving: m.saving(), before, after: m.kept() }
}

Deno.test({
	name:
		"a batch stopped after any of its calls loads as before it or after it, losing no one's work",
	ignore: !mac,
	fn: () =>
		within(async (root, bin) => {
			// how many calls the batch makes
			const counting = crashing(quick(), fake(bin))
			const first = await scene(`${root}/count`, counting.sys, counting.sys.trash)
			counting.arm(Infinity)
			await first.t.write(first.saving)
			const calls = counting.count
			assert(calls > 30, `${calls} calls`)
			let befores = 0, afters = 0
			for (let n = 1; n <= calls + 1; n++) {
				const folder = `${root}/s${n}`
				const trash = `${bin}/${n}`
				const c = crashing(quick(), fake(trash))
				const s = await scene(folder, c.sys, c.sys.trash)
				c.arm(n)
				let crashed = false
				try {
					await s.t.write(s.saving)
				} catch (e) {
					if (!(e instanceof Crash)) throw e
					crashed = true
				}
				assertEquals(crashed, n <= calls, `call ${n}`)
				const listed: Listed[] = []
				const again = store(folder, {
					sys: quick(),
					trash: fake(trash),
					list: (l) => listed.push(l),
				})
				const loaded = await kept(again)
				if (JSON.stringify(loaded) === JSON.stringify(s.before)) befores++
				else {
					assertEquals(loaded, s.after, `call ${n}`)
					afters++
				}
				// the folder is the graph's, nothing is left in tmp, and no one's work is lost
				assertEquals(await again.differences(), [], `call ${n}`)
				assertEquals(
					await Array.fromAsync(Deno.readDir(`${folder}/.ermine/tmp`)),
					[],
					`call ${n}`,
				)
				const found = await contents(folder, trash)
				for (const work of ["12:30", "mine", "notes"]) {
					assert(found.includes(work), `call ${n}: ${work} is lost`)
				}
			}
			assert(befores > 0 && afters > 0, `${befores} before, ${afters} after`)
		}),
})

Deno.test({
	name:
		"a folder holding others' entries becomes a store only for a host running the files program",
	ignore: !mac,
	fn: () =>
		within(async (folder, bin) => {
			await Deno.mkdir(folder)
			await Deno.writeTextFile(`${folder}/.DS_Store`, "finder")
			// only names passed over: a new store
			const empty = store(folder, { sys: safe(), trash: fake(bin) })
			assertEquals(await empty.read(), undefined)
			await Deno.remove(`${folder}/.ermine`, { recursive: true })
			await Deno.writeTextFile(`${folder}/notes.md`, "# hi")
			await Deno.mkdir(`${folder}/photos`)
			const refused = store(folder, { sys: safe(), trash: fake(bin) })
			await assertRejects(() => refused.read(), StoreError)
			await assertRejects(() => Deno.lstat(`${folder}/.ermine`), Deno.errors.NotFound)
			const taken = store(folder, { sys: safe(), trash: fake(bin), files: true })
			assertEquals(await taken.read(), undefined)
			assertEquals(taken.missed.map((d) => [d.path, d.now?.kind]), [
				["notes.md", "file"],
				["photos", "folder"],
			])
		}),
})

Deno.test({
	name:
		"edits made while nothing watched are listed, or for a host with no files program, trashed",
	ignore: !mac,
	fn: () =>
		within(async (folder, bin) => {
			const m = await example(store(folder, { sys: safe(), trash: fake(bin) }))
			await Deno.writeTextFile(`${folder}/apps/clock.txt`, "12:30")
			await Deno.remove(`${folder}/docs/1.txt`)
			await Deno.writeTextFile(`${folder}/new.txt`, "new")
			await Deno.writeTextFile(`${folder}/.DS_Store`, "passed over")
			const watched = store(folder, { sys: safe(), trash: fake(bin), files: true })
			assertEquals(await kept(watched), m.kept())
			assertEquals(watched.missed.map((d) => d.path).sort(), [
				"apps/clock.txt",
				"docs/1.txt",
				"new.txt",
			])
			const listed: Listed[] = []
			const plain = store(folder, { sys: safe(), trash: fake(bin), list: (l) => listed.push(l) })
			assertEquals(await kept(plain), m.kept())
			assertEquals(plain.missed, [])
			assertEquals(listed.map((l) => l.path).sort(), ["apps/clock.txt", "new.txt"])
			assertEquals(await Deno.readTextFile(`${folder}/apps/clock.txt`), "12:00")
			assertEquals(await Deno.readTextFile(`${folder}/docs/1.txt`), "hello")
			assertEquals(await plain.differences(), [])
			const trashed = await contents(bin)
			assert(trashed.includes("12:30") && trashed.includes("new"))
			assertEquals(await Deno.readTextFile(`${folder}/.DS_Store`), "passed over")
		}),
})

Deno.test({
	name: "a last frame cut short loads as before it; a missing kept file makes the store invalid",
	ignore: !mac,
	fn: () =>
		within(async (folder, bin) => {
			const t = store(folder, { sys: safe(), trash: fake(bin) })
			const m = new Model()
			await t.read()
			m.place("r", "a", "a", "one")
			await t.write(m.saving())
			const before = m.kept()
			const log = `${folder}/.ermine/manifest`
			const size = (await Deno.stat(log)).size
			m.write("a", "two")
			await t.write(m.saving())
			// the batch's first frame, cut short: as if the crash came during its append
			const bytes = await Deno.readFile(log)
			const view = new DataView(bytes.buffer)
			const kept1 = size + 4 + view.getUint32(size)
			await Deno.writeFile(log, bytes.slice(0, kept1 - 3))
			const again = store(folder, { sys: safe(), trash: fake(bin) })
			assertEquals(await kept(again), before)
			assertEquals(await Deno.readTextFile(`${folder}/a.txt`), "one")
			// a kept file gone: invalid, and nothing is changed
			for await (const e of Deno.readDir(`${folder}/.ermine/values`)) {
				await Deno.remove(`${folder}/.ermine/values/${e.name}`)
			}
			const log2 = await Deno.readFile(log)
			await assertRejects(
				() => store(folder, { sys: safe(), trash: fake(bin) }).read(),
				StoreError,
			)
			assertEquals(await Deno.readFile(log), log2)
		}),
})

Deno.test({
	name: "a file laid is not read again; a dropped id is set again",
	ignore: !mac,
	fn: () =>
		within(async (folder, bin) => {
			const sys = safe()
			const t = store(folder, { sys, trash: fake(bin) })
			const m = new Model()
			await t.read()
			m.place("r", "a", "a", "one")
			await t.write(m.saving())
			await sys.unset(`${folder}/a.txt`, attr.id)
			assertEquals(await t.differences(), [])
			assertEquals(await attribute(sys, `${folder}/a.txt`, attr.id), "a")
			// a file with the stat it was laid with is not read: changing it in place keeps size, time and id
			const f = await Deno.open(`${folder}/a.txt`, { write: true })
			const { mtime } = await f.stat()
			await f.write(utf8.encode("eno"))
			await f.utime(mtime!, mtime!)
			f.close()
			assertEquals(await t.differences(), [])
			assertEquals((await t.differences(["", "nowhere", ".ermine/tmp"])).length, 0)
		}),
})

// random graphs ----------------------------------------------------------------

function random(seed: number) {
	let s = seed >>> 0 || 1
	const next = () => {
		s ^= s << 13
		s ^= s >>> 17
		s ^= s << 5
		return (s >>> 0) / 4294967296
	}
	return {
		next,
		int: (n: number) => Math.floor(next() * n),
		pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)],
	}
}

const NAMES = [
	"a",
	"A",
	"b",
	"docs",
	"README.md",
	"x.text",
	"data.raw",
	"",
	"a/b",
	"café",
	".DS_Store",
	"1",
	"ß",
	"SS",
]

function value(r: ReturnType<typeof random>): Json {
	switch (r.int(7)) {
		case 0:
			return r.pick(["", "hi", "12:00\n", "ünï"])
		case 1:
			return r.pick([PNG, new Uint8Array([1, 2, 3]), new Uint8Array([0xff, 0xfe])])
		case 2:
			return r.pick([
				new Float32Array([r.int(5), NaN]),
				new BigInt64Array([-5n]),
				new Uint8Array([7]),
			])
		case 3:
			return { n: r.int(3), b: new Uint8Array([1]), x: [-0, Infinity] }
		case 4:
			return null
		case 5:
			return [r.int(3), "x", true]
		default:
			return r.int(4) / 2
	}
}

Deno.test({
	name: "for a few dozen seeds of random changes, a store loads as the host had it",
	ignore: !mac,
	fn: () =>
		within(async (root, bin) => {
			for (let seed = 1; seed <= 24; seed++) {
				const r = random(seed)
				const folder = `${root}/s${seed}`
				const m = new Model()
				let t = store(folder, { sys: quick(), trash: fake(bin) })
				await t.read()
				let made = 0
				for (let batch = 0; batch < 12; batch++) {
					for (let k = r.int(4) + 1; k > 0; k--) {
						const ids = [...m.nodes.keys()]
						const h = r.pick(ids)
						const op = r.int(12)
						const slots = [...m.nodes.get(h)!.children]
							.map(([name, vs]) => [name, (vs[0]?.content ?? []) as Id[]] as const)
							.filter(([, ids]) => ids.length)
						if (op < 4) m.place(h, r.pick(NAMES), `n${++made}`, value(r))
						else if (op < 6) {
							const name = r.pick(NAMES)
							const id = r.next() < 0.2 ? `p${r.int(2)}` : r.pick(ids)
							m.place(h, name, id)
						} else if (op < 8 && slots.length) {
							const [name, ids] = r.pick(slots)
							m.unplace(h, name, r.pick(ids))
						} else if (op < 9 && h !== m.root) m.write(h, value(r))
						else if (op < 10 && h !== m.root) {
							m.sides(
								h,
								Array.from({ length: r.int(3) }, () => value(r)),
							)
						} else if (op < 11) {
							m.info(h, r.pick(["color", "size"]), r.next() < 0.3 ? undefined : value(r))
						} else m.tick()
					}
					await t.write(m.saving())
					// now and then, a host that starts again
					if (r.next() < 0.25) {
						t = store(folder, { sys: quick(), trash: fake(bin) })
						assertEquals(await kept(t), m.kept(), `seed ${seed}, batch ${batch}`)
					}
				}
				const again = store(folder, { sys: quick(), trash: fake(bin) })
				assertEquals(await kept(again), m.kept(), `seed ${seed}`)
				assertEquals(await again.differences(), [], `seed ${seed}`)
				assertEquals(await contents(bin), [], `seed ${seed}: nothing went to the Trash`)
			}
		}),
})

Deno.test({
	name:
		"the host's records are kept with a batch, and a grown manifest is folded once a batch is done",
	ignore: !mac,
	fn: () =>
		within(async (folder, bin) => {
			const t = store(folder, { sys: quick(), trash: fake(bin), slack: 0 })
			const m = new Model()
			await t.read()
			m.place("r", "a", "a", "one")
			await t.write({ ...m.saving(), records: new Map([["sync:heads", utf8.encode("theirs")]]) })
			for (let i = 0; i < 6; i++) {
				m.write("a", `value ${i}`)
				const records = new Map(i === 2 ? [["sync:heads", utf8.encode("theirs, later")]] : [])
				await t.write({ ...m.saving(), records })
			}
			assertEquals(text.decode(t.others().get("sync:heads")!), "theirs, later")
			// folded: one frame, and only the values a node names are kept
			const log = await Deno.readFile(`${folder}/.ermine/manifest`)
			assertEquals(new DataView(log.buffer).getUint32(0) + 4, log.length)
			const values = await Array.fromAsync(Deno.readDir(`${folder}/.ermine/values`))
			assertEquals(values.map((e) => e.name), [manifest.hash("value 5")])
			const again = store(folder, { sys: quick(), trash: fake(bin) })
			assertEquals(await kept(again), m.kept())
			assertEquals(text.decode(again.others().get("sync:heads")!), "theirs, later")
			assertEquals(await Deno.readTextFile(`${folder}/a.txt`), "value 5")
			await again.write({ ...m.saving(), records: new Map([["sync:heads", null]]) })
			assertEquals(again.others().size, 0)
			await assertRejects(
				() => again.write({ ...m.saving(), records: new Map([["meta", null]]) }),
				StoreError,
			)
		}),
})
