// Share, built apart as dist/share.js and imported only when asked for.
//
// The owner serves /desk on a fresh channel over Subduction's ephemeral
// messages (wss://galaxy.observer): a mounter's operations are made against
// this page's scheduler, at /desk, chrooted there, each change stamped here,
// and its agent becomes {actor, peer}, so the feed says who and from where.
//
// A viewer (/d2/#mount=<channel>, viewer.ts, in d2.js) joins it. A mount is
// a Remote, whose every operation is a promise, so it is not an Interface:
// nothing can be wrapped, bound or run as a process over it.
//
// The viewer's own code is in d2.js, not here: every file of this bundle is
// ermine's (ours), so a write made from code in it would find no site.

import { serve } from "../../../src/link/serve.ts";
import { mount, type Remote } from "../../../src/link/mount.ts";
import { subduction } from "../../../src/link/subduction.ts";
import { channel, type Transport } from "../../../src/link/wire.ts";
import type { Interface } from "../../../src/types.ts";

/** Serves /desk of the stack on a new channel; gives the channel and a way to stop. */
export async function share(
  api: Interface,
  open: (name: string) => Promise<Transport> = subduction,
): Promise<{ channel: string; close(): Promise<void> }> {
  const name = channel();
  const transport = await open(name);
  // serve stamps each request's agent as {actor: what the mounter claimed, peer: its key}
  const served = serve(api, ["desk"], transport);
  return { channel: name, close: () => served.close() };
}

/** Mounts a channel: a Remote, every operation a promise. */
export async function join(
  name: string,
  open: (name: string) => Promise<Transport> = subduction,
): Promise<Remote> {
  return await mount(await open(name));
}

export type { Remote };
