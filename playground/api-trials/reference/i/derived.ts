// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	const n = open("./n", 2)
	const doubled = createMemo("doubled", () => n() * 2)
	createEffect("draw", () => doubled(), (d) => show(`doubled: ${d}`))
	createMethod("./on/set", (v) => n(v))
}
