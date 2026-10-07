// "demo", as a program imports it: this host. screen(self) is the element a
// process's effect draws on; h(tag, props, ...children) builds an element;
// fire(process, handler, input?) fires a handler from the world, as the acting
// agent. Each asks the page's world when it is called, so a world made again
// is the one asked.
const host = () => globalThis.__ermineDemo.demo;
export const h = (...a) => host().h(...a);
export const screen = (...a) => host().screen(...a);
export const fire = (...a) => host().fire(...a);
// key(self) is the key the host hands a process beneath protect, if it hands
// it one; load(code) makes a module's source, as the host loads an api, into
// its default export
export const key = (...a) => host().key(...a);
export const load = (...a) => host().load(...a);
