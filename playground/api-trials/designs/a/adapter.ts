// design A, "words": today's process api as it is. the adapter passes the real words through,
// only the ones on the sheet (a word not on it is undefined in api)
import type { Adapter } from "../../lib/trial.ts"

const adapter: Adapter = (api, extras) => {
	const {
		open,
		read,
		peep,
		reads,
		list,
		edit,
		memo,
		effect,
		method,
		send,
		status,
		explain: why,
		teardown,
	} = api
	return {
		open,
		read,
		peep,
		reads,
		list,
		edit,
		memo,
		effect,
		method,
		send,
		status,
		why,
		teardown,
		PENDING: api.PENDING,
		...extras,
	}
}
export default adapter
