// @ts-nocheck: a program as a model would write it, untyped
export default function () {
	const [status, setStatus] = createSignal({ state: "idle" }, { name: "./status" })
	createMethod("./on/save", async (text) => {
		setStatus({ state: "saving" })
		const result = await save(text)
		setStatus({ state: "saved", result })
	})
}
