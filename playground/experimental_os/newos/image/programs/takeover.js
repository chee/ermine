// /programs/takeover: full screen, the Mac's ways out off too (takeover, or
// takeover on), or on again (takeover off); with toggle, the other of what
// /dev/display/mode says: /dev/display/want, which the compositor asks of
// the metal (n, a new number each time, so asking the same twice asks again);
// then it ends.
import { data, val, whole } from "ermine:kit"
import { end } from "ermine:os"

export default (given) => {
	const { api } = given
	const [what] = data(given)?.args ?? []
	const now = !!val(api, ["/", "dev", "display", "mode"])?.takeover
	const on = what === "toggle" ? !now : what !== "off"
	api.write(["/", "dev", "display", "want"], whole({ takeover: on, n: Date.now() }))
	end(given)
}
