// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	const status = open("./status")
	method("./on/save", async (text) => {
		status({ state: "saving" })
		const result = await save(text)
		status({ state: "saved", result })
	})
}
