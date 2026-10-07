// "ermine", as a program imports it: the import map in index.html (and
// ts/deno.json, for the headless test) maps the name here. The page that runs
// the demo holds the library; this hands on what a program may want of it.
const e = globalThis.__ermineDemo.ermine;
export const PENDING = e.PENDING;
export const equal = e.equal;
export const applyPatch = e.applyPatch;
export const applyPatches = e.applyPatches;
export const codePoints = e.codePoints;
export const parseAddress = e.parseAddress;
export const isBytes = e.isBytes;
export const isLive = e.isLive;
export const kindOf = e.kindOf;
export const errorJson = e.errorJson;
export const ErmineError = e.ErmineError;
export const Invalid = e.Invalid;
export const Refused = e.Refused;
export const Thrown = e.Thrown;
