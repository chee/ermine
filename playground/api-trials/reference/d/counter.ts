// @ts-nocheck: a program as a model would write it, untyped
export default function (api) {
	const { open, effect, method, show } = api
	const count = open("./count", 0)
	method("./on/click", () => count.edit((n) => n + 1))
	effect("draw", () => count.read(), (n) => show(`count: ${n}`))
}
