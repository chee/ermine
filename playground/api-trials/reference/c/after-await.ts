// @ts-nocheck: a program as a model would write it, untyped
export default function (api) {
	const { usePath, method, title } = api
	const [, patchTitle] = usePath("./title", "")
	const [, patchHistory] = usePath("./history", [])
	method("./on/fetch", async (url) => {
		const got = await title(url)
		patchTitle(got)
		patchHistory((d) => void d.push(url))
		return got
	})
}
