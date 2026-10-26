// @ts-nocheck: a program as a model would write it, untyped
export default function (api) {
	const { open, method, save } = api
	const status = open("./status", { state: "idle" })
	method("./on/save", async (text) => {
		status({ state: "saving" })
		const result = await save(text)
		status({ state: "saved", result })
	})
}
