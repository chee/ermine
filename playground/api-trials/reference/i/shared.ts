// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	const list = open("/shared/list", [])
	createMethod("./on/add", async (text) => {
		await check(text)
		list((d) => d.push(text))
	})
}
