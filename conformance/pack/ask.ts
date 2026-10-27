// a harness asked: the main runner's ask (a non-zero exit or a sanitizer report is an error)
import { ask as run } from "../typescript/ask.ts"

type Request = Record<string, unknown> & { op: string }
export type Answer = Record<string, unknown> & {
	entries?: unknown[][]
	nodes?: { value?: unknown; change: Record<string, unknown> }[]
	node?: { value?: unknown; change: Record<string, unknown> }
	bytes?: string
	code?: string
	part?: string
	id?: string
	error?: string
}

export const ask = (command: string[], requests: Request[]) =>
	run(command, requests) as Promise<Answer[]>
