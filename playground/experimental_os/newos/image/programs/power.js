// /programs/power: power off (the world menu's last item): the power
// switch, /dev/power/switch, written; then it ends.
import { data, whole } from "ermine:kit"
import { end } from "ermine:os"

export default (given) => {
	const { api } = given
	const [what] = data(given)?.args ?? []
	if (what === "off") api.write(["/", "dev", "power", "switch"], whole({ off: true }))
	else console.log("power: power off")
	end(given)
}
