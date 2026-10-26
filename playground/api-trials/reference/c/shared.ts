// @ts-nocheck: a program as a model would write it, untyped
export default function (api) {
	const { usePath, method, check } = api
	const [, patchList] = usePath("/shared/list", [])
	method("./on/add", async (text) => {
		await check(text)
		patchList((d) => void d.push(text))
	})
}
