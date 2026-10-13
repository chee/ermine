// things built on places from outside it, with nothing but what it exports: each would be nice in
// an api at some point (a handle's, or a library's over places), not in places itself
import type { Address, Item, Key, Places } from "./places.ts"

// the address from the start, then from each place the start was found in: every one's items,
// nearest first
export function lookups(p: Places, address: Address, from: Item): Item[] {
	const out: Item[] = []
	for (let at: Item | undefined = from; at; at = at.up) out.push(...p.get(address, at))
	return out
}

// every item under from (from included) whose value matches, depth first. value: the item's value,
// from wherever its parts are kept; an id already walked is not walked again, so a folder mounted
// inside itself ends
export function* matching(
	p: Places,
	value: (item: Item) => unknown,
	schema: (value: unknown) => boolean,
	from: Item,
): Generator<Item> {
	const seen = new Set<Key>()
	const stack = [from]
	while (stack.length) {
		const item = stack.pop()!
		if (seen.has(item.id)) continue
		seen.add(item.id)
		if (schema(value(item))) yield item
		for (const name of p.names(item)) stack.push(...p.get([name], item))
	}
}
