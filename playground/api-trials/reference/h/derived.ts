// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	const n = open("./n", 2)
	const doubled = memo("doubled", () => n() * 2)
	effect("draw", () => doubled(), (d) => show(`doubled: ${d}`))
	method("./on/set", (v) => n(v))
}
