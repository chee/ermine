// tippet's own cbor (wire.h)
#include "wire.h"

#include <stdbool.h>
#include <string.h>

// ermine/encoding/c/cbor.h's, declared here: that header is C11 (its json.h)
bool cborCheck(const unsigned char *data, size_t length, const char **why, size_t *at);

void *tp_alloc(const tp_mem *mem, size_t size) { return mem->fn(mem->ctx, NULL, 0, size); }
void *tp_grow(const tp_mem *mem, void *p, size_t old, size_t size) {
	return mem->fn(mem->ctx, p, old, size);
}
void tp_free(const tp_mem *mem, void *p, size_t size) {
	if (p) mem->fn(mem->ctx, p, size, 0);
}

int tp_head(tp_in *in, int *major, uint64_t *arg) {
	if (in->p >= in->end) return -1;
	uint8_t b = *in->p++;
	unsigned info = b & 31;
	*major = b >> 5;
	if (*major == 7) {
		size_t skip = info == 24 ? 1 : info == 25 ? 2 : info == 26 ? 4 : info == 27 ? 8 : 0;
		if (info > 27 || (size_t)(in->end - in->p) < skip) return -1;
		in->p += skip;
		*arg = info;
		return 0;
	}
	if (info < 24) {
		*arg = info;
		return 0;
	}
	if (info > 27) return -1;
	size_t n = (size_t)1 << (info - 24);
	if ((size_t)(in->end - in->p) < n) return -1;
	uint64_t v = 0;
	for (size_t i = 0; i < n; i++) v = v << 8 | *in->p++;
	*arg = v;
	return 0;
}

// no recursion: how many items are still to pass
int tp_skip(tp_in *in, tp_span *item) {
	const uint8_t *start = in->p;
	uint64_t left = 1;
	while (left) {
		int major;
		uint64_t arg;
		if (tp_head(in, &major, &arg)) return -1;
		left--;
		size_t room = (size_t)(in->end - in->p);
		if (major == 2 || major == 3) {
			if (arg > room) return -1;
			in->p += arg;
		} else if (major == 4 || major == 5) {
			// every item at least a byte
			if (arg > room || (major == 5 && arg > room / 2)) return -1;
			left += major == 5 ? 2 * arg : arg;
		} else if (major == 6) {
			left++;
		}
		if (left > room) return -1;
	}
	if (item) item->p = start, item->n = (size_t)(in->p - start);
	return 0;
}

int tp_whole(tp_in *in, uint64_t *out) {
	int major;
	if (tp_head(in, &major, out) || major != 0 || *out > TP_WHOLE) return -1;
	return 0;
}

int tp_int(tp_in *in, int64_t *out) {
	int major;
	uint64_t arg;
	if (tp_head(in, &major, &arg) || major > 1 || arg > TP_WHOLE - (major == 1)) return -1;
	*out = major ? -1 - (int64_t)arg : (int64_t)arg;
	return 0;
}

int tp_bytes(tp_in *in, size_t want, tp_span *out) {
	int major;
	uint64_t arg;
	if (tp_head(in, &major, &arg) || major != 2 || arg > (uint64_t)(in->end - in->p)) return -1;
	if (want && arg != want) return -1;
	out->p = in->p, out->n = (size_t)arg;
	in->p += arg;
	return 0;
}

int tp_text(tp_in *in, tp_span *out) {
	int major;
	uint64_t arg;
	if (tp_head(in, &major, &arg) || major != 3 || arg > (uint64_t)(in->end - in->p)) return -1;
	out->p = in->p, out->n = (size_t)arg;
	in->p += arg;
	return 0;
}

static int container(tp_in *in, int want, uint64_t *count) {
	int major;
	if (tp_head(in, &major, count) || major != want) return -1;
	return *count > (uint64_t)(in->end - in->p) ? -1 : 0;
}
int tp_array(tp_in *in, uint64_t *count) { return container(in, 4, count); }
int tp_map(tp_in *in, uint64_t *count) { return container(in, 5, count); }

int tp_null(tp_in *in) {
	if (in->p < in->end && *in->p == 0xf6) return in->p++, 1;
	return 0;
}

int tp_is(tp_span t, const char *s) { return strlen(s) == t.n && !memcmp(t.p, s, t.n); }

int tp_canonical(const uint8_t *p, size_t n) { return cborCheck(p, n, NULL, NULL); }

uint8_t *tp_reserve(tp_buf *b, size_t n) {
	if (b->bad) return NULL;
	if (n > b->max - b->len || b->len > b->max) {
		b->bad = TP_BOUND;
		return NULL;
	}
	if (b->len + n > b->cap && b->mem) {
		size_t cap = b->cap ? b->cap : 64;
		while (cap < b->len + n) cap = cap > b->max / 2 ? b->max : cap * 2;
		uint8_t *q = tp_grow(b->mem, b->p, b->cap, cap);
		if (!q) {
			b->bad = TP_NOMEM;
			return NULL;
		}
		b->p = q, b->cap = cap;
	}
	uint8_t *at = b->len + n <= b->cap ? b->p + b->len : NULL;
	b->len += n;
	return at;
}

void tp_put(tp_buf *b, const void *p, size_t n) {
	uint8_t *at = tp_reserve(b, n);
	if (at && n) memcpy(at, p, n);
}

void tp_put_head(tp_buf *b, int major, uint64_t arg) {
	uint8_t h[9];
	size_t n = 1;
	if (arg < 24) {
		h[0] = (uint8_t)(major << 5 | arg);
	} else {
		int size = arg <= 0xff ? 1 : arg <= 0xffff ? 2 : arg <= 0xffffffff ? 4 : 8;
		h[0] = (uint8_t)(major << 5 | (size == 1 ? 24 : size == 2 ? 25 : size == 4 ? 26 : 27));
		for (int i = size; i > 0; i--) h[n++] = (uint8_t)(arg >> (8 * (i - 1)));
	}
	tp_put(b, h, n);
}

void tp_put_int(tp_buf *b, int64_t v) {
	if (v < 0) tp_put_head(b, 1, (uint64_t)(-1 - v));
	else tp_put_head(b, 0, (uint64_t)v);
}

void tp_put_text(tp_buf *b, const char *s) {
	size_t n = strlen(s);
	tp_put_head(b, 3, n);
	tp_put(b, s, n);
}

void tp_buf_free(tp_buf *b) {
	if (b->mem) tp_free(b->mem, b->p, b->cap);
	b->p = NULL, b->cap = b->len = 0;
}

int tp_buf_why(const tp_buf *b) { return b->bad; }
