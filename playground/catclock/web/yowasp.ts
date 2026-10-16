// yowasp.ts: wasm-clang's build, clang and wasm-ld built as wasm (@yowasp/clang), in a filesystem
// of its own holding only the files given. Built as serve.ts builds (clang.ts' flags): a C file
// compiled into its object, or objects linked; the answer an Answer. One build for both that run
// it: the page's worker (clang.worker.ts) and the Netlify function (functions/compile.mts). The
// first build fetches clang (105 MB: beside @yowasp/clang's bundle.js); onFetch is told how far
import { commands } from "@yowasp/clang"
import { type Answer, type Ask, CC, LD, objectOf } from "./clang.ts"

type Tree = { [name: string]: Tree | string | Uint8Array }
const text = new TextDecoder()

export async function build(
	ask: Ask,
	onFetch?: (fetched: number, total: number) => void,
): Promise<Answer> {
	const started = performance.now()
	const ms = () => Math.round(performance.now() - started)
	let said = ""
	const options = {
		stdout: (b: Uint8Array | null) => void (b && (said += text.decode(b))),
		stderr: (b: Uint8Array | null) => void (b && (said += text.decode(b))),
		fetchProgress: ({ doneLength, totalLength }: { doneLength: number; totalLength: number }) =>
			onFetch?.(doneLength, totalLength),
	}
	try {
		let out: string, made: Tree
		if ("cc" in ask) {
			const { main, files } = ask.cc
			out = objectOf(main)
			made = await commands.clang([...CC, "-c", main, "-o", out], files, options) as Tree
		} else {
			const { objects } = ask.ld
			// named as build.sh names it, so the same objects make the same bytes
			out = ask.ld.out
			made = await commands["wasm-ld"](
				[...LD, "-o", out, ...Object.keys(objects).sort()],
				objects,
				options,
			) as Tree
		}
		const bytes = made[out]
		if (!(bytes instanceof Uint8Array)) return { ok: false, error: `${out}: none made`, ms: ms() }
		return { ok: true, bytes, warnings: said.trim(), ms: ms() }
	} catch (e) {
		// clang's or wasm-ld's own words; an exit with nothing said, as it is
		return { ok: false, error: said.trim() || String((e as Error)?.message ?? e), ms: ms() }
	}
}
