// @ts-nocheck: a program as a model would write it, untyped
export default function (api) {
	const { open, memo, effect, method, show } = api
	const n = open("./n", 2)
	const doubled = memo("doubled", () => n.read() * 2)
	effect("draw", () => doubled.read(), (d) => show(`doubled: ${d}`))
	method("./on/set", (v) => n.set(v))
}
