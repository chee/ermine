// the host: one world (a scheduler, a table, places with processes, away and children), one den in
// it, and a link to the other dens over a channel. dens_test.ts' world(), made in a page. the den's
// id is its device key, as hex: the name together's channel proves (one den a device key)
//
//   const h = await createHost({ seed, name: "ada", device: "browser" })
//   h.den.start("/system/den/runners/button", "/things/button", "/work/button-1")
//   h.link.ask("cardputer", { op: "start", ... })
//
// what each thing gives, it writes on its own process node: attributes["thing.out"]. the den's row
// (den.nodes(), published by away) carries every process's attributes, so every other den gets the
// same node, by the same id, mirrored
import createEntry from "@ermine/node/entry"
import { createScheduler, type Scope } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/table"
import { children, createPlaces } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import { processes } from "@ermine/processes"
import { createScopeNodes } from "@ermine/processes/scopes"
import { type Channel, createBroadcast } from "@ermine/together/presence/channel"
import { createChannel } from "@ermine/together/channel"
import { hex } from "@ermine/together/hex"
import { createSigner, type Signer } from "@ermine/together/seal"
import { createDevice } from "@ermine/together/transport"
import { decode } from "@ermine/encoding/cbor"
import { blake3 } from "@ermine/blake3"
import { createDen, type Den, TAKES } from "@ermine/dens"
import { anchorOf, away, connect, type Link } from "@ermine/dens/away"
import { RUNNERS } from "./things.ts"

export const ROOT = "root"

// a room: who meets. its code is a few letters a person can read off a screen and type (no I, L,
// O, B, G, Q, S, U, V, Z: none that look like another); its id, the node away's rows go on, is the
// code's hash: "ermine://" + hex(blake3("party.chee.ermine.dens.room:" + CODE)). the cardputer
// makes the same id from the same code (playground/cardputer/main/den.c)
export const LETTERS = "ACDEFHJKMNPRTWXY"
export const roomCode = (typed: string): string | undefined => {
	const c = typed.toUpperCase().replace(/[^A-Z]/g, "")
	return c.length === 4 && [...c].every((x) => LETTERS.includes(x)) ? c : undefined
}
export const newCode = (): string =>
	Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => LETTERS[b % 16]).join("")
export const roomId = (code: string): string =>
	"ermine://" + hex(blake3(new TextEncoder().encode(`party.chee.ermine.dens.room:${code}`)))
export const BUS = "ermine-dens"
export const OUT = "thing.out"
export const TYPE = (kind: string) => `thing.${kind}`
// the kinds you can add; the cardputer's hardware (keys, screen, pigs) runs on three more
export const KINDS = ["button", "pad", "counter", "timer", "chart", "sound"] as const
export type Kind = typeof KINDS[number] | "keys" | "screen" | "pigs"

// the one seam: where a den's channel comes from, named its key's hex. a server (a wss:// url):
// together's createChannel on a Subduction device joined to it, so dens on any computers meet;
// joined again every 5 s until it is, told as it goes. none: a BroadcastChannel between the tabs
// of one browser
export function openChannel(
	signer: Signer,
	server: string | undefined,
	told: (state: string) => void,
): Channel & { close?: () => void } {
	if (server === undefined) {
		told("tabs only")
		return createBroadcast(hex(signer.key), BUS)
	}
	const device = createDevice({ signer })
	const at = new URL(server).host
	;(async () => {
		for (;;) {
			try {
				told(`joining ${at}`)
				await device.connectDiscover(server)
				return told(`on ${at}`)
			} catch (e) {
				told(`${at}: offline (${String(e)}), again in 5 s`)
				await new Promise((r) => setTimeout(r, 5000))
			}
		}
	})()
	return { ...createChannel(device, signer), close: () => void device.close() }
}

// an ask arriving for this den, as the channel carried it (for the caption: who asked what)
export type Heard = { from: string; op: string; runner?: unknown }

export type Host = {
	// the den's id: its device key, as hex
	id: string
	// the room's code, and the presence anchor its rows are at ("dens:" + the room's id)
	room: string
	anchor: string
	s: ReturnType<typeof createScheduler>
	table: ReturnType<typeof createTable>
	places: ReturnType<typeof createPlaces>
	den: Den
	link: Link
	host: Scope
	hosted: <T>(f: () => T) => T
	// a pulse soon (after what arrived or was written outside one)
	soon: () => void
	onPulse: (f: () => void) => void
	onAsked: (f: (h: Heard) => void) => void
	// the server's state as it changes (told the last at once)
	onServer: (f: (state: string) => void) => void
}

// seed: the device key's 32 bytes. server: none, tabs only
export async function createHost(
	o: { seed: Uint8Array; name: string; device: string; room: string; server?: string },
): Promise<Host> {
	const signer = await createSigner(o.seed)
	const id = hex(signer.key)
	const s = createScheduler()
	let due = false
	const soon = () => {
		if (due) return
		due = true
		setTimeout(() => {
			due = false
			s.pulse()
		}, 0)
	}
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const paths = createPaths<unknown>()
	const places = createPlaces({
		root: ROOT,
		table,
		paths,
		scheduler: s,
		contributors: [processes(ROOT), away(ROOT), children],
	})
	s.onTrackingEnd((key) => places.release(key))
	// whatever made something due (a write here, a row or mirror arriving): a pulse soon
	s.onMark((_, __, due) => due.length > 0 && soon())
	const scopes = createScopeNodes({ scheduler: s, table })
	const host = s.createRootScope({ actor: id })
	const hosted = <T>(f: () => T) => s.runWithScope(host, f)
	const put = (part: Key, id: Id, v: unknown) =>
		hosted(() => table.sub(part, id, createEntry(v as never, createChangeHeader(s))))

	// the programs, at /things/<kind>: a few words of what it is, its form the runner's takes
	const all = Object.keys(RUNNERS) as Kind[]
	put("children", ROOT, { things: "things" })
	put("children", "things", Object.fromEntries(all.map((k) => [k, `things/${k}`])))
	for (const k of all) {
		put("value", `things/${k}`, RUNNERS[k].program)
		put("attributes", `things/${k}`, { "ermine.type": TYPE(k) })
	}

	const den = hosted(() =>
		createDen({
			scheduler: s,
			table,
			places,
			scopes,
			// a start made outside a pulse (a click, an ask) asks for one: ours
			schedule: () => soon(),
			id,
			name: o.name,
			device: o.device,
			// a demo policy: yes to every ask
			may: () => ({ answer: "yes" }),
		})
	)
	for (const k of all) {
		hosted(() => den.offer("runners", k, { [TAKES]: TYPE(k) }, RUNNERS[k].run))
	}

	// the channel, each arrival followed by a pulse; asks to this den told to the page too
	let state = ""
	const servers: ((state: string) => void)[] = []
	const raw = openChannel(signer, o.server, (x) => {
		state = x
		for (const f of servers) f(x)
	})
	const asked: ((h: Heard) => void)[] = []
	const anchor = anchorOf(roomId(o.room))
	const mine = `${anchor}/ask/${id}`
	const channel: Channel = {
		name: raw.name,
		send: raw.send,
		on: (topic, fn) =>
			raw.on(topic, (from, bytes) => {
				fn(from, bytes)
				if (topic === mine) {
					try {
						const m = decode(bytes) as Record<string, unknown>
						for (const f of asked) {
							f({ from, op: String(m.op), runner: m.runner })
						}
					} catch {
						// not one
					}
				}
				soon()
			}),
	}
	// the room's id the topic; published though it is not the root
	const link = hosted(() =>
		connect(den, channel, { ttl: 6000, topic: roomId(o.room), publish: true })
	)
	const pulsed: (() => void)[] = []
	s.onAfterPulse(() => {
		for (const f of pulsed) f()
	})
	// the heartbeat, and rows past their time swept
	setInterval(() => {
		hosted(() => {
			link.beat()
			link.sweep()
		})
		soon()
		for (const f of pulsed) f()
	}, 2000)
	addEventListener("pagehide", () => {
		try {
			hosted(() => link.stop())
		} catch {
			// going anyway
		}
	})
	soon()
	return {
		id,
		room: o.room,
		anchor,
		s,
		table,
		places,
		den,
		link,
		host,
		hosted,
		soon,
		onPulse: (f) => void pulsed.push(f),
		onAsked: (f) => void asked.push(f),
		onServer: (f) => (servers.push(f), f(state)),
	}
}
