// @ts-nocheck: a program as a model would write it, untyped
export default function (me) {
	const slow = me.node("/slow/value")
	me.effect(
		"draw",
		(me) => me.read(slow),
		(v, _before, me) => me.show(v === undefined ? "waiting" : `got: ${v}`),
	)
}
