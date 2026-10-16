// /programs/power: power off (the world menu's last item): the power
// switch, /dev/power/switch, written; then it ends.
import { data, drop, whole } from "ermine:kit"
import { here } from "ermine:os"

export default (given) => {
	const { api, self, name } = given
	const [what] = data(given)?.args ?? []
	if (what === "off") api.write(["/", "dev", "power", "switch"], whole({ off: true }))
	else console.log("power: power off")
	drop(api, here(self).slice(0, -1), name, self)
}
