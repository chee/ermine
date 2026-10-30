// A log's store on disk (deno). Records are appended to dir/log as frames (4-byte big-endian
// length, then the record); a frame cut short by a crash is cut off on load.
import { createIndex, type Store } from "./log.ts"

const framed = (steps: Uint8Array[]) => {
	const out = new Uint8Array(steps.reduce((k, s) => k + 4 + s.length, 0))
	const view = new DataView(out.buffer)
	let at = 0
	for (const s of steps) view.setUint32(at, s.length), out.set(s, at + 4), at += 4 + s.length
	return out
}
const frames = (bytes: Uint8Array) => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out = []
	let at = 0
	// A zero length is a tail that was never written (a power cut) and ends the log.
	while (
		at + 4 <= bytes.length && view.getUint32(at) > 0 &&
		at + 4 + view.getUint32(at) <= bytes.length
	) {
		const size = view.getUint32(at)
		out.push({ at: at + 4, record: bytes.slice(at + 4, at + 4 + size) })
		at += 4 + size
	}
	return { frames: out, end: at }
}

async function synced(path: string) {
	const f = await Deno.open(path, { write: true })
	await f.syncData().finally(() => f.close())
}

export function fileStore(dir: string): Store {
	const records = `${dir}/log`, snap = `${dir}/snapshot`, keyfile = `${dir}/key`
	const opens = `${dir}/open`
	let made: Promise<void> | undefined
	const ready = () => made ??= Deno.mkdir(dir, { recursive: true })
	const read = (path: string) =>
		Deno.readFile(path).catch((e) => {
			if (e instanceof Deno.errors.NotFound) return undefined
			throw e
		})
	const written = new Map<number, Uint8Array>()
	let end = 0
	let writing: Promise<unknown> = Promise.resolve()
	let file: Deno.FsFile | undefined
	let filed = { first: 0, count: 0 }, dirty = false
	const index = createIndex<[number, number]>(([at, size]) => {
		const unwritten = written.get(at)
		if (unwritten) return unwritten
		const out = new Uint8Array(size)
		file ??= Deno.openSync(records)
		file.seekSync(at, Deno.SeekMode.Start)
		for (let got = 0; got < out.length;) {
			const n = file.readSync(out.subarray(got))
			if (n === null) throw new Error("the store's file is shorter than it was")
			got += n
		}
		return out
	})

	return {
		async load(each) {
			const bytes = await read(records) ?? new Uint8Array()
			index.clear()
			const log = frames(bytes)
			for (const { at, record } of log.frames) {
				const held = each(record)
				if (held) index.hold(held, [at, record.length])
			}
			if (log.end < bytes.length) await Deno.truncate(records, log.end)
			end = log.end
			const open = await read(opens) ?? new Uint8Array(), o = frames(open)
			filed = { first: 0, count: 0 }, dirty = false
			for (const { record } of o.frames) {
				const held = each(record)
				if (!held) dirty = true
				else {
					index.open(record, held)
					if (!filed.count) filed.first = held[1]
					filed.count++
				}
			}
			if (o.end < open.length) {
				await Deno.truncate(opens, o.end)
				const f = await Deno.open(opens, { write: true })
				await f.syncData().finally(() => f.close())
			}
			return await read(snap)
		},
		open: index.open,
		append(record, held) {
			const frame = new Uint8Array(4 + record.length), at = end + 4
			new DataView(frame.buffer).setUint32(0, record.length)
			frame.set(record, 4)
			if (held) index.hold(held, [at, record.length]), written.set(at, record)
			end += frame.length
			writing = writing.catch(() => {}).then(async () => {
				await ready()
				await Deno.writeFile(records, frame, { append: true })
				written.delete(at)
			})
			return writing as Promise<void>
		},
		run: index.run,
		get: index.get,
		drop: index.drop,
		async snapshot(bytes) {
			await ready()
			await Deno.writeFile(`${snap}.new`, bytes)
			await synced(`${snap}.new`)
			await Deno.rename(`${snap}.new`, snap)
		},
		async key(seed) {
			await ready()
			try {
				await Deno.writeFile(keyfile, seed, { createNew: true, mode: 0o600 })
				await synced(keyfile)
				return seed
			} catch (e) {
				if (!(e instanceof Deno.errors.AlreadyExists)) throw e
				const key = await Deno.readFile(keyfile)
				if (key.length !== 32) throw new Error(`${keyfile} is not a key`)
				return key
			}
		},
		sync() {
			const p = writing.catch(() => {}).then(async () => {
				if (end) {
					const f = await Deno.open(records, { write: true })
					await f.syncData().finally(() => f.close())
				}
				const o = index.opened(), steps = o?.steps ?? []
				const first = steps.length ? o!.first : Infinity
				const stale = dirty || (filed.count > 0 && filed.first < first)
				const empty = stale && !(filed.count > 0 && filed.first + filed.count > first)
				if (empty) filed = { first, count: 0 }, dirty = false
				else if (!filed.count) filed.first = first
				const write = steps.slice(Math.max(0, filed.first + filed.count - first))
				if (!write.length && !empty) return
				await ready()
				await Deno.writeFile(opens, framed(write), { append: !empty })
				const g = await Deno.open(opens, { write: true })
				await g.syncData().finally(() => g.close())
				filed.count += write.length
			})
			writing = p
			return p
		},
		close() {
			file?.close()
			file = undefined
		},
	}
}
