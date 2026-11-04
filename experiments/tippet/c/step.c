// A step is one kept write as it travels (../WIRE.md), read in place and never encoded twice.
#include <string.h>

#include "../../../lib/blake3/c/blake3/blake3.h"
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
		case TP_SIGNATURE: return "signature";
		case TP_BEFORE: return "before";
		case TP_FORK: return "fork";
		case TP_LATE: return "late, and the steps after it let go";
		default: return "unknown";
	}
}

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

static int range(tp_in *in, uint64_t *from, uint64_t *to) {
	uint64_t k;
	return tp_array(in, &k) || k != 2 || tp_whole(in, from) || tp_whole(in, to) ? -1 : 0;
}

static int move(tp_in *in, tp_patch *q) {
	const uint8_t *start = in->p;
	uint64_t k;
	int pathed = 0;
	if (tp_map(in, &k) || k < 1 || k > 2) return -1;
	for (uint64_t i = 0; i < k; i++) {
		tp_span key, p;
		if (tp_text(in, &key)) return -1;
		if (tp_is(key, "path") && !path(in, &p)) pathed = 1, q->mpath = p;
		else if (!tp_is(key, "range") || range(in, &q->mfrom, &q->mto)) return -1;
		else q->mranged = 1;
	}
	q->move.p = start, q->move.n = (size_t)(in->p - start);
	return pathed ? 0 : -1;
}

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
			: tp_is(key, "move")  ? move(in, p)
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
	tp_in in = {s->on.p + *at, s->on.p + s->on.n};
	uint64_t k;
	if (*at == 0 && tp_array(&in, &k)) return -1;
	if (in.p == in.end) return 1;
	if (on_item(&in, s->device, s->n, device, n)) return -1;
	*at = (size_t)(in.p - s->on.p);
	return 0;
}

// an element id as written: this device's x (whole or negative) or [x, k] (x whole, below n);
// another's [device, seq] or [device, n, k] (n from 1)
static int id_item(tp_in *in, const uint8_t *device, uint64_t n) {
	uint64_t k, a, b;
	int64_t x;
	tp_span key;
	if (in->p < in->end && *in->p >> 5 <= 1) {
		if (tp_int(in, &x)) return -1;
		return x >= 0 ? ((uint64_t)x > TP_WHOLE ? -1 : 0) : ((uint64_t)-x > TP_WHOLE ? -1 : 0);
	}
	if (tp_array(in, &k)) return -1;
	if (in->p < in->end && *in->p >> 5 == 0) {
		return k != 2 || tp_whole(in, &a) || a >= n || tp_whole(in, &b) ? -1 : 0;
	}
	if (k < 2 || k > 3 || tp_bytes(in, 32, &key) || !memcmp(key.p, device, 32) || tp_whole(in, &a)) return -1;
	return k == 3 && (a < 1 || tp_whole(in, &b)) ? -1 : 0;
}

uint64_t tp_patch_made(const tp_patch *p) {
	uint64_t made = 0, k;
	if (p->move.p) return !p->ranged ? 0 : p->mranged ? (p->mto > p->mfrom ? p->mto - p->mfrom : 0) : 1;
	if (!p->ranged || !p->value.p) return 0;
	tp_in in = {p->value.p, p->value.p + p->value.n};
	tp_span t;
	if (*in.p >> 5 == 3 && !tp_text(&in, &t)) {
		for (size_t i = 0; i < t.n; i++) made += (t.p[i] & 0xc0) != 0x80;
	} else if (*in.p >> 5 == 4 && !tp_array(&in, &k)) made = k;
	return made;
}

uint64_t tp_step_made(const tp_step *s) {
	size_t at = 0;
	uint64_t made = 0;
	tp_patch p;
	while (!tp_patch_next(s->patches, &at, &p)) made += tp_patch_made(&p);
	return made;
}

// a node as written: this device's [n, i, rel…] (n from 1 to the step's, and the step's only with i
// below the patch's index at), another's [device, n, i, rel…] (n from 1); rel: text or whole
static int node_item(tp_in *in, const uint8_t *device, uint64_t n, uint64_t at) {
	uint64_t k, a, b;
	tp_span key;
	if (tp_array(in, &k) || k < 2 || in->p >= in->end) return -1;
	if (*in->p >> 5 == 0) {
		if (tp_whole(in, &a) || a < 1 || a > n || tp_whole(in, &b) || (a == n && b >= at)) return -1;
		k -= 2;
	} else {
		if (k < 3 || tp_bytes(in, 32, &key) || !memcmp(key.p, device, 32) || tp_whole(in, &a) || a < 1 ||
			tp_whole(in, &b))
			return -1;
		k -= 3;
	}
	for (; k; k--) {
		tp_span t;
		if (in->p >= in->end) return -1;
		if (*in->p >> 5 == 3 ? tp_text(in, &t) : tp_whole(in, &a)) return -1;
	}
	return 0;
}
// a path's length, and whether it ends in a whole
static uint64_t path_end(tp_span path, int *whole) {
	tp_in in = {path.p, path.p + path.n};
	uint64_t k;
	tp_span item;
	tp_array(&in, &k);
	*whole = 0;
	for (uint64_t i = 0; i < k; i++) *whole = *in.p >> 5 == 0, tp_skip(&in, &item);
	return k;
}

// the path of a list move's source is the path of its array, then (an item) a place, or the same
// (a range)
static int move_paths(const tp_patch *p) {
	uint64_t k, mk;
	tp_in a = {p->path.p, p->path.p + p->path.n}, b = {p->mpath.p, p->mpath.p + p->mpath.n};
	if (tp_array(&a, &k) || tp_array(&b, &mk)) return 0;
	size_t an = (size_t)(a.end - a.p), bn = (size_t)(b.end - b.p);
	if (p->mranged) return mk == k && an == bn && !memcmp(a.p, b.p, an);
	return mk == k + 1 && bn > an && !memcmp(a.p, b.p, an) && b.p[an] >> 5 == 0;
}
// a list move: an item, or at most 4096 items, of an array to a gap in the same array
static int list_move(const tp_patch *p) {
	if (!p->move.p || !p->ranged || p->from != p->to || p->value.p) return 0;
	if (p->mranged && !(p->mto > p->mfrom && p->mto - p->mfrom <= 4096)) return 0;
	return move_paths(p);
}

// the ids: one per patch: its container (a node; null only for a put of the whole value) and
//   a put or removal at a key, or of the whole value: [container, pred]    pred: array of nodes
//   a put at an index of an array: [container, pred, element]
//   a splice (a patch with a range), a removal at an index, a list move: [container, after, gone,
//   before]; a list move's gone is what it moves, in order, their counts summing to what it moves
// before null for the end, true for after's own (after not null)
static int ids_item(tp_in *in, const tp_step *s, const uint8_t *device) {
	uint64_t k, two, g;
	size_t at = 0;
	tp_patch p;
	if (tp_array(in, &k) || k != s->count) return -1;
	for (uint64_t i = 0; i < k; i++) {
		if (tp_patch_next(s->patches, &at, &p)) return -1;
		if (tp_null(in) || tp_array(in, &two)) return -1;
		if (p.move.p && !list_move(&p)) return -1;
		int whole;
		uint64_t len = path_end(p.path, &whole);
		int sliced = p.ranged || (whole && !p.value.p), cnull = tp_null(in);
		if (cnull ? len || p.ranged : node_item(in, device, s->n, i)) return -1;
		if (!sliced) {
			if (tp_array(in, &g)) return -1;
			for (uint64_t j = 0; j < g; j++) {
				if (node_item(in, device, s->n, i)) return -1;
			}
			if (whole ? two != 3 || cnull || id_item(in, device, s->n) : two != 2) return -1;
			continue;
		}
		if (two != 4 || cnull) return -1;
		int after = !tp_null(in);
		if (after && id_item(in, device, s->n)) return -1;
		if (tp_array(in, &g)) return -1;
		uint64_t one = 0, total = 0;
		for (uint64_t j = 0; j < g; j++) {
			uint64_t pair, count;
			if (tp_array(in, &pair) || pair != 2 || id_item(in, device, s->n) || tp_whole(in, &count) || count < 1)
				return -1;
			one = count;
			total = count > TP_WHOLE - total ? TP_WHOLE : total + count;
		}
		if (p.move.p && total != (p.mranged ? p.mto - p.mfrom : 1)) return -1;
		int before = 0;
		if (in->p < in->end && *in->p == 0xf5) {
			if (!after) return -1;
			in->p++, before = 1;
		} else if (in->p < in->end && *in->p == 0xf6) in->p++;
		else if (id_item(in, device, s->n)) return -1;
		else before = 1;
		// a removal at an index: no after, the one element, no before
		if (!p.ranged && (after || g != 1 || one != 1 || before)) return -1;
	}
	return 0;
}

int tp_step_decode(const uint8_t *bytes, size_t length, tp_step *s) {
	tp_in in = {bytes, bytes + length};
	tp_span device, before = {0};
	uint64_t items, k;
	memset(s, 0, sizeof *s);
	if (!tp_canonical(bytes, length)) return TP_NOTSTEP;
	int deeper = tp_deeper(bytes, length, TP_DEPTH);
	if (deeper) return deeper < 0 ? TP_NOMEM : TP_NOTSTEP;
	if (tp_array(&in, &items) || items < 11 || items > 12) return TP_NOTSTEP;
	if (tp_bytes(&in, 32, &device) || tp_whole(&in, &s->n) || s->n < 1) return TP_NOTSTEP;
	if (!tp_null(&in) && tp_bytes(&in, 32, &before)) return TP_NOTSTEP;
	if (in.p < in.end && *in.p == 0x81) {
		in.p++, s->relative = 1;
		if (tp_text(&in, &s->node) || (s->node.n && *s->node.p != '/')) return TP_NOTSTEP;
	} else if (tp_text(&in, &s->node)) return TP_NOTSTEP;
	if (tp_text(&in, &s->part)) return TP_NOTSTEP;
	if (memchr(s->node.p, 0, s->node.n) || memchr(s->part.p, 0, s->part.n)) return TP_NOTSTEP;
	const uint8_t *start = in.p;
	if (tp_array(&in, &k)) return TP_NOTSTEP;
	s->count = (size_t)k;
	tp_patch p;
	for (uint64_t i = 0; i < k; i++) {
		if (patch(&in, &p)) return TP_NOTSTEP;
	}
	s->patches.p = start, s->patches.n = (size_t)(in.p - start);
	if (tp_whole(&in, &s->lamport) || tp_whole(&in, &s->when) || tp_whole(&in, &s->seq)) return TP_NOTSTEP;
	if (s->seq > TP_WHOLE - tp_step_made(s)) return TP_NOTSTEP;
	if (in.p >= in.end || *in.p >> 5 != 4) return TP_NOTSTEP;
	const uint8_t *d;
	uint64_t m;
	start = in.p;
	if (tp_array(&in, &k)) return TP_NOTSTEP;
	for (uint64_t i = 0; i < k; i++) {
		if (on_item(&in, device.p, s->n, &d, &m)) return TP_NOTSTEP;
	}
	s->on.p = start, s->on.n = (size_t)(in.p - start);
	if (in.p >= in.end || *in.p >> 5 != 4) return TP_NOTSTEP;
	start = in.p;
	if (ids_item(&in, s, device.p)) return TP_NOTSTEP;
	s->ids.p = start, s->ids.n = (size_t)(in.p - start);
	if (items == 12 && tp_text(&in, &s->who)) return TP_NOTSTEP;
	if (in.p != in.end) return TP_NOTSTEP;
	s->bytes.p = bytes, s->bytes.n = length;
	s->device = device.p, s->before = before.p;
	return 0;
}

static void encode(tp_buf *b, const tp_step *s) {
	tp_put_head(b, 4, 11 + (s->who.p != NULL));
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
	tp_put_head(b, 0, s->seq);
	tp_put(b, s->on.p, s->on.n);
	tp_put(b, s->ids.p, s->ids.n);
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
