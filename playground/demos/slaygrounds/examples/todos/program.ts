/** @jsxImportSource ermine-h */
import { createAction, ensureNode, patch, peep, read, unplace } from "@ermine/system"
import { bind, handler } from "ermine-h"

// program.ts: todos are nodes under ./todos/items, their order a list of ids in ./todos/order. ensureNode
// makes each only the first time, so a reload finds them as they were. the list is bound to the
// order and each li keyed by its id: a reload and a reorder move only what must move. edits are
// patches: the new list as one patch on the order
export default function program() {
	ensureNode("./todos/items/a", "write the spec")
	ensureNode("./todos/items/b", "make a demo")
	ensureNode("./todos/items/c", "show chee")
	const order = ensureNode("./todos/order", ["a", "b", "c"])
	const list = () => peep(() => read(order)) as string[]
	const set = (d: string[]) => patch(order, [{ path: [], value: d }])

	createAction("on/add", (text: string) => {
		const id = crypto.randomUUID().slice(0, 4)
		ensureNode(`./todos/items/${id}`, text)
		set([...list(), id])
	})
	createAction("on/remove", (id: string) => {
		set(list().filter((x) => x !== id))
		unplace(`./todos/items/${id}`)
	})
	createAction("on/up", (id: string) => {
		const d = list(), i = d.indexOf(id)
		if (i > 0) set([...d.slice(0, i - 1), id, d[i - 1], ...d.slice(i + 1)])
	})

	// the text typed, taken out of the input: none, no send
	let input: HTMLInputElement
	const typed = () => {
		const text = input.value.trim()
		input.value = ""
		return text ? [text] : undefined
	}
	return (
		<div>
			<ul>
				{bind("todos/order", (list: string[]) =>
					list.map((id) => (
						<li key={id}>
							{bind(`todos/items/${id}`)} <button onClick={handler("on/up", [id])}>↑</button>
							<button onClick={handler("on/remove", [id])}>×</button>
						</li>
					)))}
			</ul>
			<input
				ref={(e) => (input = e)}
				placeholder="a new todo"
				onKeyDown={handler("on/add", (e) => (e.key === "Enter" ? typed() : undefined))}
			/>
			<button onClick={handler("on/add", typed)}>add</button>
		</div>
	)
}
