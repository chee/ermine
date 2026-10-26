// @ts-nocheck: a program as a model would write it, untyped
export default function (api) {
	const { open, method, check } = api
	const list = open("/shared/list", [])
	method("./on/add", async (text) => {
		await check(text)
		list((d) => void d.push(text))
	})
}
