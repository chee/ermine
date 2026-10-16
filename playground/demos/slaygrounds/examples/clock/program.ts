/** @jsxImportSource ermine-h */
import type { API } from "@ermine/api"
import { bind, handler } from "ermine-h"

// the clock: writes /time every second. the view's button stops it (its row is taken out, its
// scope goes). a timer writes as the clock, with no method between
export function clock({ open, edit, teardown }: API) {
	const time = open("./time", 0)
	const every = setInterval(() => edit(time, (t: number) => t + 1), 1000)
	// replaced or ended: either way the timer goes
	teardown(() => clearInterval(every))
}

// the view: reads /time, says whether the clock is placed, can stop it. its jsx names what it
// reads: /time is the clock's, running is its own
export function view({ list, memo, method, kill }: API & { kill: (name: string) => void }) {
	memo("running", () => list("/").includes("clock"))
	method("on/stop", () => kill("clock"))
	return (
		<div>
			<p>
				time {bind("/time")} · clock placed: {bind("running")}
			</p>
			<button onClick={handler("on/stop")}>stop the clock</button>
		</div>
	)
}
