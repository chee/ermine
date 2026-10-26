// design J, the smallest api the tasks need: H with every word a program can do without dropped
// (open, the handle, memo, effect, method, send, show are left). the rest is H's
// (designs/h/adapter.ts)
import { called } from "../h/adapter.ts"

export default called({ small: true })
