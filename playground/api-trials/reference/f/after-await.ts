// @ts-nocheck: a program as a model would write it, untyped
export default function (me) {
	const titleNode = me.make("./title", "")
	const history = me.make("./history", [])
	me.answer("./on/fetch", async (me, url) => {
		const got = await me.title(url)
		me.write(titleNode, got)
		me.edit(history, (d) => void d.push(url))
		return got
	})
}
