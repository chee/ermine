// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	const status = node("status")
	on("on/save", async (text) => {
		status.set({ state: "saving" })
		const result = await save(text)
		status.set({ state: "saved", result })
	})
}
