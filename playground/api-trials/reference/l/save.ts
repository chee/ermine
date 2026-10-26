// @ts-nocheck: a program as a model would write it, untyped
import { edit, here, method, open } from "ermine"

export default function ({ save }) {
	const status = open("./status", { state: "idle" })
	method("./on/save", async (text) => {
		edit(status, () => ({ state: "saving" }))
		// after the await nothing is open: keep the call's place to write in it
		const back = here()
		const result = await save(text)
		back(() => edit(status, () => ({ state: "saved", result })))
	})
}
