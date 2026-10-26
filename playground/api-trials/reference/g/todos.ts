// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	const todos = node("todos", [])
	on("on/add", (text) => todos.set((list) => [...list, text]))
	on("on/remove", (i) => todos.set((list) => list.filter((_, j) => j !== i)))
	todos.watch((list) => show(list.join(", ")))
}
