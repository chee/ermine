// echoes each request: the harness loop's own test (typescript_test.ts)
import { serve } from "./harness.ts"
await serve((r) => r)
