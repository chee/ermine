import { createHost } from "./host_harness.ts"
Deno.test({ name: "probe", sanitizeOps: false, sanitizeResources: false, async fn() {
	const ROOM = "ermine:0010bf04115f9b284145026eab6801219d6e"
	const host = await createHost("probe")
	await host.device.connectDiscover("wss://galaxy.observer")
	await host.sync.follow(ROOM)
	await new Promise((r) => setTimeout(r, 15000))
	const h = host.device.history(ROOM)
	console.log("all", h.all().length, "heads", h.heads().length, "refused", JSON.stringify(h.refused().slice(-3)))
	for (const p of ["value", "attributes", "children"]) console.log(p, JSON.stringify(host.table.get(p, ROOM)?.value))
	await host.close()
}})
