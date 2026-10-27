// a stand-in for the browser's window.event, defined on the global before @ermine/system loads
// (userevent.ts keeps the native getter then): tests set `current` to say what is being dispatched
export const dispatching: { current: { isTrusted: boolean } | undefined } = { current: undefined }
Object.defineProperty(globalThis, "event", {
	get: () => dispatching.current,
	configurable: true,
})
