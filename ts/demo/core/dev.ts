// Builds the demo, serves it, and builds again when a file changes.

import { build } from "./build.ts";
import { build as buildD2 } from "../d2/build.ts";

const here = new URL(".", import.meta.url).pathname;
const port = Number(Deno.env.get("PORT") ?? 8317);
const types: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  wasm: "application/wasm",
  map: "application/json; charset=utf-8",
};

const d2 = new URL("../d2/", import.meta.url).pathname;
/** d2 at /d2/: its page, its style, and dist/ (subduction.wasm is share.js's "../subduction.wasm") */
function d2File(path: string): string | undefined {
  const rest = path.slice("/d2/".length);
  if (rest === "" || rest === "index.html") return `${d2}index.html`;
  if (rest === "style.css") return `${d2}style.css`;
  if (rest === "subduction.wasm") return `${d2}dist/subduction.wasm`;
  if (/^dist\/[\w.-]+$/.test(rest)) return `${d2}${rest}`;
}

await build();
await buildD2();
Deno.serve(
  { port, onListen: () => console.log(`ermine core: http://localhost:${port}/`) },
  async (req) => {
    let path = new URL(req.url).pathname;
    if (path === "/d2") return Response.redirect(new URL("/d2/", req.url), 301);
    if (path === "/") path = "/index.html";
    const file = path.startsWith("/d2/") ? d2File(path) : `${here}dist${path}`;
    try {
      if (!file) throw new Error("not found");
      const body = await Deno.readFile(file);
      return new Response(body, {
        headers: {
          "content-type": types[file.split(".").pop()!] ?? "application/octet-stream",
          "cache-control": "no-store",
        },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  },
);

let timer: ReturnType<typeof setTimeout> | undefined;
let core = false;
for await (
  const e of Deno.watchFs([
    `${here}src`,
    `${here}style.css`,
    `${here}index.html`,
    `${here}host`,
    `${here}../../src`,
    `${d2}src`,
    `${d2}index.html`,
    `${d2}style.css`,
  ])
) {
  if (e.paths.every((p) => p.includes("/dist/"))) continue;
  if (!e.paths.every((p) => p.startsWith(d2))) core = true;
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const both = core;
    core = false;
    if (both && await build()) console.log("rebuilt");
    if (await buildD2()) console.log("rebuilt d2");
  }, 120);
}
