// Echoes each request; the test for the harness loop.
import { serve } from "./harness.ts"
await serve((r) => r)
