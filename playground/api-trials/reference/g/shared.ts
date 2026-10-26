// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	const list = node("/shared/list")
	on("on/add", async (text) => {
		await check(text)
		list.set((l) => [...l, text])
	})
}
