// @ts-nocheck: a program as a model would write it, untyped
export default function (api) {
	const { open, method, title } = api
	const titleNode = open("./title", "")
	const history = open("./history", [])
	method("./on/fetch", async (url) => {
		const got = await title(url)
		titleNode(got)
		history((d) => void d.push(url))
		return got
	})
}
