/** @jsxImportSource ermine-h */
import { createAction, createMemo, patch, peep, read, readEntries } from "@ermine/system"
import { bind, handler } from "ermine-h"

const names = ["a", "b", "c"]

// program.ts: each note is read through the rules, by a memo of its own (readEntries keeps a refused
// item in its place: refused, no value), so a hidden note reads as REFUSED. toggle a name and
// the rules are edited: the memo asked again under the new rules. the rules are a node too: /rules
export default function program() {
	for (const name of names) {
		createMemo(name, () => {
			const [item] = readEntries(`/notes/${name}`)
			return !item || item.refused ? "REFUSED" : item.value
		})
	}
	createAction("on/toggle", (name: string) => {
		const { hidden } = peep(() => read("/rules")) as { hidden: string[] }
		patch("/rules", [{
			path: ["hidden"],
			value: hidden.includes(name) ? hidden.filter((h) => h !== name) : [...hidden, name],
		}])
	})
	return (
		<div>
			<ul>
				{names.map((name) => <li>{name}: {bind(name)}</li>)}
			</ul>
			<p>
				hidden by /rules:{" "}
				{bind("/rules", (r: { hidden: string[] }) => r.hidden.join(", ") || "nothing")}
			</p>
			{names.map((name) => <button onClick={handler("on/toggle", [name])}>toggle {name}
			</button>)}
		</div>
	)
}
