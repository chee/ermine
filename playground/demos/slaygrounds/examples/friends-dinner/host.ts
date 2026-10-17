// friends-dinner's host: the world (@ermine/slaygrounds/world), two processes from one module (the
// dinner: default; the post: its export, with a folder of its own for what it saves), and one
// extra, who: who is calling, which the api does not say
import { getWho } from "@ermine/places/header"
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

// who is calling: the nearest caller and trusted, from the innermost
// scope open (the way the header's actor goes). caller is a process's id: said by its name
export type Who = { caller: string; trusted: boolean }
export type Tools = { who: () => Who }

const named = new Map<string, string>()
type Pairs = readonly (readonly [string, unknown])[] | undefined
const nearest = (pairs: Pairs, key: string) => pairs?.find(([k]) => k === key)?.[1]

const world = createWorld({
	render,
	processes: [{ name: "dinner" }, { name: "post", export: "post", cwd: ["mail"] }],
	extend: (_api, ctx): Tools => {
		named.set(ctx.process.id, ctx.process.at.join("/"))
		return {
			who() {
				const pairs = getWho(ctx.scheduler)?.metadata
				const caller = nearest(pairs, "caller")
				return {
					caller: named.get(String(caller)) ?? String(caller),
					trusted: nearest(pairs, "trusted") === true,
				}
			},
		}
	},
})

export const reload = world.reload
