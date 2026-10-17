// deno-lint-ignore no-import-prefix
import * as wasm from "npm:@automerge/subduction@0.23.0"
import { assert, assertEquals } from "@std/assert"
import { type Backend, Storage } from "./storage.ts"

const tree = wasm.SedimentreeId.fromBytes(new Uint8Array(32).fill(1))
const id = (n: number) => wasm.CommitId.fromBytes(new Uint8Array(32).fill(n))
const signed = { encode: () => new Uint8Array([1, 2, 3]) }

// a backend whose writes wait until let go, each batch it is given kept as a copy
function slow(fail = false) {
	const kept = new Map<string, Uint8Array>()
	const batches: Map<string, Uint8Array | null>[] = []
	let go: (() => void)[] = []
	const backend: Backend = {
		read: () => Promise.resolve(new Map(kept)),
		write(batch) {
			batches.push(new Map(batch))
			return new Promise((done, failed) =>
				go.push(() => {
					if (fail) return failed(new Error("full"))
					for (const [k, v] of batch) v === null ? kept.delete(k) : kept.set(k, v)
					done()
				})
			)
		},
	}
	// lets every write go, those begun meanwhile too
	const release = async () => {
		for (;;) {
			await new Promise((r) => setTimeout(r, 0))
			if (!go.length) return
			const now = go
			go = []
			for (const f of now) f()
		}
	}
	return { backend, kept, batches, release }
}

Deno.test("storage: writes made while the backend writes go to it as one batch, after", async () => {
	const b = slow()
	const s = await Storage.open(b.backend)
	const first = s.saveCommit(tree, id(1), signed, new Uint8Array([1]))
	await new Promise((r) => setTimeout(r, 0))
	assertEquals(b.batches.length, 1)
	const rest = [2, 3, 4].map((n) => s.saveCommit(tree, id(n), signed, new Uint8Array([n])))
	rest.push(s.deleteCommit(tree, id(2)))
	await b.release()
	await Promise.all([first, ...rest])
	assertEquals(b.batches.length, 2)
	assertEquals(b.batches[1].size, 3)
	assertEquals((await s.listCommitIds(tree)).length, 3)
	assertEquals([...b.kept.keys()].filter((k) => k.startsWith("commit-")).length, 3)
})

Deno.test("storage: a save resolves only once its batch is kept", async () => {
	const b = slow()
	const s = await Storage.open(b.backend)
	let done = false
	const p = s.saveCommit(tree, id(1), signed, new Uint8Array([1])).then(() => done = true)
	await new Promise((r) => setTimeout(r, 10))
	assert(!done)
	await b.release()
	await p
	assert(b.kept.size > 0)
})

Deno.test("storage: a sedimentree id already here is not written again", async () => {
	const b = slow()
	const s = await Storage.open(b.backend)
	const saves = [
		s.saveSedimentreeId(tree),
		s.saveSedimentreeId(tree),
		s.saveBatchAll(tree, [{ commitId: id(1), signedCommit: signed, blob: new Uint8Array() }], []),
	]
	await b.release()
	await Promise.all(saves)
	const trees = b.batches.flatMap((m) => [...m.keys()]).filter((k) => k.startsWith("tree-"))
	assertEquals(trees.length, 1)
	const gone = s.deleteSedimentreeId(tree)
	await b.release()
	await gone
	assertEquals(await s.containsSedimentreeId(tree), false)
	const again = s.saveSedimentreeId(tree)
	await b.release()
	await again
	assertEquals(await s.containsSedimentreeId(tree), true)
	assert(b.kept.has(trees[0]))
})

Deno.test("storage: deleting every commit takes one write, and lists stay right", async () => {
	const b = slow()
	const s = await Storage.open(b.backend)
	const saves = [1, 2, 3].map((n) => s.saveCommit(tree, id(n), signed, new Uint8Array([n])))
	await b.release()
	await Promise.all(saves)
	const before = b.batches.length
	const gone = s.deleteAllCommits(tree)
	await b.release()
	await gone
	assertEquals(b.batches.length, before + 1)
	assertEquals(await s.listCommitIds(tree), [])
	const reopened = await Storage.open(b.backend)
	assertEquals(await reopened.listCommitIds(tree), [])
})

Deno.test("storage: behind: saves resolve at once; flush resolves once kept", async () => {
	const b = slow()
	const s = await Storage.open(b.backend, { behind: true })
	await s.saveCommit(tree, id(1), signed, new Uint8Array([1]))
	await s.saveCommit(tree, id(2), signed, new Uint8Array([2]))
	assertEquals(b.kept.size, 0)
	assertEquals((await s.listCommitIds(tree)).length, 2)
	let flushed = false
	const f = s.flush().then(() => flushed = true)
	await new Promise((r) => setTimeout(r, 10))
	assert(!flushed)
	await b.release()
	await f
	assertEquals(b.kept.size, 2)
	assert(b.batches.length <= 2)
})

Deno.test("storage: behind: what a write threw, flush throws", async () => {
	const b = slow(true)
	const s = await Storage.open(b.backend, { behind: true })
	await s.saveCommit(tree, id(1), signed, new Uint8Array([1]))
	const f = s.flush().catch((e) => e)
	await b.release()
	assertEquals((await f).message, "full")
})

Deno.test("storage: without behind, what a write threw, the save throws", async () => {
	const b = slow(true)
	const s = await Storage.open(b.backend)
	const p = s.saveCommit(tree, id(1), signed, new Uint8Array([1])).catch((e) => e)
	await b.release()
	assertEquals((await p).message, "full")
	await s.flush()
})
