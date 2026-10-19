// littlesync over the gateway's HTTP sessions (gateway/README.md, http): one link, a POST at a time,
// bytes up in the body, bytes down in the answer. Sans-IO like littlesync.h: the request itself is the
// platform's (a post function: http_posix.c on a Mac, esp_http_client on an ESP32).
//
// pacing: something to send, wait=0 (the answer at once); nothing, a long poll (wait idle_ms, the
// gateway answers as soon as a frame comes). One exchange at a time, the next straight after. A failed
// one (no answer, not 200): the next after 0.5 s, twice as long each failure, 30 s at most. What a
// failed one carried is lost as on a line: littlesync resends what is not acked; a new session (the
// gateway began again, or 30 s idle) brings the gateway's hello and the peer starts over.
//
// ---- use (a loop that must not stall: begin and end, the post on a thread or task of its own) ----
//   ls_http *h = ls_http_open(ls_link(dev), &(ls_http_options){.url = "https://galaxy.observer",
//                             .random = my_random});
//   for (;;) {
//     ls_tick(dev, now);
//     ls_http_request r;
//     if (!busy && ls_http_begin(h, now, &r)) busy = 1, start r on the other thread;
//     if (busy && it is done) busy = 0, ls_http_end(h, now, its length);   // -1: failed
//   }
// or, where a blocking loop is fine: ls_http_turn(h, now, post, context) does all three.
// ls_http_begin, ls_http_end and ls_http_turn are ls_ calls (one task); the post may run anywhere.
#ifndef LITTLESYNC_HTTP_H
#define LITTLESYNC_HTTP_H

#include "littlesync.h"

// the wait while there is nothing to send, ms (the gateway's longest: 25000)
#define LS_HTTP_IDLE_MS 1000
// a failure's pause: the first, and the longest
#define LS_HTTP_BACK_MS 500
#define LS_HTTP_BACK_MAX_MS 30000

// one POST: url (with ?wait=&most=), body bytes up. The answer's bytes go in answer[0..room): its
// length, or -1 when failed (no answer, a status but 200, more than room). wait_ms is how long the
// gateway may hold it: wait longer than that before giving up
typedef long (*ls_http_post)(void *context, const char *url, uint32_t wait_ms, const uint8_t *body, size_t length,
	uint8_t *answer, size_t room);

typedef struct {
	const char *url;     // the gateway: "http://host:port" or "https://host" (/littlesync/<session> is added)
	const char *session; // 8 to 64 of A-Z a-z 0-9 _ -; NULL: 16 random hex from random
	void (*random)(void *context, uint8_t *out, size_t n);
	void *random_context;
	uint32_t idle_ms; // 0: LS_HTTP_IDLE_MS
	uint32_t most;    // the answer's bytes at most (0: 16384). Room for one frame always
} ls_http_options;

typedef struct ls_http ls_http;

// the request ls_http_begin hands out: all of it the ls_http's, valid till ls_http_end
typedef struct {
	const char *url;
	uint32_t wait_ms;
	const uint8_t *body;
	size_t length;
	uint8_t *answer;
	size_t room;
} ls_http_request;

typedef struct {
	uint32_t posts, failed; // exchanges ended, of them failed
	uint32_t failing;       // failures in a row now (0: the last one answered)
	uint64_t up, down;      // bytes sent and taken in
} ls_http_stats;

// NULL: no url, a session that is not one, no memory. The link stays the caller's (ls_unlink after
// ls_http_close)
ls_http *ls_http_open(struct ls_link *link, const ls_http_options *options);
void ls_http_close(ls_http *http);
// 1 and the request when an exchange is due (none out, no pause): the link's bytes to send taken
// (ls_next), into the body. 0: not now. Call after ls_tick
int ls_http_begin(ls_http *http, int64_t now_ms, ls_http_request *out);
// the exchange is over: length the answer's bytes in out.answer (fed to the link), or -1 failed
void ls_http_end(ls_http *http, int64_t now_ms, long length);
// begin, post (blocking) and end: 1 when an exchange was made, answered or not
int ls_http_turn(ls_http *http, int64_t now_ms, ls_http_post post, void *context);
const ls_http_stats *ls_http_stats_of(const ls_http *http);
const char *ls_http_session(const ls_http *http);

// http_posix.c: a post over plain sockets (http://, HTTP/1.1, the connection kept between posts,
// dialled again when it drops); https:// through libcurl when built with LS_HTTP_CURL (else -1).
// context: ls_http_socket_open's
void *ls_http_socket_open(void);
void ls_http_socket_close(void *context);
long ls_http_socket(void *context, const char *url, uint32_t wait_ms, const uint8_t *body, size_t length,
	uint8_t *answer, size_t room);

#endif
