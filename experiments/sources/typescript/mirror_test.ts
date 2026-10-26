import { assert, assertEquals } from "@std/assert"
import { createFakeFile } from "./access.ts"
import { denoFile } from "./deno.ts"
import { get } from "@ermine/core/places/lib"
import { PROCESS } from "@ermine/processes"
import { CWD } from "@ermine/processes/start"
import { createLink } from "./link.ts"
import { cbor, type Mirror, type MirrorSetup, openMirror, text } from "./mirror.ts"
import { FILE, MIRRORS, readRecord, readState, STATES, UNWRITTEN } from "./status.ts"
import { createWorld, type World } from "./world.ts"

const granted = (name: "write" | "run") => Deno.permissions.querySync({ name }).state === "granted"
const utf8 = (s: string) => new TextEncoder().encode(s)
const read = (b: Uint8Array | undefined) => b && new TextDecoder().decode(b)

async function until(f: () => boolean) {
	for (let i = 0; i < 400 && !f(); i++) await new Promise((r) => setTimeout(r, 5))
	assert(f(), "never came")
}

// the mirror's scope: the one device watching the file
const device = (w: World) => w.scheduler.createRootScope({ actor: "laptop" })
const tick = () => new Promise((r) => setTimeout(r, 10))
// what the mirror's node says, read by no one
// what the mirror's node holds, read by no one: its records, and its state's code
const shown = (w: World, m: Mirror) => readRecord(w.places, m.process.id)
const state = (w: World, m: Mirror) => readState(w.places, m.process.id)?.code
// a mirror opened, not refused
async function open(setup: MirrorSetup): Promise<Mirror> {
	const m = await openMirror(setup)
	if ("refused" in m) throw new Error(`refused: ${m.refused}`)
	return m
}

Deno.test("a hand edit to the file: an ordinary write into the graph, named by its history, by the device watching", async () => {
	const w = createWorld("A")
	const file = createFakeFile()
	w.set("NOTE", "first")
	const mirror = await open({ ...w, scope: device(w), node: "NOTE", file, codec: text })
	assertEquals(read(file.bytes), "first")
	file.edit(utf8("edited by hand"))
	await until(() => w.value("NOTE") === "edited by hand")
	const last = w.history.writes().at(-1)!
	assertEquals(last.patches, [{ path: [], value: "edited by hand" }])
	assertEquals(last.change.actor, "laptop")
	assertEquals(last.parents, [w.history.writes()[0].name])
	mirror.stop()
})

Deno.test("no echo: the graph's write written to the file once; the file heard back, nothing written", async () => {
	const w = createWorld("A")
	const file = createFakeFile()
	let writes = 0
	const counted = { ...file, write: (b: Uint8Array) => (writes++, file.write(b)) }
	w.set("NOTE", "one")
	const mirror = await open({
		...w,
		scope: device(w),
		node: "NOTE",
		file: counted,
		codec: text,
	})
	w.set("NOTE", "two")
	await mirror.idle()
	await new Promise((r) => setTimeout(r, 10))
	await mirror.idle()
	assertEquals(read(file.bytes), "two")
	assertEquals(writes, 2)
	assertEquals(w.history.writes().length, 2)
	// a hand edit: one write into the graph, nothing written back
	file.edit(utf8("three"))
	await until(() => w.value("NOTE") === "three")
	await new Promise((r) => setTimeout(r, 10))
	await mirror.idle()
	assertEquals(writes, 2)
	assertEquals(w.history.writes().length, 3)
	mirror.stop()
})

Deno.test("opened on a file there: the file read into the graph; an edit goes on through a link", async () => {
	const a = createWorld("A"), b = createWorld("B")
	const file = createFakeFile()
	file.bytes = utf8("on disk")
	const mirror = await open({ ...a, scope: device(a), node: "NOTE", file, codec: text })
	assertEquals(a.value("NOTE"), "on disk")
	const link = createLink(a.history, b.history, { graph: a })
	link.start()
	await link.idle()
	assertEquals(b.value("NOTE"), "on disk")
	file.edit(utf8("edited"))
	await until(() => b.value("NOTE") === "edited")
	// and back: b's write reaches a, and a's mirror writes the file
	b.set("NOTE", "from b")
	await until(() => read(file.bytes) === "from b")
	link.stop()
	mirror.stop()
})

Deno.test("cbor: any value; a file that doesn't decode is said on the node, the graph untouched", async () => {
	const w = createWorld("A")
	const file = createFakeFile()
	w.set("N", { list: [1, 2], bytes: new Uint8Array([9]) })
	const mirror = await open({ ...w, scope: device(w), node: "N", file, codec: cbor })
	file.edit(new Uint8Array([0xff]))
	await tick()
	await mirror.idle()
	assertEquals(state(w, mirror), "cant-decode")
	assert(readState(w.places, mirror.process.id)?.why?.startsWith("as CBOR"))
	assertEquals(w.value("N"), { list: [1, 2], bytes: new Uint8Array([9]) })
	mirror.stop()
})

Deno.test("status: a process at /system/mirrors/<file>; its state its computer's value, on its node; its records attributes; a reader runs again; never recorded; gone at stop", async () => {
	const w = createWorld("A")
	const file = createFakeFile("notes/today.txt")
	w.set("NOTE", "a")
	const mirror = await open({ ...w, scope: device(w), node: "NOTE", file, codec: text })
	const id = mirror.process.id
	assertEquals(mirror.process.at, ["system", "mirrors", "notes%2Ftoday.txt"])
	assertEquals(get(w.places, ["system", "mirrors", "notes%2Ftoday.txt"]), id)
	assertEquals(readState(w.places, id), { code: "in-step", words: "in step" })
	assertEquals(shown(w, mirror), {
		[FILE]: "notes/today.txt",
		[MIRRORS]: "NOTE",
		[UNWRITTEN]: 0,
		[CWD]: ["system", "mirrors"],
	})
	// a card: a computer reading the node's state
	const seen: unknown[] = []
	w.scheduler.runWithScope(
		w.scope,
		() => w.scheduler.createComputer(() => state(w, mirror), (v) => void seen.push(v)),
	)
	w.scheduler.pulse()
	file.fail = true
	w.set("NOTE", "b")
	await mirror.idle()
	w.scheduler.pulse()
	assertEquals(seen, ["in-step", "cant-write"])
	assertEquals(readState(w.places, id), {
		code: "cant-write",
		words: "can't write",
		why: "the disk said no",
	})
	// this device's: nothing of the node, nor the process's row, in the history
	assert(!w.history.writes().some((x) => x.node === id || x.part === PROCESS))
	// a hand edit's change names the mirror's process, its path naming the file
	file.fail = false
	file.edit(utf8("c"))
	await until(() => w.value("NOTE") === "c")
	const change = w.history.writes().at(-1)!.change
	assertEquals(change.actor, "laptop")
	assertEquals(change.metadata, { process: ["system", "mirrors", "notes%2Ftoday.txt"], node: id })
	mirror.stop()
	assertEquals([shown(w, mirror), readState(w.places, id)], [{}, undefined])
	assertEquals(get(w.places, ["system", "mirrors", "notes%2Ftoday.txt"]), undefined)
})

Deno.test("a hand edit not yet heard when a graph write lands: not written over; read in; both in history; said", async () => {
	const w = createWorld("A")
	const f = createFakeFile()
	w.set("NOTE", "base")
	const mirror = await open({ ...w, scope: device(w), node: "NOTE", file: f, codec: text })
	f.edit(utf8("typed by hand"))
	w.set("NOTE", "from elsewhere")
	await tick()
	await mirror.idle()
	assertEquals(read(f.bytes), "typed by hand")
	assertEquals(w.value("NOTE"), "typed by hand")
	assertEquals(w.history.writes().map((x) => x.patches[0].value), [
		"base",
		"from elsewhere",
		"typed by hand",
	])
	assertEquals(shown(w, mirror)[UNWRITTEN], 1)
	assertEquals(readState(w.places, mirror.process.id), {
		code: "changed-not-written",
		words: STATES["changed-not-written"],
	})
	// the next write: in step again
	w.set("NOTE", "later")
	await mirror.idle()
	assertEquals([read(f.bytes), state(w, mirror)], ["later", "in-step"])
	mirror.stop()
})

Deno.test("a write that throws: said, tried again later; written once the disk takes it", async () => {
	const w = createWorld("A")
	const f = createFakeFile()
	w.set("NOTE", "old")
	const mirror = await open({
		...w,
		scope: device(w),
		node: "NOTE",
		file: f,
		codec: text,
		retry: 5,
	})
	f.fail = true
	w.set("NOTE", "new")
	await mirror.idle()
	assertEquals(state(w, mirror), "cant-write")
	await tick()
	assertEquals(read(f.bytes), "old")
	f.fail = false
	await until(() => read(f.bytes) === "new")
	await mirror.idle()
	assertEquals(state(w, mirror), "in-step")
	mirror.stop()
})

Deno.test("a write that throws, then a hand edit to the file not written: read in over the value not written, said", async () => {
	const w = createWorld("A")
	const f = createFakeFile()
	w.set("NOTE", "old")
	const mirror = await open({
		...w,
		scope: device(w),
		node: "NOTE",
		file: f,
		codec: text,
		retry: 60_000,
	})
	f.fail = true
	w.set("NOTE", "new")
	await mirror.idle()
	f.fail = false
	f.edit(utf8("old, edited"))
	await until(() => w.value("NOTE") === "old, edited")
	await mirror.idle()
	assertEquals(read(f.bytes), "old, edited")
	assertEquals(state(w, mirror), "changed-while-failing")
	assert(w.history.writes().some((x) => x.patches[0].value === "new"))
	mirror.stop()
})

Deno.test("a file deleted by hand: said; nothing written while it is gone; a file there again is read in", async () => {
	const w = createWorld("A")
	const f = createFakeFile()
	w.set("NOTE", "one")
	const mirror = await open({ ...w, scope: device(w), node: "NOTE", file: f, codec: text })
	f.remove()
	await tick()
	await mirror.idle()
	assertEquals(state(w, mirror), "gone")
	assertEquals(w.value("NOTE"), "one")
	w.set("NOTE", "two")
	await mirror.idle()
	assertEquals(f.bytes, undefined)
	assertEquals(state(w, mirror), "gone-not-written")
	assertEquals(shown(w, mirror)[UNWRITTEN], 1)
	f.edit(utf8("back"))
	await until(() => w.value("NOTE") === "back")
	assertEquals(state(w, mirror), "in-step")
	mirror.stop()
})

Deno.test("a file not UTF-8, saved by hand: said; nothing written over it; edited into text, read in", async () => {
	const w = createWorld("A")
	const f = createFakeFile()
	w.set("NOTE", "fine")
	const mirror = await open({ ...w, scope: device(w), node: "NOTE", file: f, codec: text })
	const odd = new Uint8Array([0x68, 0x69, 0xff])
	f.edit(odd)
	await tick()
	await mirror.idle()
	assertEquals(state(w, mirror), "cant-decode")
	assertEquals(w.value("NOTE"), "fine")
	w.set("NOTE", "later")
	await mirror.idle()
	assertEquals(f.bytes, odd)
	assertEquals(state(w, mirror), "cant-decode-not-written")
	f.edit(utf8("hi"))
	await until(() => w.value("NOTE") === "hi")
	assertEquals(state(w, mirror), "in-step")
	mirror.stop()
})

Deno.test("two mirrors on one file: the second refused by start (its path taken), nothing made; free again once the first stops", async () => {
	const w = createWorld("A")
	const f = createFakeFile("note.txt")
	w.set("N", "n's")
	w.set("M", "m's")
	const one = await open({ ...w, scope: device(w), node: "N", file: f, codec: text })
	const two = await openMirror({ ...w, scope: device(w), node: "M", file: f, codec: text })
	assertEquals(two, { refused: "taken", at: ["system", "mirrors", "note.txt"] })
	w.set("N", "only n")
	await one.idle()
	await tick()
	assertEquals([read(f.bytes), w.value("M")], ["only n", "m's"])
	one.stop()
	const three = await open({ ...w, scope: device(w), node: "M", file: f, codec: text })
	assertEquals(state(w, three), "in-step")
	three.stop()
})

Deno.test({
	name: "on disk through Deno: a file edited by another process shows up as a write",
	ignore: !granted("write") || !granted("run"),
	async fn() {
		const dir = await Deno.makeTempDir()
		const path = `${dir}/note.txt`
		try {
			const w = createWorld("A")
			w.set("NOTE", "before")
			const mirror = await open({
				...w,
				scope: device(w),
				node: "NOTE",
				file: denoFile(path),
				codec: text,
			})
			assertEquals(await Deno.readTextFile(path), "before")
			const script = `await Deno.writeTextFile(${
				JSON.stringify(path)
			}, "after, by another process")`
			const child = new Deno.Command(Deno.execPath(), { args: ["eval", "--quiet", script] })
			assertEquals((await child.output()).code, 0)
			await until(() => w.value("NOTE") === "after, by another process")
			assertEquals(w.history.writes().at(-1)!.change.actor, "laptop")
			mirror.stop()
		} finally {
			await Deno.remove(dir, { recursive: true })
		}
	},
})

Deno.test({
	name: "on disk through Deno: a save not heard yet is not written over; nothing left beside",
	ignore: !granted("write"),
	async fn() {
		const dir = await Deno.makeTempDir()
		const path = `${dir}/note.txt`
		try {
			const w = createWorld("A")
			w.set("NOTE", "before")
			const mirror = await open({
				...w,
				scope: device(w),
				node: "NOTE",
				file: denoFile(path),
				codec: text,
			})
			await Deno.writeTextFile(path, "saved by hand")
			w.set("NOTE", "from elsewhere")
			await mirror.idle()
			assertEquals(await Deno.readTextFile(path), "saved by hand")
			assertEquals(shown(w, mirror)[UNWRITTEN], 1)
			await until(() => w.value("NOTE") === "saved by hand")
			assertEquals(Array.from(Deno.readDirSync(dir), (e) => e.name), ["note.txt"])
			mirror.stop()
		} finally {
			await Deno.remove(dir, { recursive: true })
		}
	},
})
