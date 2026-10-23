// tippet's http long-poll carrier (experiments/tippet/WIRE.md "http long-poll", its framing and acks
// tippet's tp_http): the den's sync (den.h) linked to a room on a server, url/send and url/recv, as
// a device that can only make requests does. the requests are made on two workers of the
// platform's (the Cardputer's: esp_http_client on two tasks, wifi.c; the Mac's: curl on two
// threads, sim.c), one waiting on recv, one sending; every tp_ call stays on the loop's task
//
//   poll_start(den_sync(), "https://galaxy.observer/littlesync/tippet/dens-KAYA");
//   for (;;) { poll_turn(now_ms); ... }
#ifndef POLL_H
#define POLL_H

#include <stddef.h>
#include <stdint.h>

#include "experiments/tippet/c/tippet.h"

// a request, made on a worker: post (send) or get (recv) at url, with body; answered with status
// (-1: no answer) and answer (malloc'd by the worker, length bytes, NULL: none), then done set
typedef struct {
	int post;
	char url[256];
	const uint8_t *body;
	size_t n;
	uint8_t *answer;
	size_t length;
	int status;
	int done;
} poll_request;
// the platform's: r made on worker (0 recv, 1 send; with one worker, 0), r->done set (__atomic, release) once answered
void poll_do(int worker, poll_request *r);
// the platform's: whether the network is up (a request now could be answered)
int poll_up(void);

// how many workers the platform runs: 1, recv and send take turns on one connection (one TLS
// session's heap, but a send waits for the recv out, up to the 2 s of a room's heartbeat); 2, a
// recv waits on one while sends go on the other (about 9 KB more, worth it since packed runs)
#ifndef POLL_WORKERS
#define POLL_WORKERS 2
#endif
// the most an answer carries (room=), and the most a send's body copies (one message at least)
#define POLL_ROOM 8192
#define POLL_BODY 8192
// the outbox's bytes at which the link says it is full (tp_send's 1)
#define POLL_FULL 8192
// the most of an answer a worker takes; more: no answer
#define POLL_MOST (48 * 1024)

// url: the room's, without /send or /recv
void poll_start(tp_sync *sync, const char *url);
// each loop: answers taken, the next requests begun, a link made again when the server lost it
void poll_turn(int64_t now);
// in a few words: "on galaxy.observer", "joining galaxy.observer", "offline"
const char *poll_state(void);
// whether the first answer has come on this link (the room joined), and how many answers
int poll_joined(void);
// requests made, failed, and messages in and out
void poll_counts(unsigned *requests, unsigned *failed, unsigned *in, unsigned *out);

#endif
