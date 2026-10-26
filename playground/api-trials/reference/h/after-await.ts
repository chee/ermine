// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	const titleNode = open("./title")
	const history = open("./history", [])
	method("./on/fetch", async (url) => {
		const got = await title(url)
		titleNode(got)
		history((d) => d.push(url))
		return got
	})
}
