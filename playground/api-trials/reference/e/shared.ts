// @ts-nocheck: a program as a model would write it, untyped
export default function (e) {
	const list = e.node("/shared/list", [])
	e.handler("./on/add", async (e, text) => {
		await e.check(text)
		e.edit(list, (d) => void d.push(text))
	})
}
