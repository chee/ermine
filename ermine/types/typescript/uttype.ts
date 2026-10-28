// UTType: swift's names, in javascript. a type read through places from a types folder (typesAt),
// so a computer that asks reruns when what it asked changes
//
//   const types = createTypes(places, typesAt(places, ["clocks"]))
//   const jpeg = types.get("public.jpeg")       // always a UTType, as UTType(_:) is
//   types.fromFilenameExtension("jpg")          // UTType(filenameExtension:), conformingTo .data
//   types.fromFilenameExtension("txt", { conformingTo: types.text })
//   types.fromMIMEType("image/png")
//   types.jpeg, types.plainText                 // the documented constants (constants.json)
//
//   jpeg.identifier                    "public.jpeg"
//   jpeg.preferredFilenameExtension    "jpeg"
//   jpeg.preferredMIMEType             "image/jpeg"
//   jpeg.isDeclared, isDynamic, isPublic
//   jpeg.referenceURL                  URL | undefined
//   jpeg.version                       number | undefined
//   jpeg.supertypes                    Set<UTType>: the same objects each time, so has() works
//   jpeg.conformsTo(types.image)       conforms(to:)
//   jpeg.isSubtypeOf(types.image)      isSubtype(of:)
//   types.image.isSupertypeOf(jpeg)    isSupertype(of:)
//
// declared: the type has a node in the folder. public: its identifier starts "public."; dynamic:
// "dyn.". where swift would make a dynamic type (an extension or mime type nobody claims), these give
// undefined. no folder: nothing is declared
// reads: get reads nothing; each getter reads when asked, the type's node in the folder and the one
// field of its value; supertypes and the conformance checks read each type followed (conformance);
// fromFilenameExtension and fromMIMEType read the folder's names and each type's one field
import { conformance, type Folder, lowered, nodeOf, type Reads, strings } from "./types.ts"
import { level } from "@ermine/core/places"
import { members } from "@ermine/core/places/lib"
import { keyorder } from "@ermine/core/util/keyorder"
import CONSTANTS from "./constants.json" with { type: "json" }

// a documented constant's name ("jpeg", "plainText"): constants.json, gathered by ../mac/gather.ts
export type Constant = keyof typeof CONSTANTS

export type Types =
	& {
		// the type with this identifier: the same object for the same identifier
		get(identifier: string): UTType
		// the first type in the folder's order claiming the extension (no ".", any case) that conforms
		// to conformingTo (none: public.data, as swift's); none: undefined
		fromFilenameExtension(
			extension: string,
			options?: { conformingTo?: UTType },
		): UTType | undefined
		// the same, by a mime type (any case)
		fromMIMEType(mimeType: string, options?: { conformingTo?: UTType }): UTType | undefined
	}
	& { readonly [K in Constant]: UTType }

export class UTType {
	readonly identifier: string
	readonly #places: Reads
	readonly #folder: Folder | undefined
	readonly #types: Types

	constructor(places: Reads, folder: Folder | undefined, types: Types, identifier: string) {
		this.#places = places
		this.#folder = folder
		this.#types = types
		this.identifier = identifier
	}

	// one field of the type's value; undeclared: undefined
	#field(name: string): unknown {
		const id = this.#folder && nodeOf(this.#places, this.#folder, this.identifier)
		return id === undefined ? undefined : this.#places.readValue("value", id, [name])
	}

	get isDeclared(): boolean {
		return this.#folder !== undefined &&
			nodeOf(this.#places, this.#folder, this.identifier) !== undefined
	}
	get isDynamic(): boolean {
		return this.identifier.startsWith("dyn.")
	}
	get isPublic(): boolean {
		return this.identifier.startsWith("public.")
	}
	get preferredFilenameExtension(): string | undefined {
		return strings(this.#field("filenameExtension"))[0]
	}
	get preferredMIMEType(): string | undefined {
		return strings(this.#field("mimeType"))[0]
	}
	get referenceURL(): URL | undefined {
		const url = this.#field("referenceURL")
		return typeof url === "string" && URL.canParse(url) ? new URL(url) : undefined
	}
	get version(): number | undefined {
		const v = this.#field("version")
		return typeof v === "number" ? v : undefined
	}
	// every type it conforms to, not itself
	get supertypes(): Set<UTType> {
		const { all } = conformance(this.#places, this.#folder, this.identifier)
		return new Set(all.slice(1).map((id) => this.#types.get(id)))
	}
	// itself, or one of its supertypes
	conformsTo(type: UTType): boolean {
		return type.identifier === this.identifier ||
			conformance(this.#places, this.#folder, this.identifier).all.includes(type.identifier)
	}
	// conforms, and is not it
	isSubtypeOf(type: UTType): boolean {
		return type.identifier !== this.identifier && this.conformsTo(type)
	}
	isSupertypeOf(type: UTType): boolean {
		return this.#types.get(type.identifier).isSubtypeOf(this)
	}
	toString(): string {
		return this.identifier
	}
}

export function createTypes(places: Reads, folder: Folder | undefined): Types {
	const made = new Map<string, UTType>()
	const get = (identifier: string) => {
		let t = made.get(identifier)
		if (t === undefined) made.set(identifier, t = new UTType(places, folder, types, identifier))
		return t
	}
	// the first type in the folder's order whose field holds tag (any case) and conforms
	const byTag = (field: string, tag: string, conformingTo: UTType | undefined) => {
		if (folder === undefined) return
		const want = lowered(tag)
		const to = conformingTo ?? get("public.data")
		const here = members(places, folder.path).filter((m) => m.id !== level)
		here.sort((a, b) => keyorder(a.name, b.name))
		for (const m of here) {
			if (!strings(places.readValue("value", m.id, [field])).some((x) => lowered(x) === want)) {
				continue
			}
			const t = get(m.name)
			if (t.conformsTo(to)) return t
		}
	}
	const types = {
		get,
		fromFilenameExtension: (extension: string, options: { conformingTo?: UTType } = {}) =>
			byTag("filenameExtension", extension, options.conformingTo),
		fromMIMEType: (mimeType: string, options: { conformingTo?: UTType } = {}) =>
			byTag("mimeType", mimeType, options.conformingTo),
	} as Types
	for (const [name, identifier] of Object.entries(CONSTANTS)) {
		Object.defineProperty(types, name, { get: () => get(identifier), enumerable: true })
	}
	return types
}
