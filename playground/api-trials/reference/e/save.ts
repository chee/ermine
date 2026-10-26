// @ts-nocheck: a program as a model would write it, untyped
export default function (e) {
	const status = e.node("./status", { state: "idle" })
	e.handler("./on/save", async (e, text) => {
		e.write(status, { state: "saving" })
		const result = await e.save(text)
		e.write(status, { state: "saved", result })
	})
}
