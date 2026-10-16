import { assert, assertEquals, assertRejects } from "@std/assert"
import { type Value } from "@ermine/encoding/cbor"
import createNode, { type List, type Node as Saved } from "./saved.ts"
import * as manifest from "./manifest.ts"
import { type Mirror, mirror as make, type Saving } from "./store.ts"
import { fake, type Sys, system } from "./sys.ts"
import { type Id, type Listed, type Options, StoreError } from "./types.ts"

// A mirror lays a node's subtree out in a folder, its graph the host's. Every
// test works in a folder of its own from Deno.makeTempDir, with a test home
// and a fake Trash there.

const granted = (["write", "ffi"] as const).every((name) =>
	Deno.permissions.querySync({ name }).state === "granted"
)
const mac = Deno.build.os === "darwin" && granted
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const safe = (): Sys => ({
	...system(),
	trash: () => Promise.reject(new Error("a test never uses the real Trash")),
})

async function within(
	fn: (folder: string, d: { dir: string; home: string; bin: string }) => Promise<void>,
) {
	const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "ermine-mirror-" }))
	try {
		await fn(`${dir}/Folder`, { dir, home: `${dir}/Home`, bin: `${dir}/Trash` })
	} finally {
		await Deno.remove(dir, { recursive: true })
	}
}

const open = (
	d: { home: string; bin: string },
	folder: string,
	options: Options = {},
): Mirror => make(folder, { sys: safe(), trash: fake(d.bin), home: d.home, ...options })

/** A host's graph, changed by hand; its root is the node the mirror shows. */
class Model {
	time = 0
	nodes = new Map<Id, Saved<unknown, unknown>>()
	constructor(readonly root = "doc") {
		this.nodes.set(root, createNode<unknown, unknown>(root))
	}
	#change(node: Id) {
		return { time: this.time, actor: "host", node }
	}
	place(at: Id, name: string, id: Id, value?: Value) {
		this.time++
		if (value !== undefined) {
			this.nodes.set(
				id,
				createNode<unknown, unknown>(id, {
					value: [{ content: value, change: this.#change(id) }],
				}),
			)
		}
		const v = this.nodes.get(at)!.children.get(name)?.[0]
		const list: List = [...(v?.content ?? []).filter((x) => x !== id), id]
		this.nodes.get(at)!.children.set(name, [{ content: list, change: this.#change(at) }])
	}
	write(id: Id, value: Value) {
		this.time++
		this.nodes.get(id)!.value = [{ content: value, change: this.#change(id) }]
	}
	saving(): Saving {
		return { root: this.root, get: (id) => this.nodes.get(id), time: this.time }
	}
}

const STEPS: ((m: Model) => void)[] = [
	(m) => m.write("doc", "the document"),
	(m) => m.place("doc", "apps", "a", { theme: "dark" }),
	(m) => m.place("a", "clock", "c", "12:00"),
	(m) => m.place("doc", "docs", "d1", "hello"),
	(m) => m.place("doc", "docs", "d2", PNG),
	(m) => m.place("doc", "pinned", "d1"),
	(m) => m.place("doc", "Notes", "x9"),
]

async function laid(t: Mirror, m: Model, steps = STEPS) {
	await t.read(m.saving())
	for (const s of steps) {
		s(m)
		await t.write(m.saving())
	}
}

/** Every entry under a folder: a file's text, a link's target, a folder's "/". */
async function listing(dir: string) {
	const out: { [path: string]: string } = {}
	const walk = async (at: string, prefix: string) => {
		for await (const e of Deno.readDir(at)) {
			if (!prefix && e.name === ".ermine") continue
			const p = prefix + e.name
			if (e.isSymlink) out[p] = "-> " + await Deno.readLink(`${at}/${e.name}`)
			else if (e.isDirectory) {
				out[p] = "/"
				await walk(`${at}/${e.name}`, p + "/")
			} else out[p] = new TextDecoder().decode(await Deno.readFile(`${at}/${e.name}`))
		}
	}
	await walk(dir, "")
	return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)))
}

const records = (folder: string) => manifest.manifest(`${folder}/.ermine`, system()).read()

Deno.test({
	name: "a mirror lays a node's subtree out as a store does, and keeps only layout records",
	ignore: !mac,
	fn: () =>
		within(async (folder, d) => {
			const t = open(d, folder)
			const m = new Model()
			await laid(t, m)
			assertEquals(await listing(folder), {
				"Notes": "-> .ermine/id/x9",
				"apps": "/",
				"apps.text": '{\n  "theme": "dark"\n}',
				"apps/clock.txt": "12:00",
				"docs": "/",
				"docs/1.txt": "hello",
				"docs/2.png": new TextDecoder().decode(PNG),
				"pinned.txt": "-> docs/1.txt",
			})
			assertEquals(await Deno.readTextFile(`${folder}/.ermine/root.txt`), "the document")
			// the manifest is a log of frames with the layout and store alone; no graph, no kept values
			const all = await records(folder)
			assertEquals(
				[...all.keys()].sort(),
				["shown:a", "shown:c", "shown:d1", "shown:d2", "shown:doc", "store"],
			)
			assertEquals(
				(await Array.fromAsync(Deno.readDir(`${folder}/.ermine`))).map((e) => e.name).sort(),
				[
					"id",
					"manifest",
					"root.txt",
					"tmp",
				],
			)
			// each batch had a time of its own counting up: seven, as the host had seven changes
			assertEquals(manifest.state.decode(all.get("store")!).done, 7)
			assertEquals(t.layout.get("doc")!.folder, true)
			assertEquals(manifest.shown.decode(all.get("shown:c")!).laid, manifest.hash("12:00"))
		}),
})

Deno.test({
	name: "a batch that changes nothing laid takes no time, and a changed value takes the next",
	ignore: !mac,
	fn: () =>
		within(async (folder, d) => {
			const t = open(d, folder)
			const m = new Model()
			await laid(t, m, STEPS.slice(0, 3))
			const done = async () => manifest.state.decode((await records(folder)).get("store")!).done
			assertEquals(await done(), 3)
			// the host's own time moves, nothing in the folder does
			m.time += 10
			await t.write(m.saving())
			assertEquals(await done(), 3)
			m.write("c", "13:00")
			await t.write(m.saving())
			assertEquals(await done(), 4)
			assertEquals(await Deno.readTextFile(`${folder}/apps/clock.txt`), "13:00")
			assertEquals(await Array.fromAsync(Deno.readDir(`${folder}/.ermine/tmp`)), [])
		}),
})

Deno.test({
	name: "a mirror loads again with the host's graph, laying out what the graph has become",
	ignore: !mac,
	fn: () =>
		within(async (folder, d) => {
			const m = new Model()
			await laid(open(d, folder), m)
			const before = await listing(folder)
			const again = open(d, folder)
			await again.read(m.saving())
			assertEquals(again.missed, [])
			assertEquals(await again.differences(), [])
			assertEquals(await listing(folder), before)
			// the graph changed while nothing ran: the first read lays it out
			m.write("c", "14:00")
			m.place("doc", "new", "n", "fresh")
			const third = open(d, folder)
			await third.read(m.saving())
			assertEquals(await Deno.readTextFile(`${folder}/apps/clock.txt`), "14:00")
			assertEquals(await Deno.readTextFile(`${folder}/new.txt`), "fresh")
			// and it goes on counting
			m.write("n", "newer")
			await third.write(m.saving())
			assertEquals(await Deno.readTextFile(`${folder}/new.txt`), "newer")
			assertEquals(
				manifest.state.decode((await records(folder)).get("store")!).done > 7,
				true,
			)
		}),
})

Deno.test({
	name:
		"a batch stopped after any of its calls is carried out again from the graph the host gives",
	ignore: !mac,
	fn: () =>
		within(async (folder, d) => {
			const last: (m: Model) => void = (m) => {
				m.write("c", "13:00")
				m.write("d1", "hi")
				m.place("doc", "more", "e", "extra")
				m.place("doc", "docs", "d3", "third")
			}
			// what one run with no crash leaves
			const clean = `${d.dir}/Clean`
			const m0 = new Model()
			await laid(open(d, clean), m0, [...STEPS, last])
			const expect = await listing(clean)
			for (let n = 1; n < 80; n++) {
				const f = `${d.dir}/Crash${n}`
				const m = new Model()
				await laid(open(d, f), m, STEPS)
				let count = 0
				const base = safe()
				const crashing: Sys = {
					...base,
					rename: (
						a,
						b,
					) => (++count >= n ? Promise.reject(new Error("crash")) : base.rename(a, b)),
					swap: (
						a,
						b,
					) => (++count >= n ? Promise.reject(new Error("crash")) : base.swap(a, b)),
					set: (
						p,
						k,
						v,
					) => (++count >= n ? Promise.reject(new Error("crash")) : base.set(p, k, v)),
				}
				const t = open(d, f, { sys: crashing })
				await t.read(m.saving())
				last(m)
				let crashed = false
				try {
					await t.write(m.saving())
				} catch {
					crashed = true
				}
				const again = open(d, f, { files: true })
				await again.read(m.saving())
				assertEquals(await listing(f), expect, `a crash at call ${n}`)
				assertEquals(again.missed, [], `a crash at call ${n}`)
				assertEquals(await Array.fromAsync(Deno.readDir(`${f}/.ermine/tmp`)), [])
				if (!crashed) break
			}
		}),
})

Deno.test({
	name: "edits made in a mirror's folder are differences, and mend lays them out again",
	ignore: !mac,
	fn: () =>
		within(async (folder, d) => {
			const t = open(d, folder)
			const m = new Model()
			await laid(t, m)
			await Deno.writeTextFile(`${folder}/apps/clock.txt`, "12:30")
			await Deno.writeTextFile(`${folder}/stray.txt`, "mine")
			await Deno.writeTextFile(`${folder}/.ermine/root.txt`, "edited root")
			const found = await t.differences()
			assertEquals(found.map((x) => x.path).sort(), [
				".ermine/root.txt",
				"apps/clock.txt",
				"stray.txt",
			])
			await t.lock(() => t.mend())
			assertEquals(await Deno.readTextFile(`${folder}/apps/clock.txt`), "12:00")
			assertEquals(await Deno.readTextFile(`${folder}/.ermine/root.txt`), "the document")
			assertEquals(await t.differences(), [])
			assertEquals(await Deno.readTextFile(`${d.bin}/stray.txt`), "mine")
			assert(await Deno.lstat(`${folder}/stray.txt`).then(() => false, () => true))
		}),
})

Deno.test({
	name: "a folder holding others' entries is a mirror only for a host running the files program",
	ignore: !mac,
	fn: () =>
		within(async (folder, d) => {
			await Deno.mkdir(folder)
			await Deno.writeTextFile(`${folder}/mine.txt`, "mine")
			const m = new Model()
			await assertRejects(
				() => open(d, folder).read(m.saving()),
				StoreError,
				"entries and no store",
			)
			const listed: Listed[] = []
			const t = open(d, folder, { files: true, list: (l) => listed.push(l) })
			await t.read(m.saving())
			assertEquals(t.missed.map((x) => x.path), ["mine.txt"])
			// a mirror keeps no records of a host's, and no graph
			await t.write(m.saving())
			await assertRejects(
				() => t.write({ ...m.saving(), records: new Map([["sync", new Uint8Array([1])]]) }),
				StoreError,
				"keeps no records",
			)
			assertEquals(await Deno.readTextFile(`${folder}/mine.txt`), "mine")
		}),
})

Deno.test({
	name: "a mirror in a synced place keeps its manifest outside, as a store does",
	ignore: !mac,
	fn: () =>
		within(async (_, d) => {
			const folder = `${d.home}/Library/CloudStorage/Dropbox/Mirror`
			await Deno.mkdir(`${d.home}/Library/CloudStorage/Dropbox`, { recursive: true })
			const m = new Model()
			await laid(open(d, folder), m)
			assertEquals(
				(await Array.fromAsync(Deno.readDir(folder))).map((e) => e.name).sort(),
				["Notes", "apps", "apps.text", "docs", "pinned.txt"],
			)
			const [uuid] = (await Array.fromAsync(Deno.readDir(`${d.home}/.ermine/external`))).map((
				e,
			) => e.name)
				.filter((n) => n !== "stores")
			const dir = `${d.home}/.ermine/external/${uuid}`
			assertEquals(
				(await Array.fromAsync(Deno.readDir(dir))).map((e) => e.name).sort(),
				["id", "manifest", "root.txt", "tmp"],
			)
		}),
})
