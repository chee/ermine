// hello: a program in core's words. It counts keys: the kbd driver calls
// its handler with each turn's keys; a compute reads the count and an effect
// says it.
import { effect, handler, make, snap, val } from "ermine:kit"
import { here } from "ermine:os"

export default (given) => {
	const { api, self, name } = given
	make(api, [name], "count", 0)
	const me = here(self)
	handler(given, "keys", ({ api, args }) => {
		const [records] = args
		snap(api, [name, "count"], val(api, [name, "count"]) + records.length)
		return records.length
	})
	// the kbd driver calls whoever /dev/kbd/to names
	api.write(["/", "dev", "kbd", "to"], [{ path: [], value: [...me, "on", "keys"] }])
	effect(
		given,
		"say",
		({ api }) => val(api, ["count"]),
		({ value }) => console.log("hello: keys", value),
	)
	console.log("hello: set up as", self, "at", JSON.stringify(me))
	return "hello"
}
