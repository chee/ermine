// @ts-nocheck: a program as a model would write it, untyped
export default function (me) {
	const n = me.make("./n", 2)
	const doubled = me.compute("doubled", (me) => me.read(n) * 2)
	me.effect("draw", (me) => me.read(doubled), (d, _before, me) => me.show(`doubled: ${d}`))
	me.answer("./on/set", (me, v) => me.write(n, v))
}
