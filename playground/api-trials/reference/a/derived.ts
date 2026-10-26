// @ts-nocheck: a program as a model would write it, untyped
export default function (api) {
	const { open, read, edit, memo, effect, method, show } = api
	const n = open("./n", 2)
	const doubled = memo("doubled", () => read(n) * 2)
	effect("draw", () => read(doubled), (d) => show(`doubled: ${d}`))
	method("./on/set", (v) => edit(n, () => v))
}
