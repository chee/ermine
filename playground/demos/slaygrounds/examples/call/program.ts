/** @jsxImportSource @ermine */
import {
	createAction,
	createEffect,
	ensureNode,
	executeAction,
	patch,
	peep,
	read,
} from "@ermine/system"
import { who } from "@ermine/slaygrounds/tools"
import { bind, handler } from "@ermine/render/h"

// the greeter owns the action, and what it last said is saved at ./last (a reload keeps it). a call
// runs in a scope under the greeter's, holding its caller; who() says who called and whether a
// person's event is being dispatched (read live, as the action runs), and the greeter saves both
export function greeter() {
	const last = ensureNode("./last", "nobody yet")
	createAction("on/hello", (name: string) => {
		const { caller, "trusted-event": person } = who()
		patch(last, [{
			path: [],
			value: `hello, ${name} (called by ${caller}, ${person ? "a person" : "not a person"})`,
		}])
	})
}

// the asker runs the greeter's action: a click is a person's (the world says so as it calls it, from
// the event being dispatched). "from code" was a timer's call, saved in the scope it was set in and
// made later, not a person's. nothing open after a timer, so no function works there: an effect is
// what runs apart from a handler. the button counts at ./asks, the effect reruns each time it
// changes and runs the action from its act. but the effect runs in a microtask of the click, while
// the click is still the event being dispatched: who() says a person. the view says so
export function asker() {
	const asks = ensureNode("asks", 0)
	createAction("on/code", () => {
		patch(asks, [{ path: [], value: (peep(() => read(asks)) as number) + 1 }])
	})
	createEffect("code", () => read(asks), (n) => {
		if ((n as number) > 0) executeAction("/greeter/on/hello", "a script")
	})
	return (
		<div>
			<p>greeter says: {bind("/last")}</p>
			<button onClick={handler("/greeter/on/hello", ["chee"])}>hello (click)</button>
			<button onClick={handler("on/code")}>hello (from an effect)</button>
			<p>
				a timer's call is made through a writer (createWriter, in setup); this one runs in an
				effect, in the click's own microtask: the event is still the click, a person's
			</p>
		</div>
	)
}
