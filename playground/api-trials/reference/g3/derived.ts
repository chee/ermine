// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	const n = node("n", 2)
	const doubled = derived("doubled", () => n.get() * 2)
	doubled.watch((d) => show(`doubled: ${d}`))
	on("on/set", (v) => n.set(v))
}
