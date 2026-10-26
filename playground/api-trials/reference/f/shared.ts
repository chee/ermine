// @ts-nocheck: a program as a model would write it, untyped
export default function (me) {
	const list = me.make("/shared/list", [])
	me.answer("./on/add", async (me, text) => {
		await me.check(text)
		me.edit(list, (d) => void d.push(text))
	})
}
