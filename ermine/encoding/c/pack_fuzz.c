// libFuzzer target (fuzz.sh pack): arbitrary bytes read by pk_unpack and pk_decode. The first byte
// says how: 1 loosy, 2 decode (else unpack), 4 a small limit (4096), 8 the rest is the map of
// columns, deflated and put under {columns} here (so the fuzzer reaches past deflate). Checked:
// - nothing leaks, nothing reads or writes out of bounds, no undefined behaviour;
// - read strictly: loosy reads it too, the same;
// - unpacked: what came out packs (it can be carried), that unpacks the same, and packs again to
//   the same bytes (a fixed point);
// - unpacked strictly, the columns form: packing what came out gives the bytes read. pack.h: only
//   what pack writes is read. with the columns given (8), the map of columns is compared, so
//   another deflate of the same map is no find; else the whole input. found: told on stderr (the
//   first few), and with PACK_FUZZ_EXACT set, a crash;
// - decoded strictly: encoding the node gives the input exactly; loosy: encoding it decodes
//   strictly the same;
// - pk_put of a value writes what cborEncode writes for its pk_to_json, or has no encoding when
//   that has none: each node's value; the input read as one CBOR value, as it is and with every
//   map's keys reversed and a NULL item in every list and map (pk_to_json leaves them out); once,
//   values with no encoding (a stand-in with no kind, text and a key not UTF-8, CBOR_DEPTH + 1 deep).
#include "pack.h"
#include "deflate.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void die(const char *why) {
	fprintf(stderr, "fuzz: %s\n", why);
	abort();
}

static int exact = -1, told = 0;

static void hex(const uint8_t *b, size_t n) {
	for (size_t i = 0; i < n && i < 512; i++) fprintf(stderr, "%02x", b[i]);
	fputs(n > 512 ? "…\n" : "\n", stderr);
}

// a read bytes other than it: told, or a crash
static void other(const char *why, const uint8_t *b, size_t n) {
	if (exact < 0) exact = getenv("PACK_FUZZ_EXACT") != NULL;
	if (exact) {
		fputs("fuzz: ", stderr), fputs(why, stderr), fputs(": ", stderr), hex(b, n);
		die(why);
	}
	if (told++ < 5) fputs("fuzz: ", stderr), fputs(why, stderr), fputs(": ", stderr), hex(b, n);
}

// pk_put writes the value as pk_to_json and cborEncode do
static void put_same(const op_value *v) {
	Json *j = pk_to_json(v);
	size_t n = 0;
	bool want = j != NULL && cborEncode(j, NULL, 0, &n, NULL);
	uint8_t *bytes = malloc(n + 1);
	if (want) cborEncode(j, bytes, n, &n, NULL);
	CborOut o = {NULL, 0, 0, true};
	bool got = pk_put(&o, v);
	if (got != want) die(want ? "pk_put refuses a value cborEncode writes" : "pk_put writes a value with no encoding");
	if (want && (o.length != n || memcmp(o.data, bytes, n) != 0)) die("pk_put writes other bytes");
	free(o.data), free(bytes);
	jsonFree(j);
}

// the value with every map's keys in reverse and a NULL item in each list and map (recursing:
// CBOR_DEPTH at most)
static op_value *twisted(const Json *j) {
	if (j->type == JSON_ARRAY) {
		op_value *l = op_list();
		for (int i = 0; i < j->array.count; i++) {
			if (i == j->array.count / 2) op_push(l, NULL);
			op_push(l, twisted(j->array.items[i]));
		}
		if (j->array.count == 0) op_push(l, NULL);
		return l;
	}
	if (j->type == JSON_OBJECT) {
		op_value *m = op_map();
		op_set(m, "\x01none", NULL);
		for (int i = j->object.count - 1; i >= 0; i--) op_set(m, j->object.members[i].key, twisted(j->object.members[i].value));
		return m;
	}
	if (j->type == JSON_STAND) return op_stand(twisted(j->stand.kind));
	return pk_of_json(j);
}

// values with no encoding, and the deepest that has one
static void edges(void) {
	op_value *v = op_stand(NULL);
	put_same(v);
	op_free(v);
	v = op_str("a\xff");
	put_same(v);
	op_free(v);
	v = op_map();
	op_set(v, "\xc3", op_null());
	put_same(v);
	op_free(v);
	for (int deep = CBOR_DEPTH; deep <= CBOR_DEPTH + 1; deep++) {
		v = op_list();
		op_value *at = v;
		for (int i = 1; i < deep; i++) {
			op_value *in = i % 3 ? op_list() : op_map();
			if (at->type == OP_MAP) op_set(at, "k", in);
			else op_push(at, in);
			at = in;
		}
		put_same(v);
		op_free(v);
	}
}

// a node's encoding, fresh; free it
static pk_bytes encoded(const nd_entry *n) {
	if (n->value != NULL) put_same(n->value);
	pk_bytes b = {0};
	if (pk_encode(n, NULL, &b) != PK_OK) die("a node read cannot be encoded");
	return b;
}

static size_t number(const pk_read *r, const nd_entry *n) {
	for (size_t k = 0; k < r->count; k++)
		if (r->nodes[k] == n) return k;
	die("an entry's node is not one of the nodes");
	return 0;
}

// two reads the same: keys, numbering, each node's encoding
static int same(const pk_read *a, const pk_read *b) {
	if (a->length != b->length || a->count != b->count) return 0;
	for (size_t i = 0; i < a->length; i++) {
		const pk_entry *x = &a->entries[i], *y = &b->entries[i];
		if (strcmp(x->part.string, y->part.string) != 0 || strcmp(x->id.string, y->id.string) != 0) return 0;
		if (number(a, x->node) != number(b, y->node)) return 0;
	}
	for (size_t k = 0; k < a->count; k++) {
		pk_bytes x = encoded(a->nodes[k]), y = encoded(b->nodes[k]);
		int ok = x.length == y.length && memcmp(x.data, y.data, x.length) == 0;
		free(x.data), free(y.data);
		if (!ok) return 0;
	}
	return 1;
}

// what came out, packed; free it
static pk_bytes repacked(const pk_read *r) {
	pk_bytes b = {0};
	const pk_entry *at = NULL;
	if (pk_pack(r->entries, r->length, NULL, &b, &at) != PK_OK) die("what unpack gave cannot be packed");
	return b;
}

// the map of columns in a pack: inflated, fresh; free it
static uint8_t *inner(const pk_bytes *b, size_t *n) {
	// a1 67 "columns", a byte string's head, the deflate
	size_t at = 9, length;
	uint8_t h = b->data[at++];
	if ((h >> 5) != 2) die("pack wrote no byte string");
	h &= 31;
	if (h < 24) length = h;
	else {
		int k = h == 24 ? 1 : h == 25 ? 2 : 4;
		length = 0;
		for (int i = 0; i < k; i++) length = length << 8 | b->data[at++];
	}
	uint8_t *out;
	if (df_inflate(b->data + at, length, (size_t)1 << 30, &out, n) != DF_OK) die("pack wrote no deflate");
	return out;
}

static void unpacked(const uint8_t *in, size_t n, int loosy, size_t limit, const uint8_t *columns,
	size_t cn) {
	pk_reading reading = {.loosy = loosy, .limit = limit};
	pk_read r;
	pk_code code = pk_unpack(in, n, &reading, &r);
	if (code != PK_OK) {
		if (code != PK_NOT_A_PACK) die("unpack refused other than not-a-pack");
		if (r.entries != NULL || r.nodes != NULL || r.own != NULL) die("refused, something made");
		pk_free(&r);
		return;
	}
	if (!loosy) {
		pk_reading loose = {.loosy = 1, .limit = limit};
		pk_read l;
		if (pk_unpack(in, n, &loose, &l) != PK_OK) die("taken strictly, refused loosy");
		if (!same(&r, &l)) die("loosy reads it otherwise");
		pk_free(&l);
	}
	pk_bytes b = repacked(&r);
	pk_read back;
	if (pk_unpack(b.data, b.length, NULL, &back) != PK_OK) die("a pack of what came out is refused");
	if (!same(&r, &back)) die("packed and unpacked, another read");
	pk_bytes again = repacked(&back);
	if (again.length != b.length || memcmp(again.data, b.data, b.length) != 0) die("packing again differs");
	// the columns form read strictly: what pack writes, and only that
	if (!loosy && n > 0 && in[0] == 0xa1) {
		if (columns != NULL) {
			size_t wn;
			uint8_t *w = inner(&b, &wn);
			if (wn != cn || memcmp(w, columns, cn) != 0) other("columns taken that pack does not write", columns, cn);
			free(w);
		} else if (b.length != n || memcmp(b.data, in, n) != 0) other("a pack taken that pack does not write", in, n);
	}
	free(b.data), free(again.data);
	pk_free(&back);
	pk_free(&r);
}

static void decoded(const uint8_t *in, size_t n, int loosy, size_t limit) {
	pk_reading reading = {.loosy = loosy, .limit = limit};
	pk_read r;
	pk_code code = pk_decode(in, n, &reading, &r);
	if (code != PK_OK) {
		if (code != PK_NOT_A_NODE) die("decode refused other than not-a-node");
		pk_free(&r);
		return;
	}
	if (r.count != 1 || r.length != 0) die("decode gave other than one node");
	pk_bytes b = encoded(r.nodes[0]);
	if (!loosy && (b.length != n || memcmp(b.data, in, n) != 0)) die("a node taken that encode does not write");
	if (loosy) {
		pk_read back;
		if (pk_decode(b.data, b.length, NULL, &back) != PK_OK) die("an encoding of a node read is refused");
		pk_bytes again = encoded(back.nodes[0]);
		if (again.length != b.length || memcmp(again.data, b.data, b.length) != 0) die("encoding again differs");
		free(again.data);
		pk_free(&back);
	} else {
		pk_reading loose = {.loosy = 1, .limit = limit};
		pk_read l;
		if (pk_decode(in, n, &loose, &l) != PK_OK) die("decoded strictly, refused loosy");
		pk_bytes x = encoded(l.nodes[0]);
		if (x.length != b.length || memcmp(x.data, b.data, b.length) != 0) die("loosy decodes it otherwise");
		free(x.data);
		pk_free(&l);
	}
	free(b.data);
	pk_free(&r);
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
	if (size == 0) return 0;
	int how = data[0], loosy = how & 1;
	size_t limit = how & 4 ? 4096 : 0;
	// the rest in a buffer of its own size, so a read past it is caught
	size_t n = size - 1;
	uint8_t *in = malloc(n ? n : 1);
	memcpy(in, data + 1, n);
	static int once;
	if (!once++) edges();
	Json *j = cborDecode(in, n, NULL, NULL);
	if (j != NULL) {
		op_value *v = pk_of_json(j), *t = twisted(j);
		put_same(v), put_same(t);
		op_free(v), op_free(t);
		jsonFree(j);
	}
	if (how & 2) decoded(in, n, loosy, limit);
	else if (how & 8) {
		uint8_t *z;
		size_t zn;
		df_deflate(in, n, &z, &zn);
		pk_bytes w = {0};
		uint8_t h[5] = {0x5a, (uint8_t)(zn >> 24), (uint8_t)(zn >> 16), (uint8_t)(zn >> 8), (uint8_t)zn};
		size_t hn = zn < 24 ? 1 : zn < 0x100 ? 2 : zn < 0x10000 ? 3 : 5;
		if (hn == 1) h[0] = (uint8_t)(0x40 | zn);
		else if (hn == 2) h[0] = 0x58, h[1] = (uint8_t)zn;
		else if (hn == 3) h[0] = 0x59, h[1] = (uint8_t)(zn >> 8), h[2] = (uint8_t)zn;
		w.data = malloc(9 + hn + zn);
		memcpy(w.data, "\xa1\x67" "columns", 9);
		memcpy(w.data + 9, h, hn);
		memcpy(w.data + 9 + hn, z, zn);
		w.length = 9 + hn + zn;
		unpacked(w.data, w.length, loosy, limit, in, n);
		free(w.data), free(z);
	} else unpacked(in, n, loosy, limit, NULL, 0);
	free(in);
	return 0;
}
