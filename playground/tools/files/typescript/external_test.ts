import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert"
import { decode, type Value } from "@ermine/encoding/cbor"
import createNode, { type List, type Node as Saved } from "./saved.ts"
import * as pack from "./saved.ts"
import { type Foundation, system as foundation } from "./foundation.ts"
import { find, type Store, store as make, stores } from "./store.ts"
import { attr, fake, type Sys, system } from "./sys.ts"
import { type Id, type Listed, type Options, StoreError } from "./types.ts"

// Every test works in a folder of its own from Deno.makeTempDir, with a home
// folder and a fake Trash there: the person's home and Trash are never asked.
// Synced places are the test home's Library/CloudStorage, a place the test
// names, or a folder a fake Foundation says is in iCloud.

const granted = (["write", "ffi"] as const).every((name) =>
	Deno.permissions.querySync({ name }).state === "granted"
)
const mac = Deno.build.os === "darwin" && granted
const text = new TextDecoder()
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const safe = (): Sys => ({
	...system(),
	trash: () => Promise.reject(new Error("a test never uses the real Trash")),
})

type Dirs = { dir: string; home: string; bin: string; cloud: string }

/** A folder holding a test home, a Trash and a place a service syncs. */
async function within(fn: (d: Dirs) => Promise<void>) {
	const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "ermine-external-" }))
	const d = {
		dir,
		home: `${dir}/Home`,
		bin: `${dir}/Trash`,
		cloud: `${dir}/Home/Library/CloudStorage/Dropbox`,
	}
	await Deno.mkdir(d.cloud, { recursive: true })
	try {
		await fn(d)
	} finally {
		await Deno.remove(dir, { recursive: true })
	}
}

const open = (d: Dirs, folder: string, options: Options = {}): Store =>
	make(folder, { sys: safe(), trash: fake(d.bin), home: d.home, ...options })

/** A graph of newcore nodes, changed by hand as a host's table would hold it. */
class Model {
	time = 0
	nodes = new Map<Id, Saved<unknown, unknown>>()
	constructor(readonly root = "r") {
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
	saving() {
		return { root: this.root, get: (id: Id) => this.nodes.get(id), time: this.time }
	}
	kept() {
		const nodes = pack.walk(this.root, (id) => this.nodes.get(id)).nodes
		return nodes.map((n) => [n.id, [...pack.encode(n)]] as const).sort((
			[a],
			[b],
		) => (a < b ? -1 : 1))
	}
}

/** The graph a store loads, to compare with a model's. */
const loaded = async (t: Store) => {
	const r = await t.read()
	return r?.nodes.map((n) => [n.id, [...pack.encode(n)]] as const).sort(([a], [b]) =>
		a < b ? -1 : 1
	)
}

async function made(t: Store, m = new Model()) {
	await t.read()
	for (
		const s of [
			() => m.write("r", "hello"),
			() => m.place("r", "apps", "a", { theme: "dark" }),
			() => m.place("a", "clock", "c", "12:00"),
			() => m.place("r", "docs", "d1", "hello"),
			() => m.place("r", "docs", "d2", PNG),
			() => m.place("r", "Notes", "x9"),
		]
	) {
		s()
		await t.write(m.saving())
	}
	return m
}

const names = async (dir: string) =>
	(await Array.fromAsync(Deno.readDir(dir))).map((e) => e.name).sort()
const exists = (path: string) => Deno.lstat(path).then(() => true, () => false)
const uuidOf = async (folder: string) => {
	const b = await system().get(folder, attr.store)
	return b ? text.decode(b) : undefined
}
const listing = async (dir: string) => {
	const out: string[] = []
	const walk = async (at: string, prefix: string) => {
		for await (const e of Deno.readDir(at)) {
			if (!prefix && e.name === ".ermine") continue
			out.push(
				prefix + e.name + (e.isSymlink ? ` -> ${await Deno.readLink(`${at}/${e.name}`)}` : ""),
			)
			if (e.isDirectory) await walk(`${at}/${e.name}`, prefix + e.name + "/")
		}
	}
	await walk(dir, "")
	return out.sort()
}

Deno.test({
	name: "an ordinary folder keeps its manifest inside and is in the list of stores",
	ignore: !mac,
	fn: () =>
		within(async (d) => {
			const folder = `${d.dir}/Store`
			const t = open(d, folder)
			const m = await made(t)
			assert(await exists(`${folder}/.ermine/manifest`))
			assert(await exists(`${folder}/.ermine/root.txt`))
			const uuid = (await uuidOf(folder))!
			assert(uuid)
			assertEquals((await stores({ home: d.home })).map((s) => [s.uuid, s.path]), [[
				uuid,
				folder,
			]])
			assertEquals(await find(uuid, { home: d.home }), folder)
			assertEquals(await names(`${d.home}/.ermine/external`), ["stores"])
			assertEquals(await loaded(open(d, folder)), m.kept())
		}),
})

Deno.test({
	name: "a folder in CloudStorage keeps its manifest in the home folder, links as ever",
	ignore: !mac,
	fn: () =>
		within(async (d) => {
			const folder = `${d.cloud}/Store`
			const t = open(d, folder)
			const m = await made(t)
			const uuid = (await uuidOf(folder))!
			// nothing of ermine's is in the folder
			assertEquals(await names(folder), ["Notes", "apps", "apps.text", "docs"])
			const dir = `${d.home}/.ermine/external/${uuid}`
			assertEquals(await names(dir), ["id", "manifest", "root.txt", "tmp", "values"])
			assertEquals(await Deno.readTextFile(`${dir}/root.txt`), "hello")
			// a link into .ermine/id is as it is inside, and leads nowhere
			assertEquals(await Deno.readLink(`${folder}/Notes`), ".ermine/id/x9")
			assertEquals(await listing(folder), [
				"Notes -> .ermine/id/x9",
				"apps",
				"apps.text",
				"apps/clock.txt",
				"docs",
				"docs/1.txt",
				"docs/2.png",
			])
			// loading finds it by the folder's uuid, and nothing is a difference
			const again = open(d, folder)
			assertEquals(await loaded(again), m.kept())
			assertEquals(again.missed, [])
			assertEquals(await again.differences(), [])
			// more is laid, still outside
			m.write("c", "13:00")
			await again.write(m.saving())
			assertEquals(await Deno.readTextFile(`${folder}/apps/clock.txt`), "13:00")
			assertEquals(await names(folder), ["Notes", "apps", "apps.text", "docs"])
			assertEquals((await stores({ home: d.home })).map((s) => [s.uuid, s.path]), [[
				uuid,
				folder,
			]])
		}),
})

Deno.test({
	name: "a place the host names, and a folder macOS says is in iCloud, have theirs outside too",
	ignore: !mac,
	fn: () =>
		within(async (d) => {
			const named = `${d.dir}/Shared/Store`
			await Deno.mkdir(`${d.dir}/Shared`)
			await made(open(d, named, { outside: [`${d.dir}/Shared`] }))
			assertEquals(await names(named), ["Notes", "apps", "apps.text", "docs"])
			const icloud = `${d.dir}/iCloud`
			await Deno.mkdir(icloud)
			const says: Foundation = { ...foundation, ubiquitous: (p) => p.startsWith(icloud) }
			// the folder is not there yet: the nearest parent is asked
			await made(open(d, `${icloud}/Store`, { foundation: says }))
			assertEquals(await names(`${icloud}/Store`), ["Notes", "apps", "apps.text", "docs"])
			assertEquals((await names(`${d.home}/.ermine/external`)).length, 3)
			// and an ordinary folder, beside them, has its own inside
			await made(open(d, `${d.dir}/Plain`, { foundation: says, outside: [`${d.dir}/Shared`] }))
			assert(await exists(`${d.dir}/Plain/.ermine/manifest`))
		}),
})

Deno.test({
	name: "a folder moved into a synced place has its manifest moved out, and back when it leaves",
	ignore: !mac,
	fn: () =>
		within(async (d) => {
			const folder = `${d.dir}/Store`
			const m = await made(open(d, folder))
			const uuid = (await uuidOf(folder))!
			assert(await exists(`${folder}/.ermine/manifest`))
			// into CloudStorage, by Finder or mv: the folder's uuid moves with it
			const there = `${d.cloud}/Moved`
			await Deno.rename(folder, there)
			const t = open(d, there)
			assertEquals(await loaded(t), m.kept())
			assertEquals(t.missed, [])
			assertEquals(await names(there), ["Notes", "apps", "apps.text", "docs"])
			assert(await exists(`${d.home}/.ermine/external/${uuid}/manifest`))
			assertEquals((await stores({ home: d.home })).map((s) => [s.uuid, s.path]), [[
				uuid,
				there,
			]])
			// and out of it
			const back = `${d.dir}/Back`
			await Deno.rename(there, back)
			const u = open(d, back)
			assertEquals(await loaded(u), m.kept())
			assert(await exists(`${back}/.ermine/manifest`))
			assertEquals(await names(`${d.home}/.ermine/external`), ["stores"])
			assertEquals((await stores({ home: d.home })).map((s) => [s.uuid, s.path]), [[uuid, back]])
			assertEquals(await uuidOf(back), uuid)
			// a batch after the moves is laid as ever
			m.write("c", "13:00")
			await u.write(m.saving())
			assertEquals(await Deno.readTextFile(`${back}/apps/clock.txt`), "13:00")
		}),
})

Deno.test({
	name:
		"a folder renamed is found by its uuid; the list follows it, and a bookmark while nothing runs",
	ignore: !mac,
	fn: () =>
		within(async (d) => {
			const a = `${d.cloud}/Store`
			const m = await made(open(d, a))
			const uuid = (await uuidOf(a))!
			const b = `${d.cloud}/Renamed`
			await Deno.rename(a, b)
			// no host has run: the bookmark leads there
			assertEquals(await find(uuid, { home: d.home }), b)
			assertEquals((await stores({ home: d.home }))[0].path, a)
			const t = open(d, b)
			assertEquals(await loaded(t), m.kept())
			assertEquals((await stores({ home: d.home }))[0].path, b)
			// a store that is gone is not found
			await Deno.remove(b, { recursive: true })
			assertEquals(await find(uuid, { home: d.home }), undefined)
			assertEquals(await find("no-such-uuid", { home: d.home }), undefined)
		}),
})

Deno.test({
	name:
		"a copy of a store is a store of its own, with an empty manifest, whether it was outside or in",
	ignore: !mac,
	fn: () =>
		within(async (d) => {
			for (const outside of [true, false]) {
				const where = outside ? d.cloud : d.dir
				const a = `${where}/Store${outside}`
				const m = await made(open(d, a))
				const uuid = (await uuidOf(a))!
				// Duplicate: every file, the folder's hidden ones and its attributes too
				const b = `${where}/Copy${outside}`
				await new Deno.Command("cp", { args: ["-Rp", a, b] }).output()
				assertEquals(await uuidOf(b), uuid)
				// a host that does not run the files program will not write into it
				await assertRejects(() => open(d, b).read(), StoreError, "entries and no store")
				const listed: Listed[] = []
				const t = open(d, b, { files: true, list: (l) => listed.push(l) })
				assertEquals(await t.read(), undefined)
				const mine = (await uuidOf(b))!
				assertNotEquals(mine, uuid)
				assertEquals(t.missed.length > 0, true)
				// an inside manifest, copied, was no one's: it is in the Trash
				assertEquals(listed.map((l) => l.path), outside ? [] : [".ermine"])
				assertEquals(await exists(`${b}/.ermine`), !outside)
				if (!outside) assertEquals(await names(`${d.bin}`), [".ermine"])
				if (!outside) await Deno.remove(`${d.bin}/.ermine`, { recursive: true })
				assert(
					await exists(
						outside ? `${d.home}/.ermine/external/${mine}/tmp` : `${b}/.ermine/tmp`,
					),
				)
				// the original is as it was
				assertEquals(await loaded(open(d, a)), m.kept())
				assertEquals(await uuidOf(a), uuid)
				const all = (await stores({ home: d.home })).map((s) => s.uuid)
				assert(all.includes(uuid) && all.includes(mine))
				await Deno.remove(a, { recursive: true })
				await Deno.remove(b, { recursive: true })
			}
		}),
})

Deno.test({
	name: "a folder with a uuid and no manifest here is a new store",
	ignore: !mac,
	fn: () =>
		within(async (d) => {
			// as iCloud brings it from another Mac: the folder, its attribute, no manifest
			const folder = `${d.cloud}/Brought`
			await Deno.mkdir(folder)
			await system().set(folder, attr.store, new TextEncoder().encode("from-another-mac"))
			const t = open(d, folder)
			assertEquals(await t.read(), undefined)
			assertEquals(await uuidOf(folder), "from-another-mac")
			assert(await exists(`${d.home}/.ermine/external/from-another-mac/id`))
			assertEquals(await names(folder), [])
			const m = await made(t)
			assertEquals(await loaded(open(d, folder)), m.kept())
		}),
})

Deno.test({
	name: "the list of stores is a CBOR map of uuid to path and bookmark",
	ignore: !mac,
	fn: () =>
		within(async (d) => {
			const a = `${d.dir}/One`, b = `${d.cloud}/Two`
			await made(open(d, a))
			await made(open(d, b))
			const raw = decode(await Deno.readFile(`${d.home}/.ermine/external/stores`)) as {
				[uuid: string]: { path: string; bookmark: Uint8Array }
			}
			const got = Object.entries(raw).map(([u, e]) => [u, e.path, e.bookmark.byteLength > 0])
				.sort((x, y) => (x[1]! < y[1]! ? -1 : 1))
			assertEquals(
				got,
				[
					[(await uuidOf(b))!, b, true],
					[(await uuidOf(a))!, a, true],
				].sort((x, y) => (x[1]! < y[1]! ? -1 : 1)),
			)
			assertEquals((await stores({ home: d.home })).length, 2)
			// no file of a write in progress is left beside it
			assert(!(await names(`${d.home}/.ermine/external`)).some((n) => n.startsWith("stores.")))
		}),
})

Deno.test({
	name: "a test's home is the only one touched",
	ignore: !mac,
	fn: () =>
		within(async (d) => {
			const real = `${Deno.env.get("HOME")}/.ermine/external/stores`
			const before = await exists(real) ? await Deno.readFile(real) : null
			await made(open(d, `${d.cloud}/Store`))
			await made(open(d, `${d.dir}/Plain`))
			assertEquals(await exists(real) ? await Deno.readFile(real) : null, before)
		}),
})

Deno.test({
	name: "writes of entries a person sees are coordinated, those in tmp are not, unless it is off",
	ignore: !mac,
	fn: () =>
		within(async (d) => {
			for (const on of [true, false]) {
				const paths: string[] = []
				const watching: Foundation = {
					...foundation,
					coordinate(path, writing, fn, options) {
						paths.push(path)
						return foundation.coordinate(path, writing, fn, options)
					},
				}
				const folder = `${d.dir}/Store${on}`
				const t = open(d, folder, { foundation: watching, coordinate: on })
				const m = await made(t)
				m.write("c", "13:00")
				await t.write(m.saving())
				assertEquals(await Deno.readTextFile(`${folder}/apps/clock.txt`), "13:00")
				if (!on) assertEquals(paths, [])
				else {
					assert(paths.length > 0)
					assert(paths.includes(`${folder}/apps/clock.txt`))
					assert(paths.includes(`${folder}/docs/2.png`))
					assert(paths.every((p) => p.startsWith(`${folder}/`) && !p.includes("/.ermine/tmp")))
					assertEquals(await loaded(open(d, folder, { coordinate: on })), m.kept())
				}
			}
		}),
})
