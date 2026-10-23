// The panel's only way into the page: devtools' inspectedWindow.eval. Firefox
// and Safari give `browser`, whose eval returns a promise of [result, thrown];
// Chrome gives `chrome`, whose eval takes a callback. Chrome has `browser` too
// now, its eval's promise the result alone: Chrome (told by userAgentData,
// which Firefox and Safari lack) takes the callback.

type Thrown = {
  isException?: boolean;
  isError?: boolean;
  value?: unknown;
  description?: string;
};

// deno-lint-ignore no-explicit-any
const g = globalThis as any;
export const ext = g.browser ?? g.chrome;

function fail(ex: Thrown): Error {
  return new Error(String(ex.value ?? ex.description ?? JSON.stringify(ex)));
}

export function evaluate<T>(code: string): Promise<T> {
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

/** A call on the page's agent, its arguments as JSON. */
export function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const list = args.map((a) => JSON.stringify(a)).join(", ");
  return evaluate<T>(`globalThis.__ermine_devtools?.${method}(${list})`);
}

/** The devtools theme: "dark", or "default" for light. */
export const theme = (): string | undefined => ext.devtools?.panels?.themeName;
