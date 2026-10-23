import { assert, assertEquals } from "@std/assert"
import { createFakeFile } from "./access.ts"
import { denoFile } from "./deno.ts"
import { createLink } from "./link.ts"
import { cbor, openMirror, text } from "./mirror.ts"
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

Deno.test("a hand edit to the file: an ordinary write into the graph, named by its history, by the device watching", async () => {
	const w = createWorld("A")
	const file = createFakeFile()
	w.set("NOTE", "first")
	const mirror = await openMirror({ ...w, scope: device(w), node: "NOTE", file, codec: text })
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
	const mirror = await openMirror({
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
	const mirror = await openMirror({ ...a, scope: device(a), node: "NOTE", file, codec: text })
	assertEquals(a.value("NOTE"), "on disk")
	const link = createLink(a.history, b.history)
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

Deno.test("cbor: any value; a file that doesn't decode is trouble, the graph untouched", async () => {
	const w = createWorld("A")
	const file = createFakeFile()
	w.set("N", { list: [1, 2], bytes: new Uint8Array([9]) })
	const mirror = await openMirror({ ...w, scope: device(w), node: "N", file, codec: cbor })
	file.edit(new Uint8Array([0xff]))
	await new Promise((r) => setTimeout(r, 10))
	await mirror.idle()
	assert(mirror.trouble()?.startsWith("unreadable"))
	assertEquals(w.value("N"), { list: [1, 2], bytes: new Uint8Array([9]) })
	mirror.stop()
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
			const mirror = await openMirror({
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
