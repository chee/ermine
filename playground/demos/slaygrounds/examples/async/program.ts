/** @jsxImportSource ermine-h */
import { createAction, createMemo, patch, peep, PENDING, read } from "@ermine/system"
import { bind, handler } from "ermine-h"

// a fake fetch: 900ms, then a name
const fetchUser = (id: number) =>
	new Promise<string>((done) => setTimeout(() => done(`user #${id}`), 900))

// program.ts: while the promise is out, the memo's node holds a pending status (see the graph tab),
// and what is bound to it says it is waiting (data-ermine-waiting, ⏳ in 💡 explain)
export default function program() {
	createMemo("user", () => {
		const query = read("/query")
		return typeof query === "number" ? fetchUser(query) : PENDING
	})
	createAction("on/next", () => {
		patch("/query", [{ path: [], value: (peep(() => read("/query")) as number) + 1 }])
	})
	return (
		<div>
			<p>
				query {bind("/query")} · fetched: {bind("user")}
			</p>
			<button onClick={handler("on/next")}>next user</button>
		</div>
	)
}
