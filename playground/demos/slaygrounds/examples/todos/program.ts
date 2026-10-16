/** @jsxImportSource ermine-h */
import type { API } from "@ermine/api"
import { bind, handler } from "ermine-h"

// program.ts: todos are nodes under ./todos/items, their order a list of ids in ./todos/order. open
// makes each only the first time, so a reload finds them as they were. the list is bound to the
// order and each li keyed by its id: a reload and a reorder move only what must move. edits are
// recipes: a push, a splice, each one patch on the order
export default function program({ open, read, edit, remove, method }: API) {
	open("./todos/items/a", "write the spec")
	open("./todos/items/b", "make a demo")
	open("./todos/items/c", "show chee")
	const order = open("./todos/order", ["a", "b", "c"])

	method("on/add", (text: string) => {
		const id = crypto.randomUUID().slice(0, 4)
		open(`./todos/items/${id}`, text)
		edit(order, (d: string[]) => void d.push(id))
	})
	method("on/remove", (id: string) => {
		edit(order, (d: string[]) => void d.splice(d.indexOf(id), 1))
		remove(`./todos/items/${id}`)
	})
	method("on/up", (id: string) => {
		const i = (read(order) as string[]).indexOf(id)
		if (i > 0) edit(order, (d: string[]) => void d.splice(i - 1, 0, ...d.splice(i, 1)))
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
