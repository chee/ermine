// @ts-nocheck: a program as a model would write it, untyped
export default function (api) {
	const { usePath, useEffect, method, show } = api
	const [todos, patchTodos] = usePath("./todos", [])
	method("./on/add", (text) => patchTodos((d) => void d.push(text)))
	method("./on/remove", (i) => patchTodos((d) => void d.splice(i, 1)))
	useEffect("draw", () => todos(), (t) => show(t.join(", ")))
}
