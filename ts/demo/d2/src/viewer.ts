// The viewer of a mount: /d2/#mount=<channel>. It joins the channel through
// share.js and draws what awaited reads over the link return: the served
// tree, and hello's note, which it edits. It lives in d2.js so that its
// writes carry a site there (share.js is ermine's own, all of it).

import type { SlotItem, ValueItem } from "d2/ermine";
import type { Remote } from "./share.ts";

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The viewer: mounts the channel and draws what reads over it return. */
export async function view(
  name: string,
  root: HTMLElement,
  join: (name: string) => Promise<Remote>,
) {
  root.innerHTML = `<div class="viewer"><h1>mounting ${esc(name.slice(0, 12))}…</h1></div>`;
  let remote: Remote;
  try {
    remote = await join(name);
  } catch (e) {
    root.innerHTML = `<div class="viewer"><h1>could not mount</h1><p>${esc(String(e))}</p></div>`;
    return;
  }
  // the owner stamps it {actor: "viewer", peer: this mount's key}; a map here would nest
  const agent = "viewer";
  const box = root.querySelector(".viewer")!;
  box.innerHTML = `
    <h1>a mount of someone's /desk</h1>
    <p class="muted">Every line below is an awaited read over the link. Changes you make are made
    by the owner's stack, stamped there, as {actor: "viewer", peer: your key}.</p>
    <label>cards/hello/text<textarea id="note"></textarea></label>
    <p id="said" class="muted"></p>
    <ul id="tree" class="viewer-tree"></ul>`;
  const note = box.querySelector<HTMLTextAreaElement>("#note")!;
  const said = box.querySelector<HTMLElement>("#said")!;
  const tree = box.querySelector<HTMLElement>("#tree")!;

  async function showNote() {
    const [item] = await remote.read({ agent, address: ["cards", "hello", "text"] });
    // what the person is typing is not overwritten; the next answer catches up
    if (item && note.value !== item.value && document.activeElement !== note) {
      note.value = String(item.value);
    }
    const c = item?.change;
    said.textContent = c ? `t=${c.time} · ${c.kind} · ${JSON.stringify(c.agent)}` : "";
  }
  async function walk(path: string[], depth: number): Promise<string> {
    if (depth > 4) return "";
    const listing = await remote.directory({ agent, address: path });
    if (!("directory" in listing)) return "";
    let out = "";
    for (const [n, items] of listing.directory as [string, SlotItem[]][]) {
      if (n.startsWith("@")) continue;
      let v: ValueItem | undefined;
      try {
        [v] = await remote.read({ agent, address: [...path, n] });
      } catch { /* refused or gone */ }
      const shown = v === undefined ? "" : JSON.stringify(v.value)?.slice(0, 60) ?? "";
      out += `<li><b>${esc(n)}</b>${items.length > 1 ? ` <i>(${items.length})</i>` : ""} <code>${
        esc(shown)
      }</code><ul>${await walk([...path, n], depth + 1)}</ul></li>`;
    }
    return out;
  }
  // one write in flight at a time, each the text as it is when sent: the link may reorder
  let sending: Promise<unknown> = Promise.resolve();
  let queued = false;
  note.addEventListener("input", () => {
    if (queued) return;
    queued = true;
    sending = sending.then(() => {
      queued = false;
      return remote.write({
        agent,
        address: ["cards", "hello", "text"],
        patches: [{ type: "snapshot", value: note.value }],
      });
    }).catch((e) => (said.textContent = `not written: ${e}`));
  });
  note.addEventListener("blur", () => void showNote());
  await remote.subscribe({
    agent,
    address: ["cards", "hello", "text"],
    send: () => void showNote(),
  });
  await showNote();
  tree.innerHTML = await walk([], 0);
}
