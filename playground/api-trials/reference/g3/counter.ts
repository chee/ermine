// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	const count = node("count", 0)
	on("on/click", () => count.set(count.get() + 1))
	count.watch((n) => show(`count: ${n}`))
}
