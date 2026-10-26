// @ts-nocheck: a program as a model would write it, untyped
export default function (e) {
	const slow = e.node("/slow/value")
	e.effect("draw", (e) => e.read(slow), (e, v) => e.show(v == null ? "waiting" : `got: ${v}`))
}
