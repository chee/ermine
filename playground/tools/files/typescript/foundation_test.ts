import { assert, assertEquals, assertNotEquals, assertThrows } from "@std/assert"
import { answers, makealias, READING, system as foundation, WRITING } from "./foundation.ts"

// Every test works in a folder of its own from Deno.makeTempDir, and never
// the person's home. What needs macOS is skipped elsewhere, and where FFI is
// not permitted, as sys_test.ts skips.

const granted = (["write", "ffi"] as const).every((name) =>
	Deno.permissions.querySync({ name }).state === "granted"
)
const mac = Deno.build.os === "darwin" && granted

async function within(fn: (dir: string) => Promise<void>) {
	const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "ermine-foundation-" }))
	try {
		await fn(dir)
	} finally {
		await Deno.remove(dir, { recursive: true })
	}
}

Deno.test({
	name: "on Linux every call does nothing but run the function",
	ignore: Deno.build.os === "darwin",
	fn() {
		assertEquals(foundation.coordinate("/nowhere", true, () => 7), 7)
		assertEquals(foundation.bookmark("/"), undefined)
		assertEquals(foundation.resolve(new Uint8Array([1])), undefined)
		assertEquals(foundation.ubiquitous("/"), false)
		assertEquals(foundation.alias("/"), undefined)
		assertEquals(makealias("/", "/nowhere"), false)
	},
})

Deno.test({
	name: "coordinate runs the function once, under the coordinator, and gives what it returns",
	ignore: !mac,
	fn: () =>
		within(async (dir) => {
			const file = `${dir}/a.txt`
			await Deno.writeTextFile(file, "12:00")
			let runs = 0
			const r = foundation.coordinate(file, true, () => {
				runs++
				// a call that changes the entry runs inside the accessor, on this thread
				Deno.renameSync(file, `${dir}/b.txt`)
				return "moved"
			}, WRITING.moving)
			assertEquals([r, runs], ["moved", 1])
			assertEquals(await Deno.readTextFile(`${dir}/b.txt`), "12:00")
			assertEquals(foundation.coordinate(`${dir}/b.txt`, false, () => "read"), "read")
			assertEquals(
				foundation.coordinate(`${dir}/b.txt`, false, () => 3, READING.withoutChanges),
				3,
			)
			// an entry that is not there, a new one's place
			assertEquals(
				foundation.coordinate(`${dir}/new.txt`, true, () => "made", WRITING.merging),
				"made",
			)
		}),
})

Deno.test({
	name: "an error the function throws comes out of coordinate, and the coordinator is left clean",
	ignore: !mac,
	fn: () =>
		within(async (dir) => {
			await Deno.writeTextFile(`${dir}/a.txt`, "x")
			assertThrows(
				() =>
					foundation.coordinate(`${dir}/a.txt`, true, () => {
						throw new RangeError("boom")
					}),
				RangeError,
				"boom",
			)
			// a coordinated call inside another, as a move between two homes does
			const r = foundation.coordinate(`${dir}/a.txt`, true, () =>
				foundation.coordinate(`${dir}/c.txt`, true, () =>
					"inner", WRITING.merging))
			assertEquals(r, "inner")
			// many calls, each making and releasing a coordinator
			let n = 0
			for (let i = 0; i < 500; i++) {
				n += foundation.coordinate(`${dir}/a.txt`, true, () =>
					1)
			}
			assertEquals(n, 500)
		}),
})

Deno.test({
	name: "a bookmark follows a folder moved, and leads nowhere once it is gone",
	ignore: !mac,
	fn: () =>
		within(async (dir) => {
			await Deno.mkdir(`${dir}/Store`)
			const b = foundation.bookmark(`${dir}/Store`)
			assert(b && b.length > 0)
			assertEquals(foundation.resolve(b), `${await Deno.realPath(dir)}/Store`)
			await Deno.rename(`${dir}/Store`, `${dir}/Renamed`)
			assertEquals(await Deno.realPath(foundation.resolve(b)!), `${dir}/Renamed`)
			await Deno.mkdir(`${dir}/in`)
			await Deno.rename(`${dir}/Renamed`, `${dir}/in/Deeper`)
			assertEquals(await Deno.realPath(foundation.resolve(b)!), `${dir}/in/Deeper`)
			await Deno.remove(`${dir}/in/Deeper`)
			assertEquals(foundation.resolve(b), undefined)
			// nothing to bookmark, and nothing that is a bookmark
			assertEquals(foundation.bookmark(`${dir}/never`), undefined)
			assertEquals(foundation.resolve(new Uint8Array([1, 2, 3])), undefined)
			assertEquals(foundation.resolve(new Uint8Array()), undefined)
		}),
})

Deno.test({
	name: "ubiquitous says false of a plain folder or a path that is not there",
	ignore: !mac,
	fn: () =>
		within(async (dir) => {
			assertEquals(foundation.ubiquitous(dir), false)
			assertEquals(foundation.ubiquitous(`${dir}/nothing`), false)
		}),
})

Deno.test({
	name: "ubiquitous says true of iCloud Drive, where this Mac has it",
	ignore: !mac,
	fn() {
		// read only: nothing is made in it
		const drive = `${Deno.env.get("HOME")}/Library/Mobile Documents/com~apple~CloudDocs`
		let there = false
		try {
			there = Deno.statSync(drive).isDirectory
		} catch {
			// this Mac has none
		}
		if (!there) return
		// Foundation gives no value for any item where the iCloud daemon is out of reach
		// (a sandbox, a background job), so it cannot say yes or no: say why, and stop.
		if (!answers(Deno.cwd())) {
			console.warn(
				"skipped: Foundation gives no NSURLIsUbiquitousItemKey value here (iCloud daemon out of reach)",
			)
			return
		}
		assertEquals(foundation.ubiquitous(drive), true)
	},
})

Deno.test({
	name: "alias gives the path a Finder alias file leads to, and nothing for any other file",
	ignore: !mac,
	fn: () =>
		within(async (dir) => {
			await Deno.mkdir(`${dir}/docs`)
			await Deno.writeTextFile(`${dir}/docs/1.txt`, "hello")
			assert(makealias(`${dir}/docs/1.txt`, `${dir}/pinned`))
			assertEquals(foundation.alias(`${dir}/pinned`), `${dir}/docs/1.txt`)
			assert(makealias(`${dir}/docs`, `${dir}/docs alias`))
			assertEquals(foundation.alias(`${dir}/docs alias`), `${dir}/docs`)
			// it follows its target moved
			await Deno.rename(`${dir}/docs/1.txt`, `${dir}/docs/2.txt`)
			assertEquals(foundation.alias(`${dir}/pinned`), `${dir}/docs/2.txt`)
			assertEquals(foundation.alias(`${dir}/docs/2.txt`), undefined)
			assertEquals(foundation.alias(`${dir}/docs`), undefined)
			assertEquals(foundation.alias(`${dir}/never`), undefined)
			assertNotEquals((await Deno.lstat(`${dir}/pinned`)).isSymlink, true)
		}),
})
