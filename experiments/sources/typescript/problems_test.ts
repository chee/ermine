// the problems found (plan.org, "found"), each shown as it is now: a test here passes while its
// problem stands, and fails once something changes it. nothing here is a rule
import { assert, assertEquals, assertNotEquals } from "@std/assert"
import { createScheduler } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Key } from "@ermine/table"
import { createPlaces, type Fact, place } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import { upsert } from "@ermine/places/upsert"
import createEntry from "@ermine/node/entry"
import { createFakeFile, type FileAccess } from "./access.ts"
import { denoFile } from "./deno.ts"
import { openFile, UNWRITABLE } from "./file.ts"
import { createHistory } from "./history.ts"
import { ORPHAN } from "./holder.ts"
import { createLink } from "./link.ts"
import { createMemory } from "./memory.ts"
import { openMirror, text } from "./mirror.ts"
import { createWorld, type World } from "./world.ts"

const granted = (name: "write") => Deno.permissions.querySync({ name }).state === "granted"
const utf8 = (s: string) => new TextEncoder().encode(s)
const read = (b: Uint8Array | undefined) => b && new TextDecoder().decode(b)
const tick = () => new Promise((r) => setTimeout(r, 10))
const device = (w: World) => w.scheduler.createRootScope({ actor: "laptop" })

async function until(f: () => boolean) {
	for (let i = 0; i < 400 && !f(); i++) await new Promise((r) => setTimeout(r, 5))
	assert(f(), "never came")
}

// a file in memory that can also be taken away, as a person deleting or renaming it does
function removable() {
	const file = createFakeFile()
	const pokes = new Set<() => void>()
	const access: FileAccess = {
		read: file.read,
		write: file.write,
		watch(poke) {
			pokes.add(poke)
			const stop = file.watch(poke)
			return () => (pokes.delete(poke), stop())
		},
	}
	const remove = () => {
		file.bytes = undefined
		queueMicrotask(() => [...pokes].forEach((p) => p()))
	}
	return { file, access, remove }
}

// ---- found before, checked again on this main

Deno.test("problem: a holder's drop and a link's since don't meet: what was dropped is never sent again", async () => {
	const a = createWorld("A"), m = createMemory()
	const link = createLink(a.history, m)
	a.set("N", 1)
	await link.sync()
	await m.drop("N")
	a.set("N", 2)
	const after = await link.sync()
	assertEquals(after.ab.refused.map((r) => r.why), [ORPHAN])
	assertEquals(m.writes(), [])
	// the history's own drop: the next write there is a second root
	await a.history.drop("N")
	a.set("N", 3)
	assertEquals(a.history.writes().at(-1)!.parents, [])
})

Deno.test("problem: refused for now is lost on that link: the disk comes back, the node never does", async () => {
	const a = createWorld("A"), f = createFakeFile()
	const holder = await openFile(f)
	const link = createLink(a.history, holder)
	f.fail = true
	a.set("N", 1)
	assert((await link.sync()).ab.refused[0].why.startsWith(UNWRITABLE))
	f.fail = false
	a.set("N", 2)
	const after = await link.sync()
	assertEquals(after.ab.refused.map((r) => r.why), [ORPHAN])
	assertEquals(holder.get && (await holder.get("N")).length, 0)
})

Deno.test("problem: a cursor can't move partway: a holder that says not now once is never asked again", async () => {
	const a = createWorld("A")
	let busy = true
	const m = createMemory({ refuse: () => busy ? "busy" : undefined })
	const link = createLink(a.history, m)
	a.set("N", 1)
	a.set("K", 1)
	assertEquals((await link.sync()).ab.refused.length, 2)
	busy = false
	assertEquals((await link.sync()).ab.sent, 0)
	assertEquals(m.writes(), [])
})

// table.del taking no header: on main places makes a removal's change from the scope open, its
// site table.del's caller (history_test.ts). left: a removal landed from elsewhere
Deno.test("problem: a removal landed from elsewhere is told with no change: who took it out is lost", async () => {
	const a = createWorld("A"), b = createWorld("B")
	a.set("N", 1)
	a.scheduler.runWithScope(a.scope, () => a.table.del("value", "N"))
	assertEquals(a.history.writes()[1].change.actor, "A")
	const told: Fact[] = []
	b.places.watchAll((f) => void told.push(f))
	await b.history.put(a.history.writes())
	assertEquals(b.value("N"), undefined)
	const removal = told.find((f) => f.id === "N" && f.patches[0].value === undefined)!
	assertEquals(removal.change, undefined)
	// landed with a scope open, it is told as that scope's
	const c = createWorld("C")
	const at: Fact[] = []
	c.places.watchAll((f) => void at.push(f))
	await c.scheduler.runWithScope(c.scope, () => c.history.put(a.history.writes()))
	assertEquals(at.find((f) => f.patches[0].value === undefined)!.change?.actor, "C")
})

// found before, not shown here: unread copies a patch's value before writing under it, so a fact's
// patches stay as told (the fact's entry is live, as it says)
Deno.test("not reproduced: a fact's values changed after it is told (children written in place)", () => {
	const w = createWorld("A")
	const facts: Fact[] = []
	w.places.watchAll((f) => void facts.push(f))
	w.scheduler.runWithScope(w.scope, () => {
		w.table.add("children", "D", createEntry({}, createChangeHeader(w.scheduler)) as never)
		w.places.commit(
			place(w.table.get("children", "D")!, "a", "X", createChangeHeader(w.scheduler)),
		)
		w.places.commit(
			place(w.table.get("children", "D")!, "b", "Y", createChangeHeader(w.scheduler)),
		)
	})
	assertEquals(facts.map((f) => f.patches), [
		[{ path: [], value: {} }],
		[{ path: ["a"], value: "X" }],
		[{ path: ["b"], value: "Y" }],
	])
})

Deno.test("problem: a history made after the graph's first write has no base; another graph never gets the node", async () => {
	const scheduler = createScheduler()
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const places = createPlaces({ root: "R", table, paths: createPaths<unknown>(), scheduler })
	const scope = scheduler.createRootScope({ actor: "A" })
	const set = (value: unknown, path: string[]) =>
		scheduler.runWithScope(scope, () => {
			places.commit(upsert(table, "value", "N", path, value, createChangeHeader(scheduler)))
		})
	set({ a: 0, b: 0 }, [])
	const late = createHistory({ table, places })
	set(1, ["a"])
	assertEquals(late.writes()[0].parents, [])
	const b = createWorld("B")
	assertEquals(await b.history.put(late.writes()), ["taken"])
	assertEquals(b.value("N"), undefined)
})

Deno.test("problem: echo by a flag: a watcher writing back while a write lands is never recorded", async () => {
	const a = createWorld("A"), b = createWorld("B")
	b.places.watchAll((f) => {
		const v = b.value("N") as Record<string, unknown> | undefined
		if (f.id === "N" && v && !("seen" in v)) b.set("N", true, ["seen"])
	})
	a.set("N", { x: 1 })
	await createLink(a.history, b.history).sync()
	assertEquals(b.value("N"), { x: 1, seen: true })
	assertEquals(b.history.writes().length, 1)
	assertEquals(a.value("N"), { x: 1 })
})

Deno.test("problem: a holder that can't list: a poke has nothing to say, so the link moves nothing", async () => {
	const a = createWorld("A"), b = createWorld("B")
	const n = createMemory({ lists: false })
	b.set("N", 1)
	await n.put(b.history.writes())
	const link = createLink(a.history, n)
	await link.sync()
	assertEquals(a.value("N"), undefined)
	await link.fetch("N")
	assertEquals(a.value("N"), 1)
})

Deno.test("problem: the mirror's whole-value write: a hand edit and a write elsewhere at once, one lost whole", async () => {
	const a = createWorld("A"), b = createWorld("B")
	const f = createFakeFile()
	a.set("NOTE", "hello world")
	const mirror = await openMirror({ ...a, scope: device(a), node: "NOTE", file: f, codec: text })
	const link = createLink(a.history, b.history)
	await link.sync()
	f.edit(utf8("hello world!"))
	await until(() => a.value("NOTE") === "hello world!")
	b.set("NOTE", "Hello world")
	await link.sync()
	await mirror.idle()
	const won = a.value("NOTE")
	assertEquals(b.value("NOTE"), won)
	assert(won === "hello world!" || won === "Hello world")
	assertNotEquals(won, "Hello world!")
	assertEquals(read(f.bytes), won)
	mirror.stop()
})

// ---- found now

Deno.test("problem: a hand edit not yet heard when a graph write lands is written over, in no history", async () => {
	const w = createWorld("A")
	const f = createFakeFile()
	w.set("NOTE", "base")
	const mirror = await openMirror({ ...w, scope: device(w), node: "NOTE", file: f, codec: text })
	f.edit(utf8("typed by hand"))
	w.set("NOTE", "from elsewhere")
	await tick()
	await mirror.idle()
	assertEquals(read(f.bytes), "from elsewhere")
	assertEquals(w.value("NOTE"), "from elsewhere")
	assert(!w.history.writes().some((x) => x.patches.some((p) => p.value === "typed by hand")))
	mirror.stop()
})

Deno.test("problem: a file that wouldn't write is never written again, and a hand edit to it then wins over the newer value", async () => {
	const w = createWorld("A")
	const f = createFakeFile()
	w.set("NOTE", "old")
	const mirror = await openMirror({ ...w, scope: device(w), node: "NOTE", file: f, codec: text })
	f.fail = true
	w.set("NOTE", "new")
	await mirror.idle()
	assert(mirror.trouble()?.includes("the disk said no"))
	f.fail = false
	await tick()
	await mirror.idle()
	assertEquals(read(f.bytes), "old")
	f.edit(utf8("old, edited"))
	await until(() => w.value("NOTE") === "old, edited")
	mirror.stop()
})

Deno.test("problem: a file deleted by hand is nothing; it comes back on the next write", async () => {
	const w = createWorld("A")
	const { file, access, remove } = removable()
	w.set("NOTE", "one")
	const mirror = await openMirror({
		...w,
		scope: device(w),
		node: "NOTE",
		file: access,
		codec: text,
	})
	const before = w.history.writes().length
	remove()
	await tick()
	await mirror.idle()
	assertEquals(w.value("NOTE"), "one")
	assertEquals(w.history.writes().length, before)
	w.set("NOTE", "two")
	await mirror.idle()
	assertEquals(read(file.bytes), "two")
	mirror.stop()
})

Deno.test("problem: a value taken out leaves the file; a hand edit to it brings the value back", async () => {
	const w = createWorld("A")
	const f = createFakeFile()
	w.set("NOTE", "here")
	const mirror = await openMirror({ ...w, scope: device(w), node: "NOTE", file: f, codec: text })
	w.scheduler.runWithScope(w.scope, () => w.table.del("value", "NOTE"))
	await tick()
	await mirror.idle()
	assertEquals(read(f.bytes), "here")
	f.edit(utf8("here again"))
	await until(() => w.value("NOTE") === "here again")
	mirror.stop()
})

Deno.test("problem: two mirrors on one file: the second's node is written over when opened, then the two are tied", async () => {
	const w = createWorld("A")
	const f = createFakeFile()
	w.set("N", "n's")
	w.set("M", "m's")
	const one = await openMirror({ ...w, scope: device(w), node: "N", file: f, codec: text })
	const two = await openMirror({ ...w, scope: device(w), node: "M", file: f, codec: text })
	assertEquals(w.value("M"), "n's")
	w.set("N", "only n")
	await until(() => w.value("M") === "only n")
	one.stop()
	two.stop()
})

Deno.test("problem: text: a value not a string goes out as JSON and comes back a string", async () => {
	const w = createWorld("A")
	const f = createFakeFile()
	w.set("N", { a: 1 })
	const mirror = await openMirror({ ...w, scope: device(w), node: "N", file: f, codec: text })
	assertEquals(read(f.bytes), '{"a":1}')
	f.edit(utf8('{"a":2}'))
	await until(() => typeof w.value("N") === "string")
	assertEquals(w.value("N"), '{"a":2}')
	mirror.stop()
})

Deno.test("problem: a file that won't decode: trouble on the mirror only; the next write goes over the person's bytes", async () => {
	const w = createWorld("A")
	const f = createFakeFile()
	w.set("NOTE", "fine")
	const mirror = await openMirror({ ...w, scope: device(w), node: "NOTE", file: f, codec: text })
	f.edit(new Uint8Array([0x68, 0x69, 0xff]))
	await tick()
	await mirror.idle()
	assert(mirror.trouble()?.startsWith("unreadable"))
	assertEquals(w.value("NOTE"), "fine")
	w.set("NOTE", "later")
	await mirror.idle()
	assertEquals(read(f.bytes), "later")
	mirror.stop()
})

Deno.test("problem: opened, the file wins over the graph's value, no one asked", async () => {
	const w = createWorld("A")
	const f = createFakeFile()
	w.set("NOTE", "the graph's")
	f.bytes = utf8("the file's")
	const mirror = await openMirror({ ...w, scope: device(w), node: "NOTE", file: f, codec: text })
	assertEquals(w.value("NOTE"), "the file's")
	mirror.stop()
})

Deno.test("problem: a hand edit's site is mirror.ts, and nothing in its change names the file", async () => {
	const w = createWorld("A")
	const f = createFakeFile()
	w.set("NOTE", "a")
	const mirror = await openMirror({ ...w, scope: device(w), node: "NOTE", file: f, codec: text })
	f.edit(utf8("b"))
	await until(() => w.value("NOTE") === "b")
	const change = w.history.writes().at(-1)!.change
	assert(change.external?.[0].file.endsWith("/mirror.ts"))
	assertEquals(change.metadata, { actor: "laptop" })
	mirror.stop()
})

Deno.test("problem: a merge lands as one whole value under the last write's change; of two at one path, one is in no read", async () => {
	const base = createWorld("O")
	base.set("N", { a: 0, b: 0 })
	const a = createWorld("A"), b = createWorld("B")
	await a.history.put(base.history.writes())
	await b.history.put(base.history.writes())
	a.set("N", 1, ["a"])
	b.set("N", 2, ["b"])
	const told: Fact[] = []
	a.places.watchAll((f) => void told.push(f))
	await a.history.put(b.history.writes().slice(1))
	assertEquals(a.value("N"), { a: 1, b: 2 })
	// a's own change to a is told, and kept, as B's replacing the whole value
	const entry = a.table.get("value", "N")!
	assertEquals(entry.change.actor, "B")
	assertEquals(entry.change.op?.patches, [{ path: [], value: { a: 1, b: 2 } }])
	assertEquals(told.map((f) => f.patches), [[{ path: [], value: { a: 1, b: 2 } }]])
	// at one path: one value, picked by name order; the other only in history
	a.set("N", "a's", ["a"])
	b.set("N", "b's", ["a"])
	await a.history.put(b.history.writes().slice(-1))
	assertEquals(a.history.heads("N", "value").length, 2)
	const kept = (a.value("N") as { a: string }).a
	assert(kept === "a's" || kept === "b's")
})

Deno.test("problem: every node is recorded and landed, reachable or not; the host has no say in what syncs", async () => {
	const a = createWorld("A"), b = createWorld("B")
	a.set("SECRET", "not placed anywhere")
	await createLink(a.history, b.history).sync()
	assertEquals(b.value("SECRET"), "not placed anywhere")
	assertEquals(b.table.get("children", "R"), undefined)
})

Deno.test("problem: a scope whose info holds a function: all its writes are skipped, counted, never sent", () => {
	const w = createWorld("A")
	const odd = w.scheduler.createRootScope({ actor: "A", open: () => {} })
	w.scheduler.runWithScope(odd, () => {
		w.places.commit(
			upsert(w.table, "value", "N", [], 1, createChangeHeader(w.scheduler)),
		)
	})
	assertEquals(w.value("N"), 1)
	assertEquals(w.history.writes(), [])
	assertEquals(w.history.skipped(), 1)
})

Deno.test("problem: a write at a symbol id is dropped, not even counted", () => {
	const w = createWorld("A")
	const id = Symbol("N")
	w.scheduler.runWithScope(w.scope, () => {
		w.places.commit(upsert(w.table, "value", id, [], 1, createChangeHeader(w.scheduler)))
	})
	assertEquals(w.table.get("value", id)?.value, 1)
	assertEquals([w.history.writes().length, w.history.skipped()], [0, 0])
})

Deno.test("problem: one process's drop is undone by another's next save", async () => {
	const a = createWorld("A"), f = createFakeFile()
	const one = await openFile(f), two = await openFile(f)
	a.set("N", 1)
	await createLink(a.history, one).sync()
	await two.load()
	await one.drop("N")
	assertEquals((await one.get!("N")).length, 0)
	a.set("K", 1)
	await createLink(a.history, two).sync()
	await one.load()
	assertEquals((await one.get!("N")).length, 1)
})

Deno.test({
	name: "problem: on disk, a mirrored symlink is replaced by a plain file",
	ignore: !granted("write"),
	async fn() {
		const dir = await Deno.makeTempDir()
		try {
			await Deno.writeTextFile(`${dir}/real.txt`, "a")
			await Deno.symlink(`${dir}/real.txt`, `${dir}/note.txt`)
			const w = createWorld("A")
			const mirror = await openMirror({
				...w,
				scope: device(w),
				node: "NOTE",
				file: denoFile(`${dir}/note.txt`),
				codec: text,
			})
			w.set("NOTE", "b")
			await mirror.idle()
			mirror.stop()
			assertEquals((await Deno.lstat(`${dir}/note.txt`)).isSymlink, false)
			assertEquals(await Deno.readTextFile(`${dir}/real.txt`), "a")
		} finally {
			await Deno.remove(dir, { recursive: true })
		}
	},
})
