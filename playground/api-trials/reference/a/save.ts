// @ts-nocheck: a program as a model would write it, untyped
export default function (api) {
	const { open, edit, method, save } = api
	const status = open("./status", { state: "idle" })
	method("./on/save", async (text) => {
		edit(status, () => ({ state: "saving" }))
		const result = await save(text)
		edit(status, () => ({ state: "saved", result }))
	})
}
