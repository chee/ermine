// The reference apply.ts on the line protocol (session.ts): create, add, side, versions.
import { serve } from "../../../conformance/typescript/harness.ts"
import { answer } from "./session.ts"

if (import.meta.main) await serve((r) => answer(r as never))
