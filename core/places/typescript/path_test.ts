import { assertEquals, assertThrows } from "@std/assert"
import { address, parse, path } from "./path.ts"
import { PlacesError } from "./places.ts"

Deno.test("parse: split at each /, a leading / the root, empty pieces skipped", () => {
	assertEquals(parse("/notes/today"), ["/", "notes", "today"])
	assertEquals(parse("notes/today"), ["notes", "today"])
	assertEquals(parse("../x/./y"), ["..", "x", ".", "y"])
	assertEquals(parse("/"), ["/"])
	assertEquals(parse(""), [])
	assertEquals(parse("a//b/"), ["a", "b"])
	assertEquals(parse("é/🦊"), ["é", "🦊"])
})

Deno.test("address: a string parsed, steps as given", () => {
	const steps = ["/", "notes", "re/set"]
	assertEquals(address("/notes/today"), ["/", "notes", "today"])
	assertEquals(address(steps), steps)
})

Deno.test("path: an empty name is refused", () => {
	assertThrows(() => path`/a/${""}/b`, PlacesError, "not-a-name")
})

Deno.test("path: what is put in is one name, never split", () => {
	const title = "re/set"
	assertEquals(path`/notes/${title}/comments`, ["/", "notes", "re/set", "comments"])
	assertEquals(path`${title}`, ["re/set"])
	assertEquals(path`/${"x"}${"y"}`, ["/", "x", "y"])
	assertEquals(path`../${1}`, ["..", "1"])
	assertEquals(path`/notes/today`, ["/", "notes", "today"])
})
