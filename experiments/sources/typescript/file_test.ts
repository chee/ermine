import { assert, assertEquals } from "@std/assert"
import { encode } from "@ermine/encoding/cbor"
import { createFakeFile } from "./access.ts"
import { denoFile } from "./deno.ts"
import { openFile, UNWRITABLE } from "./file.ts"
import { createLink } from "./link.ts"
import { createWorld } from "./world.ts"

const granted = (name: "write" | "run") => Deno.permissions.querySync({ name }).state === "granted"

// until f holds, a few times a turn, at most a second
async function until(f: () => boolean) {
	for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 5))
	assert(f(), "never came")
}

Deno.test("a graph's writes saved in a file, and read back by a holder opened later", async () => {
	const file = createFakeFile()
	const a = createWorld("A")
	const holder = await openFile(file)
	a.set("N", 1)
	a.set("N", 2)
	await createLink(a.history, holder).sync()
	assert(file.bytes !== undefined)
	const again = await openFile(file)
	const b = createWorld("B")
	await createLink(again, b.history).sync()
	assertEquals(b.value("N"), 2)
	holder.close()
	again.close()
})

Deno.test("another process writing the file: heard, loaded, and on to the graph as writes", async () => {
	const file = createFakeFile()
	const a = createWorld("A"), b = createWorld("B")
	// two holders over one file, as two processes would have
	const mine = await openFile(file), theirs = await openFile(file)
	const ab = createLink(a.history, mine), bb = createLink(theirs, b.history)
	ab.start()
	bb.start()
	a.set("N", "from a")
	await until(() => b.value("N") === "from a")
	b.set("N", "from b")
	await until(() => a.value("N") === "from b")
	assertEquals(a.history.writes(), b.history.writes())
	for (const x of [ab, bb]) x.stop()
	mine.close()
	theirs.close()
})

Deno.test("a file that won't write: refused, nothing held", async () => {
	const file = createFakeFile()
	const holder = await openFile(file)
	const a = createWorld("A")
	a.set("N", 1)
	file.fail = true
	const round = await createLink(a.history, holder).sync()
	assertEquals(round.ab.refused.map((r) => r.why.split(":")[0]), [UNWRITABLE])
	assertEquals((await holder.since!()).writes, [])
	holder.close()
})

Deno.test("a file not a list of writes: trouble said, nothing taken; bad writes counted", async () => {
	const file = createFakeFile()
	file.bytes = new Uint8Array([0xff, 0x00])
	const holder = await openFile(file)
	assert(holder.trouble()?.startsWith("unreadable"))
	file.bytes = encode([{ name: "x", node: "N" }, 1])
	assertEquals(await holder.load(), { taken: 0, bad: 2 })
	assertEquals(holder.trouble(), undefined)
	holder.close()
})

Deno.test("drop: the node's writes gone from the file too", async () => {
	const file = createFakeFile()
	const holder = await openFile(file)
	const a = createWorld("A")
	a.set("N", 1)
	a.set("M", 1)
	await createLink(a.history, holder).sync()
	await holder.drop("N")
	const again = await openFile(file)
	assertEquals((await again.since!()).writes.map((w) => w.node), ["M"])
	holder.close()
	again.close()
})

Deno.test({
	name: "on disk through Deno: another process writing the file is heard by watchFs",
	ignore: !granted("write") || !granted("run"),
	async fn() {
		const dir = await Deno.makeTempDir()
		const path = `${dir}/graph.cbor`
		try {
			const a = createWorld("A"), b = createWorld("B")
			const holder = await openFile(denoFile(path))
			b.set("N", "from b")
			// the other process: b's writes, saved to the file by a holder of its own
			const other = createWorld("O")
			await createLink(b.history, other.history).sync()
			const link = createLink(holder, a.history)
			link.start()
			const writes = JSON.stringify(other.history.writes())
			const script = `
				import { encode } from "@ermine/encoding/cbor"
				await Deno.writeFile(${JSON.stringify(path)}, encode(${writes}))
			`
			const child = new Deno.Command(Deno.execPath(), {
				args: ["eval", "--quiet", script],
				cwd: new URL("../", import.meta.url).pathname,
			})
			assertEquals((await child.output()).code, 0)
			await until(() => a.value("N") === "from b")
			link.stop()
			holder.close()
		} finally {
			await Deno.remove(dir, { recursive: true })
		}
	},
})
