// tippet over a websocket (ws.c): the den's sync linked to wss://<server>/littlesync/tippet/<room>,
// the path the browsers use (tippet's carriers/websocket.ts; galaxy: one tippet message a binary
// frame). one TLS session (esp_tls), worked by one task of its own: it reads what comes as it comes
// (a select, never a read that waits for a send) and writes what the loop handed it, a ping every
// 20 s, and links again after a drop, waiting a little longer each time. every tp_ call stays on
// the loop's task, as poll.c's do
//
//   ws_start(den_sync(), "https://galaxy.observer/littlesync/tippet/dens-KAYA");
//   for (;;) { ws_turn(now_ms); ... }
#ifndef WS_H
#define WS_H

#include <stdint.h>

#include "experiments/tippet/c/tippet.h"

// a ping this often; a line with nothing heard for this long (a pong at least) is dropped
#define WS_PING 20000
#define WS_DEAD 60000
// the outbox's bytes at which the link says it is full (tp_send's 1), as poll.c's POLL_FULL
#define WS_FULL 8192
// the most a message coming in may be, and what waits for the loop before the task stops reading
#define WS_MOST (64 * 1024)
#define WS_WAITING (32 * 1024)

// url: the room's (https://host[:port]/path, or http:// for ws://); the task started
void ws_start(tp_sync *sync, const char *url);
// each loop: what came handed to the sync, what the sync wrote handed to the task, a link made
// again after a drop
void ws_turn(int64_t now);
// in a few words: "on galaxy.observer", "joining galaxy.observer", "offline: again in 4 s"
const char *ws_state(void);
// whether the line is open (the room joined); messages in and out; links made
int ws_joined(void);
void ws_counts(unsigned *links, unsigned *in, unsigned *out);

#endif
