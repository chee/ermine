// @ts-nocheck: a program as a model would write it, untyped
import { edit, effect, method, open, read, show } from "ermine"

export default function () {
	const todos = open("./todos", [])
	method("./on/add", (text) => edit(todos, (d) => void d.push(text)))
	method("./on/remove", (i) => edit(todos, (d) => void d.splice(i, 1)))
	effect("draw", () => read(todos), (t) => show(t.join(", ")))
}
