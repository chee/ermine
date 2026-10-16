/** @jsxImportSource ermine-h */
import type { API } from "@ermine/api"
import { bind, handler } from "ermine-h"

// a fake fetch: 900ms, then a name
const fetchUser = (id: number) =>
	new Promise<string>((done) => setTimeout(() => done(`user #${id}`), 900))

// program.ts: while the promise is out, the memo's node holds a pending status (see the graph tab),
// and what is bound to it says it is waiting (data-ermine-waiting, ⏳ in 💡 explain)
export default function program({ read, edit, memo, method, PENDING }: API) {
	memo("user", () => {
		const query = read("/query")
		return typeof query === "number" ? fetchUser(query) : PENDING
	})
	method("on/next", () => edit("/query", (q: number) => q + 1))
	return (
		<div>
			<p>
				query {bind("/query")} · fetched: {bind("user")}
			</p>
			<button onClick={handler("on/next")}>next user</button>
		</div>
	)
}
