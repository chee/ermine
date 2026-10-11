// The C pack on the line protocol (newcore/conformance/pack/harness.ts): one JSON request per
// line in, one answer per line out. Values are kept as their JSON text (shown.c); the codec writes
// that JSON as CBOR and reads CBOR back as JSON: maps with text keys, arrays, texts, numbers,
// true, false, null. Bytes are hex.
#include "pack.h"
#include "shown.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// --- the codec: JSON text to CBOR ---

static void head(pk_bytes *b, int major, uint64_t n) {
	uint8_t h[9];
	size_t size = n < 24 ? 0 : n <= 0xff ? 1 : n <= 0xffff ? 2 : n <= 0xffffffff ? 4 : 8;
	int ai = size == 0 ? (int)n : size == 1 ? 24 : size == 2 ? 25 : size == 4 ? 26 : 27;
	h[0] = (uint8_t)(major << 5 | ai);
	for (size_t i = 0; i < size; i++) h[1 + i] = (uint8_t)(n >> 8 * (size - 1 - i));
	pk_put(b, h, 1 + size);
}

static void dbl(pk_bytes *b, double d) {
	uint64_t bits;
	memcpy(&bits, &d, 8);
	uint8_t h[9] = {0xfb};
	for (int i = 0; i < 8; i++) h[1 + i] = (uint8_t)(bits >> 8 * (7 - i));
	pk_put(b, h, 9);
}

static void cbor(const char *p, pk_bytes *b) {
	p = space(p);
	if (*p == '"') {
		char *s = string(p);
		head(b, 3, strlen(s));
		pk_put(b, s, strlen(s));
	} else if (*p == '[') {
		const char **xs;
		size_t n = items(p, &xs);
		head(b, 4, n);
		for (size_t i = 0; i < n; i++) cbor(xs[i], b);
	} else if (*p == '{') {
		size_t n = 0;
		for (const char *q = space(p + 1); *q == '"'; n++) {
			q = space(skip(space(skip(q)) + 1));
			if (*q == ',') q = space(q + 1);
		}
		head(b, 5, n);
		for (const char *q = space(p + 1); *q == '"';) {
			char *name = string(q);
			head(b, 3, strlen(name));
			pk_put(b, name, strlen(name));
			q = space(space(skip(q)) + 1);
			cbor(q, b);
			q = space(skip(q));
			if (*q == ',') q = space(q + 1);
		}
	} else if (strncmp(p, "true", 4) == 0) pk_put(b, "\xf5", 1);
	else if (strncmp(p, "false", 5) == 0) pk_put(b, "\xf4", 1);
	else if (strncmp(p, "null", 4) == 0) pk_put(b, "\xf6", 1);
	else {
		// as cbor-x writes numbers: an integer in 32 bits, else a double
		const char *end = skip(p);
		int whole = 1;
		for (const char *q = p; q < end; q++)
			if (*q == '.' || *q == 'e' || *q == 'E') whole = 0;
		double d = strtod(p, NULL);
		if (whole && d >= 0 && d <= 0xffffffff) head(b, 0, (uint64_t)strtoull(p, NULL, 10));
		else if (whole && d < 0 && d >= -4294967296.0) head(b, 1, (uint64_t)(-1 - strtoll(p, NULL, 10)));
		else dbl(b, d);
	}
}

static int encode(void *context, const void *value, pk_bytes *out) {
	(void)context;
	if (value == NULL) return 1;
	cbor(value, out);
	return 0;
}

// --- the codec: CBOR to JSON text ---

typedef struct {
	char *data;
	size_t length, capacity;
} out;

static void add(out *o, const char *s, size_t n) {
	if (o->length + n + 1 > o->capacity) {
		while (o->length + n + 1 > o->capacity) o->capacity = o->capacity ? o->capacity * 2 : 64;
		o->data = realloc(o->data, o->capacity);
		if (o->data == NULL) fail("out of memory");
	}
	memcpy(o->data + o->length, s, n);
	o->length += n;
	o->data[o->length] = 0;
}
static void adds(out *o, const char *s) {
	add(o, s, strlen(s));
}

typedef struct {
	const uint8_t *p, *end;
} in;

// a head: its major type, *arg, *ai; -1 at the end
static int next(in *r, uint64_t *arg, int *ai) {
	if (r->p >= r->end) return -1;
	uint8_t b = *r->p++;
	*ai = b & 31;
	*arg = 0;
	if (*ai < 24) *arg = (uint64_t)*ai;
	else if (*ai <= 27) {
		size_t n = (size_t)1 << (*ai - 24);
		if ((size_t)(r->end - r->p) < n) return -1;
		for (size_t i = 0; i < n; i++) *arg = *arg << 8 | *r->p++;
	} else return -1;
	return b >> 5;
}

static double half(uint64_t h) {
	int e = (int)(h >> 10 & 0x1f);
	double m = (double)(h & 0x3ff);
	double v = e == 0 ? ldexp(m, -24) : e == 31 ? (m ? NAN : INFINITY) : ldexp(m + 1024, e - 25);
	return h & 0x8000 ? -v : v;
}

static void quoted(out *o, const uint8_t *s, size_t n) {
	add(o, "\"", 1);
	for (size_t i = 0; i < n; i++) {
		char e[8];
		if (s[i] == '"' || s[i] == '\\') e[0] = '\\', e[1] = (char)s[i], add(o, e, 2);
		else if (s[i] < 0x20) snprintf(e, sizeof e, "\\u%04x", s[i]), adds(o, e);
		else add(o, (const char *)&s[i], 1);
	}
	add(o, "\"", 1);
}

// 0: written; nonzero: not JSON this reads
static int json(in *r, out *o) {
	uint64_t n;
	int ai, major = next(r, &n, &ai);
	char num[40];
	switch (major) {
	case 0: snprintf(num, sizeof num, "%llu", (unsigned long long)n), adds(o, num); return 0;
	case 1: snprintf(num, sizeof num, "-%llu", (unsigned long long)n + 1), adds(o, num); return 0;
	case 3:
		if ((uint64_t)(r->end - r->p) < n) return 1;
		quoted(o, r->p, (size_t)n);
		r->p += n;
		return 0;
	case 4:
		add(o, "[", 1);
		for (uint64_t i = 0; i < n; i++) {
			if (i) add(o, ",", 1);
			if (json(r, o)) return 1;
		}
		add(o, "]", 1);
		return 0;
	case 5:
		add(o, "{", 1);
		for (uint64_t i = 0; i < n; i++) {
			if (i) add(o, ",", 1);
			const uint8_t *at = r->p;
			uint64_t k;
			int kai;
			if (next(r, &k, &kai) != 3) return 1;
			r->p = at;
			if (json(r, o)) return 1;
			add(o, ":", 1);
			if (json(r, o)) return 1;
		}
		add(o, "}", 1);
		return 0;
	case 7: {
		if (ai == 20) return adds(o, "false"), 0;
		if (ai == 21) return adds(o, "true"), 0;
		if (ai == 22) return adds(o, "null"), 0;
		double d;
		if (ai == 25) d = half(n);
		else if (ai == 26) {
			float f;
			uint32_t u = (uint32_t)n;
			memcpy(&f, &u, 4);
			d = f;
		} else if (ai == 27) memcpy(&d, &n, 8);
		else return 1;
		if (!isfinite(d)) adds(o, "null");
		else if (d == floor(d) && fabs(d) < 1e21) snprintf(num, sizeof num, "%.0f", d), adds(o, num);
		else snprintf(num, sizeof num, "%.17g", d), adds(o, num);
		return 0;
	}
	default: return 1;
	}
}

static int decode(void *context, const uint8_t *item, size_t length, const void **value) {
	(void)context;
	in r = {item, item + length};
	out o = {0};
	int bad = json(&r, &o) || r.p != r.end;
	if (!bad) {
		char *s = take(o.length + 1);
		memcpy(s, o.data, o.length + 1);
		*value = s;
	}
	free(o.data);
	return bad;
}

static const pk_codec codec = {encode, decode, NULL};

// --- the nodes a request loads ---

typedef struct {
	nd_node **nodes;
	size_t length;
} table;

static const nd_node *get(void *context, const char *id) {
	const table *t = context;
	for (size_t i = 0; i < t->length; i++)
		if (strcmp(t->nodes[i]->id, id) == 0) return t->nodes[i];
	return NULL;
}

static table load(const char *line) {
	table t = {0};
	const char *given = field(line, "nodes");
	if (given == NULL) return t;
	const char **xs;
	t.length = items(given, &xs);
	t.nodes = take(t.length * sizeof *t.nodes);
	for (size_t i = 0; i < t.length; i++) t.nodes[i] = parse_node(xs[i]);
	return t;
}

static void unload(table t) {
	for (size_t i = 0; i < t.length; i++) nd_free(t.nodes[i]);
}

// --- answers ---

static const char *codes[] = {"", "nothing-there", "cannot-carry", "not-a-graph", "no-memory"};

static void error(pk_code code, const char *id) {
	printf("{\"code\":\"%s\"", codes[code]);
	if (id) fputs(",\"id\":", stdout), text(id);
	puts("}");
}

static void graph(const pk_graph *g) {
	fputs("{\"graph\":{\"root\":", stdout);
	text(g->root);
	fputs(",\"nodes\":[", stdout);
	for (size_t i = 0; i < g->length; i++) {
		if (i) putchar(',');
		show_node(g->nodes[i]);
	}
	fputs("],\"missing\":[", stdout);
	for (size_t i = 0; i < g->missing_length; i++) {
		if (i) putchar(',');
		text(g->missing[i]);
	}
	puts("]}}");
}

static void walk(const char *line) {
	table t = load(line);
	const char *root = string(field(line, "root"));
	pk_graph g;
	pk_code code = pk_walk(root, get, &t, &g);
	if (code == PK_OK) graph(&g);
	else error(code, code == PK_NOTHING_THERE ? root : NULL);
	pk_free(&g);
	unload(t);
}

static void pack(const char *line) {
	table t = load(line);
	const char *root = string(field(line, "root")), *id = NULL;
	pk_bytes b = {0};
	pk_code code = pk_pack(root, get, &t, &codec, &b, &id);
	if (code == PK_OK) {
		fputs("{\"bytes\":\"", stdout);
		for (size_t i = 0; i < b.length; i++) printf("%02x", b.data[i]);
		puts("\"}");
	} else error(code, code == PK_NOTHING_THERE ? root : id);
	free(b.data);
	unload(t);
}

static void unpack(const char *line) {
	const char *hex = string(field(line, "bytes"));
	size_t n = strlen(hex) / 2;
	uint8_t *bytes = take(n);
	for (size_t i = 0; i < n; i++) {
		unsigned x;
		if (sscanf(hex + 2 * i, "%2x", &x) != 1) fail("bad hex");
		bytes[i] = (uint8_t)x;
	}
	pk_graph g;
	pk_code code = pk_unpack(bytes, n, &codec, &g);
	if (code == PK_OK) graph(&g);
	else error(code, NULL);
	pk_free(&g);
}

int main(void) {
	char *line = NULL;
	size_t capacity = 0;
	while (getline(&line, &capacity, stdin) != -1) {
		if (strspn(line, " \t\r\n") == strlen(line)) continue;
		const char *op = field(line, "op");
		if (op == NULL) fail("no op");
		char *name = string(op);
		if (strcmp(name, "walk") == 0) walk(line);
		else if (strcmp(name, "pack") == 0) pack(line);
		else if (strcmp(name, "unpack") == 0) unpack(line);
		else printf("{\"error\":\"unknown op %s\"}\n", name);
		fflush(stdout);
		clear();
	}
	free(line);
	finish();
	return 0;
}
