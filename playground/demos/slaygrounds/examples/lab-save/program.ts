/** @jsxImportSource ermine-h */
import type { API } from "@ermine/api"
import { bind, handler } from "ermine-h"

// program.ts: a notebook. its notes live in /data, a folder the host seeded, away from this
// process's own nodes: a view and its buttons are live values, which a pack cannot carry. the host
// saves /data into IndexedDB (💾), puts it back (⤺), and a 🍒 Restart starts from what was saved.
// the save, load and forget buttons send to the host's own methods, at /host/on
export default function program({ open, edit, remove, method }: API) {
	const order = open("/data/order", [])

	method("on/add", (text: string) => {
		const id = crypto.randomUUID().slice(0, 4)
		open(`/data/notes/${id}`, text)
		edit(order, (d: string[]) => void d.push(id))
	})
	method("on/remove", (id: string) => {
		edit(order, (d: string[]) => void d.splice(d.indexOf(id), 1))
		remove(`/data/notes/${id}`)
	})

	// the text typed, taken out of the input: none, no send
	let input: HTMLInputElement
	const typed = () => {
		const text = input.value
		input.value = ""
		return text ? [text] : undefined
	}
	// whether a save keeps each change's undo: the checkbox's own state, read when saving
	let undo: HTMLInputElement
	return (
		<div>
			<ul>
				{bind("/data/order", (list: string[]) =>
					list.map((id) => (
						<li key={id}>
							{bind(`/data/notes/${id}`)}{" "}
							<button onClick={handler("on/remove", [id])}>×</button>
						</li>
					)))}
			</ul>
			<input ref={(e) => (input = e)} />
			<button onClick={handler("on/add", typed)}>add</button>
			<p>
				<button onClick={handler("/host/on/save", () => [{ op: undo.checked }])}>
					💾 save
				</button>{" "}
				<button onClick={handler("/host/on/load")}>⤺ load</button>{" "}
				<button onClick={handler("/host/on/forget")}>forget</button>{" "}
				<label>
					<input type="checkbox" defaultChecked ref={(e) => (undo = e)} />{" "}
					keep each change's undo
				</label>
			</p>
			<p>{bind("/host/saved")}</p>
		</div>
	)
}
