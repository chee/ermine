// Builds one browser module per layer into dist/, plain and minified.

const layers = ["graph", "protect", "drive"];

await Deno.remove("dist", { recursive: true }).catch(() => {});
for (const layer of layers) {
  for (const min of [false, true]) {
    const out = `dist/${layer}${min ? ".min" : ""}.js`;
    const args = ["bundle", "--quiet", "--platform", "browser", "--keep-names", "-o", out];
    if (min) args.push("--minify");
    args.push(`src/bundle/${layer}.ts`);
    const { code } = await new Deno.Command(Deno.execPath(), { args }).spawn().status;
    if (code !== 0) Deno.exit(code);
    console.log(out, (await Deno.stat(out)).size, "bytes");
  }
}
