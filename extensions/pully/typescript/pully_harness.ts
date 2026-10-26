// pully's harness: the ermine harness (ermine/system/typescript/ermine_harness.ts: its ermine,
// programs, requests and test features, all as documented there) with pully (pully.ts) beside:
// the feature asked for by name, "pully", and its library's functions a program may call:
//   ["provide", x, handler]   provide(x, handler): x's provider named handler (an action node)
//   ["unprovide", x]          unprovide(x)
//   ["check", x]              check(x): x's handler sent "check", its answer
import pully, { check, provide, unprovide } from "./pully.ts"
import { libraries, named, serveErmine } from "../../../ermine/system/typescript/ermine_harness.ts"

named.set("pully", pully)
libraries.set(
	"provide",
	(env, raw, { arg }) => provide(arg(env, raw[0]) as never, arg(env, raw[1]) as never),
)
libraries.set("unprovide", (env, raw, { arg }) => unprovide(arg(env, raw[0]) as never))
libraries.set("check", (env, raw, { arg }) => check(arg(env, raw[0]) as never))

if (import.meta.main) serveErmine()
