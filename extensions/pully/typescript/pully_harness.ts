// pully's harness: the ermine harness (ermine/ermine/typescript/ermine_harness.ts: its ermine,
// programs, requests and test features, all as documented there) with pully (pully.ts) beside:
// the feature asked for by name, "pully", and its library's words a program may call:
//   ["provide", x, handler]   provide(api, x, handler): x's provider named handler (a method node)
//   ["unprovide", x]          unprovide(api, x)
//   ["check", x]              check(api, x): x's handler sent "check", its answer
import pully, { check, provide, unprovide } from "./pully.ts"
import { named, serveErmine, words } from "../../../ermine/ermine/typescript/ermine_harness.ts"

named.set("pully", pully)
words.set(
	"provide",
	(api, env, raw, { arg }) => provide(api, arg(env, raw[0]) as never, arg(env, raw[1]) as never),
)
words.set("unprovide", (api, env, raw, { arg }) => unprovide(api, arg(env, raw[0]) as never))
words.set("check", (api, env, raw, { arg }) => check(api, arg(env, raw[0]) as never))

if (import.meta.main) serveErmine()
