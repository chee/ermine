// @ts-nocheck: a program as a model would write it, untyped
// a computation can't send (me.send is not inside one): an effect's act asks, and writes ./loud
export default function (me) {
	const text = me.make("./text", "hi")
	const loud = me.make("./loud", "")
	me.effect("ask", (me) => me.read(text), async (t, _before, me) => {
		me.write(loud, await me.send(me.node("/services/upper"), t))
	})
	me.effect("draw", (me) => me.read(loud), (v, _before, me) => {
		if (v !== "") me.show(`loud: ${v}`)
	})
	me.answer("./on/set", (me, t) => me.write(text, t))
}
