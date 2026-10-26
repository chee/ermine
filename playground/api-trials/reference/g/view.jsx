// a program as a model would write it, untyped
export default function () {
	const count = node("count", 0)
	on("on/click", () => count.set((n) => n + 1))
	count.watch((n) => show(<p>count: {n}</p>))
}
