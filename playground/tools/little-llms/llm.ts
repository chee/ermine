// the models, a llama.cpp server for one of them at a time, and a streaming chat call that stops once the code is in

import { complete } from "./extract.ts"
import type { Wrap } from "./kits.ts"

export type Model = {
	name: string
	file: string
	mb: number
	tier: "tiny" | "small" | "medium"
	think?: boolean
	// llama.cpp crashes on LFM2.5, and garbles Qwen3.5, with more than one sequence at a time
	slots?: number
	// only the example-prompted grid: one slot makes the full one too slow on CPU
	reduced?: boolean
}

// in browser terms: tiny loads anywhere, small wants WebGPU or a patient wllama, medium is WebGPU only
export const models: Model[] = [
	{ name: "gemma3-270m", file: "gemma3-270m.gguf", mb: 253, tier: "tiny" },
	{ name: "lfm2.5-350m", file: "lfm2.5-350m.gguf", mb: 229, tier: "tiny", slots: 1 },
	{ name: "smollm2-360m", file: "smollm2-360m.gguf", mb: 386, tier: "tiny" },
	{ name: "granite4-350m", file: "granite4-350m.gguf", mb: 237, tier: "tiny" },
	{
		name: "qwen2.5-coder-0.5b",
		file: "qwen2.5-coder-0.5b.gguf",
		mb: 491,
		tier: "tiny",
	},
	{
		name: "qwen3.5-0.8b",
		file: "qwen3.5-0.8b.gguf",
		mb: 533,
		tier: "tiny",
		think: true,
		slots: 1,
	},
	{ name: "lfm2.5-1.2b", file: "lfm2.5-1.2b.gguf", mb: 731, tier: "small", slots: 1 },
	{ name: "llama3.2-1b", file: "llama3.2-1b.gguf", mb: 808, tier: "small" },
	{ name: "gemma3-1b", file: "gemma3-1b.gguf", mb: 806, tier: "small" },
	{ name: "granite4-1b", file: "granite4-1b.gguf", mb: 1024, tier: "small" },
	{
		name: "qwen2.5-coder-1.5b",
		file: "qwen2.5-coder-1.5b.gguf",
		mb: 1117,
		tier: "small",
	},
	{ name: "smollm2-1.7b", file: "smollm2-1.7b.gguf", mb: 1055, tier: "small" },
	{
		name: "qwen3.5-2b",
		file: "qwen3.5-2b.gguf",
		mb: 1280,
		tier: "small",
		think: true,
		slots: 1,
		reduced: true,
	},
	{
		name: "qwen2.5-coder-3b",
		file: "qwen2.5-coder-3b.gguf",
		mb: 2104,
		tier: "medium",
	},
	{
		name: "qwen3.5-4b",
		file: "qwen3.5-4b.gguf",
		mb: 2740,
		tier: "medium",
		think: true,
		slots: 1,
	},
	{
		name: "gemma4-e2b",
		file: "gemma4-e2b.gguf",
		mb: 3106,
		tier: "medium",
		think: true,
		slots: 1,
	},
]

export const PARALLEL = 4
const PORT = 8090
const base = `http://127.0.0.1:${PORT}`

export async function startServer(model: Model, dir: string, server: string) {
	const cmd = new Deno.Command(server, {
		args: [
			"-m",
			`${dir}/${model.file}`,
			"-c",
			String(4096 * (model.slots ?? PARALLEL)),
			"-np",
			String(model.slots ?? PARALLEL),
			"-t",
			"4",
			"--port",
			String(PORT),
			"--jinja",
			"--no-webui",
		],
		stdout: "null",
		stderr: "null",
	})
	const child = cmd.spawn()
	for (let i = 0; i < 240; i++) {
		try {
			const r = await fetch(`${base}/health`)
			if (r.ok && (await r.json()).status == "ok") return child
		} catch { /* not up yet */ }
		await new Promise((r) => setTimeout(r, 500))
	}
	child.kill()
	throw new Error(`server for ${model.name} did not start`)
}

export async function stopServer(child: Deno.ChildProcess) {
	try {
		child.kill("SIGTERM")
	} catch { /* gone */ }
	await child.status
}

export type Message = {
	role: "system" | "user" | "assistant"
	content: string
}
export type Reply = {
	text: string
	tokens: number
	promptTokens: number
	ms: number
	stopped: boolean
	error?: string
}

export async function chat(
	model: Model,
	messages: Message[],
	o: { wrap: Wrap; blocks: number; maxTokens: number },
): Promise<Reply> {
	const start = Date.now()
	const ctl = new AbortController()
	const timer = setTimeout(() => ctl.abort(), 300_000)
	let text = "", tokens = 0, promptTokens = 0, stopped = false
	try {
		const r = await fetch(`${base}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			signal: ctl.signal,
			body: JSON.stringify({
				messages,
				temperature: 0,
				max_tokens: o.maxTokens,
				stream: true,
				stream_options: { include_usage: true },
				cache_prompt: true,
				...(model.think ? { chat_template_kwargs: { enable_thinking: false } } : {}),
			}),
		})
		if (!r.ok || !r.body) {
			throw new Error(`HTTP ${r.status}: ${await r.text()}`)
		}
		const reader = r.body.pipeThrough(new TextDecoderStream()).getReader()
		let buffer = ""
		for (;;) {
			const { value, done } = await reader.read()
			if (done) break
			buffer += value
			const lines = buffer.split("\n")
			buffer = lines.pop()!
			for (const line of lines) {
				if (!line.startsWith("data: ") || line == "data: [DONE]") continue
				const ev = JSON.parse(line.slice(6))
				const delta = ev.choices?.[0]?.delta
				if (delta?.content) {
					text += delta.content
					tokens++
				}
				if (ev.usage) promptTokens = ev.usage.prompt_tokens
			}
			if (complete(text, o.wrap, o.blocks)) {
				stopped = true
				ctl.abort()
				break
			}
		}
		return { text, tokens, promptTokens, ms: Date.now() - start, stopped }
	} catch (e) {
		if (stopped) {
			return { text, tokens, promptTokens, ms: Date.now() - start, stopped }
		}
		return {
			text,
			tokens,
			promptTokens,
			ms: Date.now() - start,
			stopped,
			error: String((e as Error)?.message ?? e),
		}
	} finally {
		clearTimeout(timer)
	}
}
