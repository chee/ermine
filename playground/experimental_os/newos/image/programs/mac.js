// /programs/mac: a Mac app started, as a word: its words are its data's args,
// as a binding in /etc/keys gives them, then it ends.
//
//   mac launch TextEdit               by name, bundle id (com.apple.TextEdit) or path
//   mac launch -s TextEdit            and its first window shown, as macapps' Enter shows one
//
// It places /dev/mac/do/<its own>, {n, act: "launch", app, show?}; the mac
// driver starts the app and answers in it (done, error, value its pid; the
// log says it too), then this ends and the node with it. A window to show is
// the driver's to wait for. From a shell: wm run mac launch TextEdit.
import { data, drop, effect, idAt, make, val } from "ermine:kit"
import { here } from "ermine:os"

export default (given) => {
	const { api, self, name } = given
	const [verb, ...rest] = data(given)?.args ?? []
	const show = rest[0] === "-s"
	const app = (show ? rest.slice(1) : rest).join(" ")
	const NAME = `launch-${String(self).replace(/[^A-Za-z0-9]/g, "")}`
	const DO = ["/", "dev", "mac", "do", NAME]
	let ask
	// the ask let go (its name would stay a name in /dev/mac/do), then this
	const end = (api, why) => {
		if (why) console.log("mac:", why)
		if (ask) drop(api, DO.slice(0, -1), NAME, ask)
		drop(api, here(self).slice(0, -1), name, self)
	}
	if (verb !== "launch" || !app || !idAt(api, ["/", "dev", "mac"])) {
		return end(api, verb === "launch" && app ? "no /dev/mac" : "mac launch [-s] <app>")
	}
	ask = make(api, DO.slice(0, -1), NAME, {
		n: 1,
		act: "launch",
		app,
		...(show ? { show: true } : {}),
	}, { ephemeral: true })
	effect(given, "answer", ({ api }) => val(api, DO) ?? null, ({ value: d, api }) => {
		if (d?.done !== undefined) end(api, d.error)
	})
}
