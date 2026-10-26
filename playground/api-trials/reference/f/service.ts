// @ts-nocheck: a program as a model would write it, untyped
export default async function (me) {
	const reply = await me.send(me.node("/services/greet"), "mimi")
	me.make("./greeting", reply)
}
