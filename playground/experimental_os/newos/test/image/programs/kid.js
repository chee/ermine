// kid: started by parent with data put right after the start
import { data } from "ermine:kit"
export default (given) => {
	console.log("kid: data is", JSON.stringify(data(given)))
	return null
}
