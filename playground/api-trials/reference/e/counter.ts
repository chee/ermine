// @ts-nocheck: a program as a model would write it, untyped
export default function (e) {
	const count = e.node("./count", 0)
	e.handler("./on/click", (e) => e.edit(count, (n) => n + 1))
	e.effect("draw", (e) => e.read(count), (e, n) => e.show(`count: ${n}`))
}
