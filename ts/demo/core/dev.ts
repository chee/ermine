// Builds the demo, serves it, and builds again when a file changes.

import { build } from "./build.ts";

const here = new URL(".", import.meta.url).pathname;
const port = Number(Deno.env.get("PORT") ?? 8317);
const types: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
};

await build();
Deno.serve(
  { port, onListen: () => console.log(`ermine core: http://localhost:${port}/`) },
  async (req) => {
    let path = new URL(req.url).pathname;
    if (path === "/") path = "/index.html";
    try {
      const body = await Deno.readFile(`${here}dist${path}`);
      return new Response(body, {
        headers: {
          "content-type": types[path.split(".").pop()!] ?? "application/octet-stream",
          "cache-control": "no-store",
        },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  },
);

let timer: ReturnType<typeof setTimeout> | undefined;
for await (
  const e of Deno.watchFs([
    `${here}src`,
    `${here}style.css`,
    `${here}index.html`,
    `${here}../../src`,
  ])
) {
  if (e.paths.every((p) => p.includes("/dist/"))) continue;
  clearTimeout(timer);
  timer = setTimeout(async () => {
    if (await build()) console.log("rebuilt");
  }, 120);
}
