/** @jsxImportSource ermine-h */
import type { API } from "@ermine/api"
import { bind, handler } from "ermine-h"

// the greeter owns the method, and what it last said is saved at ./last (a reload keeps it). a send runs in a scope under the greeter's, saying who sent and
// whether a person did it: see /last in the graph tab, its change's pairs
export function greeter({ open, edit, method }: API) {
	const last = open("./last", "nobody yet")
	method("on/hello", (who: string) => edit(last, () => `hello, ${who}`))
}

// the asker sends to the greeter's method: a click is a person's (the send reads the event being
// dispatched). "from code" sends a moment later, from a timer: no event then, not trusted
export function asker({ send }: API) {
	const later = () => void setTimeout(() => send("/greeter/on/hello", "a script"), 0)
	return (
		<div>
			<p>greeter says: {bind("/last")}</p>
			<button onClick={handler("/greeter/on/hello", ["chee"])}>hello (click)</button>
			<button onClick={later}>hello (from code)</button>
		</div>
	)
}
