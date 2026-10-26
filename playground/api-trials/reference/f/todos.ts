// @ts-nocheck: a program as a model would write it, untyped
export default function (me) {
	const todos = me.make("./todos", [])
	me.answer("./on/add", (me, text) => me.edit(todos, (d) => void d.push(text)))
	me.answer("./on/remove", (me, i) => me.edit(todos, (d) => void d.splice(i, 1)))
	me.effect("draw", (me) => me.read(todos), (t, _before, me) => me.show(t.join(", ")))
}
