// design G3, G with a draft word: x.set(v) replaces the whole value, x.produce(draft => …) changes part
// of it (the real edit with a recipe). everything else is G's (designs/g/adapter.ts)
import { invented } from "../g/adapter.ts"

export default invented("produce")
