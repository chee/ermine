// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	const todos = open("./todos", [])
	createMethod("./on/add", (text) => todos((d) => d.push(text)))
	createMethod("./on/remove", (i) => todos((d) => d.filter((_, j) => j !== i)))
	createEffect("draw", () => todos(), (t) => show(t.join(", ")))
}
