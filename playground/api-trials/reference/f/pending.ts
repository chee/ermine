// @ts-nocheck: a program as a model would write it, untyped
export default function (me) {
	const slow = me.node("/slow/value")
	const label = me.compute(
		"label",
		(me) => me.status(slow).state === "pending" ? "loading" : `got: ${me.read(slow)}`,
	)
	me.effect("draw", (me) => me.read(label), (l, _before, me) => me.show(l))
}
