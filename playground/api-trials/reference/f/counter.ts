// @ts-nocheck: a program as a model would write it, untyped
export default function (me) {
	const count = me.make("./count", 0)
	me.answer("./on/click", (me) => me.write(count, me.read(count) + 1))
	me.effect("draw", (me) => me.read(count), (n, _before, me) => me.show(`count: ${n}`))
}
