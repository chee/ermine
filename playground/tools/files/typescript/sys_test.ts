import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert"
import { attr, fake, system } from "./sys.ts"

// Every test works in a folder of its own from Deno.makeTempDir. None calls
// the real Trash: trash is the fake, or system's with a home of the test's.

// a run that may not write or call the system, as newcore's own deno task test, skips what needs to
const granted = (["write", "ffi"] as const).every((name) =>
	Deno.permissions.querySync({ name }).state === "granted"
)
/** A test that writes a temporary folder, on any system. */
const disk = (name: string, fn: () => Promise<void>) => Deno.test({ name, ignore: !granted, fn })
const mac = Deno.build.os === "darwin" && granted
const utf8 = new TextEncoder()
const read = (path: string) => Deno.readTextFile(path)
const names = async (dir: string) =>
	(await Array.fromAsync(Deno.readDir(dir))).map((e) => e.name).sort()
const gone = async (path: string) => {
	await assertRejects(() => Deno.lstat(path), Deno.errors.NotFound)
}

async function within(fn: (dir: string) => Promise<void>) {
	const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "ermine-sys-" }))
	try {
		await fn(dir)
	} finally {
		await Deno.remove(dir, { recursive: true })
	}
}

Deno.test({
	name: "an attribute is set, read back, replaced and removed",
	ignore: !mac,
	fn: () =>
		within(async (dir) => {
			const sys = system({ home: dir })
			const file = `${dir}/clock.txt`
			await Deno.writeTextFile(file, "12:00")
			await Deno.mkdir(`${dir}/apps`)
			assertEquals(await sys.get(file, attr.id), null)
			await sys.set(file, attr.id, utf8.encode("c"))
			assertEquals(await sys.get(file, attr.id), utf8.encode("c"))
			// bytes, any of them, and a view into a larger buffer
			const all = new Uint8Array(300).map((_, i) => i % 256)
			await sys.set(file, attr.slot, all.subarray(7, 290))
			assertEquals(await sys.get(file, attr.slot), all.slice(7, 290))
			await sys.set(file, attr.slot, new Uint8Array([0]))
			assertEquals(await sys.get(file, attr.slot), new Uint8Array([0]))
			await sys.set(file, attr.side, new Uint8Array())
			assertEquals(await sys.get(file, attr.side), new Uint8Array())
			await sys.unset(file, attr.id)
			assertEquals(await sys.get(file, attr.id), null)
			await sys.unset(file, attr.id)
			assertEquals(await sys.get(file, attr.slot), new Uint8Array([0]))
			// a folder, the store's own included
			await sys.set(`${dir}/apps`, attr.id, utf8.encode("a"))
			await sys.set(dir, attr.store, utf8.encode("uuid"))
			assertEquals(await sys.get(`${dir}/apps`, attr.id), utf8.encode("a"))
			assertEquals(await sys.get(dir, attr.store), utf8.encode("uuid"))
			// the file's content is untouched
			assertEquals(await read(file), "12:00")
		}),
})

Deno.test({
	name: "attribute calls act on a link itself, never its target",
	ignore: !mac,
	fn: () =>
		within(async (dir) => {
			const sys = system({ home: dir })
			await Deno.mkdir(`${dir}/docs`)
			await Deno.writeTextFile(`${dir}/docs/1.txt`, "hello")
			await Deno.symlink("docs/1.txt", `${dir}/pinned.txt`)
			await sys.set(`${dir}/docs/1.txt`, attr.id, utf8.encode("d1"))
			assertEquals(await sys.get(`${dir}/pinned.txt`, attr.id), null)
			await sys.set(`${dir}/pinned.txt`, attr.id, utf8.encode("link"))
			assertEquals(await sys.get(`${dir}/pinned.txt`, attr.id), utf8.encode("link"))
			assertEquals(await sys.get(`${dir}/docs/1.txt`, attr.id), utf8.encode("d1"))
			await sys.unset(`${dir}/pinned.txt`, attr.id)
			assertEquals(await sys.get(`${dir}/pinned.txt`, attr.id), null)
			assertEquals(await sys.get(`${dir}/docs/1.txt`, attr.id), utf8.encode("d1"))
			// a pending mount's link leads nowhere, and still carries its id
			await Deno.symlink(".ermine/id/x9", `${dir}/Notes`)
			await sys.set(`${dir}/Notes`, attr.id, utf8.encode("x9"))
			assertEquals(await sys.get(`${dir}/Notes`, attr.id), utf8.encode("x9"))
		}),
})

Deno.test({
	name: "attribute calls on a missing entry are NotFound, with errno's code",
	ignore: !mac,
	fn: () =>
		within(async (dir) => {
			const sys = system({ home: dir })
			const missing = `${dir}/missing.txt`
			const e = await assertRejects(() => sys.get(missing, attr.id), Deno.errors.NotFound)
			assertEquals((e as { code?: string }).code, "ENOENT")
			assert(e.message.includes(missing))
			await assertRejects(
				() => sys.set(missing, attr.id, utf8.encode("x")),
				Deno.errors.NotFound,
			)
			await assertRejects(() => sys.unset(missing, attr.id), Deno.errors.NotFound)
			await assertRejects(() => sys.get(`${dir}/a\0b`, attr.id), TypeError)
		}),
})

Deno.test({
	name: "swap exchanges two entries in one step, attributes and ids with them",
	ignore: !mac,
	fn: () =>
		within(async (dir) => {
			const sys = system({ home: dir })
			const a = `${dir}/clock.txt`, b = `${dir}/tmp.1`
			await Deno.writeTextFile(a, "12:00")
			await Deno.writeTextFile(b, "13:00")
			await sys.set(a, attr.id, utf8.encode("old"))
			await sys.set(b, attr.id, utf8.encode("new"))
			const [ia, ib] = [await sys.id(a), await sys.id(b)]
			await sys.swap(b, a)
			assertEquals([await read(a), await read(b)], ["13:00", "12:00"])
			assertEquals(await sys.get(a, attr.id), utf8.encode("new"))
			assertEquals(await sys.get(b, attr.id), utf8.encode("old"))
			assertEquals([await sys.id(a), await sys.id(b)], [ib, ia])
			// a file and a folder, and a file and a link
			await Deno.mkdir(`${dir}/apps`)
			await Deno.writeTextFile(`${dir}/apps/x.txt`, "x")
			await sys.swap(a, `${dir}/apps`)
			assertEquals(await read(`${dir}/apps`), "13:00")
			assertEquals(await read(`${a}/x.txt`), "x")
			await Deno.symlink("apps", `${dir}/link`)
			await sys.swap(`${dir}/link`, b)
			assertEquals(await Deno.readLink(b), "apps")
			assertEquals(await read(`${dir}/link`), "12:00")
			// swapping with nothing is NotFound, and changes nothing
			await assertRejects(() => sys.swap(`${dir}/apps`, `${dir}/missing`), Deno.errors.NotFound)
			assertEquals(await read(`${dir}/apps`), "13:00")
		}),
})

disk("rename moves only into a free place", () =>
	within(async (dir) => {
		const sys = system({ home: dir })
		const a = `${dir}/a.txt`, b = `${dir}/b.txt`
		await Deno.writeTextFile(a, "a")
		await Deno.writeTextFile(b, "b")
		const ia = await sys.id(a)
		assertEquals(await sys.rename(a, b), "taken")
		assertEquals([await read(a), await read(b)], ["a", "b"])
		assertEquals(await sys.rename(a, `${dir}/c.txt`), "done")
		await gone(a)
		assertEquals(await read(`${dir}/c.txt`), "a")
		assertEquals(await sys.id(`${dir}/c.txt`), ia)
		// a folder, into a folder
		await Deno.mkdir(`${dir}/docs`)
		await Deno.mkdir(`${dir}/apps`)
		assertEquals(await sys.rename(`${dir}/docs`, `${dir}/apps`), "taken")
		assertEquals(await sys.rename(`${dir}/docs`, `${dir}/apps/docs`), "done")
		assertEquals(await names(`${dir}/apps`), ["docs"])
		// a link is taken, even one leading nowhere
		await Deno.symlink(".ermine/id/x9", `${dir}/Notes`)
		assertEquals(await sys.rename(`${dir}/c.txt`, `${dir}/Notes`), "taken")
		await assertRejects(() => sys.rename(`${dir}/missing`, `${dir}/d.txt`), Deno.errors.NotFound)
		await assertRejects(() => sys.rename(b, `${dir}/no/d.txt`), Deno.errors.NotFound)
	}))

disk(
	"clone copies a file, shares nothing written after, and never replaces",
	() =>
		within(async (dir) => {
			const sys = system({ home: dir })
			const kept = `${dir}/kept`, file = `${dir}/2.png`
			const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
			await Deno.writeFile(kept, png)
			await sys.clone(kept, file)
			assertEquals(await Deno.readFile(file), png)
			assertNotEquals(await sys.id(file), await sys.id(kept))
			await Deno.writeFile(file, new Uint8Array([1, 2, 3]))
			assertEquals(await Deno.readFile(kept), png)
			// a large one
			const big = new Uint8Array(1 << 20).map((_, i) => (i * 31) & 255)
			await Deno.writeFile(`${dir}/big`, big)
			await sys.clone(`${dir}/big`, `${dir}/big.bin`)
			assertEquals(await Deno.readFile(`${dir}/big.bin`), big)
			await assertRejects(() => sys.clone(kept, file), Deno.errors.AlreadyExists)
			assertEquals(await Deno.readFile(file), new Uint8Array([1, 2, 3]))
			await assertRejects(() => sys.clone(`${dir}/missing`, `${dir}/x`), Deno.errors.NotFound)
			await gone(`${dir}/x`)
		}),
)

disk("sync flushes a file and a folder", () =>
	within(async (dir) => {
		const sys = system({ home: dir })
		await Deno.writeTextFile(`${dir}/clock.txt`, "12:00")
		await sys.sync(`${dir}/clock.txt`)
		await sys.sync(dir)
		await assertRejects(() => sys.sync(`${dir}/missing`), Deno.errors.NotFound)
	}))

disk("id is the entry's own file id, kept across a rename", () =>
	within(async (dir) => {
		const sys = system({ home: dir })
		await Deno.writeTextFile(`${dir}/a.txt`, "a")
		await Deno.symlink("a.txt", `${dir}/link.txt`)
		const id = await sys.id(`${dir}/a.txt`)
		assertEquals(id, (await Deno.lstat(`${dir}/a.txt`)).ino)
		assertNotEquals(await sys.id(`${dir}/link.txt`), id)
		await Deno.rename(`${dir}/a.txt`, `${dir}/b.txt`)
		assertEquals(await sys.id(`${dir}/b.txt`), id)
		// a link leading nowhere has one too
		assert(await sys.id(`${dir}/link.txt`) > 0)
		await assertRejects(() => sys.id(`${dir}/a.txt`), Deno.errors.NotFound)
	}))

disk(
	"the fake trash moves each entry into its folder under a free name",
	() =>
		within(async (dir) => {
			const bin = `${dir}/bin`
			const trash = fake(bin)
			await Deno.writeTextFile(`${dir}/clock.txt`, "1")
			await trash(`${dir}/clock.txt`)
			await Deno.writeTextFile(`${dir}/clock.txt`, "2")
			await trash(`${dir}/clock.txt`)
			await Deno.mkdir(`${dir}/docs`)
			await Deno.writeTextFile(`${dir}/docs/1.txt`, "hello")
			await trash(`${dir}/docs`)
			await Deno.mkdir(`${dir}/docs`)
			await trash(`${dir}/docs`)
			await Deno.symlink(".ermine/id/x9", `${dir}/.hidden`)
			await trash(`${dir}/.hidden`)
			assertEquals(await names(dir), ["bin"])
			assertEquals(await names(bin), [".hidden", "clock 2.txt", "clock.txt", "docs", "docs 2"])
			assertEquals([await read(`${bin}/clock.txt`), await read(`${bin}/clock 2.txt`)], [
				"1",
				"2",
			])
			assertEquals(await read(`${bin}/docs/1.txt`), "hello")
			assertEquals(await Deno.readLink(`${bin}/.hidden`), ".ermine/id/x9")
			await assertRejects(() => trash(`${dir}/missing`), Deno.errors.NotFound)
		}),
)

Deno.test({
	name: "the trash of a given home is its .Trash, under a free name, attributes kept",
	ignore: !mac,
	fn: () =>
		within(async (dir) => {
			const home = `${dir}/home`, store = `${dir}/Store`
			await Deno.mkdir(`${home}/.Trash`, { recursive: true })
			await Deno.mkdir(store)
			const sys = system({ home })
			await Deno.writeTextFile(`${store}/clock.txt`, "12:30")
			await sys.set(`${store}/clock.txt`, attr.id, utf8.encode("c"))
			const id = await sys.id(`${store}/clock.txt`)
			await sys.trash(`${store}/clock.txt`)
			await Deno.writeTextFile(`${store}/clock.txt`, "13:00")
			await sys.trash(`${store}/clock.txt`)
			// a link goes itself; what it leads to stays
			await Deno.writeTextFile(`${store}/1.txt`, "hello")
			await Deno.symlink("1.txt", `${store}/pinned.txt`)
			await sys.trash(`${store}/pinned.txt`)
			assertEquals(await names(store), ["1.txt"])
			assertEquals(await names(`${home}/.Trash`), ["clock 2.txt", "clock.txt", "pinned.txt"])
			assertEquals(await read(`${home}/.Trash/clock.txt`), "12:30")
			assertEquals(await sys.get(`${home}/.Trash/clock.txt`, attr.id), utf8.encode("c"))
			assertEquals(await sys.id(`${home}/.Trash/clock.txt`), id)
			assertEquals(await Deno.readLink(`${home}/.Trash/pinned.txt`), "1.txt")
			await assertRejects(() => sys.trash(`${store}/missing`), Deno.errors.NotFound)
		}),
})

Deno.test({
	name: "an entry's own attributes are listed by name, never a link's target's",
	ignore: !mac,
	fn: () =>
		within(async (dir) => {
			const sys = system({ home: dir })
			const file = `${dir}/clock.txt`
			await Deno.writeTextFile(file, "12:00")
			await Deno.symlink("clock.txt", `${dir}/link.txt`)
			// macOS may add its own, as com.apple.provenance
			const own = async (path: string) =>
				(await sys.names(path)).filter((n) => n.startsWith(attr.own)).sort()
			assertEquals(await own(file), [])
			await sys.set(file, attr.id, utf8.encode("c"))
			await sys.set(file, attr.info + "color", utf8.encode("red"))
			assertEquals(await own(file), [attr.id, attr.info + "color"].sort())
			assertEquals(await own(`${dir}/link.txt`), [])
			await assertRejects(() => sys.names(`${dir}/none`), Deno.errors.NotFound)
		}),
})
