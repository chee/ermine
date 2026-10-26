// The panel's only way into the page: devtools' inspectedWindow.eval. Firefox
// and Safari give `browser`, whose eval returns a promise of [result, thrown];
// Chrome gives `chrome`, whose eval takes a callback. Chrome has `browser` too
// now, its eval's promise the result alone: Chrome (told by userAgentData,
// which Firefox and Safari lack) takes the callback.
//
// Safari (WebKit with site isolation, as Safari 27 runs): a panel may not eval. The
// panel runs in Web Inspector's own process, which WebKit does not trust with
// inspectedWindow.eval, and Safari kills that process for asking: Web Inspector
// closes. The devtools page runs in its own trusted process and may eval. So in
// WebKit the devtools page makes the panel with a key in its address, and the
// panel's evals go to that page as runtime messages carrying the key; the page
// evaluates and replies. A key per devtools page: with two inspectors open,
// each panel reaches its own.

type Thrown = {
	isException?: boolean;
	isError?: boolean;
	value?: unknown;
	description?: string;
};

/** an eval the panel hands to its devtools page, and the reply */
type Relayed = { ermine: "eval"; key: string; code: string };
type Reply = { ok?: unknown; error?: string };

// deno-lint-ignore no-explicit-any
const g = globalThis as any;
export const ext = g.browser ?? g.chrome;

/** the panel's devtools page's key, when its evals go through that page */
const relay = new URLSearchParams(g.location?.search ?? "").get("relay");

function fail(ex: Thrown): Error {
	return new Error(String(ex.value ?? ex.description ?? JSON.stringify(ex)));
}

/** inspectedWindow.eval itself */
function inspect<T>(code: string): Promise<T> {
	if (g.browser && !g.navigator?.userAgentData) {
		const ie = g.browser.devtools.inspectedWindow;
		return ie.eval(code).then(([result, ex]: [T, Thrown | undefined]) => {
			if (ex && (ex.isException || ex.isError)) throw fail(ex);
			return result;
		});
	}
	const ie = (g.chrome ?? ext).devtools.inspectedWindow;
	return new Promise((resolve, reject) => {
		ie.eval(code, (result: T, ex?: Thrown) => {
			if (ex && (ex.isException || ex.isError)) reject(fail(ex));
			else resolve(result);
		});
	});
}

export function evaluate<T>(code: string): Promise<T> {
	if (!relay) return inspect<T>(code);
	const ask: Relayed = { ermine: "eval", key: relay, code };
	return ext.runtime.sendMessage(ask).then((r: Reply | undefined) => {
		if (!r || typeof r !== "object") throw new Error("the devtools page did not answer");
		if (r.error !== undefined) throw new Error(r.error);
		return r.ok as T;
	});
}

/** A call on the page's agent, its arguments as JSON. */
export function call<T>(method: string, ...args: unknown[]): Promise<T> {
	const list = args.map((a) => JSON.stringify(a)).join(", ");
	return evaluate<T>(`globalThis.__ermine_devtools?.${method}(${list})`);
}

/** WebKit's extension pages: Safari's, and WebKit's own default */
const webkit = ["safari-web-extension:", "webkit-extension:"];

/** For the devtools page: the panel's address. In WebKit it carries this page's key, and this
 * page answers that panel's evals. */
export function panelPage(): string {
	if (!webkit.includes(g.location?.protocol)) return "panel.html";
	const key = Array.from(
		crypto.getRandomValues(new Uint8Array(8)),
		(b) => b.toString(16).padStart(2, "0"),
	)
		.join("");
	ext.runtime.onMessage.addListener(
		(m: Relayed | undefined, _sender: unknown, reply: (r: Reply) => void) => {
			if (m?.ermine !== "eval" || m.key !== key) return;
			inspect(m.code).then(
				(ok) => reply({ ok }),
				(e) => reply({ error: plain(String((e as Error)?.message ?? e)) }),
			);
			return true;
		},
	);
	return `panel.html?relay=${key}`;
}

/** how a refused eval begins: Safari has not let the extension onto the inspected site */
export const REFUSED = "Safari has not allowed ermine devtools on this site.";

/** Safari's refusal, said as what to do */
function plain(error: string): string {
	if (!/does not have access to this tab/i.test(error)) return error;
	return `${REFUSED} Allow it when Safari asks, or in Safari › Settings › Websites › ` +
		"ermine devtools: set this site to Allow.";
}

/** The devtools theme: "dark", or "default" for light. */
export const theme = (): string | undefined => ext.devtools?.panels?.themeName;
