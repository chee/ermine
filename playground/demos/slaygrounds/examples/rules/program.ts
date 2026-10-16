/** @jsxImportSource ermine-h */
import type { API } from "@ermine/api"
import { bind, handler } from "ermine-h"

const names = ["a", "b", "c"]

// program.ts: each note is read through the rules, by a memo of its own (entries keeps a refused
// item in its place: its id REFUSED, no value), so a hidden note reads as REFUSED. toggle a name and
// the rules are edited: the memo asked again under the new rules. the rules are a node too: /rules
export default function program({ read, edit, entries, memo, method, REFUSED }: API) {
	for (const name of names) {
		memo(name, () => {
			const [item] = entries(`/notes/${name}`)
			return !item || item.id === REFUSED ? "REFUSED" : item.value
		})
	}
	method("on/toggle", (name: string) =>
		edit("/rules", (r: { hidden: string[] }) => {
			const at = r.hidden.indexOf(name)
			if (at < 0) r.hidden.push(name)
			else r.hidden.splice(at, 1)
		}))
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
