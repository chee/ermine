#include "pack.h"

#include "cbor.h"
#include "json.h"

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

// --- the walk ---

// ids seen: open addressing, kept at most half full
typedef struct {
	const char **slots;
	size_t capacity, count;
} seen;

static uint64_t hash(const char *s) {
	uint64_t h = 14695981039346656037u;
	for (; *s; s++) h = (h ^ (unsigned char)*s) * 1099511628211u;
	return h;
}

// 1: added; 0: there already; -1: out of memory
static int see(seen *s, const char *id) {
	if (2 * (s->count + 1) > s->capacity) {
		size_t c = s->capacity ? s->capacity * 2 : 64;
		const char **slots = calloc(c, sizeof *slots);
		if (slots == NULL) return -1;
		for (size_t i = 0; i < s->capacity; i++) {
			if (s->slots[i] == NULL) continue;
			size_t j = hash(s->slots[i]) & (c - 1);
			while (slots[j]) j = (j + 1) & (c - 1);
			slots[j] = s->slots[i];
		}
		free(s->slots);
		s->slots = slots;
		s->capacity = c;
	}
	size_t j = hash(id) & (s->capacity - 1);
	for (; s->slots[j]; j = (j + 1) & (s->capacity - 1))
		if (strcmp(s->slots[j], id) == 0) return 0;
	s->slots[j] = id;
	s->count++;
	return 1;
}

pk_code pk_walk(const char *root, pk_get get, void *context, pk_graph *out) {
	*out = (pk_graph){0};
	const nd_node *first = get(context, root);
	if (first == NULL) return PK_NOTHING_THERE;
	size_t capacity = 0, missing_capacity = 0;
	seen s = {0};
	out->root = root;
	if (!grow(&out->nodes, &capacity, 1, sizeof *out->nodes) || see(&s, root) < 0) goto oom;
	out->nodes[out->length++] = first;
	for (size_t i = 0; i < out->length; i++) {
		const nd_node *n = out->nodes[i];
		for (size_t c = 0; c < n->children_length; c++) {
			nd_object o = n->children[c].object;
			for (size_t v = 0; v < o.length; v++) {
				const nd_list *l = o.versions[v].content;
				for (size_t k = 0; l && k < l->length; k++) {
					const char *id = l->items[k].id;
					if (id == NULL) continue;
					int added = see(&s, id);
					if (added < 0) goto oom;
					if (!added) continue;
					const nd_node *m = get(context, id);
					if (m != NULL) {
						if (!grow(&out->nodes, &capacity, out->length + 1, sizeof *out->nodes))
							goto oom;
						out->nodes[out->length++] = m;
					} else {
						if (!grow(&out->missing, &missing_capacity, out->missing_length + 1,
							    sizeof *out->missing))
							goto oom;
						out->missing[out->missing_length++] = id;
					}
				}
			}
		}
	}
	free(s.slots);
	return PK_OK;
oom:
	free(s.slots);
	pk_free(out);
	return PK_NO_MEMORY;
}

// --- writing CBOR ---

void pk_put(pk_bytes *b, const void *data, size_t length) {
	if (b->failed) return;
	if (!grow(&b->data, &b->capacity, b->length + length, 1)) {
		b->failed = 1;
		return;
	}
	memcpy(b->data + b->length, data, length);
	b->length += length;
}

static void head(pk_bytes *b, int major, uint64_t n) {
	uint8_t h[9];
	size_t size = 1;
	int ai;
	if (n < 24) ai = (int)n, size = 0;
	else if (n <= 0xff) ai = 24, size = 1;
	else if (n <= 0xffff) ai = 25, size = 2;
	else if (n <= 0xffffffff) ai = 26, size = 4;
	else ai = 27, size = 8;
	h[0] = (uint8_t)(major << 5 | ai);
	for (size_t i = 0; i < size; i++) h[1 + i] = (uint8_t)(n >> 8 * (size - 1 - i));
	pk_put(b, h, 1 + size);
}

typedef struct {
	pk_bytes *b;
	const pk_codec *codec;
	int cannot;
} writer;

// U+0000 is held as C0 80, as json.h holds it, and written as the byte 00; text that is not UTF-8
// (a lone surrogate) has no encoding
static void str(writer *w, const char *s) {
	pk_bytes *b = w->b;
	size_t n = strlen(s), held = 0;
	if (!cborText(s, n)) w->cannot = 1;
	for (const char *q = s; (q = strstr(q, "\xC0\x80")) != NULL; q += 2) held++;
	head(b, 3, n - held);
	if (held == 0) {
		pk_put(b, s, n);
		return;
	}
	for (const char *q = s; *q; q++) {
		if ((unsigned char)q[0] == 0xC0 && (unsigned char)q[1] == 0x80) pk_put(b, "", 1), q++;
		else pk_put(b, q, 1);
	}
}

// as the encoding writes numbers: the shortest float that holds it exactly, never an integer
static void number(pk_bytes *b, int64_t v) {
	double d = (double)v;
	float f = (float)d;
	if (v == 0) {
		pk_put(b, "\xf9\x00\x00", 3);
		return;
	}
	if ((double)f == d) {
		// a half: 11 bits of mantissa, exponent -14 .. 15; or a subnormal
		int e;
		frexp(d, &e);
		double a = fabs(d);
		double scaled = e - 1 >= -14 ? ldexp(a, 10 - (e - 1)) : ldexp(a, 24);
		if (e - 1 <= 15 && scaled == floor(scaled)) {
			unsigned h = e - 1 >= -14 ? (unsigned)(e - 1 + 15) << 10 | ((unsigned)scaled - 1024)
			                          : (unsigned)scaled;
			if (d < 0) h |= 0x8000;
			uint8_t x[3] = {0xf9, (uint8_t)(h >> 8), (uint8_t)h};
			pk_put(b, x, 3);
			return;
		}
		uint32_t bits;
		memcpy(&bits, &f, 4);
		uint8_t x[5] = {0xfa};
		for (int i = 0; i < 4; i++) x[1 + i] = (uint8_t)(bits >> 8 * (3 - i));
		pk_put(b, x, 5);
		return;
	}
	uint64_t bits;
	memcpy(&bits, &d, 8);
	uint8_t x[9] = {0xfb};
	for (int i = 0; i < 8; i++) x[1 + i] = (uint8_t)(bits >> 8 * (7 - i));
	pk_put(b, x, 9);
}

static void put_value(writer *w, pk_field f, const void *v) {
	if (!w->cannot && w->codec->encode(w->codec->context, f, v, w->b) != 0) w->cannot = 1;
}

static void put_versions(writer *w, nd_object o, int lists) {
	head(w->b, 4, o.length);
	for (size_t i = 0; i < o.length; i++) {
		const nd_version *v = &o.versions[i];
		head(w->b, 5, 1 + !!v->change + !!v->because);
		if (v->change) str(w, "change"), put_value(w, PK_CHANGE, v->change);
		if (v->because) str(w, "because"), put_value(w, PK_BECAUSE, v->because);
		str(w, "content");
		if (lists) {
			const nd_list *l = v->content;
			size_t n = l ? l->length : 0;
			head(w->b, 4, n);
			for (size_t k = 0; k < n; k++) {
				if (l->items[k].id) str(w, l->items[k].id);
				else w->cannot = 1;
			}
		} else put_value(w, PK_CONTENT, v->content);
	}
}

static void put_entries(writer *w, const nd_entry *es, size_t n, int lists) {
	head(w->b, 4, n);
	for (size_t i = 0; i < n; i++) {
		head(w->b, 4, 2);
		str(w, es[i].name);
		put_versions(w, es[i].object, lists);
	}
}

// keys shorter first, then bytewise: site, time, actor, cause, reader
static void put_header(writer *w, const nd_header *h) {
	head(w->b, 5, !!h->has_time + !!h->actor + !!h->reader + !!h->has_site + !!h->cause);
	if (h->has_site) {
		const nd_site *s = &h->site;
		str(w, "site");
		head(w->b, 5, 2 + !!s->has_column + !!s->function);
		str(w, "file"), str(w, s->file);
		str(w, "line"), number(w->b, s->line);
		if (s->has_column) str(w, "column"), number(w->b, s->column);
		if (s->function) str(w, "function"), str(w, s->function);
	}
	if (h->has_time) str(w, "time"), number(w->b, h->time);
	if (h->actor) str(w, "actor"), put_value(w, PK_ACTOR, h->actor);
	if (h->cause) str(w, "cause"), put_value(w, PK_CAUSE, h->cause);
	if (h->reader) str(w, "reader"), str(w, h->reader);
}

// a node as written: id, info, value, header, children
static void put_node(writer *w, const nd_node *n) {
	head(w->b, 5, 5);
	str(w, "id"), str(w, n->id);
	str(w, "info"), put_entries(w, n->info, n->info_length, 0);
	str(w, "value"), put_versions(w, n->value, 0);
	str(w, "header"), put_header(w, &n->header);
	str(w, "children"), put_entries(w, n->children, n->children_length, 1);
}

pk_code pk_pack(const char *root, pk_get get, void *context, const pk_codec *codec,
	pk_bytes *out, const char **id) {
	pk_graph g;
	pk_code code = pk_walk(root, get, context, &g);
	if (code != PK_OK) return code;
	size_t start = out->length;
	writer w = {out, codec, 0};
	head(out, 5, 3);
	str(&w, "root"), str(&w, root);
	// the root's id is also its node's: that node names it
	int bad = w.cannot;
	w.cannot = 0;
	str(&w, "nodes"), head(out, 4, g.length);
	for (size_t i = 0; i < g.length && !w.cannot; i++) {
		const nd_node *n = g.nodes[i];
		put_node(&w, n);
		if (w.cannot && id) *id = n->id;
	}
	str(&w, "missing"), head(out, 4, g.missing_length);
	for (size_t i = 0; i < g.missing_length; i++) str(&w, g.missing[i]);
	pk_free(&g);
	code = w.cannot || bad ? PK_CANNOT_CARRY : out->failed ? PK_NO_MEMORY : PK_OK;
	if (code != PK_OK && !out->failed) out->length = start;
	return code;
}

pk_code pk_encode(const nd_node *node, const pk_codec *codec, pk_bytes *out) {
	size_t start = out->length;
	writer w = {out, codec, 0};
	put_node(&w, node);
	pk_code code = w.cannot ? PK_CANNOT_CARRY : out->failed ? PK_NO_MEMORY : PK_OK;
	if (code != PK_OK && !out->failed) out->length = start;
	return code;
}

// --- reading CBOR ---

// everything unpack allocates but the nodes and the graph's arrays
typedef struct {
	void **items;
	size_t length, capacity;
} arena;

typedef struct {
	const uint8_t *p, *end;
	int bad, oom;
	arena *own;
	const pk_codec *codec;
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
static const void *read_value(reader *r, pk_field f) {
	const uint8_t *start = r->p;
	skip(r);
	if (failed(r)) return NULL;
	const void *v = NULL;
	if (r->codec->decode(r->codec->context, f, start, (size_t)(r->p - start), &v) != 0) r->bad = 1;
	return v;
}

static const nd_list *list(reader *r) {
	size_t n = (size_t)expect(r, 4);
	nd_list *l = take(r, sizeof *l);
	nd_item *items = take(r, n * sizeof *items);
	if (failed(r)) return NULL;
	for (size_t i = 0; i < n && !failed(r); i++) items[i] = (nd_item){text(r), NULL};
	*l = (nd_list){items, n};
	return l;
}

static nd_object read_versions(reader *r, int lists) {
	size_t n = (size_t)expect(r, 4);
	nd_version *vs = take(r, n * sizeof *vs);
	if (failed(r)) return (nd_object){0};
	for (size_t i = 0; i < n && !failed(r); i++) {
		vs[i] = (nd_version){0};
		int content = 0;
		size_t m = (size_t)expect(r, 5);
		for (size_t k = 0; k < m && !failed(r); k++) {
			const uint8_t *s;
			size_t len;
			if (!key(r, &s, &len)) break;
			if (is(s, len, "content")) vs[i].content = lists ? list(r) : read_value(r, PK_CONTENT), content = 1;
			else if (is(s, len, "change")) vs[i].change = read_value(r, PK_CHANGE);
			else if (is(s, len, "because")) vs[i].because = read_value(r, PK_BECAUSE);
			else skip(r);
		}
		if (!content) r->bad = 1; // a version is its content
	}
	return (nd_object){vs, n};
}

static size_t read_entries(reader *r, int lists, const nd_entry **out) {
	size_t n = (size_t)expect(r, 4);
	nd_entry *es = take(r, n * sizeof *es);
	*out = es;
	if (failed(r)) return 0;
	for (size_t i = 0; i < n && !failed(r); i++) {
		if (expect(r, 4) != 2) r->bad = 1;
		const char *name = text(r);
		es[i] = (nd_entry){name, read_versions(r, lists)};
	}
	return n;
}

static nd_site site(reader *r) {
	nd_site s = {0};
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

static nd_header read_header(reader *r) {
	nd_header h = {0};
	size_t m = (size_t)expect(r, 5);
	for (size_t k = 0; k < m && !failed(r); k++) {
		const uint8_t *s;
		size_t len;
		if (!key(r, &s, &len)) break;
		if (is(s, len, "time")) h.has_time = 1, h.time = number_in(r);
		else if (is(s, len, "actor")) h.actor = read_value(r, PK_ACTOR);
		else if (is(s, len, "reader")) h.reader = text(r);
		else if (is(s, len, "site")) h.has_site = 1, h.site = site(r);
		else if (is(s, len, "cause")) h.cause = read_value(r, PK_CAUSE);
		else skip(r);
	}
	return h;
}

// a node as written; every field must be there
static nd_node *node(reader *r) {
	const char *id = NULL;
	nd_contents c = {0};
	nd_header h = {0};
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
	nd_node *n = nd_make(id, &c, &h, NULL);
	if (n == NULL) r->oom = 1;
	return n;
}

static void forget(pk_graph *g) {
	for (size_t i = 0; i < g->length; i++) nd_free((nd_node *)g->nodes[i]);
	g->length = 0;
}

// whether the bytes are exactly one item in the canonical encoding (ENCODING.tex), values and
// all: shortest heads, definite lengths, floats only, keys in order, UTF-8, nothing after
static int canonical(const uint8_t *bytes, size_t length) {
	Json *x = cborDecode(bytes, length, NULL, NULL);
	if (x == NULL) return 0;
	jsonFree(x);
	return 1;
}

pk_code pk_unpack(const uint8_t *bytes, size_t length, const pk_codec *codec, pk_graph *out) {
	*out = (pk_graph){0};
	arena *own = calloc(1, sizeof *own);
	if (own == NULL) return PK_NO_MEMORY;
	out->own = own;
	if (!canonical(bytes, length)) {
		pk_free(out);
		return PK_NOT_A_GRAPH;
	}
	reader r = {bytes, bytes + length, 0, 0, own, codec};
	int nodes = 0, missing = 0;
	size_t capacity = 0, missing_capacity = 0;
	size_t m = (size_t)expect(&r, 5);
	for (size_t k = 0; k < m && !failed(&r); k++) {
		const uint8_t *s;
		size_t len;
		if (!key(&r, &s, &len)) break;
		if (is(s, len, "root")) out->root = text(&r);
		else if (is(s, len, "nodes")) {
			// a key twice: the last, as cbor-x reads it
			forget(out);
			nodes = 1;
			size_t n = (size_t)expect(&r, 4);
			for (size_t i = 0; i < n && !failed(&r); i++) {
				nd_node *x = node(&r);
				if (x == NULL) break;
				if (!grow(&out->nodes, &capacity, out->length + 1, sizeof *out->nodes)) {
					nd_free(x);
					r.oom = 1;
					break;
				}
				out->nodes[out->length++] = x;
			}
		} else if (is(s, len, "missing")) {
			missing = 1;
			out->missing_length = 0;
			size_t n = (size_t)expect(&r, 4);
			for (size_t i = 0; i < n && !failed(&r); i++) {
				const char *id = text(&r);
				if (id == NULL) break;
				if (!grow(&out->missing, &missing_capacity, out->missing_length + 1,
					    sizeof *out->missing)) {
					r.oom = 1;
					break;
				}
				out->missing[out->missing_length++] = id;
			}
		} else skip(&r);
	}
	if (!failed(&r) && (out->root == NULL || !nodes || !missing || r.p != r.end)) r.bad = 1;
	if (!failed(&r)) return PK_OK;
	pk_code code = r.oom ? PK_NO_MEMORY : PK_NOT_A_GRAPH;
	pk_free(out);
	return code;
}

pk_code pk_decode(const uint8_t *bytes, size_t length, const pk_codec *codec, pk_graph *out) {
	*out = (pk_graph){0};
	if (!canonical(bytes, length)) return PK_NOT_A_NODE;
	arena *own = calloc(1, sizeof *own);
	if (own == NULL) return PK_NO_MEMORY;
	out->own = own;
	reader r = {bytes, bytes + length, 0, 0, own, codec};
	nd_node *n = node(&r);
	if (n != NULL && r.p != r.end) r.bad = 1;
	if (n != NULL && !failed(&r) && (out->nodes = malloc(sizeof *out->nodes)) != NULL) {
		out->nodes[0] = n;
		out->length = 1;
		out->root = n->id;
		return PK_OK;
	}
	if (n != NULL) nd_free(n);
	pk_code code = r.oom || n != NULL ? PK_NO_MEMORY : PK_NOT_A_NODE;
	if (r.bad) code = PK_NOT_A_NODE;
	pk_free(out);
	return code;
}

void pk_free(pk_graph *g) {
	arena *own = g->own;
	if (own != NULL) {
		forget(g);
		for (size_t i = 0; i < own->length; i++) free(own->items[i]);
		free(own->items);
		free(own);
	}
	free(g->nodes);
	free(g->missing);
	*g = (pk_graph){0};
}
