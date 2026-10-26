// @ts-nocheck: a program as a model would write it, untyped
export default function (api) {
	const { usePath, method, save } = api
	const [, patchStatus] = usePath("./status", { state: "idle" })
	method("./on/save", async (text) => {
		patchStatus({ state: "saving" })
		const result = await save(text)
		patchStatus({ state: "saved", result })
	})
}
