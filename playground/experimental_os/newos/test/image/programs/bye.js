// bye: a program that ends itself (ermine:os end): its child effect stops, its cleanup runs
import { effect, val } from "ermine:kit"
import { end } from "ermine:os"

export default (given) => {
	const { api, onCleanup } = given
	onCleanup(({ killed }) => console.log("bye: cleaned up, killed", killed))
	effect(
		given,
		"watch",
		({ api }) => val(api, ["/", "dev", "kbd", "state"]),
		({ value }) => console.log("bye: saw", JSON.stringify(value)),
	)
	end(given)
	return "bye"
}
