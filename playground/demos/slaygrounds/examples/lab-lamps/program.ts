/** @jsxImportSource ermine-h */
import {
	createAction,
	createEffect,
	createMemo,
	ensureNode,
	hasNode,
	list,
	patch,
	peep,
	place,
	read,
	unplace,
} from "@ermine/system"
import { up } from "@ermine/slaygrounds/tools"
import { bind, handler, type Item, under } from "ermine-h"

// program.ts: lamps. a house is a tree of nodes: rooms hold rooms, lamps (lampN) and maybe a
// power node (a list of colours). a lamp is lit if the NEAREST power node walking up from where
// it stands holds its colour. the walk is a read of power at each room going up from where the lamp stands, nearest first, tracked, so a
// lamp reruns only when something on its way up changed. a mirror is the same room node placed in
// a second room: its lamps stand in two places, and each place has its own way up, so one lamp
// can be lit in one place and dark in the other. every lamp says which power node lit it.
// the view is jsx: each room lists its members (under), each chip is bound to its room's power
// node and calls on/toggle. a lamp's light is a walk up, not one node: its own effect draws it
const LOOK = `
body { background: #ffff88; margin: 8px; font-family: Jost, system-ui, sans-serif; font-size: 13px }
.lab { display: flex; flex-direction: column; gap: 8px; width: 584px }
.card { background: #fff; border: 1px solid #000; box-shadow: 0 0 10px 2px #66003322; border-radius: 6px; padding: 6px }
.room { border: 1px solid #000; border-radius: 4px; padding: 4px 6px; margin: 4px 0 4px 10px; background: #fff }
.room > .name { font-weight: 600; margin-right: 8px }
.mirror { background: #d4e4ff }
.row { display: flex; gap: 5px; align-items: center; flex-wrap: wrap }
.row:not([data-own]) > .name { color: #666 }
.row:not([data-own]) > .x { visibility: hidden }
.chip { width: 16px; height: 16px; border-radius: 50%; border: 1px solid #000; cursor: pointer; opacity: .25; padding: 0; box-shadow: none; transition: transform 100ms }
.chip[data-on] { opacity: 1 }
.chip:hover { transform: translateY(-1px) }
.x { font: inherit; border: 0; background: none; cursor: pointer; color: #ff2284; padding: 0 3px }
.lamp { display: inline-flex; align-items: center; gap: 4px; margin: 2px 8px 2px 0; font-size: 11px }
.bulb { width: 18px; height: 18px; border-radius: 50%; border: 1px solid #000; background: #fff; transition: background 150ms, box-shadow 150ms }
.lamp[data-lit] .bulb { box-shadow: 0 0 8px 3px var(--c) ; background: var(--c) }
.tag { display: inline-block; background: #ffff88; border: 1px solid #000; padding: 0 8px; transform: skew(-8deg); font-weight: 600 }
button.b { font: inherit; padding: 2px 12px; color: #000; background: #fff; border: 1px solid #000; border-radius: 2px;
	box-shadow: 1px 1px 0 #000; cursor: pointer; transition: transform 100ms, box-shadow 100ms }
button.b:hover { transform: translateY(-1px); box-shadow: 2px 2px 0 #000 }
.dim { color: #666 }
`
const COLOUR: Record<string, string> = {
	red: "#ff2284",
	blue: "#2269ff",
	yellow: "#ffd400",
	mint: "#40dcba",
}

type Def = { name: string; power?: string[]; lamps?: string[]; rooms?: Def[] }
const HOUSE: Def = {
	name: "house",
	power: ["red"],
	rooms: [
		{ name: "kitchen", lamps: ["red", "blue"] },
		{
			name: "hall",
			power: ["blue"],
			lamps: ["blue", "red"],
			rooms: [
				{ name: "closet", power: ["yellow"], lamps: ["yellow", "red"] },
			],
		},
		{ name: "stairs", rooms: [{ name: "nursery", lamps: ["red", "yellow", "blue"] }] },
		{ name: "attic", power: ["yellow", "mint"] },
	],
}

export default function program() {
	// the house, the first time: ensureNode makes only what is not there after a reload
	const abs = (where: string[], ...more: string[]) => "/" + [...where, ...more].join("/")
	const build = (at: string[], d: Def) => {
		const room = [...at, d.name]
		ensureNode(abs(room), null)
		if (d.power) ensureNode(abs(room, "power"), d.power)
		d.lamps?.forEach((c, i) => ensureNode(abs(room, "lamp" + (i + 1)), c))
		d.rooms?.forEach((r) => build(room, r))
	}
	build([], HOUSE)

	// ---- actions: a click on a chip, the mirror ----
	createAction("on/toggle", (where: string[], colour: string) => {
		const power = abs(where, "power")
		if (!hasNode(power)) return void ensureNode(power, [colour])
		const have = peep(() => read(power)) as string[]
		patch(power, [{
			path: [],
			value: have.includes(colour) ? have.filter((c) => c !== colour) : [...have, colour],
		}])
	})
	// take the room's own power out: what is above it lights it again
	createAction("on/inherit", (where: string[]) => {
		if (hasNode(abs(where, "power"))) unplace(abs(where, "power"))
	})
	createAction("on/mirror", () => {
		if (peep(() => list("/house/attic")).includes("nursery")) {
			return unplace("/house/attic/nursery")
		}
		place("/house/attic/nursery", "/house/stairs/nursery")
	})

	// ---- what the bar says: two memos, each a node the view is bound to ----
	const isLamp = (name: string | undefined) => /^lamp\d+$/.test(name ?? "")
	const isRoom = (name: string | undefined) => name !== "power" && !isLamp(name)
	createMemo("mirrored", () => list("/house/attic").includes("nursery"))
	createMemo("standing", () => {
		let n = 0
		const count = (room: string[]) => {
			for (const k of list(abs(room))) isLamp(k) ? n++ : isRoom(k) && count([...room, k])
		}
		count(["house"])
		return n
	})

	// the rooms that are a mirror: walking the house in order, a room whose node was met at an
	// earlier place stands here a second time (drawn blue). the node at a place is up's `found`
	createMemo("mirrors", () => {
		const seen = new Set<string>()
		const out: Record<string, true> = {}
		const walk = (room: string[]) => {
			const id = up(room, [])?.found
			if (id !== undefined) {
				if (seen.has(id)) out[room.join("/")] = true
				seen.add(id)
			}
			for (const k of list(abs(room))) if (isRoom(k)) walk([...room, k])
		}
		walk(["house"])
		return out
	})

	// the nearest power going up from where a lamp stands: its room's, else the room above's... the
	// root left out. up is the walk, tracked at each room on the way
	const nearest = (where: string[]) => {
		const found = up(["power"], where.slice(0, -1), { stop: 1 })
		if (found === undefined) return { list: [] as string[], from: "nothing" }
		return {
			list: read(abs(found.path)) as string[],
			from: found.path.slice(0, -1).join("/"),
		}
	}

	// a lamp: its colour is bound; lit is one tracked walk up from where it stands, so its own
	// effect draws it, made as the element is (ref)
	const light = (el: Element, where: string[]) =>
		createEffect(`lit-${where.join("-")}`, () => {
			const colour = read(abs(where)) as string
			const up = nearest(where)
			return { lit: up.list.includes(colour), from: up.from }
		}, (v: { lit: boolean; from: string }) => {
			el.toggleAttribute("data-lit", v.lit)
			el.lastElementChild!.textContent = (v.lit ? "lit by " : "dark: ") + v.from
		}, { equal: (a: any, b: any) => a?.lit === b?.lit && a?.from === b?.from })
	const Lamp = ({ lamp }: { lamp: Item }) => (
		<span
			class="lamp"
			style={bind(lamp, (c: string) => `--c: ${COLOUR[c]}`)}
			ref={(el) => light(el, lamp.path as string[])}
		>
			<span class="bulb" />
			<span class="dim" />
		</span>
	)

	// a room: its name, a chip per colour (on when its own power node holds it), then its lamps
	// and its rooms, each a list of its members
	const Room = ({ where, target }: { where: string[]; target: Item | string }): any => {
		const power = abs(where, "power")
		return (
			<div
				class={bind("mirrors", (m: Record<string, true>) =>
					m[where.join("/")] ? "room mirror" : "room")}
			>
				<div
					class="row"
					data-own={bind(power, () =>
						true)}
				>
					<span class="name">{where.at(-1)}</span>
					{Object.keys(COLOUR).map((c) => (
						<button
							class="chip"
							style={`background: ${COLOUR[c]}`}
							title={`${c} power in ${where.at(-1)}`}
							aria-label={`${c} power in ${where.at(-1)}`}
							data-on={bind(power, (list: string[]) => list.includes(c))}
							onClick={handler("on/toggle", [where, c])}
						/>
					))}
					<button class="x" onClick={handler("on/inherit", [where])}>inherit</button>
				</div>
				<div class="lamps">
					{under(target, (k) => isLamp(k.name) ? <Lamp lamp={k} /> : null)}
				</div>
				<div class="rooms">
					{under(
						target,
						(k) => isRoom(k.name) ? <Room where={k.path as string[]} target={k} /> : null,
					)}
				</div>
			</div>
		)
	}

	return (
		<div class="lab">
			<style>{LOOK}</style>
			<div class="row">
				<button class="b" onClick={handler("on/mirror")}>
					{bind("mirrored", (m) =>
						m ? "take the mirror out of the attic" : "mirror the nursery into the attic")}
				</button>
				<span class="tag">
					{bind("standing", (n) =>
						`${n} lamps standing`)}
				</span>
			</div>
			<div class="card">
				<Room where={["house"]} target="house" />
			</div>
		</div>
	)
}
