// a step: one kept write, as it travels (../WIRE.md step). a step is its bytes: read in place,
// never encoded twice
#include <string.h>

#include "../../../ermine/encoding/c/blake3/blake3.h"
#include "wire.h"

const char *tp_why(int code) {
	switch (code) {
		case 0: return "ok";
		case TP_NOMEM: return "no memory";
		case TP_BOUND: return "past a bound";
		case TP_NOTSTEP: return "not a step";
		case TP_STORE: return "the store failed";
		case TP_NOKEY: return "this log writes nothing";
		case TP_END: return "lamport is at its end";
		case TP_KEY: return "this store has a key of its own";
		case TP_OWN: return "own";
		case TP_GAP: return "gap";
		case TP_CHAIN: return "chain";
		case TP_LAMPORT: return "lamport";
		case TP_SIGNATURE: return "signature";
		case TP_BEFORE: return "before";
		default: return "unknown";
	}
}

// a path: names and whole numbers
static int path(tp_in *in, tp_span *out) {
	const uint8_t *start = in->p;
	uint64_t k;
	if (tp_array(in, &k)) return -1;
	for (uint64_t i = 0; i < k; i++) {
		tp_span s;
		uint64_t w;
		if (in->p < in->end && *in->p >> 5 == 3 ? tp_text(in, &s) : tp_whole(in, &w)) return -1;
	}
	out->p = start, out->n = (size_t)(in->p - start);
	return 0;
}

// a range: two whole numbers
static int range(tp_in *in, uint64_t *from, uint64_t *to) {
	uint64_t k;
	return tp_array(in, &k) || k != 2 || tp_whole(in, from) || tp_whole(in, to) ? -1 : 0;
}

// a move: {path, range?}
static int move(tp_in *in, tp_span *out) {
	const uint8_t *start = in->p;
	uint64_t k, from, to;
	int pathed = 0;
	if (tp_map(in, &k) || k < 1 || k > 2) return -1;
	for (uint64_t i = 0; i < k; i++) {
		tp_span key, p;
		if (tp_text(in, &key)) return -1;
		if (tp_is(key, "path") && !path(in, &p)) pathed = 1;
		else if (!tp_is(key, "range") || range(in, &from, &to)) return -1;
	}
	out->p = start, out->n = (size_t)(in->p - start);
	return pathed ? 0 : -1;
}

// a patch: {path, range?, value?, move?}
static int patch(tp_in *in, tp_patch *p) {
	uint64_t k;
	memset(p, 0, sizeof *p);
	if (tp_map(in, &k) || k < 1 || k > 4) return -1;
	for (uint64_t i = 0; i < k; i++) {
		tp_span key;
		if (tp_text(in, &key)) return -1;
		int bad = tp_is(key, "path")    ? path(in, &p->path)
			: tp_is(key, "range") ? (p->ranged = 1, range(in, &p->from, &p->to))
			: tp_is(key, "value") ? tp_skip(in, &p->value)
			: tp_is(key, "move")  ? move(in, &p->move)
					      : -1;
		if (bad) return -1;
	}
	return p->path.p ? 0 : -1;
}

int tp_patch_next(tp_span patches, size_t *at, tp_patch *p) {
	tp_in in = {patches.p + *at, patches.p + patches.n};
	uint64_t k;
	if (*at == 0 && tp_array(&in, &k)) return -1;
	if (in.p == in.end) return 1;
	if (patch(&in, p)) return -1;
	*at = (size_t)(in.p - patches.p);
	return 0;
}

// one of on's: this device's step n - k (k from 1, n - k from 1), or another's [device, n from 1].
// 0, or -1
static int on_item(tp_in *in, const uint8_t *device, uint64_t n, const uint8_t **d, uint64_t *m) {
	uint64_t k;
	tp_span key;
	if (in->p < in->end && *in->p >> 5 == 0) {
		if (tp_whole(in, &k) || k < 1 || k >= n) return -1;
		*d = device, *m = n - k;
		return 0;
	}
	if (tp_array(in, &k) || k != 2 || tp_bytes(in, 32, &key) || tp_whole(in, m) || *m < 1) return -1;
	if (!memcmp(key.p, device, 32)) return -1;
	*d = key.p;
	return 0;
}

int tp_on_next(const tp_step *s, size_t *at, const uint8_t **device, uint64_t *n) {
	if (!s->on.p) return 1;
	tp_in in = {s->on.p + *at, s->on.p + s->on.n};
	uint64_t k;
	if (*at == 0 && tp_array(&in, &k)) return -1;
	if (in.p == in.end) return 1;
	if (on_item(&in, s->device, s->n, device, n)) return -1;
	*at = (size_t)(in.p - s->on.p);
	return 0;
}

int tp_step_decode(const uint8_t *bytes, size_t length, tp_step *s) {
	tp_in in = {bytes, bytes + length};
	tp_span device, before = {0};
	uint64_t items, k;
	memset(s, 0, sizeof *s);
	if (!tp_canonical(bytes, length)) return TP_NOTSTEP;
	if (tp_array(&in, &items) || items < 8 || items > 10) return TP_NOTSTEP;
	if (tp_bytes(&in, 32, &device) || tp_whole(&in, &s->n) || s->n < 1) return TP_NOTSTEP;
	if (!tp_null(&in) && tp_bytes(&in, 32, &before)) return TP_NOTSTEP;
	// node: its id, or [the rest after the device's own id], "" or "/…"
	if (in.p < in.end && *in.p == 0x81) {
		in.p++, s->relative = 1;
		if (tp_text(&in, &s->node) || (s->node.n && *s->node.p != '/')) return TP_NOTSTEP;
	} else if (tp_text(&in, &s->node)) return TP_NOTSTEP;
	if (tp_text(&in, &s->part)) return TP_NOTSTEP;
	const uint8_t *start = in.p;
	if (tp_array(&in, &k)) return TP_NOTSTEP;
	s->count = (size_t)k;
	tp_patch p;
	for (uint64_t i = 0; i < k; i++) {
		if (patch(&in, &p)) return TP_NOTSTEP;
	}
	s->patches.p = start, s->patches.n = (size_t)(in.p - start);
	if (tp_whole(&in, &s->lamport) || tp_whole(&in, &s->when)) return TP_NOTSTEP;
	// on: an array, when the step says
	if (items > 8 && in.p < in.end && *in.p >> 5 == 4) {
		const uint8_t *d;
		uint64_t m;
		start = in.p;
		if (tp_array(&in, &k)) return TP_NOTSTEP;
		for (uint64_t i = 0; i < k; i++) {
			if (on_item(&in, device.p, s->n, &d, &m)) return TP_NOTSTEP;
		}
		s->on.p = start, s->on.n = (size_t)(in.p - start);
	}
	if (items == 9 + !!s->on.p && tp_text(&in, &s->who)) return TP_NOTSTEP;
	if (items > 9 + !!s->on.p || in.p != in.end) return TP_NOTSTEP;
	s->bytes.p = bytes, s->bytes.n = length;
	s->device = device.p, s->before = before.p;
	return 0;
}

// [device, n, before, node, part, patches, lamport, when, on?, who?]
static void encode(tp_buf *b, const tp_step *s) {
	tp_put_head(b, 4, 8 + (s->on.p != NULL) + (s->who.p != NULL));
	tp_put_head(b, 2, 32);
	tp_put(b, s->device, 32);
	tp_put_head(b, 0, s->n);
	if (s->before) tp_put_head(b, 2, 32), tp_put(b, s->before, 32);
	else tp_put(b, "\xf6", 1);
	if (s->relative) tp_put_head(b, 4, 1);
	tp_put_head(b, 3, s->node.n);
	tp_put(b, s->node.p, s->node.n);
	tp_put_head(b, 3, s->part.n);
	tp_put(b, s->part.p, s->part.n);
	tp_put(b, s->patches.p, s->patches.n);
	tp_put_head(b, 0, s->lamport);
	tp_put_head(b, 0, s->when);
	if (s->on.p) tp_put(b, s->on.p, s->on.n);
	if (s->who.p) tp_put_head(b, 3, s->who.n), tp_put(b, s->who.p, s->who.n);
}

size_t tp_step_encode(const tp_step *s, uint8_t *out, size_t cap) {
	tp_buf b = {out, 0, cap, (size_t)-1, NULL, 0};
	encode(&b, s);
	return b.len;
}

size_t tp_step_node(const tp_step *s, char *out, size_t cap) {
	size_t n = (s->relative ? TP_OWN_ID : 0) + s->node.n;
	if (n > cap) return n;
	if (s->relative) memcpy(out, "ermine:ed01", 11), tp_hex(out + 11, s->device, 32);
	if (s->node.n) memcpy(out + n - s->node.n, s->node.p, s->node.n);
	return n;
}

long tp_step_rest(const uint8_t device[32], tp_span node) {
	char own[TP_OWN_ID];
	memcpy(own, "ermine:ed01", 11), tp_hex(own + 11, device, 32);
	if (node.n < TP_OWN_ID || memcmp(node.p, own, TP_OWN_ID)) return -1;
	if (node.n > TP_OWN_ID && node.p[TP_OWN_ID] != '/') return -1;
	return (long)(node.n - TP_OWN_ID);
}

void tp_step_hash(const uint8_t *bytes, size_t length, uint8_t hash[32]) {
	blake3_hasher h;
	blake3_hasher_init(&h);
	blake3_hasher_update(&h, bytes, length);
	blake3_hasher_finalize(&h, hash, 32);
}
