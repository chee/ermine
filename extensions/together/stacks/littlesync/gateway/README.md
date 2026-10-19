# littlesync gateway

littlesync devices (`../littlesync.h`) in rooms on a Subduction server (wss://galaxy.observer). A
Deno process: each WebSocket connection at `/littlesync` is one littlesync link (binary messages
carry the byte stream, frames as on a serial line), and so is each HTTP session at
`/littlesync/<session>` (http, below); inside, one together device (the mailroom and the subduction
stack, memory storage) is a Subduction peer of the upstream server. Nothing is stored here: the
server holds everything, and a node is pulled again once a device names it after a start. The plan:
`../../../../../../ermine-plans/extensions/together/bridge.org`.

## run

    make run                     # deno run --allow-net --allow-env --allow-read ... main.ts
    PORT=9000 UPSTREAM=ws://localhost:8080 UPSTREAM_SERVICE=ermine make run

| env                | default               | what                                                                              |
| ------------------ | --------------------- | --------------------------------------------------------------------------------- |
| `PORT`             | 8080                  | where `/littlesync`, `/littlesync/<session>` and `/` listen                       |
| `UPSTREAM`         | wss://galaxy.observer | the Subduction server                                                             |
| `UPSTREAM_SERVICE` | its url's host        | the server's service name when it isn't the host (local subduction_cli: `ermine`) |
| `GATEWAY_SEED`     | a new key each start  | 64 hex: the gateway's key (Subduction peer, and the ephemerals it makes)          |
| `QUIET`            |                       | `1`: no protocol log lines                                                        |

`GET /` gives the counts (`Stats` in gateway.ts: `upstream` among them), the HTTP sessions, the
nodes followed and the last refusals, as JSON. The log has one line per thing that happens:
forwarded, refused (with the reason), waiting, merge, can't send, upstream (these even when
`QUIET`), http open/idle/ended.

A device reaches it over WiFi (ESP-IDF's WebSocket client, or plain HTTP: `esp_http_client`), or
through a Mac (a relay from the serial port to the WebSocket: galaxy_test.ts's `cPeer` does this for
littlesync-pigs `--pipe`).

## http

For a device with an HTTP/1.1 client and no WebSocket. A session is one link; the device names it.

    POST   /littlesync/<session>?wait=<ms>&most=<bytes>   body: bytes up. answer: bytes down
    GET    /littlesync/<session>?wait=<ms>&most=<bytes>   the same, nothing up
    DELETE /littlesync/<session>                          ends it (204)

- session: 8 to 64 of `A-Z a-z 0-9 _ -`, picked by the device (16 random hex is plenty); else 400
- body up: what a serial line would carry (frames, half a frame, nothing), at most 64 KiB (else
  413). `Content-Length`, no chunking needed
- answer: 200, `application/octet-stream`, `Content-Length`; whole frames, those waiting, at once.
  none waiting: waits up to `wait` ms for some (default 0, at most 25000), then answers empty
- most: the answer's bytes at most (default 16384); whole frames only, one always goes however big
- a newer request on a session ends the one waiting (it answers empty): one long poll at a time
- unknown session (new, idle, or the gateway began again): opened by its first request; the
  gateway's hello comes in the answer, and littlesync starts the peer over as on any new link
- idle: no request for 30 s and none waiting, the session ends (its link closes, its holds stop)
- frames waiting past 256 KiB: the oldest go. an answer lost on the way is frames lost on a line:
  littlesync resends what is not acked
- 256 sessions at once (503 past that); 405 for other methods

The device's loop, one `esp_http_client` handle, keep-alive:

    for (;;) {
        ls_tick(dev, now_ms());
        len = ls_next(link, &up);                 // may be 0
        POST /littlesync/<session>?wait=(len ? 0 : 1000)  body up[0..len]
        ls_feed(link, answer, answer_len);
    }

A second handle can hold a long `GET ?wait=25000` while the first only POSTs, for less delay down.

In C: `../http.h` is this loop's exchange, sans-IO (`ls_http_begin`, the post on a thread of its
own, `ls_http_end`; or `ls_http_turn` with a blocking post). The posts: `../http_posix.c` (plain
sockets: littlesync-pigs `--http http://host:port`), the Cardputer's `main/net.c` (esp_http_client,
WiFi and gateway set in `./idf.sh menuconfig`, "Cardputer: littlesync over WiFi"). `http://` only;
https later. Two littlesync-pigs over HTTP to a gateway here:
`sh ../test/http.sh
../build/littlesync-pigs` (from `..`, in its `make test`; a second argument
`wss://galaxy.observer` goes through galaxy).

## upstream

`keep` (gateway.ts) dials the server over its own WebSocket (socket.ts, so it sees a close), and
again when it drops or fails: 0.5 s after, twice as long each failed try, 30 s at most; a dial and
its handshake given up after 20 s. Once connected the stack subscribes and fetches every followed
node again, and the ephemeral topics; sync both ways brings what either side wrote meanwhile.
Devices notice only delay: their links are to the gateway, not the server.

While there is no upstream, device commits are taken and put here as ever but not acked; acked when
it is back (`stats.upstream.held`). So a device keeps resending its own until the server may have
them. A connection that dies with no close (a dropped route, no FIN) is seen only when TCP gives up:
no pings from here.

## presence

A presence row (`../littlesync.h`, presence) is presence.ts's message, the bytes web pigs send on
the topic `ermine://<node's hex>`; the gateway passes it on unchanged. From the server: each row
heard on the topic of a node a device names goes down with its sender's key as `who`. From a device:
the server names a row by the key it was published under, so each device key gets a Subduction peer
of its own here (a key made for it: its rows' name in the room), dialled as the upstream is, let go
of 10 s after its last row; none while there is no upstream. Rows heard back from those keys are not
sent down again. A row also goes on to the other devices naming the node, as it came.
`stats.presence`: rows in, rows out, peers now.

## restart

All in memory: the nodes followed, what each link was sent and has acked, the holds, the commits
waiting on a parent, the HTTP sessions. On a start the server is dialled; a device's link (a new
WebSocket, or its next HTTP request) gets a hello, and littlesync forgets what that peer had acked
and resends its own held commits and heads; the gateway follows each node named again, from the
server. A commit waiting here on a parent asks the device for it (`want`).

Lost: a commit acked by the old process that never reached the server (put while the socket was
dropping unseen) and that the device no longer holds (a later write of its replaced it): its
children wait here on it, and the device can't send it. Ephemerals made again by the gateway stop
until the device's next beat. Without `GATEWAY_SEED` the gateway's key (its Subduction peer id, the
ephemerals' signer) is new.

## files

- `frame.ts`: COBS, CRC-32, frames, an unframer for a byte stream (`../frame.c`)
- `wire.ts`: the messages, hello, heads, want, commits, ephemeral, ack, presence
- `link.ts`: one link, sans-IO (hello, up, the timers), as `ls_link` is
- `gateway.ts`: the bridge (what goes which way: its header), the upstream kept
- `http.ts`: HTTP sessions
- `socket.ts`: a WebSocket as a Subduction transport
- `main.ts`: the process
- tests: `frame_test.ts`, `link_test.ts` (against littlesync-pigs `--pipe`), `gateway_test.ts` (the
  gateway, littlesync-pigs and a sync.ts device in one process, no server; presence both ways),
  `http_test.ts` (two devices over HTTP sessions and a sync.ts device), `upstream_test.ts` (a
  sync.ts device serving WebSocket here, its socket closed under the gateway), `galaxy_test.ts`
  (main.ts, littlesync-pigs and a lab-pig-style device in the pig room on `UPSTREAM`; two HTTP
  devices; the upstream socket closed; presence rows between a presence.ts world and
  littlesync-pigs); `pigs_harness.ts`, `host_harness.ts`, `http_harness.ts`

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
- `/littlesync` and `/littlesync/*` reaching it: a few lines in the patched `accept_loop`
  (server.rs), diverting by the request head as `/relay` is diverted, proxying the connection to the
  gateway's port (or a proxy in front of both). Not only upgrades: plain HTTP requests too, kept
  alive, a response up to 25 s late (long polls; Railway's proxy must allow it). Built and checked
  by CI only
- the image needs Deno and this folder with what it imports (`extensions/together`,
  `ermine/encoding`, the workspace's `deno.json`), or a `deno compile` of main.ts
- auth: galaxy stores ids whose last 16 bytes are zero (the pig room and littlesync's pigs are
  such); with Keyhive the gateway's key needs a grant per room
