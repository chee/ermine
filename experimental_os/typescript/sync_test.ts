// sync_test.ts: two headless ermine machines, each with its own SD card and
// device key, share a folder through a Subduction server on this machine
// (layers/link/typescript/deno/server.ts, which holds commits while it runs).
// A shares a folder and makes a note in it; B mounts it and reads the note;
// each writes it and the other reads the write; A powers off and boots again
// on its card, has the note as it was, and its next write reaches B. Then
// what is not a document: a process in the shared folder is seen on B, live,
// and goes when it ends; A shares /, which is not a document, as a view, and B
// reads A's whole tree under /n/mac1, with no id on A changed, and B's writes
// there never reach A; A shares /dev, and B sees a USB stick come and go and
// a terminal's window open.
//
//   deno test -A experimental_os/typescript/sync_test.ts
//
// SYNC_SERVER=wss://… runs it through another server instead.

import { assert, assertMatch } from "@std/assert";
import { server } from "../../layers/link/typescript/deno/server.ts";

const MAIN = new URL("./main.ts", import.meta.url).pathname;
// the line's colours, ESC [ ... m, and its carriage returns
// deno-lint-ignore no-control-regex
const strip = (t: string) => t.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");
const began = Date.now();
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** One headless machine: its serial line, a command at a time. */
class Machine {
  #child: Deno.ChildProcess;
  #writer: WritableStreamDefaultWriter<Uint8Array>;
  out = "";
  exited: Promise<Deno.CommandStatus>;

  constructor(readonly name: string, sd: string, fresh: boolean) {
    const child = this.#child = new Deno.Command("deno", {
      args: ["run", "-A", MAIN, "--headless", ...(fresh ? ["--fresh"] : []), "--sd", sd],
      stdin: "piped",
      stdout: "piped",
      stderr: "null",
    }).spawn();
    this.#writer = this.#child.stdin.getWriter();
    this.exited = this.#child.status;
    (async () => {
      for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) this.out += strip(chunk);
    })();
  }

  /** Waits for re in what the line says after `from`. */
  async until(re: RegExp, from = 0, ms = 30000): Promise<string> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const said = this.out.slice(from);
      if (re.test(said)) return said;
      await sleep(50);
    }
    throw new Error(`${this.name}: no ${re} in ${JSON.stringify(this.out.slice(from).slice(-600))}`);
  }

  /** Types a line, and gives what came back before the next prompt. */
  async type(line: string): Promise<string> {
    const from = this.out.length;
    await this.#writer.write(new TextEncoder().encode(line + "\n"));
    const said = await this.until(/\ndev> $/, from);
    const answer = said.slice(said.indexOf("\n") + 1, said.lastIndexOf("\ndev> "));
    console.log(`${((Date.now() - began) / 1000).toFixed(1).padStart(5)}s ${this.name}> ${line}\n${answer.split("\n").map((l) => "    " + l).join("\n")}`);
    return answer;
  }

  /** A hand on the machine: a line starting "!", which no prompt follows. */
  async hand(line: string) {
    console.log(`${((Date.now() - began) / 1000).toFixed(1).padStart(5)}s ${this.name}> ${line}`);
    await this.#writer.write(new TextEncoder().encode(line + "\n"));
    await sleep(400);
  }

  /** Types a line until what comes back matches (or, with not, stops matching), or ms pass. */
  async poll(line: string, re: RegExp, ms = 30000, not = false): Promise<string> {
    const end = Date.now() + ms;
    for (;;) {
      const said = await this.type(line);
      if (re.test(said) !== not) return said;
      if (Date.now() > end) throw new Error(`${this.name}: ${line} never gave ${re}; last ${JSON.stringify(said)}`);
      await sleep(500);
    }
  }

  async off() {
    await this.#writer.write(new TextEncoder().encode("off\n"));
    await this.#writer.close().catch(() => {});
    await this.exited;
  }
}

Deno.test({
  name: "two machines share a folder",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const own = Deno.env.get("SYNC_SERVER") ? undefined : await server({ port: 0 });
    const url = Deno.env.get("SYNC_SERVER") ?? own!.url;
    const dir = await Deno.makeTempDir({ prefix: "ermine-sync-" });
    console.log(`server ${url}; cards in ${dir}`);
    let a = new Machine("A", `${dir}/a`, true);
    const b = new Machine("B", `${dir}/b`, true);
    try {
      await a.until(/dev> $/);
      await b.until(/dev> $/);
      for (const m of [a, b]) await m.type(`write /etc/sync {"server":"${url}"}`);

      // A shares a folder and makes a note in it
      const shared = await a.type("share /apps/notes");
      const id = /ermine:\/\/[0-9a-f]{64}/.exec(shared)?.[0];
      assert(id, "share printed no id");
      await a.type(`mk /apps/notes/todo "buy milk"`);

      // B mounts it, and the note comes
      await b.type(`mount /apps/notes ${id}`);
      await b.poll("cat /apps/notes/todo", /^"buy milk"$/m);
      await b.type("ls /apps/notes");

      // a write on each shows on the other
      await b.type(`write /apps/notes/todo "oat milk"`);
      await a.poll("cat /apps/notes/todo", /^"oat milk"$/m);
      await a.type(`write /apps/notes {"done":true}`);
      await b.poll("cat /apps/notes", /"done":true/);
      await a.type("cat /dev/sync/link");
      await b.type("cat /dev/sync/@*");

      // A powers off and boots again on its card: the note is as it was, and its next write reaches B
      await a.off();
      a = new Machine("A", `${dir}/a`, false);
      await a.until(/dev> $/);
      assertMatch(await a.type("cat /apps/notes/todo"), /^"oat milk"$/m);
      assertMatch(await a.type("ls /apps/notes"), /^todo [^\n]*\n?$/);
      assertMatch(await a.type("cat /dev/sync/@*"), /"refused":\[\],"waiting":\[\],"stuck":\[\]/);
      await a.type(`write /apps/notes/todo "after a reboot"`);
      await b.poll("cat /apps/notes/todo", /^"after a reboot"$/m);
      await a.poll("cat /dev/sync/link", /"connected":true/);
      await b.type("why /apps/notes/todo");

      // a removal reaches the other machine
      await a.type("rm /apps/notes/todo");
      await b.poll("ls /apps/notes", /^$/);

      // a process in the shared folder: its node is ephemeral, shown on B live, read there, never run there
      await a.type(`mk /programs/seven "export default () => 7"`);
      const pid = /@\d+-[a-z]+/.exec(await a.type("start /apps/notes programs/seven"))?.[0];
      assert(pid, "start printed no pid");
      await b.poll(`cat /apps/notes/${pid}`, /^7$/m);
      await a.type(`kill ${pid}`);
      await b.poll("ls /apps/notes", /^$/);

      // the root is no document: shared, it is shown as a view, and no id on A changes
      const root = /ermine:\/\/[0-9a-f]{64}/.exec(await a.type("share /"))?.[0];
      assert(root, "share / printed no id");
      await b.type(`mount /n/mac1 ${root}`);
      await b.poll("cat /n/mac1/etc/desktop", /"background"/);
      await b.poll("ls /n/mac1/proc", /^@\d+-/m);
      await b.type("ls /n/mac1");
      // a write on B to A's tree stays on B: A's rules are as they were, and still name A's own ids
      await b.type(`write /n/mac1/etc/rules []`);
      await sleep(1500);
      assertMatch(await a.type("cat /etc/rules"), /"program":"drv-power"/);
      assertMatch(await a.type("ls /drivers"), /drv-power/);

      // /dev: the devices and the windows, changing on A, seen on B
      const dev = /ermine:\/\/[0-9a-f]{64}/.exec(await a.type("share /dev"))?.[0];
      assert(dev, "share /dev printed no id");
      await b.type(`mount /n/a-dev ${dev}`);
      await b.poll("ls /n/a-dev/kbd", /^state /m);
      await a.hand("!usb attach 42 SanDisk");
      await b.poll("ls /n/a-dev/usb", /sandisk/);
      await a.hand("!usb detach 42");
      await b.poll("ls /n/a-dev/usb", /sandisk/, 30000, true);
      const windows = (said: string) => (said.match(/^term-/gm) ?? []).length;
      const before = windows(await b.poll("ls /n/a-dev/display/layers", /^term-/m));
      // a window: a terminal started as the window manager starts one, not by its key, which may change
      await a.type("start /apps/term programs/term");
      // one more window than before: before + 1 lines naming a term's layer
      await b.poll("ls /n/a-dev/display/layers", new RegExp(Array(before + 1).fill("term-").join("[\\s\\S]*")));
      await a.type("cat /dev/sync/link");
    } finally {
      await a.off().catch(() => {});
      await b.off().catch(() => {});
      await own?.close();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
