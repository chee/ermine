// @ts-nocheck: a program as a model would write it, untyped
export default function (me) {
	const status = me.make("./status", { state: "idle" })
	me.answer("./on/save", async (me, text) => {
		me.write(status, { state: "saving" })
		const result = await me.save(text)
		me.write(status, { state: "saved", result })
	})
}
