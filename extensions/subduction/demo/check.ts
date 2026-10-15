// the demo, checked headless: three devices (Deno) sharing a folder through a Subduction server.
//   deno run -A sync/demo/check.ts [--server ws://localhost:8321 --service localhost:8321]
// with no --server a local subduction_cli is started. Throwaway data only.
import { assertEquals } from "@std/assert"
import { newSeed, start, type View } from "./node.ts"
import { local } from "./server.ts"

const flag = (n: string) => {
	const i = Deno.args.indexOf("--" + n)
	return i >= 0 ? Deno.args[i + 1] : undefined
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const mem = () => {
	const m = new Map<string, Uint8Array>()
	return {
		read: () => Promise.resolve(new Map(m)),
		write(b: Map<string, Uint8Array | null>) {
			for (const [k, v] of b) v === null ? m.delete(k) : m.set(k, v)
			return Promise.resolve()
		},
	}
}
async function until(what: string, f: () => boolean, ms = 20000) {
	for (let t = 0; t < ms; t += 100) {
		if (f()) return
		await sleep(100)
	}
	throw new Error("timed out waiting for " + what)
}

const spawned = flag("server") ? undefined : await local(8321 + Math.floor(Math.random() * 500))
const server = flag("server") ?? spawned!.url
const service = flag("service") ?? spawned?.service
const legacy = !/^wss?:\/\/(localhost|127\.)/.test(server)
let failed = false
const devices: Record<string, Awaited<ReturnType<typeof start>>> = {}
const views: Record<string, View | undefined> = {}
const shown = views
try {
	const seeds = { alice: newSeed(), bob: newSeed(), carol: newSeed() }
	const stores = { alice: mem(), bob: mem(), carol: mem() }
	const device = (name: "alice" | "bob" | "carol", folder?: string) =>
		start({
			backend: stores[name],
			seed: seeds[name],
			name,
			colour: "#888",
			folder,
			server,
			service,
			legacy,
			render: (v) => views[name] = v,
		})
	const text = (n: "alice" | "bob" | "carol", title: string) =>
		views[n]?.notes.find((x) => x.title === title)?.versions

	const a = devices.alice = await device("alice")
	await a.make("shopping", "milk")
	const b = devices.bob = await device("bob", a.folder)
	await until("bob sees alice's note", () => text("bob", "shopping")?.[0] === "milk")
	console.log("ok: bob opened the folder by its id and has the note")

	// presence: both see both, with a cursor
	a.at("shopping", 1, 3)
	await until("bob sees alice's cursor", () => {
		const p = views.bob?.peers.find((p) => p.name === "alice")
		return p?.live === true && p.note === "shopping" && p.from === 1 && p.to === 3
	})
	b.at("shopping", 0, 0)
	await until(
		"alice sees bob live",
		() => !!views.alice?.peers.find((p) => p.name === "bob")?.live,
	)
	console.log("ok: presence both ways (a device that joined late saw one that was already there)")

	// a device that joins later still: gets the stored notes and sees the others
	const c = devices.carol = await device("carol", a.folder)
	await until(
		"carol sees the note and both peers",
		() =>
			text("carol", "shopping")?.[0] === "milk" &&
			views.carol!.peers.filter((p) => p.live).length === 3,
	)
	console.log("ok: a third device joined late, has notes and sees everyone")

	// edits in turn flow
	b.edit("shopping", "milk", "milk, eggs")
	await until("alice gets bob's edit", () => text("alice", "shopping")?.join() === "milk, eggs")
	await until("carol gets bob's edit", () => text("carol", "shopping")?.join() === "milk, eggs")
	console.log("ok: edits flow")

	// edits at once: both are facts; the list shows both, and keep picks one
	await Promise.all([a.idle(), b.idle()])
	a.edit("shopping", "milk, eggs", "milk, eggs, jam")
	b.edit("shopping", "milk, eggs", "milk, eggs, tea")
	await until(
		"both versions everywhere",
		() => text("alice", "shopping")?.length === 2 && text("carol", "shopping")?.length === 2,
	)
	console.log("ok: concurrent edits are two versions:", JSON.stringify(text("carol", "shopping")))
	a.keep("shopping", 0, 2)
	await until(
		"one version again",
		() => ["alice", "bob", "carol"].every((n) => text(n as "alice", "shopping")?.length === 1),
	)
	assertEquals(text("bob", "shopping"), text("carol", "shopping"))
	console.log("ok: keep merged them into one:", JSON.stringify(text("carol", "shopping")))

	// a second note, made by carol, reaches the others
	await c.make("todo", "write demo")
	await until("a note made by carol", () => text("alice", "todo")?.[0] === "write demo")
	console.log("ok: a note made on another device appears")

	// restart: bob's storage alone (no server) has the folder
	await b.idle()
	await b.close()
	const b2 = await start({
		backend: stores.bob,
		seed: seeds.bob,
		name: "bob",
		colour: "#888",
		folder: a.folder,
		legacy,
		render: (v) => views.bob = v,
	})
	await until("bob's notes from storage", () => !!text("bob", "todo") && !!text("bob", "shopping"))
	console.log("ok: a restarted device had its folder from storage, offline")
	await b2.close()
	await a.close()
	await c.close()
} catch (e) {
	failed = true
	console.error("FAILED:", e)
	const id = shown.carol?.notes.find((n) => n.title === "todo")?.id
	if (id) {
		for (const [n, d] of Object.entries(devices)) {
			console.error(
				n,
				"stored",
				(await d.device.stored(id)).length,
				"heads",
				d.device.histories(id).heads("value").length,
				JSON.stringify(d.device.taking(id)),
				JSON.stringify(d.world.table.get("value", id)?.value),
			)
		}
	}
} finally {
	spawned?.stop()
}
Deno.exit(failed ? 1 : 0)
