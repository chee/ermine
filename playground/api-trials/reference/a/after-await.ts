// @ts-nocheck: a program as a model would write it, untyped
export default function (api) {
	const { open, edit, method, title } = api
	const titleNode = open("./title", "")
	const history = open("./history", [])
	method("./on/fetch", async (url) => {
		const got = await title(url)
		edit(titleNode, () => got)
		edit(history, (d) => void d.push(url))
		return got
	})
}
