/// <reference lib="webworker" />
// clang.worker.ts: wasm-clang in the page, in a worker so a build never stops the page. Asked
// {id, ask}, it builds (yowasp.ts) and answers {id, ...Answer}. The page asks one at a time.
// While fetching clang, the first time, it says {fetched, total}
import { build } from "./yowasp.ts"
import type { Ask } from "./clang.ts"

onmessage = async (e: MessageEvent<{ id: number; ask: Ask }>) => {
	const { id, ask } = e.data
	const answer = await build(ask, (fetched, total) => postMessage({ fetched, total }))
	postMessage({ id, ...answer }, answer.bytes ? [answer.bytes.buffer] : [])
}
