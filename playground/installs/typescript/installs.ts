// installs: who this install is, the same on every start. an install is a key pair and the store
// it is saved in (a browser profile, an app's install, the cardputer), stable across restarts; a
// machine may have many. it has one root. what it is called: its key, as an ermine id
// ("ermine:ed01" + the key's hex), never chosen.
//
//   const install = await openInstall(store, ed25519)   // ed25519: a secret's public key, below
//   install.id      // "ermine:ed01…", the same every time this store is opened
//   install.root    // "ermine:0010…", made the first time (or the root given then)
//
// the store holds two things: "secret" (32 bytes) and "root" (an ermine id's bytes). the first open
// of an empty store makes both and writes them; every later open reads them. what is stored is
// never made again: a secret not 32 bytes, or a root that is no ermine id, throws (a new secret
// would be a new install, and everything the old one signed another's).
// two opens of an empty store at once each make a secret: the host opens one at a time (a lock).
// signing is the host's, with the secret (together's createSigner(secret) is one); an install is
// only who
import { bytes, fresh, kind, text } from "@ermine/ids"

export type Store = {
	read: (
		name: string,
	) => Uint8Array | undefined | Promise<Uint8Array | undefined>
	write: (name: string, bytes: Uint8Array) => void | Promise<void>
}

// how a secret's Ed25519 public key (32 bytes) is worked out: ed25519 below, or the host's own
export type PublicKeyOf = (secret: Uint8Array) => Uint8Array | Promise<Uint8Array>

export type Install = {
	readonly id: string
	// the public key, 32 bytes
	readonly key: Uint8Array
	readonly secret: Uint8Array
	readonly root: string
}

export const SECRET = "secret"
export const ROOT = "root"

// root: the root an empty store's install has (none: a fresh id); a store with a root keeps its
// own. everything is read and checked before anything is written, so an error leaves the store as
// it was
export async function openInstall(
	store: Store,
	publicKeyOf: PublicKeyOf,
	options: { root?: string } = {},
): Promise<Install> {
	const given = options.root === undefined ? undefined : bytes(options.root)
	if (options.root !== undefined && given === undefined) {
		throw new Error("the root given is not an ermine id")
	}
	let secret = await store.read(SECRET)
	if (secret !== undefined && secret.length !== 32) {
		throw new Error("the stored secret is not 32 bytes")
	}
	let root = await store.read(ROOT)
	if (root !== undefined && kind(root) === undefined) {
		throw new Error("the stored root is not an ermine id")
	}
	const made = { secret: secret === undefined, root: root === undefined }
	secret ??= crypto.getRandomValues(new Uint8Array(32))
	root ??= given ?? fresh()
	const key = await publicKeyOf(secret)
	if (key.length !== 32) throw new Error("an Ed25519 public key is 32 bytes")
	if (made.secret) await store.write(SECRET, secret)
	if (made.root) await store.write(ROOT, root)
	return { id: text(Uint8Array.of(0xed, 0x01, ...key))!, key, secret, root: text(root)! }
}

// a PublicKeyOf through WebCrypto (every browser, Deno and Node): the secret as an Ed25519 seed, wrapped as
// PKCS#8 (RFC 8410) to import, its public half read from the JWK
const PKCS8 = Uint8Array.of(
	0x30,
	0x2e,
	0x02,
	0x01,
	0x00,
	0x30,
	0x05,
	0x06,
	0x03,
	0x2b,
	0x65,
	0x70,
	0x04,
	0x22,
	0x04,
	0x20,
)

export async function ed25519(secret: Uint8Array): Promise<Uint8Array> {
	const der = new Uint8Array([...PKCS8, ...secret])
	const k = await crypto.subtle.importKey(
		"pkcs8",
		der,
		{ name: "Ed25519" },
		true,
		["sign"],
	)
	const x = (await crypto.subtle.exportKey("jwk", k)).x!
	const b64 = x.replace(/-/g, "+").replace(/_/g, "/").padEnd(
		Math.ceil(x.length / 4) * 4,
		"=",
	)
	return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}
