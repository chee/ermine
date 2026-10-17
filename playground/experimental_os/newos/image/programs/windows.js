// /programs/windows: each window a Mac window (windows), or back on the
// monitor (windows off), as the shell's windows is; with toggle, the other of
// what /dev/display/mode says: /dev/display/want, which the compositor asks
// of the metal; then it ends.
import { data, val, whole } from "ermine:kit"
import { end } from "ermine:os"

export default (given) => {
	const { api } = given
	const [what] = data(given)?.args ?? []
	const now = !!val(api, ["/", "dev", "display", "mode"])?.windows
	const on = what === "toggle" ? !now : what !== "off"
	api.write(["/", "dev", "display", "want"], whole({ windows: on, n: Date.now() }))
	end(given)
}
