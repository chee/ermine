// a den from primitives, end to end, with no sync: two installs, mac and card, each its own world
// (scheduler, table, places). carry, below, stands in for whatever brings a node to a graph (sync,
// a file, a paste): it copies what is stored under an id from one table to the other, never a live
// value. nothing in a den knows it is there
//   card's den is its install's node; a room on mac names it, so mac can see what card offers
//   card's session beats on its den's node: carried, mac sees it online now
//   mac writes an ask under card's on/start: carried, card answers it; carried back, mac reads it
//   card's session ends: its den's node is still on mac, offline, and an ask can still be written
import { assertEquals } from "@std/assert"
import createEntry from "@ermine/node/entry"
import { createScheduler } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/table"
import { children, createPlaces } from "@ermine/places"
import { list } from "@ermine/places/lib"
import { createChangeHeader } from "@ermine/places/header"
import { processes } from "@ermine/processes"
import { createScopeNodes } from "@ermine/processes/scopes"
import { ed25519, openInstall } from "@ermine/installs"
import { beat, online, startSession } from "@ermine/sessions"
import { createDen, hashOf, TAKES } from "./dens.ts"
import { answer, ask, type World } from "./asks.ts"

const JS = "com.netscape.javascript-source"
const PARTS = ["attributes", "children", "value", "online"] as Key[]

function world(name: string) {
	const s = createScheduler()
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const places = createPlaces({
		root: "R",
		table,
		paths: createPaths<unknown>(),
		scheduler: s,
		contributors: [processes("R"), children],
	})
	s.onTrackingEnd((key) => places.release(key))
	const scope = s.createRootScope({ actor: name })
	const put = (part: Key, id: Id, v: unknown) =>
		s.runWithScope(
			scope,
			() => table.sub(part, id, createEntry(v as never, createChangeHeader(s))),
		)
	const w: World = { table, places, scheduler: s, scope }
	return { s, table, places, scope, put, w, scopes: createScopeNodes({ scheduler: s, table }) }
}
type W = ReturnType<typeof world>

// every stored part of node and of the ids under it its children reach ("<node>/..."), from one
// table to the other; a live value (a function) stays where it is
function carry(from: W, to: W, node: Id) {
	const ids = new Set<Id>()
	const walk = (id: Id) => {
		if (ids.has(id)) return
		ids.add(id)
		const kids = from.table.get("children", id)?.value
		if (typeof kids !== "object" || kids === null) return
		for (const k of Object.values(kids)) {
			if (typeof k === "string" && k.startsWith(`${String(node)}/`)) walk(k)
		}
	}
	walk(node)
	for (const id of ids) {
		for (const part of PARTS) {
			const v = from.table.get(part, id)?.value
			if (v !== undefined && typeof v !== "function") to.put(part, id, v)
		}
	}
}

// an install's store in memory
const store = () => {
	const m = new Map<string, Uint8Array>()
	return { read: (n: string) => m.get(n), write: (n: string, b: Uint8Array) => void m.set(n, b) }
}

Deno.test("a den from primitives: a room names an install's den, its session beats online, an ask carried there is answered and carried back; offline, the den is still there", async () => {
	const mac = world("mac"), card = world("card")
	const install = await openInstall(store(), ed25519)
	const session = startSession(install)

	// card: its den, the install's node, offering a runner that records what it runs
	const ran: unknown[] = []
	card.put("children", "R", { apps: "APPS" })
	card.put("children", "APPS", { "clock.js": "CLOCK" })
	card.put("value", "CLOCK", "hi")
	card.put("attributes", "CLOCK", { "ermine.type": JS })
	const den = card.s.runWithScope(card.scope, () =>
		createDen({
			scheduler: card.s,
			table: card.table,
			places: card.places,
			scopes: card.scopes,
			schedule: () => {},
			id: "card",
			install,
			may: () => ({ answer: "yes" }),
		}))
	assertEquals(den.node, install.id)
	card.s.runWithScope(
		card.scope,
		() =>
			den.offer(
				"runners",
				"javascript",
				{ [TAKES]: JS },
				(code: unknown) => void ran.push(code),
			),
	)
	beat(card.w, session, den.node, 10_000)
	card.s.pulse()

	// carried to mac, and placed in a room there
	carry(card, mac, den.node)
	mac.put("children", "R", { home: "ROOM" })
	mac.put("children", "ROOM", { card: den.node })
	assertEquals(mac.places.peep(() => [...list(mac.places, ["home", "card", "runners"])]), [
		"javascript",
	])
	assertEquals(mac.places.peep(() => online(mac.w, den.node, 5_000)), [
		{ session: session.id, install: install.id, until: 10_000 },
	])

	// mac asks card's den to start the clock; carried there, answered, carried back
	const n = ask(mac.w, den.node, {
		op: "start",
		who: { install: "mac's" },
		runner: ["system", "den", "runners", "javascript"],
		program: { id: "CLOCK", hash: hashOf("hi")! },
		at: ["work", "clock"],
	})
	assertEquals(mac.places.peep(() => answer(mac.w, n)), undefined)
	carry(mac, card, den.node)
	card.s.pulse()
	card.s.pulse()
	assertEquals(ran, ["hi"])
	carry(card, mac, den.node)
	const got = mac.places.peep(() => answer(mac.w, n)) as { at?: unknown }
	assertEquals(got.at, ["work", "clock"])

	// card's session ends: on mac its den is still in the room, offline, and askable
	card.s.runWithScope(card.scope, () => den.close())
	assertEquals(mac.places.peep(() => online(mac.w, den.node, 20_000)), [])
	assertEquals(mac.places.peep(() => [...list(mac.places, ["home", "card", "runners"])]), [
		"javascript",
	])
	const later = ask(mac.w, den.node, {
		op: "stop",
		who: { install: "mac's" },
		process: String((got as { id?: unknown }).id),
	})
	assertEquals(mac.places.peep(() => answer(mac.w, later)), undefined)
})
