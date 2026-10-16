// ---- POST /compile (for examples/prog-build): C in, a wasm module out ----
// clang for wasm32, no libc, linked by wasm-ld: a function not static is exported, a function
// declared and not defined is an import from "env". only from this machine, no #include or
// #embed (they read files), 64KB, 10s. 400: clang's own messages. vite's dev server and its
// preview both have it (vite.config.ts); a static host has not
import { execFile } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { IncomingMessage, ServerResponse } from "node:http"

const clang = "/usr/bin/clang"
const ld = [
	"/opt/homebrew/opt/lld/bin/wasm-ld",
	"/opt/homebrew/opt/lld@22/bin/wasm-ld",
	"/opt/homebrew/opt/lld@21/bin/wasm-ld",
	"/opt/homebrew/opt/llvm/bin/wasm-ld",
	"/usr/local/opt/lld/bin/wasm-ld",
].find((path) => existsSync(path) && statSync(path).isFile())

const text = (res: ServerResponse, body: string, status: number) => {
	res.writeHead(status, { "content-type": "text/plain; charset=utf-8" })
	res.end(body)
}

async function body(req: IncomingMessage, limit: number): Promise<string | undefined> {
	const chunks: Buffer[] = []
	let size = 0
	for await (const chunk of req) {
		size += chunk.length
		if (size > limit) return undefined
		chunks.push(chunk)
	}
	return Buffer.concat(chunks).toString("utf8")
}

export async function compile(req: IncomingMessage, res: ServerResponse) {
	const from = req.socket.remoteAddress ?? ""
	if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(from)) {
		return text(res, "compile: only from this machine", 403)
	}
	if (req.method !== "POST") return text(res, "compile: POST the C source", 405)
	if (!ld) return text(res, "compile: no wasm-ld here (brew install lld)", 501)
	const source = await body(req, 65536 * 4)
	if (source === undefined || source.length > 65536) {
		return text(res, "compile: more than 64KB", 413)
	}
	if (/^\s*#\s*(include|embed)\b|__has_(include|embed)/m.test(source)) {
		return text(res, "compile: no #include or #embed: this C has no files to read", 400)
	}
	const header = String(req.headers["x-name"] ?? "")
	const name = /^[\w-]{1,40}\.c$/.test(header) ? header : "program.c"
	const dir = await mkdtemp(join(tmpdir(), "slay-cc-"))
	try {
		await writeFile(join(dir, name), source)
		const failed = await new Promise<string | undefined>((done) =>
			execFile(
				clang,
				[
					"--target=wasm32",
					"-O2",
					"-nostdlib",
					"-nostdinc",
					"-fvisibility=default",
					`-fuse-ld=${ld}`,
					"-Wl,--no-entry",
					"-Wl,--export-dynamic",
					"-Wl,--allow-undefined",
					"-o",
					"out.wasm",
					name,
				],
				{ cwd: dir, timeout: 10_000 },
				(error, _out, err) =>
					done(
						!error
							? undefined
							: error.killed
							? "compile: more than 10s"
							: String(err || error.message),
					),
			)
		)
		if (failed !== undefined) return text(res, failed, 400)
		res.writeHead(200, { "content-type": "application/wasm", "cache-control": "no-store" })
		res.end(await readFile(join(dir, "out.wasm")))
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {})
	}
}
