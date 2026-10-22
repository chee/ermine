// the http long-poll client (../WIRE.md, typescript/carriers/http.ts's poll), its framing and
// acks alone: the device makes the requests and gives their answers here. frames: a 4-byte
// big-endian length, then a message, back to back
#include <stdio.h>
#include <string.h>

#include "wire.h"

static uint32_t length_at(const uint8_t *p) {
	return (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | p[3];
}

int tp_http_open(tp_http *h, const tp_mem *mem, const char *id, size_t room) {
	size_t n = strlen(id);
	memset(h, 0, sizeof *h);
	if (n > 64) return TP_BOUND;
	h->mem = *mem, h->room = room;
	memcpy(h->id, id, n + 1);
	return 0;
}

void tp_http_close(tp_http *h) {
	tp_free(&h->mem, h->frames, h->cap);
	h->frames = NULL, h->length = h->cap = h->waiting = h->bytes = 0;
	h->closed = 1;
}

int tp_http_send(tp_http *h, const uint8_t *message, size_t length) {
	if (h->closed) return TP_GONE;
	if (length > TP_BODY - 4) return TP_BOUND;
	// offline too long: let go, and linked again later
	if (h->bytes + length > TP_BODY) return tp_http_close(h), TP_GONE;
	if (h->length + 4 + length > h->cap) {
		size_t cap = h->cap ? h->cap : 256;
		while (cap < h->length + 4 + length) cap *= 2;
		uint8_t *p = tp_grow(&h->mem, h->frames, h->cap, cap);
		if (!p) return TP_NOMEM;
		h->frames = p, h->cap = cap;
	}
	uint8_t *at = h->frames + h->length;
	at[0] = (uint8_t)(length >> 24), at[1] = (uint8_t)(length >> 16), at[2] = (uint8_t)(length >> 8);
	at[3] = (uint8_t)length;
	if (length) memcpy(at + 4, message, length);
	h->length += 4 + length, h->waiting++, h->bytes += length;
	return 0;
}

size_t tp_http_query(const tp_http *h, char *out, size_t cap) {
	char room[32] = "";
	if (h->room) snprintf(room, sizeof room, "&room=%llu", (unsigned long long)h->room);
	int n = snprintf(out, cap, "link=%s&ack=%llu&n=%llu%s", h->id, (unsigned long long)h->ack,
		(unsigned long long)h->sent + 1, room);
	return n < 0 ? 0 : (size_t)n;
}

size_t tp_http_body(const tp_http *h, const uint8_t **body, size_t *count) {
	size_t at = 0, n = 0;
	while (at < h->length) {
		size_t next = at + 4 + length_at(h->frames + at);
		if (next > TP_BODY) break;
		at = next, n++;
	}
	*body = h->frames, *count = n;
	return at;
}

static int gone(tp_http *h, int status) {
	if (status != 409 && status != 410) return 0;
	tp_http_close(h);
	return 1;
}

int tp_http_sent(tp_http *h, int status, size_t count) {
	if (h->closed || gone(h, status)) return TP_GONE;
	if (status < 200 || status > 299) return 1;
	// the first count frames taken: out of the outbox
	size_t at = 0;
	for (size_t i = 0; i < count && at < h->length; i++) {
		size_t n = length_at(h->frames + at);
		h->bytes -= n, h->waiting--, h->sent++;
		at += 4 + n;
	}
	memmove(h->frames, h->frames + at, h->length - at);
	h->length -= at;
	return 0;
}

int tp_http_recv(tp_http *h, int status, const uint8_t *answer, size_t length,
	void (*told)(void *ctx, const uint8_t *message, size_t length), void *ctx) {
	if (h->closed || gone(h, status)) return TP_GONE;
	if (status < 200 || status > 299 || length < 4) return 1;
	// whole frames, or none told
	uint64_t got = 0;
	size_t at = 4;
	while (at + 4 <= length) {
		size_t n = length_at(answer + at);
		if (n > length - at - 4) return 1;
		at += 4 + n, got++;
	}
	if (at != length) return 1;
	// the answer's number is its last message's: those past ack are new
	uint64_t last = length_at(answer);
	int64_t k = (int64_t)last - (int64_t)got + 1;
	for (at = 4; at < length; k++) {
		size_t n = length_at(answer + at);
		if (k > (int64_t)h->ack) told(ctx, answer + at + 4, n);
		at += 4 + n;
	}
	if (last > h->ack) h->ack = last;
	return 0;
}
