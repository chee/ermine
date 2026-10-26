// @ts-nocheck: a program as a model would write it, untyped
export default function (e) {
	const n = e.node("./n", 2)
	const doubled = e.memo("doubled", (e) => e.read(n) * 2)
	e.effect("draw", (e) => e.read(doubled), (e, d) => e.show(`doubled: ${d}`))
	e.handler("./on/set", (e, v) => e.write(n, v))
}
