// Tests the http long-poll client's framing and acks. Run ./tippet-http-test.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "tippet.h"

static void *plain(void *ctx, void *p, size_t old, size_t size) {
	(void)ctx, (void)old;
	if (!size) return free(p), NULL;
	return realloc(p, size);
}

static int failed;
#define CHECK(x) \
	do { \
		if (!(x)) fprintf(stderr, "tippet-http-test: %s:%d: %s\n", __FILE__, __LINE__, #x), failed++; \
	} while (0)

static char got[256];
static void told(void *ctx, const uint8_t *m, size_t n) {
	(void)ctx;
	strncat(got, (const char *)m, n);
	strcat(got, "|");
}

static size_t answer(uint8_t *out, uint32_t number, const char *const *ms, size_t n) {
	size_t at = 4;
	out[0] = (uint8_t)(number >> 24), out[1] = (uint8_t)(number >> 16), out[2] = (uint8_t)(number >> 8);
	out[3] = (uint8_t)number;
	for (size_t i = 0; i < n; i++) {
		size_t k = strlen(ms[i]);
		out[at] = 0, out[at + 1] = 0, out[at + 2] = (uint8_t)(k >> 8), out[at + 3] = (uint8_t)k;
		memcpy(out + at + 4, ms[i], k);
		at += 4 + k;
	}
	return at;
}

int main(void) {
	tp_mem mem = {plain, NULL};
	tp_http h;
	char q[200];
	const uint8_t *body;
	size_t count;
	CHECK(tp_http_open(&h, &mem, "c0ffee", 4096) == 0);
	tp_http_query(&h, q, sizeof q);
	CHECK(!strcmp(q, "link=c0ffee&ack=0&n=1&room=4096"));

	CHECK(tp_http_send(&h, (const uint8_t *)"pig", 3) == 0);
	CHECK(tp_http_send(&h, (const uint8_t *)"cow", 3) == 0);
	size_t length = tp_http_body(&h, &body, &count);
	CHECK(length == 14 && count == 2 && !memcmp(body, "\0\0\0\3pig\0\0\0\3cow", 14));
	CHECK(tp_http_sent(&h, 503, count) == 1);
	tp_http_query(&h, q, sizeof q);
	CHECK(strstr(q, "&n=1&") != NULL);
	CHECK(tp_http_sent(&h, 204, count) == 0);
	CHECK(tp_http_body(&h, &body, &count) == 0 && count == 0);
	tp_http_query(&h, q, sizeof q);
	CHECK(strstr(q, "&n=3&") != NULL);

	uint8_t a[256];
	const char *first[] = {"one", "two"}, *again[] = {"two", "three"};
	CHECK(tp_http_recv(&h, 200, a, answer(a, 2, first, 2), told, NULL) == 0);
	CHECK(!strcmp(got, "one|two|") && h.ack == 2);
	CHECK(tp_http_recv(&h, 200, a, answer(a, 3, again, 2), told, NULL) == 0);
	CHECK(!strcmp(got, "one|two|three|") && h.ack == 3);
	CHECK(tp_http_recv(&h, 200, a, answer(a, 3, NULL, 0), told, NULL) == 0 && h.ack == 3);
	size_t cut = answer(a, 4, (const char *[]){"four"}, 1) - 1;
	CHECK(tp_http_recv(&h, 200, a, cut, told, NULL) == 1 && h.ack == 3);
	tp_http_query(&h, q, sizeof q);
	CHECK(!strcmp(q, "link=c0ffee&ack=3&n=3&room=4096"));

	static uint8_t big[TP_BODY];
	CHECK(tp_http_send(&h, big, TP_BODY) == TP_BOUND);
	for (int i = 0; i < 3; i++) CHECK(tp_http_send(&h, big, TP_BODY / 3) == !!i);
	length = tp_http_body(&h, &body, &count);
	CHECK(count == 2 && length == 2 * (4 + TP_BODY / 3));
	CHECK(tp_http_send(&h, big, 1024) == TP_GONE && h.closed);
	tp_http_close(&h);

	CHECK(tp_http_open(&h, &mem, "again", 0) == 0);
	tp_http_query(&h, q, sizeof q);
	CHECK(!strcmp(q, "link=again&ack=0&n=1"));
	CHECK(tp_http_recv(&h, 410, NULL, 0, told, NULL) == TP_GONE);
	tp_http_close(&h);
	CHECK(tp_http_open(&h, &mem, "again2", 0) == 0);
	CHECK(tp_http_send(&h, (const uint8_t *)"x", 1) == 0);
	CHECK(tp_http_sent(&h, 409, 1) == TP_GONE && tp_http_send(&h, (const uint8_t *)"x", 1) == TP_GONE);
	tp_http_close(&h);
	char id[66];
	memset(id, 'a', 65), id[65] = 0;
	CHECK(tp_http_open(&h, &mem, id, 0) == TP_BOUND);

	printf("tippet-http-test: %s\n", failed ? "FAILED" : "ok");
	return failed ? 1 : 0;
}
