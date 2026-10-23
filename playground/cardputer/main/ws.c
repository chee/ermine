// tippet over a websocket (ws.h): RFC 6455's client side, small: the upgrade (Sec-WebSocket-Key; the
// answer's 101 is all that is checked), binary frames out (masked), frames in (unmasked; a message
// may come in pieces), ping and pong, close. the task owns the TLS session; the loop owns the sync;
// between them, under a lock: what came (frames, [4-byte length][message]), the batch to write, and
// the line's state
#include "ws.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>

#include "den.h"
#include "esp_crt_bundle.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "esp_tls.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "poll.h"

// the task's stack: a TLS handshake runs on it
#define WS_STACK 6144

static int64_t ms(void) { return esp_timer_get_time() / 1000; }

// a growing buffer of bytes
typedef struct {
	uint8_t *p;
	size_t n, room;
} bytes;
static int put(bytes *b, const void *p, size_t n) {
	if (b->n + n > b->room) {
		size_t room = b->room ? b->room : 1024;
		while (room < b->n + n) room *= 2;
		uint8_t *q = realloc(b->p, room);
		if (q == NULL) return 0;
		b->p = q, b->room = room;
	}
	memcpy(b->p + b->n, p, n);
	b->n += n;
	return 1;
}
static void let_go(bytes *b) {
	free(b->p);
	*b = (bytes){0};
}
// a buffer emptied, let go when it grew past 2 KB (a catch-up's big message would hold its room
// for the line's whole life)
static void shrink(bytes *b) {
	if (b->n == 0 && b->room > 2048) let_go(b);
}
static int framed(bytes *b, const uint8_t *m, size_t n) {
	uint8_t head[4] = {(uint8_t)(n >> 24), (uint8_t)(n >> 16), (uint8_t)(n >> 8), (uint8_t)n};
	return put(b, head, 4) && put(b, m, n);
}

static struct {
	// the room's url, taken apart
	char host[64], path[128];
	int port, secure;
	tp_sync *sync;
	SemaphoreHandle_t lock;
	// under the lock: what came; the batch to write (ready: handed over, not yet written); the line
	// open, and each open and drop counted (gen), its state in words
	bytes in, job;
	int ready, open, gen;
	char state[48];
	// the loop's: its link, the line it is for, what waits to be handed over, and counts
	tp_link *link;
	int link_gen, full;
	bytes out;
	unsigned links, got, sent;
} me;

static void say(const char *s) {
	xSemaphoreTake(me.lock, portMAX_DELAY);
	snprintf(me.state, sizeof me.state, "%s", s);
	xSemaphoreGive(me.lock);
}

// ---- the task: the line ----

static esp_tls_t *tls;

static int send_all(const uint8_t *p, size_t n) {
	while (n > 0) {
		ssize_t w = esp_tls_conn_write(tls, p, n);
		if (w == ESP_TLS_ERR_SSL_WANT_READ || w == ESP_TLS_ERR_SSL_WANT_WRITE) continue;
		if (w <= 0) return 0;
		p += w, n -= (size_t)w;
	}
	return 1;
}

// a frame out: FIN, its opcode, masked (a client's always are)
static int frame_out(int op, const uint8_t *p, size_t n) {
	uint8_t head[14], mask[4];
	size_t h = 0;
	head[h++] = (uint8_t)(0x80 | op);
	if (n < 126) head[h++] = (uint8_t)(0x80 | n);
	else if (n < 65536) head[h++] = 0x80 | 126, head[h++] = (uint8_t)(n >> 8), head[h++] = (uint8_t)n;
	else {
		head[h++] = 0x80 | 127;
		for (int i = 7; i >= 0; i--) head[h++] = (uint8_t)((uint64_t)n >> (8 * i));
	}
	den_random(mask, 4);
	memcpy(head + h, mask, 4), h += 4;
	uint8_t *f = malloc(h + n);
	if (f == NULL) return 0;
	memcpy(f, head, h);
	for (size_t i = 0; i < n; i++) f[h + i] = p[i] ^ mask[i & 3];
	int ok = send_all(f, h + n);
	free(f);
	return ok;
}

static void base64(const uint8_t *in, size_t n, char *out) {
	static const char A[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	size_t o = 0;
	for (size_t i = 0; i < n; i += 3) {
		uint32_t v = (uint32_t)in[i] << 16 | (i + 1 < n ? (uint32_t)in[i + 1] << 8 : 0) | (i + 2 < n ? in[i + 2] : 0);
		out[o++] = A[v >> 18 & 63], out[o++] = A[v >> 12 & 63];
		out[o++] = i + 1 < n ? A[v >> 6 & 63] : '=';
		out[o++] = i + 2 < n ? A[v & 63] : '=';
	}
	out[o] = 0;
}

// linked: TLS (or plain TCP), then the upgrade. what came past the answer's head into rest. 1: open
static int link_up(bytes *rest) {
	esp_tls_cfg_t cfg = {
		.timeout_ms = 10000,
		.crt_bundle_attach = me.secure ? esp_crt_bundle_attach : NULL,
		.is_plain_tcp = !me.secure,
	};
	tls = esp_tls_init();
	if (tls == NULL || esp_tls_conn_new_sync(me.host, (int)strlen(me.host), me.port, &cfg, tls) != 1) return 0;
	uint8_t key[16];
	char key64[32], ask[400];
	den_random(key, sizeof key);
	base64(key, sizeof key, key64);
	int n = snprintf(ask, sizeof ask,
		"GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
		"Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n",
		me.path, me.host, key64);
	if (!send_all((const uint8_t *)ask, (size_t)n)) return 0;
	// the answer's head, to its blank line
	char head[1024];
	size_t got = 0;
	char *end = NULL;
	while (end == NULL && got < sizeof head - 1) {
		ssize_t r = esp_tls_conn_read(tls, head + got, sizeof head - 1 - got);
		if (r == ESP_TLS_ERR_SSL_WANT_READ) continue;
		if (r <= 0) return 0;
		got += (size_t)r;
		head[got] = 0;
		end = strstr(head, "\r\n\r\n");
	}
	if (end == NULL || strncmp(head, "HTTP/1.1 101", 12) != 0) {
		char *nl = strchr(head, '\r');
		if (nl) *nl = 0;
		printf("ws: no upgrade: %.60s\n", head);
		return 0;
	}
	size_t past = (size_t)(end + 4 - head);
	if (got > past) put(rest, head + past, got - past);
	return 1;
}

// whole frames off the front of r: messages to the loop, pings answered, a close a drop. 0: drop
static int frames_in(bytes *r, bytes *msg) {
	size_t at = 0;
	for (;;) {
		if (r->n - at < 2) break;
		const uint8_t *f = r->p + at;
		int fin = f[0] & 0x80, op = f[0] & 15, masked = f[1] & 0x80;
		uint64_t n = f[1] & 127;
		size_t h = 2;
		if (n == 126) {
			if (r->n - at < 4) break;
			n = (uint64_t)f[2] << 8 | f[3], h = 4;
		} else if (n == 127) {
			if (r->n - at < 10) break;
			n = 0;
			for (int i = 0; i < 8; i++) n = n << 8 | f[2 + i];
			h = 10;
		}
		if (n > WS_MOST) return 0;
		size_t mh = masked ? 4 : 0;
		if (r->n - at < h + mh + n) break;
		uint8_t *p = r->p + at + h + mh;
		if (masked)
			for (size_t i = 0; i < n; i++) p[i] ^= f[h + (i & 3)];
		at += h + mh + (size_t)n;
		if (op == 0x8) return 0;
		if (op == 0x9) {
			if (!frame_out(0xA, p, (size_t)n)) return 0;
			continue;
		}
		if (op == 0xA) continue;
		if (op != 0x0 && op != 0x1 && op != 0x2) continue;
		if (msg->n + n > WS_MOST || !put(msg, p, (size_t)n)) return 0;
		if (!fin) continue;
		xSemaphoreTake(me.lock, portMAX_DELAY);
		int ok = framed(&me.in, msg->p ? msg->p : (const uint8_t *)"", msg->n);
		xSemaphoreGive(me.lock);
		msg->n = 0;
		shrink(msg);
		if (!ok) return 0;
	}
	memmove(r->p, r->p + at, r->n - at);
	r->n -= at;
	shrink(r);
	return 1;
}

static void line(void *arg) {
	(void)arg;
	int wait = 1000;
	char words[48];
	for (;;) {
		// no WiFi yet: waited for, no drop said
		if (!poll_up()) {
			say("offline: no WiFi yet");
			vTaskDelay(pdMS_TO_TICKS(200));
			continue;
		}
		snprintf(words, sizeof words, "joining %s", me.host);
		say(words);
		bytes r = {0}, msg = {0};
		int up = link_up(&r);
		if (up) {
			xSemaphoreTake(me.lock, portMAX_DELAY);
			me.open = 1, me.gen++, me.ready = 0;
			snprintf(me.state, sizeof me.state, "on %s", me.host);
			xSemaphoreGive(me.lock);
			wait = 1000;
			int64_t heard = ms(), pinged = ms();
			int fd = -1;
			esp_tls_get_conn_sockfd(tls, &fd);
			// what came before the first read (past the upgrade's answer)
			int ok = frames_in(&r, &msg);
			while (ok) {
				// the batch the loop handed over, a frame a message
				xSemaphoreTake(me.lock, portMAX_DELAY);
				int ready = me.ready;
				xSemaphoreGive(me.lock);
				if (ready) {
					for (size_t at = 0; ok && at + 4 <= me.job.n;) {
						size_t n = (size_t)me.job.p[at] << 24 | (size_t)me.job.p[at + 1] << 16 |
							   (size_t)me.job.p[at + 2] << 8 | me.job.p[at + 3];
						ok = frame_out(0x2, me.job.p + at + 4, n);
						at += 4 + n;
					}
					extern int getenv_trace;
					if (getenv_trace) printf("trace: ws wrote %u bytes at %lld\n", (unsigned)me.job.n, (long long)ms());
					me.job.n = 0;
					shrink(&me.job);
					xSemaphoreTake(me.lock, portMAX_DELAY);
					me.ready = 0;
					xSemaphoreGive(me.lock);
				}
				int64_t now = ms();
				if (ok && now - pinged >= WS_PING) ok = frame_out(0x9, NULL, 0), pinged = now;
				if (now - heard > WS_DEAD) ok = 0;
				if (!ok) break;
				// what the loop hasn't taken yet, past a bound: not read for now (the server waits)
				xSemaphoreTake(me.lock, portMAX_DELAY);
				size_t waiting = me.in.n;
				xSemaphoreGive(me.lock);
				if (waiting > WS_WAITING) {
					vTaskDelay(pdMS_TO_TICKS(10));
					continue;
				}
				if (esp_tls_get_bytes_avail(tls) <= 0) {
					fd_set rd;
					FD_ZERO(&rd);
					FD_SET(fd, &rd);
					struct timeval tv = {0, 10000};
					if (select(fd + 1, &rd, NULL, NULL, &tv) <= 0) continue;
				}
				uint8_t buf[1024];
				ssize_t n = esp_tls_conn_read(tls, buf, sizeof buf);
				if (n == ESP_TLS_ERR_SSL_WANT_READ || n == ESP_TLS_ERR_SSL_WANT_WRITE) continue;
				if (n <= 0) break;
				heard = ms();
				ok = put(&r, buf, (size_t)n) && frames_in(&r, &msg);
			}
			if (ok == 0) frame_out(0x8, NULL, 0);
		}
		if (tls) esp_tls_conn_destroy(tls), tls = NULL;
		let_go(&r), let_go(&msg);
		xSemaphoreTake(me.lock, portMAX_DELAY);
		if (me.open) me.gen++;
		me.open = 0, me.ready = 0;
		// a TLS session wants a block of about 16 KB at once: without one, said so
		if (heap_caps_get_largest_free_block(MALLOC_CAP_8BIT) < 16 * 1024)
			snprintf(me.state, sizeof me.state, "offline: memory too low (%uK)",
				(unsigned)(heap_caps_get_free_size(MALLOC_CAP_8BIT) / 1024));
		else snprintf(me.state, sizeof me.state, "offline: again in %d s", wait / 1000);
		xSemaphoreGive(me.lock);
		printf("ws: the line to %s dropped: again in %d s\n", me.host, wait / 1000);
		vTaskDelay(pdMS_TO_TICKS(wait));
		wait = wait * 2 > 15000 ? 15000 : wait * 2;
	}
}

// ---- the loop: the sync ----

// a message onto the link: into the outbox; full at WS_FULL bytes waiting
static int send(void *ctx, const uint8_t *b, size_t n) {
	(void)ctx;
	if (!framed(&me.out, b, n)) return TP_NOMEM;
	me.sent++;
	if (me.out.n >= WS_FULL) me.full = 1;
	return me.full;
}

void ws_start(tp_sync *sync, const char *url) {
	if (sync == NULL) return;
	me.sync = sync;
	me.lock = xSemaphoreCreateMutex();
	me.secure = strncmp(url, "https://", 8) == 0 || strncmp(url, "wss://", 6) == 0;
	const char *h = strstr(url, "://");
	h = h ? h + 3 : url;
	const char *slash = strchr(h, '/'), *colon = strchr(h, ':');
	size_t hn = (size_t)((colon && (!slash || colon < slash) ? colon : slash ? slash : h + strlen(h)) - h);
	snprintf(me.host, sizeof me.host, "%.*s", (int)hn, h);
	me.port = colon && (!slash || colon < slash) ? atoi(colon + 1) : me.secure ? 443 : 80;
	snprintf(me.path, sizeof me.path, "%s", slash ? slash : "/");
	snprintf(me.state, sizeof me.state, "joining %s", me.host);
	xTaskCreate(line, "tippet ws", WS_STACK, NULL, 5, NULL);
}

void ws_turn(int64_t now) {
	(void)now;
	if (me.sync == NULL) return;
	xSemaphoreTake(me.lock, portMAX_DELAY);
	int gen = me.gen, open = me.open, ready = me.ready;
	// what came, taken whole
	bytes in = me.in;
	me.in = (bytes){0};
	xSemaphoreGive(me.lock);
	// the line opened or dropped: the old link let go (what it owed is dropped), a new one made
	if (gen != me.link_gen) {
		if (me.link) tp_sync_unlink(me.sync, me.link), me.link = NULL;
		me.out.n = 0, me.full = 0;
		me.link_gen = gen;
		if (open) {
			me.link = tp_sync_link(me.sync, send, NULL, 0);
			if (me.link) tp_sync_keeper(me.sync, me.link), me.links++;
		}
	}
	for (size_t at = 0; at + 4 <= in.n;) {
		size_t n = (size_t)in.p[at] << 24 | (size_t)in.p[at + 1] << 16 | (size_t)in.p[at + 2] << 8 | in.p[at + 3];
		me.got++;
		den_heard(in.p + at + 4, n);
		if (me.link && open) tp_sync_receive(me.sync, me.link, in.p + at + 4, n);
		at += 4 + n;
	}
	let_go(&in);
	// the outbox handed over, once the last batch is written: at most WS_FULL bytes of it (one
	// message at least)
	if (open && !ready && me.out.n > 0) {
		size_t at = 0;
		while (at < me.out.n) {
			size_t n = (size_t)me.out.p[at] << 24 | (size_t)me.out.p[at + 1] << 16 | (size_t)me.out.p[at + 2] << 8 |
				   me.out.p[at + 3];
			if (at > 0 && at + 4 + n > WS_FULL) break;
			at += 4 + n;
		}
		me.job.n = 0;
		if (put(&me.job, me.out.p, at)) {
			memmove(me.out.p, me.out.p + at, me.out.n - at);
			me.out.n -= at;
			shrink(&me.out);
			xSemaphoreTake(me.lock, portMAX_DELAY);
			me.ready = me.gen == gen;
			xSemaphoreGive(me.lock);
			extern int getenv_trace;
			if (getenv_trace) printf("trace: ws handed %u bytes at %lld\n", (unsigned)at, (long long)ms());
		}
	}
	if (me.full && me.out.n < WS_FULL / 2 && me.link) me.full = 0, tp_sync_go(me.sync, me.link);
}

const char *ws_state(void) {
	static char s[48];
	if (me.lock == NULL) return "no server";
	xSemaphoreTake(me.lock, portMAX_DELAY);
	snprintf(s, sizeof s, "%s", me.state);
	xSemaphoreGive(me.lock);
	return s;
}

int ws_joined(void) { return me.link != NULL; }

void ws_counts(unsigned *links, unsigned *in, unsigned *out) { *links = me.links, *in = me.got, *out = me.sent; }
