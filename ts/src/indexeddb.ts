// A keeper's backend in the browser: one IndexedDB database with one object
// store, "records", whose keys are the records' keys. A write is one
// transaction, so its sets and deletes happen together or not at all.

import type { Backend } from "./keeper.ts";
import { ours } from "./types.ts";

ours(import.meta.url);

// The little of IndexedDB this uses, so it type checks without the DOM's types.
type Req<T> = {
  result: T;
  error: unknown;
  onsuccess: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
};
type Cursor = { key: unknown; value: unknown; continue(): void };
type Store = {
  put(value: unknown, key: string): unknown;
  delete(key: string): unknown;
  clear(): unknown;
  openCursor(): Req<Cursor | null>;
};
type Tx = {
  objectStore(name: string): Store;
  oncomplete: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onabort: ((e: unknown) => void) | null;
  error: unknown;
};
type Db = {
  transaction(store: string, mode: "readonly" | "readwrite"): Tx;
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): unknown;
  close(): void;
};
type Open = Req<Db> & { onupgradeneeded: ((e: unknown) => void) | null; onblocked: unknown };
/** An IDBFactory, such as globalThis.indexedDB. */
export type Factory = { open(name: string, version?: number): unknown };

const STORE = "records";

/** A backend keeping its records in the IndexedDB database of that name. */
export function indexeddb(
  name: string,
  factory: Factory = (globalThis as { indexedDB?: Factory }).indexedDB!,
): Backend & { close(): void } {
  let db: Promise<Db> | undefined;
  const opened = () =>
    db ??= new Promise<Db>((resolve, reject) => {
      if (!factory) return reject(new Error("there is no IndexedDB here"));
      const req = factory.open(name, 1) as Open;
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

  const done = (tx: Tx) =>
    new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("the transaction was aborted"));
    });

  return {
    async read() {
      const tx = (await opened()).transaction(STORE, "readonly");
      const out = new Map<string, Uint8Array>();
      const req = tx.objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        const v = cursor.value;
        out.set(
          String(cursor.key),
          v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer),
        );
        cursor.continue();
      };
      await done(tx);
      return out;
    },
    async write(batch, whole) {
      const tx = (await opened()).transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      if (whole) store.clear();
      for (const [k, v] of batch) v === null ? store.delete(k) : store.put(v.slice(), k);
      await done(tx);
    },
    close() {
      db?.then((d) => d.close(), () => {});
      db = undefined;
    },
  };
}
