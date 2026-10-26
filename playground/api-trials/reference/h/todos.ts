// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	const todos = open("./todos", [])
	method("./on/add", (text) => todos((d) => d.push(text)))
	method("./on/remove", (i) => todos((d) => d.filter((_, j) => j !== i)))
	effect("draw", () => todos(), (t) => show(t.join(", ")))
}
