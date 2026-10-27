/** @jsxImportSource ermine-h */
import {
	createAction,
	createEffect,
	createMemo,
	ensureNode,
	list,
	patch,
	peep,
	read,
} from "@ermine/system"
import { host } from "@ermine/slaygrounds/tools"
import { bind, handler } from "ermine-h"

// the clock: counts /time up every second. a timer has nothing open when it fires, so a program
// cannot write from one: the host owns the timer (host.ts) and writes /beat each second, and the
// clock's effect adds one to its own ./time at each beat. the view's button stops it (its row is
// taken out, its scope goes), and the count stops with it
export function clock() {
	const time = ensureNode("./time", 0)
	createEffect("tick", () => read("/beat"), (_beat, before) => {
		if (before === undefined) return
		patch(time, [{ path: [], value: (peep(() => read(time)) as number) + 1 }])
	})
}

// the view: reads /time, says whether the clock is placed, can stop it. its jsx names what it
// reads: /time is the clock's, running is its own. a process stops another only through its host
// (the world's extend)
export function view() {
	const { kill } = host<{ kill: (name: string) => void }>()
	createMemo("running", () => list("/").includes("clock"))
	createAction("on/stop", () => kill("clock"))
	return (
		<div>
			<p>
				time {bind("/time")} · clock placed: {bind("running")}
			</p>
			<button onClick={handler("on/stop")}>stop the clock</button>
		</div>
	)
}
