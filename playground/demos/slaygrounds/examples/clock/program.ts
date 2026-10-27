/** @jsxImportSource ermine-h */
import {
	addTeardown,
	createAction,
	createMemo,
	createWriter,
	ensureNode,
	list,
	patch,
	peep,
	read,
} from "@ermine/system"
import { host } from "@ermine/slaygrounds/tools"
import { bind, handler } from "ermine-h"

// the clock: counts /time up every second. its own timer writes through a writer made in setup;
// the timer is cleared at its teardown. the view's button stops it (its row is taken out, its
// scope goes), and the count stops with it
export function clock() {
	const time = ensureNode("./time", 0)
	const withWriter = createWriter()
	const timer = setInterval(
		() =>
			withWriter(() =>
				patch(time, [{ path: [], value: (peep(() => read(time)) as number) + 1 }])
			),
		1000,
	)
	addTeardown(() => clearInterval(timer))
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
