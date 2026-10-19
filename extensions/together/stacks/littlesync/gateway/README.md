# littlesync gateway

littlesync devices (`../littlesync.h`) in rooms on a Subduction server (wss://galaxy.observer). A
Deno process: each WebSocket connection at `/littlesync` is one littlesync link (binary messages
carry the byte stream, frames as on a serial line); inside, one together device (the mailroom and
the subduction stack, memory storage) is a Subduction peer of the upstream server. Nothing is stored
here: the server holds everything, and a node is pulled again once a device names it after a start.
The plan: `../../../../../../ermine-plans/extensions/together/bridge.org`.

## run

    make run                     # deno run --allow-net --allow-env --allow-read ... main.ts
    PORT=9000 UPSTREAM=ws://localhost:8080 UPSTREAM_SERVICE=ermine make run

| env                | default               | what                                                                              |
| ------------------ | --------------------- | --------------------------------------------------------------------------------- |
| `PORT`             | 8080                  | where `/littlesync` and `/` listen                                                |
| `UPSTREAM`         | wss://galaxy.observer | the Subduction server                                                             |
| `UPSTREAM_SERVICE` | its url's host        | the server's service name when it isn't the host (local subduction_cli: `ermine`) |
| `GATEWAY_SEED`     | a new key each start  | 64 hex: the gateway's key (Subduction peer, and the ephemerals it makes)          |
| `QUIET`            |                       | `1`: no protocol log lines                                                        |

`GET /` gives the counts (`Stats` in gateway.ts), the nodes followed and the last refusals, as JSON.
The log has one line per thing that happens: forwarded, refused (with the reason), waiting, merge,
can't send.

A device reaches it over WiFi (ESP-IDF's WebSocket client) or through a Mac (a relay from the serial
port to the WebSocket: galaxy_test.ts's `cPeer` does this for littlesync-pigs `--pipe`).

## files

- `frame.ts`: COBS, CRC-32, frames, an unframer for a byte stream (`../frame.c`)
- `wire.ts`: the messages, hello, heads, want, commits, ephemeral, ack
- `link.ts`: one link, sans-IO (hello, up, the timers), as `ls_link` is
- `gateway.ts`: the bridge (what goes which way: its header)
- `main.ts`: the process
- tests: `frame_test.ts`, `link_test.ts` (against littlesync-pigs `--pipe`), `gateway_test.ts` (the
  gateway, littlesync-pigs and a sync.ts device in one process, no server), `galaxy_test.ts`
  (main.ts, littlesync-pigs and a lab-pig-style device in the pig room on `UPSTREAM`);
  `pigs_harness.ts`, `host_harness.ts`

## test

    make test          # builds littlesync-pigs into build/ (from playground/demos/pigs/littlesync), then the unit and in-process tests
    make galaxy-test   # the same peers through wss://galaxy.observer, in lab-pig's room

## the merge gap

An older littlesync write with several parents named the merge rule `littlesync/lww-path`. Now
littlesync writes neither base nor merge: each patch says what it replaces (`replaces`, values.org),
and the gateway passes the seals through as they are. An older merge commit is still taken and
forwarded like any other (the gateway's history check and the mailroom check no merge rule; that
check is sync.ts's), so a sync.ts device without the rule refuses it (`merge`) and every commit on
it (`parent`). Each one is logged (`merge ... rule "littlesync/lww-path"`) and counted
(`stats.merges`).

## left for the container

- `start.sh` in galaxy's image: start the gateway beside the server,
  `UPSTREAM=ws://localhost:<port>` (and `UPSTREAM_SERVICE` if the server's service name isn't
  `localhost`), `PORT` a port of its own
- `/littlesync` reaching it: a few lines in the patched `accept_loop` (server.rs), diverting by the
  request head as `/relay` is diverted, proxying the connection to the gateway's port (or a proxy in
  front of both). Built and checked by CI only
- the image needs Deno and this folder with what it imports (`extensions/together`,
  `ermine/encoding`, the workspace's `deno.json`), or a `deno compile` of main.ts
- upstream reconnects: main.ts retries the first connection; a connection lost later is not made
  again (Subduction's own reconnecting, if any, is all there is)
- auth: galaxy stores ids whose last 16 bytes are zero (the pig room and littlesync's pigs are
  such); with Keyhive the gateway's key needs a grant per room
