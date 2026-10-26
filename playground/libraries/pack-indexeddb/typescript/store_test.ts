// deno test playground/pack-indexeddb/typescript/store_test.ts, against fake-indexeddb
import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert"
import { IDBFactory } from "npm:fake-indexeddb@6"
import createEntry from "@ermine/core/node/entry"
import update from "@ermine/core/node/update"
import { PackError } from "@ermine/formats/pack"
import { createStore, type Factory } from "./store.ts"

const fresh = () => createStore("test", { indexedDB: new IDBFactory() as unknown as Factory })
const n = (value: unknown) => createEntry(value, { time: 1, actor: "a" })

Deno.test("pack-indexeddb: saved, then loaded back, a shared node one node again", async () => {
	const store = fresh()
	const shared = n({ k: [1, 2] })
	await store.save("home", [["value", "a", shared], ["value", "b", shared], [
		"children",
		"a",
		n({}),
	]])
	const back = (await store.load("home"))!
	assertEquals(back.map(([p, i]) => [p, i]), [["value", "a"], ["value", "b"], ["children", "a"]])
	assertStrictEquals(back[0][2], back[1][2])
	assertEquals(back[0][2].value, { k: [1, 2] })
	await store.close()
})

Deno.test("pack-indexeddb: saving a name again replaces it; names, remove", async () => {
	const store = fresh()
	await store.save("a", [["value", "x", n(1)]])
	await store.save("b", [["value", "x", n(2)]])
	await store.save("a", [["value", "x", n(3)]])
	assertEquals((await store.load("a"))![0][2].value, 3)
	assertEquals((await store.names()).sort(), ["a", "b"])
	await store.remove("a")
	assertEquals(await store.load("a"), undefined)
	assertEquals(await store.names(), ["b"])
	await store.close()
})

Deno.test("pack-indexeddb: pack's options and reading pass through", async () => {
	const store = fresh()
	const node = n({ s: "abc" })
	update(node, [{ path: ["s"], range: [0, 1], value: "A" }], { time: 2, actor: "a" })
	await store.save("with", [["value", "x", node]])
	await store.save("without", [["value", "x", node]], { op: false })
	assertEquals((await store.load("with"))![0][2].change.op, node.change.op)
	assertEquals("op" in (await store.load("without"))![0][2].change, false)
	const record = await store.saved("with")
	assertEquals(record!.bytes instanceof Uint8Array, true)
	assertEquals((await store.load("with", { loosyGoosy: true }))![0][2].value, { s: "Abc" })
	await store.close()
})

Deno.test("pack-indexeddb: a pack that throws keeps nothing", async () => {
	const store = fresh()
	await store.save("a", [["value", "x", n(1)]])
	await assertRejects(() => store.save("a", [["value", "x", n(Symbol("s"))]]), PackError)
	assertEquals((await store.load("a"))![0][2].value, 1)
	await store.close()
})
