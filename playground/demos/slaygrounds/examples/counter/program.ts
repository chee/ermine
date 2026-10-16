/** @jsxImportSource ermine-h */
import type { API } from "@ermine/api"
import { bind, handler } from "ermine-h"

// program.ts: edit me while it runs. count is ./count, saved in the folder the process runs in, so
// a reload finds it again. n reads /data/n (waiting while there is none), double reads n: both are
// memos inside the process, made again at each start. the view is jsx: each bound piece says which
// node it shows, the button which method it sends to (💡 explain shows them, ⌖ picks one)
export default function program({ open, read, edit, memo, method, PENDING }: API) {
	const count = open("./count", 0)
	const n = memo("n", () => read("/data/n") ?? PENDING)
	memo("double", () => {
		const v = read(n)
		return typeof v === "number" ? 2 * v : PENDING
	})
	method("on/press", () => edit(count, (c: number) => c + 1))

	return (
		<div>
			<p>
				n is {bind("n")}, double {bind("double")}, count {bind("count")}
			</p>
			<button onClick={handler("on/press")}>+1</button>
		</div>
	)
}
