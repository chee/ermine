// the twelve tasks, in order: the first six, the five harder ones, then components (two files)
import { counter } from "./counter.ts"
import { derived } from "./derived.ts"
import { todos } from "./todos.ts"
import { service } from "./service.ts"
import { slow } from "./slow.ts"
import { save } from "./save.ts"
import { view } from "./view.ts"
import { pending } from "./pending.ts"
import { memoSend } from "./memo-send.ts"
import { shared } from "./shared.ts"
import { afterAwait } from "./after-await.ts"
import { components } from "./components.ts"
import type { Task } from "./task.ts"

export type { Task }
export const tasks: Task[] = [
	counter,
	derived,
	todos,
	service,
	slow,
	save,
	view,
	pending,
	memoSend,
	shared,
	afterAwait,
	components,
]
export const task = (k: string) => tasks.find((t) => t.key === k)
