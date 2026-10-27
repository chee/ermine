// trace: a write outside a run keeps the whole trace text beside its change (traceOf,
// @ermine/core/places/header), not only its site. a feature the host adds [chee 10-27: "hints and
// trace, user imports and includes them as features"; before: on by default]
//
//   import { trace } from "@ermine/system/trace"
//   createErmine({ features: [trace] })
//
//   trace         the text kept, unless a build site was given (@ermine/unplugin): that site only,
//                 nothing captured
//   traceAlways   the text kept even with a build site: captured too, the build site kept as the
//                 change's site
import type { Feature } from "./features.ts"

export const trace: Feature = {
	name: "trace",
	setup: (f) => f.onTrace((t, next) => next({ ...t, text: t.text || t.built === undefined })),
}

export const traceAlways: Feature = {
	name: "trace",
	setup: (f) => f.onTrace((t, next) => next({ ...t, text: true })),
}
