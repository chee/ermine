// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	const titleNode = node("title")
	const history = node("history", [])
	on("on/fetch", async (url) => {
		const got = await title(url)
		titleNode.set(got)
		history.update((h) => {
			h.push(url)
		})
		return got
	})
}
