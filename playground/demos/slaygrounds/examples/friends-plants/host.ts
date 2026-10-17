// friends-plants's host: the world (@ermine/slaygrounds/world), four processes from one module (the
// windowsill: default; the clock, the fox and the frog: one export each), and two extras, who and
// change: who wrote a thing, which the api does not say
import type { ChangeHeader as Header } from "@ermine/node/entry"
import { getWho } from "@ermine/places/header"
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

// who a call or a change is: the nearest caller and trusted, from the
// innermost scope. caller is a process's id: said by name
export type Who = { caller: string; trusted: boolean }
export type Tools = {
	// who is calling, in the call now
	// who(change): who wrote that change
	who: (change?: Header) => Who
	// a node's latest change (tracked: a write to the node reruns what read it)
	change: (x: string) => Header | undefined
}

const named = new Map<string, string>()
const nearest = (pairs: readonly (readonly [string, unknown])[] | undefined, key: string) =>
	pairs?.find(([k]) => k === key)?.[1]

const world = createWorld({
	render,
	processes: [
		{ name: "sill" },
		{ name: "clock", export: "clock" },
		{ name: "fox", export: "fox" },
		{ name: "frog", export: "frog" },
	],
	extend: (api, ctx): Tools => {
		named.set(ctx.process.id, ctx.process.at.join("/"))
		const say = (pairs: Parameters<typeof nearest>[0]): Who => {
			const caller = nearest(pairs, "caller")
			return {
				caller: named.get(String(caller)) ?? String(caller),
				trusted: nearest(pairs, "trusted") === true,
			}
		}
		return {
			who: (change) => say(change ? change.metadata : getWho(ctx.scheduler)?.metadata),
			change(x) {
				const id = api.entries(x)[0]?.id
				return id === undefined ? undefined : ctx.places.readChange("value", id)
			},
		}
	},
})

export const reload = world.reload
