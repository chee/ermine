// @ts-nocheck: a program as a model would write it, untyped
export default function (e) {
	const titleNode = e.node("./title", "")
	const history = e.node("./history", [])
	e.handler("./on/fetch", async (e, url) => {
		const got = await e.title(url)
		e.write(titleNode, got)
		e.edit(history, (d) => void d.push(url))
		return got
	})
}
