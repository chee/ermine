// UTType (uttype.ts) over the installed list: swift's answers, read through places
import { assert, assertEquals } from "@std/assert"
import type { Entry } from "@ermine/core/node/entry"
import { createScheduler } from "@ermine/core/scheduler"
import { createChangeHeader } from "@ermine/core/places/header"
import { createErmine } from "@ermine/system"
import { createTypes, installTypes, type Known, typesAt, UTType } from "./types.ts"

function world(list?: Known[]) {
	const s = createScheduler()
	const over = createErmine({ scheduler: s, root: "R", info: { actor: "host" } })
	const commit = (changed: readonly Entry<unknown>[]) => over.places.commit(changed)
	const install = (l?: Known[]) =>
		over.within(() =>
			commit(installTypes(over.table, "R", createChangeHeader(s), l, (p) => p.join("/")))
		)
	install(list)
	const types = createTypes(over.places, typesAt(over.places, []))
	return { s, over, install, types }
}

Deno.test("uttype: a type's tags, its preferred ones first", () => {
	const { types } = world()
	const jpeg = types.get("public.jpeg")
	assert(jpeg instanceof UTType)
	assertEquals(jpeg.identifier, "public.jpeg")
	assertEquals(jpeg.preferredFilenameExtension, "jpeg")
	assertEquals(jpeg.preferredMIMEType, "image/jpeg")
	assertEquals(`${jpeg}`, "public.jpeg")
	assertEquals(types.jpeg, jpeg)
	assertEquals(types.plainText.identifier, "public.plain-text")
	assertEquals(types.get("public.folder").preferredMIMEType, undefined)
})

Deno.test("uttype: declared, dynamic, public", () => {
	const { types } = world()
	assertEquals(
		[types.jpeg.isDeclared, types.jpeg.isDynamic, types.jpeg.isPublic],
		[true, false, true],
	)
	const pdf = types.pdf
	assertEquals([pdf.identifier, pdf.isPublic], ["com.adobe.pdf", false])
	const dyn = types.get("dyn.ah62d4rv4ge80k2u")
	assertEquals([dyn.isDeclared, dyn.isDynamic, dyn.isPublic], [false, true, false])
	assertEquals([dyn.preferredFilenameExtension, dyn.supertypes.size], [undefined, 0])
	const none = createTypes(world().over.places, undefined).jpeg
	assertEquals([none.isDeclared, none.preferredMIMEType], [false, undefined])
})

Deno.test("uttype: referenceURL and version", () => {
	const { types } = world([{
		identifier: "party.chee.ermine.clockface",
		conformsTo: "public.json",
		referenceURL: "https://ermine.love/clockface",
		version: 2,
	}])
	assertEquals(
		types.get("party.chee.ermine.clockface").referenceURL?.href,
		"https://ermine.love/clockface",
	)
	assertEquals(types.get("party.chee.ermine.clockface").version, 2)
	assertEquals([types.jpeg.referenceURL, types.jpeg.version], [undefined, undefined])
})

Deno.test("uttype: supertypes, conforms, subtype and supertype", () => {
	const { types } = world()
	const { jpeg, image, data, item, plainText } = types
	assertEquals(
		[...jpeg.supertypes].map(String).sort(),
		["public.content", "public.data", "public.image", "public.item"],
	)
	assert(jpeg.supertypes.has(image))
	assert(jpeg.conformsTo(image) && jpeg.conformsTo(item) && jpeg.conformsTo(jpeg))
	assert(!jpeg.conformsTo(plainText))
	assert(jpeg.isSubtypeOf(image) && !jpeg.isSubtypeOf(jpeg))
	assert(data.isSupertypeOf(jpeg) && !jpeg.isSupertypeOf(data) && !jpeg.isSupertypeOf(jpeg))
})

Deno.test("uttype: from an extension or a mime type, conforming to public.data unless told", () => {
	const { types } = world()
	assertEquals(types.fromFilenameExtension("jpg"), types.jpeg)
	assertEquals(types.fromFilenameExtension("JPG"), types.jpeg)
	assertEquals(types.fromFilenameExtension(".jpg"), undefined)
	assertEquals(types.fromFilenameExtension("nope-nope"), undefined)
	assertEquals(types.fromFilenameExtension("ts")?.identifier, "com.microsoft.typescript")
	// .ts: the transport stream too, found when only a movie will do
	assertEquals(
		types.fromFilenameExtension("ts", { conformingTo: types.movie })?.identifier,
		"public.mpeg-2-transport-stream",
	)
	// an app bundle is a folder, not data: the one-file app is, as swift's
	assertEquals(types.fromFilenameExtension("app")?.identifier, "com.apple.application-file")
	assertEquals(types.fromFilenameExtension("mts")?.identifier, "com.microsoft.typescript")
	assertEquals(types.get("com.microsoft.typescript").preferredMIMEType, "application/typescript")
	// told any item, both claim it: the first in the folder's order (shorter first), not swift's pick
	assertEquals(
		types.fromFilenameExtension("app", { conformingTo: types.item }),
		types.get("com.apple.application-file"),
	)
	assertEquals(
		types.fromFilenameExtension("app", { conformingTo: types.directory }),
		types.applicationBundle,
	)
	assertEquals(types.fromMIMEType("IMAGE/PNG"), types.png)
	assertEquals(types.fromMIMEType("text/x-nope"), undefined)
})

Deno.test("uttype: a computer reading a type reruns when its node's field changes", () => {
	const { s, install, types } = world()
	const seen: (string | undefined)[] = []
	s.runWithScope(
		s.createRootScope({ actor: "watcher" }),
		() => s.createComputer(() => types.jpeg.preferredMIMEType, (v) => void seen.push(v)),
	)
	s.pulse()
	assertEquals(seen, ["image/jpeg"])
	install([{ identifier: "public.jpeg", conformsTo: "public.image", mimeType: "image/x-jpeg" }])
	s.pulse()
	assertEquals(seen, ["image/jpeg", "image/x-jpeg"])
})
