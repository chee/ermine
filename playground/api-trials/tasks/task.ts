import type { Adapter, Program, Result } from "../lib/trial.ts"

export type Task = {
	key: string
	title: string
	// what a program is asked to do: design-neutral, exact names
	statement: string
	// the functions the harness gives the program beside show, by name (run.ts says where)
	given?: string[]
	// the program is a .jsx file
	jsx?: boolean
	// the program is more than one file: their names, the program's first (a try is a folder of
	// them, run.ts)
	files?: string[]
	check: (adapter: Adapter, program: Program) => Promise<Result>
}
