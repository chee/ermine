// websocket.c: transport.h's messages, a WebSocket client (RFC 6455) over
// its streams: the opening handshake (its Sec-WebSocket-Accept checked),
// masked frames out, fragmented messages put together, pings answered,
// close answered. Text messages are handed on as bytes too. Portable C: the
// standard library's strings, transport.h's streams and platform.h's
// memory and randomness.

#include "transport.h"
#include "platform.h"

#include <stdio.h>
#include <string.h>

#define MAX_MESSAGE (64u << 20) // what one message may grow to

struct ErmTransport {
	ErmStream *stream;
	uint8_t *in; // bytes read, not yet framed: have of them, from start
	size_t start, have, room;
	uint8_t *message; // a fragmented message so far
	size_t messageLength;
	bool fragmented, closed, closing;
};

// SHA-1 (FIPS 180-4), for Sec-WebSocket-Accept only --------------------------------------------

static uint32_t rotate(uint32_t x, int n) {
	return (x << n) | (x >> (32 - n));
}

static void sha1(const uint8_t *data, size_t length, uint8_t out[20]) {
	uint32_t h[5] = { 0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0 };
	size_t total = ((length + 8) / 64 + 1) * 64;
	uint8_t *padded = erm_host_malloc(total);
	if (!padded) erm_host_abort();
	memset(padded, 0, total);
	memcpy(padded, data, length);
	padded[length] = 0x80;
	uint64_t bits = (uint64_t)length * 8;
	for (size_t i = 0; i < 8; i++) padded[total - 1 - i] = (uint8_t)(bits >> (8 * i));
	for (size_t block = 0; block < total; block += 64) {
		uint32_t w[80];
		for (int i = 0; i < 16; i++) {
			const uint8_t *p = padded + block + 4 * i;
			w[i] = (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | p[3];
		}
		for (int i = 16; i < 80; i++) w[i] = rotate(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
		uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
		for (int i = 0; i < 80; i++) {
			uint32_t f, k;
			if (i < 20) f = (b & c) | (~b & d), k = 0x5a827999;
			else if (i < 40) f = b ^ c ^ d, k = 0x6ed9eba1;
			else if (i < 60) f = (b & c) | (b & d) | (c & d), k = 0x8f1bbcdc;
			else f = b ^ c ^ d, k = 0xca62c1d6;
			uint32_t t = rotate(a, 5) + f + e + k + w[i];
			e = d, d = c, c = rotate(b, 30), b = a, a = t;
		}
		h[0] += a, h[1] += b, h[2] += c, h[3] += d, h[4] += e;
	}
	erm_host_free(padded);
	for (int i = 0; i < 20; i++) out[i] = (uint8_t)(h[i / 4] >> (24 - 8 * (i % 4)));
}

static void base64(const uint8_t *data, size_t length, char *out) {
	static const char digits[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	size_t o = 0;
	for (size_t i = 0; i < length; i += 3) {
		uint32_t v = (uint32_t)data[i] << 16 | (i + 1 < length ? (uint32_t)data[i + 1] << 8 : 0) | (i + 2 < length ? data[i + 2] : 0);
		out[o++] = digits[v >> 18 & 63];
		out[o++] = digits[v >> 12 & 63];
		out[o++] = i + 1 < length ? digits[v >> 6 & 63] : '=';
		out[o++] = i + 2 < length ? digits[v & 63] : '=';
	}
	out[o] = 0;
}

// reading ---------------------------------------------------------------------------------------

/** reads what has come into t->in: bytes read, 0 none, -1 closed */
static long fill(ErmTransport *t) {
	if (t->room - t->start - t->have < 16384) {
		// the framed bytes' room is given back before the buffer grows
		if (t->start) memmove(t->in, t->in + t->start, t->have), t->start = 0;
		if (t->room - t->have < 16384) {
			size_t room = t->room ? t->room * 2 : 65536;
			uint8_t *in = erm_host_realloc(t->in, room);
			if (!in) return -1;
			t->in = in, t->room = room;
		}
	}
	return ermStreamRead(t->stream, t->in + t->start + t->have, t->room - t->start - t->have);
}

/** whether text starts with prefix, ignoring ASCII case */
static bool startsCaseless(const char *text, const char *prefix) {
	for (; *prefix; text++, prefix++) {
		char a = *text >= 'A' && *text <= 'Z' ? (char)(*text + 32) : *text;
		char b = *prefix >= 'A' && *prefix <= 'Z' ? (char)(*prefix + 32) : *prefix;
		if (a != b) return false;
	}
	return true;
}

static void consume(ErmTransport *t, size_t n) {
	t->start += n;
	t->have -= n;
	if (t->have == 0) t->start = 0;
}

// frames ----------------------------------------------------------------------------------------

static bool frame(ErmTransport *t, int opcode, const uint8_t *payload, size_t length) {
	if (!t->stream) return false;
	uint8_t head[14];
	size_t n = 0;
	head[n++] = (uint8_t)(0x80 | opcode);
	if (length < 126) {
		head[n++] = (uint8_t)(0x80 | length);
	} else if (length < 65536) {
		head[n++] = 0x80 | 126;
		head[n++] = (uint8_t)(length >> 8), head[n++] = (uint8_t)length;
	} else {
		head[n++] = 0x80 | 127;
		for (int i = 7; i >= 0; i--) head[n++] = (uint8_t)((uint64_t)length >> (8 * i));
	}
	uint8_t mask[4];
	erm_host_random(mask, 4);
	memcpy(head + n, mask, 4);
	n += 4;
	uint8_t *out = erm_host_malloc(n + length + 1);
	if (!out) return false;
	memcpy(out, head, n);
	for (size_t i = 0; i < length; i++) out[n + i] = payload[i] ^ mask[i % 4];
	bool ok = ermStreamWrite(t->stream, out, n + length);
	erm_host_free(out);
	return ok;
}

// opening ---------------------------------------------------------------------------------------

ErmTransport *ermTransportOpen(const char *url, const char **error) {
	bool tls;
	if (strncmp(url, "wss://", 6) == 0) tls = true, url += 6;
	else if (strncmp(url, "ws://", 5) == 0) tls = false, url += 5;
	else return *error = "the URL is not ws:// or wss://", NULL;
	const char *slash = strchr(url, '/');
	size_t authority = slash ? (size_t)(slash - url) : strlen(url);
	const char *path = slash ? slash : "/";
	char host[256], port[16];
	if (authority == 0 || authority >= sizeof host) return *error = "the URL's host is missing or too long", NULL;
	memcpy(host, url, authority);
	host[authority] = 0;
	char *colon = strrchr(host, ':');
	if (colon && !strchr(colon, ']')) {
		snprintf(port, sizeof port, "%s", colon + 1);
		*colon = 0;
	} else {
		snprintf(port, sizeof port, "%s", tls ? "443" : "80");
	}
	if (host[0] == '[') { // an IPv6 literal
		memmove(host, host + 1, strlen(host));
		char *end = strchr(host, ']');
		if (end) *end = 0;
	}

	ErmStream *stream = ermStreamOpen(host, port, tls, error);
	if (!stream) return NULL;
	ErmTransport *t = erm_host_malloc(sizeof *t);
	if (!t) return ermStreamClose(stream), *error = "out of memory", NULL;
	memset(t, 0, sizeof *t);
	t->stream = stream;

	uint8_t nonce[16];
	erm_host_random(nonce, sizeof nonce);
	char key[32];
	base64(nonce, sizeof nonce, key);
	char request[1024];
	int n = snprintf(request, sizeof request,
		"GET %s HTTP/1.1\r\nHost: %.*s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
		"Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\nUser-Agent: ermine-peer\r\n\r\n",
		path, (int)authority, url, key);
	if (n <= 0 || (size_t)n >= sizeof request || !ermStreamWrite(stream, (const uint8_t *)request, (size_t)n)) {
		return ermTransportClose(t), *error = "the opening handshake could not be sent", NULL;
	}

	// the response's head
	char *end = NULL;
	for (int waited = 0; !end; ) {
		long got = fill(t);
		if (got < 0) return ermTransportClose(t), *error = "the server closed the connection during the opening handshake", NULL;
		t->have += (size_t)got;
		for (size_t i = 3; i < t->have && !end; i++) {
			if (memcmp(t->in + t->start + i - 3, "\r\n\r\n", 4) == 0) end = (char *)t->in + t->start + i + 1;
		}
		if (!end && got == 0) {
			if (waited++ > 300) return ermTransportClose(t), *error = "no answer to the opening handshake", NULL;
			ermStreamWait(t->stream, 100);
		}
		if (t->have > 65536) return ermTransportClose(t), *error = "the opening handshake's answer is too long", NULL;
	}
	size_t headLength = (size_t)(end - (char *)(t->in + t->start));
	char *head = erm_host_malloc(headLength + 1);
	if (!head) return ermTransportClose(t), *error = "out of memory", NULL;
	memcpy(head, t->in + t->start, headLength);
	head[headLength] = 0;
	consume(t, headLength);
	bool switched = strncmp(head, "HTTP/1.1 101", 12) == 0;
	char accept[64] = { 0 }, expected[64];
	for (char *line = strstr(head, "\r\n"); line && *line; line = strstr(line + 2, "\r\n")) {
		const char *name = "\r\nsec-websocket-accept:";
		if (startsCaseless(line, name)) {
			const char *value = line + strlen(name);
			while (*value == ' ' || *value == '\t') value++;
			size_t length = strcspn(value, " \t\r\n");
			if (length < sizeof accept) memcpy(accept, value, length);
		}
	}
	erm_host_free(head);
	char joined[96];
	snprintf(joined, sizeof joined, "%s258EAFA5-E914-47DA-95CA-C5AB0DC85B11", key);
	uint8_t digest[20];
	sha1((const uint8_t *)joined, strlen(joined), digest);
	base64(digest, sizeof digest, expected);
	if (!switched) return ermTransportClose(t), *error = "the server did not switch to the WebSocket protocol", NULL;
	if (strcmp(accept, expected) != 0) return ermTransportClose(t), *error = "the server's Sec-WebSocket-Accept is wrong", NULL;
	return t;
}

int ermTransportFd(const ErmTransport *t) {
	return t && t->stream ? ermStreamFd(t->stream) : -1;
}

bool ermTransportSend(ErmTransport *t, const uint8_t *bytes, size_t length) {
	return t && !t->closed && !t->closing && frame(t, 2, bytes, length);
}

int ermTransportReceive(ErmTransport *t, uint8_t **bytes, size_t *length) {
	if (!t || t->closed) return -1;
	for (;;) {
		// a whole frame?
		if (t->have >= 2) {
			uint8_t *p = t->in + t->start;
			bool fin = p[0] & 0x80, masked = p[1] & 0x80;
			int opcode = p[0] & 0x0f;
			uint64_t size = p[1] & 0x7f;
			size_t at = 2;
			if (size == 126 && t->have >= 4) size = (uint64_t)p[2] << 8 | p[3], at = 4;
			else if (size == 127 && t->have >= 10) {
				size = 0;
				for (int i = 0; i < 8; i++) size = size << 8 | p[2 + i];
				at = 10;
			} else if (size >= 126) {
				goto more;
			}
			if (masked || size > MAX_MESSAGE || (p[0] & 0x70)) { // a server never masks; no extensions were agreed
				t->closed = true;
				return -1;
			}
			if (t->have - at < size) goto more;
			const uint8_t *payload = p + at;
			size_t n = (size_t)size;
			if (opcode == 0x9) { // ping: its pong
				frame(t, 0xa, payload, n);
			} else if (opcode == 0x8) { // close: answered, then closed
				if (!t->closing) frame(t, 0x8, payload, n >= 2 ? 2 : 0);
				t->closed = true;
				return -1;
			} else if (opcode == 0x1 || opcode == 0x2 || opcode == 0x0) {
				if ((opcode == 0 && !t->fragmented) || (opcode != 0 && t->fragmented) || t->messageLength + n > MAX_MESSAGE) {
					t->closed = true;
					return -1;
				}
				uint8_t *message = erm_host_realloc(t->message, t->messageLength + n + 1);
				if (!message) return t->closed = true, -1;
				memcpy(message + t->messageLength, payload, n);
				t->message = message;
				t->messageLength += n;
				t->fragmented = !fin;
				if (fin) {
					*bytes = t->message;
					*length = t->messageLength;
					t->message = NULL;
					t->messageLength = 0;
					consume(t, at + n);
					return 1;
				}
			} // a pong, or an opcode with no meaning here: passed over
			consume(t, at + n);
			continue;
		}
	more: {
			long got = fill(t);
			if (got < 0) return t->closed = true, -1;
			if (got == 0) return 0;
			t->have += (size_t)got;
		}
	}
}

void ermTransportClose(ErmTransport *t) {
	if (!t) return;
	if (t->stream && !t->closed) {
		t->closing = true;
		uint8_t normal[2] = { 0x03, 0xe8 }; // 1000
		frame(t, 0x8, normal, 2);
	}
	if (t->stream) ermStreamClose(t->stream);
	erm_host_free(t->in);
	erm_host_free(t->message);
	erm_host_free(t);
}
