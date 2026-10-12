// remote selections are carried forward: A selects 40-52, B inserts 5 characters at 10, and A's
// selection as drawn on B is 45-57 at once, and stays so when A's next presence arrives.
//   deno run -A sync/demo/check_selection.ts [--server ws://localhost:8321 --service localhost:8321]
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
	for (let t = 0; t < ms; t += 50) {
		if (f()) return
		await sleep(50)
	}
	throw new Error("timed out waiting for " + what)
}

const spawned = flag("server") ? undefined : await local(8321 + Math.floor(Math.random() * 500))
const server = flag("server") ?? spawned!.url
const service = flag("service") ?? spawned?.service
const legacy = !/^wss?:\/\/(localhost|127\.)/.test(server)
let failed = false
const views: Record<string, View | undefined> = {}
try {
	const device = (name: string, folder?: string) =>
		start({
			backend: mem(),
			seed: newSeed(),
			name,
			colour: "#888",
			folder,
			server,
			service,
			legacy,
			render: (v) => views[name] = v,
		})
	const text = (n: string) => views[n]?.notes.find((x) => x.title === "n")?.versions[0]
	const on = (n: string, who: string) => {
		const p = views[n]?.peers.find((p) => p.name === who)
		return p?.live && p.note === "n" ? [p.from, p.to] : undefined
	}
	const base = "0123456789".repeat(7)
	const a = await device("alice")
	await a.make("n", base)
	const b = await device("bob", a.folder)
	await until("bob has the note", () => text("bob") === base)

	a.at("n", 40, 52)
	await until("bob sees 40-52", () => on("bob", "alice")?.join() === "40,52")
	await a.idle()
	await b.idle()

	b.edit("n", base, base.slice(0, 10) + "XXXXX" + base.slice(10))
	// at once: bob's own view, before any new presence from alice
	await until("bob's edit shown", () => text("bob")?.length === 75, 2000)
	await until("bob draws 45-57", () => on("bob", "alice")?.join() === "45,57", 1500)
	console.log("ok: selection carried on bob at once: 45-57")

	// alice's next presence, measured on the old version (she has not the edit yet, or typed before it)
	a.at("n", 41, 52)
	await sleep(1500)
	assertEquals(on("bob", "alice"), [46, 57])
	console.log("ok: a presence measured on the old version is carried: 46-57")

	// and once alice has the edit, a presence measured on the new version is used as is
	await until("alice has the edit", () => text("alice")?.length === 75)
	a.at("n", 45, 57)
	await sleep(1500)
	assertEquals(on("bob", "alice"), [45, 57])
	console.log("ok: a presence measured on the new version stays: 45-57")
	await a.close()
	await b.close()
} catch (e) {
	failed = true
	console.error("FAILED:", e)
} finally {
	spawned?.stop()
}
Deno.exit(failed ? 1 : 0)
