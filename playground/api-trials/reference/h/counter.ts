// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	const count = open("./count", 0)
	method("./on/click", () => count((n) => n + 1))
	effect("draw", () => count(), (n) => show(`count: ${n}`))
}
