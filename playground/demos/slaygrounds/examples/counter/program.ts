/** @jsxImportSource @ermine */
import { createAction, createMemo, ensureNode, patch, peep, PENDING, read } from "@ermine/system"
import { bind, handler } from "@ermine/render/h"

// program.ts: edit me while it runs. count is ./count, beside the process (in the folder it runs in),
// so a reload finds it again. n reads /data/n (waiting while there is none), double reads n: both
// are memos inside the process, made again at each start. the view is jsx: each bound piece says which
// node it shows, the button which action it runs (💡 explain shows them, ⌖ picks one)
export default function program() {
	const count = ensureNode("./count", 0)
	// read throws PENDING while there is no /data/n: the memo is pending, and runs again when it lands
	const n = createMemo("n", () => read("/data/n"))
	createMemo("double", () => {
		const v = read(n)
		return typeof v === "number" ? 2 * v : PENDING
	})
	createAction("on/press", () => {
		patch(count, [{ path: [], value: (peep(() => read(count)) as number) + 1 }])
	})

	return (
		<div>
			<p>
				n is {bind("n")}, double {bind("double")}, count {bind(count)}
			</p>
			<button onClick={handler("on/press")}>+1</button>
		</div>
	)
}
