// parent: starts kid, then puts its data, in the same part
import { put } from "ermine:kit"
export default ({ api, start }) => {
	const pid = start({ address: ["/", "apps"], program: ["programs", "kid"], name: "kid" })
	console.log("parent: started", pid)
	put(api, pid, "data", { hello: 1 })
	console.log("parent: put data")
	return null
}
