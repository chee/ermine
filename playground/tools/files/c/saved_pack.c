#include "saved_pack.h"

#include "../../../../ermine/encoding/c/cbor.h"
#include "../../../../ermine/encoding/c/json.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

// room for need items of size in *p, *capacity long
static int grow(void *p, size_t *capacity, size_t need, size_t size) {
	if (need <= *capacity) return 1;
	size_t c = *capacity ? *capacity * 2 : 16;
	while (c < need) c *= 2;
	void *q = realloc(*(void **)p, c * size);
	if (q == NULL) return 0;
	*(void **)p = q;
	*capacity = c;
	return 1;
}

// --- writing ---

void sp_put(sp_bytes *b, const void *data, size_t length) {
	if (b->failed) return;
	if (!grow(&b->data, &b->capacity, b->length + length, 1)) {
		b->failed = 1;
		return;
	}
	memcpy(b->data + b->length, data, length);
	b->length += length;
}

// --- reading CBOR ---

// everything decode allocates but the nodes and the graph's arrays
typedef struct {
	void **items;
	size_t length, capacity;
} arena;

typedef struct {
	const uint8_t *p, *end;
	int bad, oom;
	arena *own;
	const sp_codec *codec;
} reader;

static void *take(reader *r, size_t size) {
	void *p = malloc(size ? size : 1);
	if (p == NULL || !grow(&r->own->items, &r->own->capacity, r->own->length + 1, sizeof(void *))) {
		free(p);
		r->oom = 1;
		return NULL;
	}
	return r->own->items[r->own->length++] = p;
}

static int failed(reader *r) {
	return r->bad || r->oom;
}

// a head: its major type, *arg; *ai its additional information
static int next(reader *r, uint64_t *arg, int *ai) {
	*arg = 0;
	if (failed(r) || r->p >= r->end) return r->bad = 1, -1;
	uint8_t b = *r->p++;
	*ai = b & 31;
	if (*ai < 24) *arg = (uint64_t)*ai;
	else if (*ai <= 27) {
		size_t n = (size_t)1 << (*ai - 24);
		if ((size_t)(r->end - r->p) < n) return r->bad = 1, -1;
		for (size_t i = 0; i < n; i++) *arg = *arg << 8 | *r->p++;
	} else return r->bad = 1, -1;
	return b >> 5;
}

// a length of at most what is left: each item at least a byte
static int fits(reader *r, uint64_t n) {
	if (n > (uint64_t)(r->end - r->p)) r->bad = 1;
	return !r->bad;
}

// one item of any kind, without reading it: no recursion, so a value may nest as deep as the
// input is long (cbor.c's decoder is the same)
static void skip(reader *r) {
	uint64_t pending = 1; // items still to pass
	while (pending && !failed(r)) {
		uint64_t n;
		int ai, major = next(r, &n, &ai);
		if (failed(r)) return;
		pending--;
		switch (major) {
		case 2:
		case 3:
			if (fits(r, n)) r->p += n;
			break;
		case 4:
			if (fits(r, n)) pending += n;
			break;
		case 5:
			if (fits(r, n)) pending += 2 * n;
			break;
		case 6: pending++; break;
		}
	}
}

static uint64_t expect(reader *r, int major) {
	uint64_t n;
	int ai;
	if (next(r, &n, &ai) != major) r->bad = 1;
	if (major >= 2 && major <= 5 && !failed(r)) fits(r, major == 5 ? 2 * n : n);
	return failed(r) ? 0 : n;
}

// a key, in place
static int key(reader *r, const uint8_t **s, size_t *n) {
	*n = (size_t)expect(r, 3);
	*s = r->p;
	if (failed(r)) return 0;
	r->p += *n;
	return 1;
}
static int is(const uint8_t *s, size_t n, const char *name) {
	return strlen(name) == n && memcmp(s, name, n) == 0;
}

// a text, as a C string: U+0000 held as C0 80
static const char *text(reader *r) {
	size_t n = (size_t)expect(r, 3);
	if (failed(r)) return NULL;
	size_t held = 0;
	for (size_t i = 0; i < n; i++) held += r->p[i] == 0;
	char *s = take(r, n + held + 1), *o = s;
	if (s == NULL) return NULL;
	for (size_t i = 0; i < n; i++) {
		if (r->p[i] == 0) *o++ = (char)0xC0, *o++ = (char)0x80;
		else *o++ = (char)r->p[i];
	}
	*o = 0;
	r->p += n;
	return s;
}

static double half(uint64_t h) {
	int e = (int)(h >> 10 & 0x1f);
	double m = (double)(h & 0x3ff);
	double v = e == 0 ? ldexp(m, -24) : e == 31 ? (m ? NAN : INFINITY) : ldexp(m + 1024, e - 25);
	return h & 0x8000 ? -v : v;
}

// a number: a float, whole (a time, a line, a column); integers are not numbers here
static int64_t number_in(reader *r) {
	uint64_t n;
	int ai, major = next(r, &n, &ai);
	if (failed(r)) return 0;
	if (major == 7 && ai >= 25 && ai <= 27) {
		double d;
		if (ai == 25) d = half(n);
		else if (ai == 26) {
			float f;
			uint32_t u = (uint32_t)n;
			memcpy(&f, &u, 4);
			d = f;
		} else memcpy(&d, &n, 8);
		if (d == floor(d) && fabs(d) < 9223372036854775807.0) return (int64_t)d;
	}
	r->bad = 1;
	return 0;
}

// one value, by the codec
static const void *read_value(reader *r, sp_field f) {
	const uint8_t *start = r->p;
	skip(r);
	if (failed(r)) return NULL;
	const void *v = NULL;
	if (r->codec->decode(r->codec->context, f, start, (size_t)(r->p - start), &v) != 0) r->bad = 1;
	return v;
}

static const sd_list *list(reader *r) {
	size_t n = (size_t)expect(r, 4);
	sd_list *l = take(r, sizeof *l);
	sd_item *items = take(r, n * sizeof *items);
	if (failed(r)) return NULL;
	for (size_t i = 0; i < n && !failed(r); i++) items[i] = (sd_item){text(r), NULL};
	*l = (sd_list){items, n};
	return l;
}

static sd_object read_versions(reader *r, int lists) {
	size_t n = (size_t)expect(r, 4);
	sd_version *vs = take(r, n * sizeof *vs);
	if (failed(r)) return (sd_object){0};
	for (size_t i = 0; i < n && !failed(r); i++) {
		vs[i] = (sd_version){0};
		int content = 0;
		size_t m = (size_t)expect(r, 5);
		for (size_t k = 0; k < m && !failed(r); k++) {
			const uint8_t *s;
			size_t len;
			if (!key(r, &s, &len)) break;
			if (is(s, len, "content")) vs[i].content = lists ? list(r) : read_value(r, SP_CONTENT), content = 1;
			else if (is(s, len, "change")) vs[i].change = read_value(r, SP_CHANGE);
			else if (is(s, len, "because")) vs[i].because = read_value(r, SP_BECAUSE);
			else skip(r);
		}
		if (!content) r->bad = 1; // a version is its content
	}
	return (sd_object){vs, n};
}

static size_t read_entries(reader *r, int lists, const sd_entry **out) {
	size_t n = (size_t)expect(r, 4);
	sd_entry *es = take(r, n * sizeof *es);
	*out = es;
	if (failed(r)) return 0;
	for (size_t i = 0; i < n && !failed(r); i++) {
		if (expect(r, 4) != 2) r->bad = 1;
		const char *name = text(r);
		es[i] = (sd_entry){name, read_versions(r, lists)};
	}
	return n;
}

static sd_site site(reader *r) {
	sd_site s = {0};
	int line = 0;
	size_t m = (size_t)expect(r, 5);
	for (size_t k = 0; k < m && !failed(r); k++) {
		const uint8_t *name;
		size_t len;
		if (!key(r, &name, &len)) break;
		if (is(name, len, "file")) s.file = text(r);
		else if (is(name, len, "line")) s.line = (long)number_in(r), line = 1;
		else if (is(name, len, "column")) s.column = (long)number_in(r), s.has_column = 1;
		else if (is(name, len, "function")) s.function = text(r);
		else skip(r);
	}
	if (!s.file || !line) r->bad = 1;
	return s;
}

static sd_header read_header(reader *r) {
	sd_header h = {0};
	size_t m = (size_t)expect(r, 5);
	for (size_t k = 0; k < m && !failed(r); k++) {
		const uint8_t *s;
		size_t len;
		if (!key(r, &s, &len)) break;
		if (is(s, len, "time")) h.has_time = 1, h.time = number_in(r);
		else if (is(s, len, "actor")) h.actor = read_value(r, SP_ACTOR);
		else if (is(s, len, "reader")) h.reader = text(r);
		else if (is(s, len, "site")) h.has_site = 1, h.site = site(r);
		else if (is(s, len, "cause")) h.cause = read_value(r, SP_CAUSE);
		else if (is(s, len, "wallclock")) h.has_wallclock = 1, h.wallclock = number_in(r);
		else if (is(s, len, "message")) h.message = text(r);
		else skip(r);
	}
	return h;
}

// a node as written; every field must be there
static sd_node *node(reader *r) {
	const char *id = NULL;
	sd_contents c = {0};
	sd_header h = {0};
	int value = 0, info = 0, children = 0, header = 0;
	size_t m = (size_t)expect(r, 5);
	for (size_t k = 0; k < m && !failed(r); k++) {
		const uint8_t *s;
		size_t len;
		if (!key(r, &s, &len)) break;
		if (is(s, len, "id")) id = text(r);
		else if (is(s, len, "value")) c.value = read_versions(r, 0), value = 1;
		else if (is(s, len, "info")) c.info_length = read_entries(r, 0, &c.info), info = 1;
		else if (is(s, len, "children"))
			c.children_length = read_entries(r, 1, &c.children), children = 1;
		else if (is(s, len, "header")) h = read_header(r), header = 1;
		else skip(r);
	}
	if (id == NULL || !value || !info || !children || !header) r->bad = 1;
	if (failed(r)) return NULL;
	sd_node *n = sd_make(id, &c, &h, NULL);
	if (n == NULL) r->oom = 1;
	return n;
}

static void forget(sp_graph *g) {
	for (size_t i = 0; i < g->length; i++) sd_free((sd_node *)g->nodes[i]);
	g->length = 0;
}

// whether the bytes are exactly one item in the canonical encoding (ENCODING.tex), values and
// all: shortest heads, definite lengths, floats only, keys in order, UTF-8, nothing after
static int canonical(const uint8_t *bytes, size_t length) {
	return cborCheck(bytes, length, NULL, NULL);
}

sp_code sp_decode(const uint8_t *bytes, size_t length, const sp_codec *codec, sp_graph *out) {
	*out = (sp_graph){0};
	if (!canonical(bytes, length)) return SP_NOT_A_NODE;
	arena *own = calloc(1, sizeof *own);
	if (own == NULL) return SP_NO_MEMORY;
	out->own = own;
	reader r = {bytes, bytes + length, 0, 0, own, codec};
	sd_node *n = node(&r);
	if (n != NULL && r.p != r.end) r.bad = 1;
	if (n != NULL && !failed(&r) && (out->nodes = malloc(sizeof *out->nodes)) != NULL) {
		out->nodes[0] = n;
		out->length = 1;
		out->root = n->id;
		return SP_OK;
	}
	if (n != NULL) sd_free(n);
	sp_code code = r.oom || n != NULL ? SP_NO_MEMORY : SP_NOT_A_NODE;
	if (r.bad) code = SP_NOT_A_NODE;
	sp_free(out);
	return code;
}

void sp_free(sp_graph *g) {
	arena *own = g->own;
	if (own != NULL) {
		forget(g);
		for (size_t i = 0; i < own->length; i++) free(own->items[i]);
		free(own->items);
		free(own);
	}
	free(g->nodes);
	free(g->missing);
	*g = (sp_graph){0};
}
