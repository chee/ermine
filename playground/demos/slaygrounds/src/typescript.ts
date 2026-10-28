/// <reference lib="dom" />
/// <reference types="vite/client" />
// typescript 7's language server (tsgo, wasm) in a worker, talking json-rpc with the editor.
// its files are in memory: host.ts, program.tsx (jsx parses only in a .tsx) and the modules'
// sources, which tsconfig "paths" names by the same specifiers the import map uses
import { startTsgo } from "./tsgo/host.ts"
import tsgoWasm from "tsgo-wasm/tsgo.wasm?url"

type Message =
	| { lsp: string }
	| { types: Record<string, string>; paths: Record<string, string[]> }

let tsgo: Awaited<ReturnType<typeof startTsgo>> | undefined
const queue: Message[] = []

function handle(m: Message) {
	if ("lsp" in m) return tsgo!.send(m.lsp)
	const changes: { uri: string; type: 1 | 2 | 3 }[] = []
	for (const [path, text] of Object.entries(m.types)) {
		changes.push({
			uri: `file://${path}`,
			type: tsgo!.fs.writeFile(path, text) === "created" ? 1 : 2,
		})
	}
	const config = JSON.stringify({
		compilerOptions: {
			target: "esnext",
			module: "esnext",
			moduleResolution: "bundler",
			allowImportingTsExtensions: true,
			noEmit: true,
			strict: true,
			// the program is written without annotations on its own parameters
			noImplicitAny: false,
			skipLibCheck: true,
			lib: ["esnext", "dom"],
			// jsx in program.tsx (the editor's program.ts, as the server sees it): the automatic
			// runtime, @ermine's (@ermine/jsx-runtime) unless the file's @jsxImportSource says another
			jsx: "react-jsx",
			jsxImportSource: "@ermine",
			paths: m.paths,
		},
		include: ["host.ts", "program.ts", "program.tsx", "types/**/*"],
	})
	changes.push({
		uri: "file:///tsconfig.json",
		type: tsgo!.fs.writeFile("/tsconfig.json", config) === "created" ? 1 : 2,
	})
	tsgo!.notify("workspace/didChangeWatchedFiles", { changes })
	tsgo!.refresh()
}

self.onmessage = (e: MessageEvent<Message>) => (tsgo ? handle(e.data) : queue.push(e.data))

// no webassembly (or no streaming compile) in this browser: it says so, the page shows it
// no tsgo.wasm on this host (one that was not given the 49MB): "off:", and the page says so
const wasm = fetch(tsgoWasm).then((r) => {
	if (!r.ok) throw new Error("off: no tsgo.wasm on this host")
	return r
})
startTsgo(wasm, (lsp) => self.postMessage({ lsp }))
	.then((ready) => {
		tsgo = ready
		for (const m of queue.splice(0)) handle(m)
	})
	.catch((e) => {
		console.error("[tsgo] failed to start", e)
		self.postMessage({ failed: String(e?.message ?? e) })
	})
