// The C places library on the line protocol: one JSON request per line in, one answer per line
// out, in order. Same as ../conformance/harness.ts. State lasts for the process: the table of
// nodes (id -> node), the heres cd made by name, and the time counting changes. A value's and an
// info's contents are notify/c's values, as mutate takes them; a list's, nodes/c's.
#define _POSIX_C_SOURCE 200809L
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>


// a parsed JSON value. scalar: its text as written; string: decoded, UTF-8
typedef struct node node;
struct node {
	char type; // 'v' scalar, 's' string, 'a' array, 'o' object
	char *text;
	size_t len;
	node **kids;
	char **keys;
	size_t n;
};

// everything one request made, freed after its answer
static void **pool;
static size_t npool, cappool;
static void *keep(void *p) {
	if (!p) abort();
	if (npool == cappool) {
		cappool = cappool ? cappool * 2 : 64;
		pool = realloc(pool, cappool * sizeof *pool);
		if (!pool) abort();
	}
	return pool[npool++] = p;
}
static void *alloc(size_t n) { return keep(calloc(1, n ? n : 1)); }
static void release(void) {
	while (npool) free(pool[--npool]);
}

static const char *p; // the scanner's place in the line

static void ws(void) {
	while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
}

static int put8(char *o, unsigned long c) {
	if (c < 0x80) { o[0] = (char)c; return 1; }
	if (c < 0x800) { o[0] = (char)(0xC0 | c >> 6); o[1] = (char)(0x80 | (c & 63)); return 2; }
	if (c < 0x10000) {
		o[0] = (char)(0xE0 | c >> 12); o[1] = (char)(0x80 | ((c >> 6) & 63)); o[2] = (char)(0x80 | (c & 63));
		return 3;
	}
	o[0] = (char)(0xF0 | c >> 18); o[1] = (char)(0x80 | ((c >> 12) & 63));
	o[2] = (char)(0x80 | ((c >> 6) & 63)); o[3] = (char)(0x80 | (c & 63));
	return 4;
}

static unsigned long hex4(const char *s) {
	char b[5] = {s[0], s[1], s[2], s[3], 0};
	return strtoul(b, NULL, 16);
}

// at the opening quote: p after the closing one
static char *str(size_t *len) {
	const char *s = ++p;
	while (*p && *p != '"') p += *p == '\\' && p[1] ? 2 : 1;
	char *out = alloc((size_t)(p - s) + 1), *o = out;
	while (s < p) {
		if (*s != '\\') { *o++ = *s++; continue; }
		s++;
		switch (*s) {
		case 'n': *o++ = '\n'; s++; break;
		case 't': *o++ = '\t'; s++; break;
		case 'r': *o++ = '\r'; s++; break;
		case 'b': *o++ = '\b'; s++; break;
		case 'f': *o++ = '\f'; s++; break;
		case 'u': {
			unsigned long c = hex4(s + 1);
			s += 5;
			if (c >= 0xD800 && c < 0xDC00 && s[0] == '\\' && s[1] == 'u') {
				unsigned long d = hex4(s + 2);
				c = 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00);
				s += 6;
			}
			o += put8(o, c);
			break;
		}
		default: *o++ = *s++; // " \ /
		}
	}
	*o = 0;
	if (*p == '"') p++;
	*len = (size_t)(o - out);
	return out;
}

static node *parse(void) {
	ws();
	node *v = alloc(sizeof *v);
	if (*p == '"') {
		v->type = 's';
		v->text = str(&v->len);
		return v;
	}
	if (*p == '[' || *p == '{') {
		v->type = *p == '[' ? 'a' : 'o';
		char close = *p++ == '[' ? ']' : '}';
		size_t cap = 0;
		for (ws(); *p && *p != close; ws()) {
			if (v->n == cap) {
				cap = cap ? cap * 2 : 4;
				node **k = alloc(cap * sizeof *k);
				char **ks = alloc(cap * sizeof *ks);
				if (v->n) memcpy(k, v->kids, v->n * sizeof *k), memcpy(ks, v->keys, v->n * sizeof *ks);
				v->kids = k, v->keys = ks;
			}
			if (v->type == 'o') {
				size_t l;
				v->keys[v->n] = str(&l);
				ws();
				if (*p == ':') p++;
			}
			v->kids[v->n++] = parse();
			ws();
			if (*p == ',') p++;
		}
		if (*p) p++;
		return v;
	}
	const char *s = p;
	while (*p && *p != ',' && *p != '}' && *p != ']' && *p != ' ' && *p != '\r' && *p != '\n') p++;
	v->type = 'v';
	v->len = (size_t)(p - s);
	v->text = alloc(v->len + 1);
	memcpy(v->text, s, v->len);
	return v;
}

static node *get(const node *o, const char *k) {
	if (!o || o->type != 'o') return NULL;
	for (size_t i = 0; i < o->n; i++)
		if (!strcmp(o->keys[i], k)) return o->kids[i];
	return NULL;
}
static long num(const node *v) { return v && v->type == 'v' ? strtol(v->text, NULL, 10) : 0; }


#include "places.h"

// what lasts until the next graph: nodes, interned strings, heres, and what placing makes
static void **perm;
static size_t nperm, capperm;
static void *palloc(size_t n) {
	if (nperm == capperm) {
		capperm = capperm ? capperm * 2 : 256;
		perm = realloc(perm, capperm * sizeof *perm);
		if (!perm) abort();
	}
	void *m = calloc(1, n ? n : 1);
	if (!m) abort();
	return perm[nperm++] = m;
}
static void forget(void) {
	while (nperm) free(perm[--nperm]);
}
static const char *pstr(const char *s) {
	char *c = palloc(strlen(s) + 1);
	return strcpy(c, s);
}
static node *clone(const node *j) {
	node *c = palloc(sizeof *c);
	c->type = j->type, c->len = j->len, c->n = j->n;
	if (j->text) {
		c->text = palloc(j->len + 1);
		memcpy(c->text, j->text, j->len);
	}
	if (j->n) {
		c->kids = palloc(j->n * sizeof *c->kids);
		if (j->keys) c->keys = palloc(j->n * sizeof *c->keys);
		for (size_t i = 0; i < j->n; i++) {
			c->kids[i] = clone(j->kids[i]);
			if (j->type == 'o') c->keys[i] = (char *)pstr(j->keys[i]);
		}
	}
	return c;
}

// the table
static nd_node **table;
static size_t ntable, captable;
static nd_node *lookup_id(void *ctx, const char *id) {
	(void)ctx;
	for (size_t i = 0; i < ntable; i++)
		if (!strcmp(table[i]->id, id)) return table[i];
	return NULL;
}

// a change: { time, actor: "me", node }
static long ticks;
static const void *by(void *ctx, const char *id) {
	(void)ctx;
	node *o = palloc(sizeof *o), *t = palloc(sizeof *t), *a = palloc(sizeof *a), *n = palloc(sizeof *n);
	char buf[32];
	snprintf(buf, sizeof buf, "%ld", ++ticks);
	t->type = 'v', t->len = strlen(buf), t->text = (char *)pstr(buf);
	a->type = 's', a->len = 2, a->text = (char *)pstr("me");
	n->type = 's', n->len = strlen(id), n->text = (char *)pstr(id);
	o->type = 'o', o->n = 3;
	o->kids = palloc(3 * sizeof *o->kids), o->keys = palloc(3 * sizeof *o->keys);
	o->kids[0] = t, o->kids[1] = a, o->kids[2] = n;
	o->keys[0] = (char *)pstr("time"), o->keys[1] = (char *)pstr("actor"), o->keys[2] = (char *)pstr("node");
	return o;
}

// memory for the library: kept (heres, placing) or for this request only
static int persist;
static void *lib_alloc(void *ctx, size_t n) {
	(void)ctx;
	return persist ? palloc(n) : alloc(n);
}

static pl_places places = {lookup_id, lib_alloc, by, NULL, "", NULL};

static const char *str_of(const node *v) { return v && v->type == 's' ? v->text : ""; }

// an array of strings; kept: copied for good
static const char **strs(const node *a, int kept, size_t *n) {
	*n = a && a->type == 'a' ? a->n : 0;
	const char **out = alloc(*n * sizeof *out);
	for (size_t i = 0; i < *n; i++) {
		const char *s = str_of(a->kids[i]);
		out[i] = kept ? pstr(s) : s;
	}
	return out;
}

// an address, or an id given as a string (places.h, pl_id)
static const char **where(const node *a, int kept, size_t *n) {
	if (a == NULL || a->type != 's') return strs(a, kept, n);
	const char **out = alloc(2 * sizeof *out);
	out[0] = pl_id, out[1] = kept ? pstr(a->text) : a->text;
	*n = 2;
	return out;
}

// a value's or an info's content, or a patch's value, as notify/c's
static nt_value *value_of(const node *j) {
	if (j == NULL) return nt_null();
	if (j->type == 's') return nt_str(j->text);
	if (j->type == 'v') {
		if (!strcmp(j->text, "null")) return nt_null();
		if (!strcmp(j->text, "true") || !strcmp(j->text, "false")) return nt_bool(j->text[0] == 't');
		return nt_num(strtod(j->text, NULL));
	}
	nt_value *v = j->type == 'a' ? nt_list() : nt_map();
	for (size_t i = 0; i < j->n; i++) {
		if (j->type == 'a') nt_push(v, value_of(j->kids[i]));
		else nt_set(v, j->keys[i], value_of(j->kids[i]));
	}
	return v;
}

// a patch's place: a path of keys, and a range; anything else a key mutate refuses
static const nt_key bad_key = {.type = NT_NUM_KEY, .n = -1};
static int whole(const node *x, long *out) {
	if (!x || x->type != 'v') return 0;
	char *end;
	double d = strtod(x->text, &end);
	if (end == x->text || d != floor(d) || fabs(d) > 1e15) return 0;
	*out = (long)d;
	return 1;
}
static void place_of(const node *m, nt_place *p) {
	memset(p, 0, sizeof *p);
	const node *path = get(m, "path"), *r = get(m, "range");
	if (path == NULL || path->type != 'a') goto bad;
	nt_key *ks = palloc((path->n + 1) * sizeof *ks);
	for (size_t i = 0; i < path->n; i++) {
		const node *x = path->kids[i];
		if (x->type == 's') ks[i] = (nt_key){.type = NT_STR_KEY, .s = pstr(x->text)};
		else if (whole(x, &ks[i].n)) ks[i].type = NT_NUM_KEY;
		else goto bad;
	}
	p->path = ks, p->length = path->n;
	if (r) {
		if (r->type != 'a' || r->n != 2 || !whole(r->kids[0], &p->from) || !whole(r->kids[1], &p->to))
			goto bad;
		p->has_range = 1;
	}
	return;
bad:
	memset(p, 0, sizeof *p);
	p->path = &bad_key, p->length = 1;
}
static nt_patch *patches_of(const node *a, size_t *n) {
	*n = a && a->type == 'a' ? a->n : 0;
	nt_patch *ps = palloc(*n * sizeof *ps);
	for (size_t i = 0; i < *n; i++) {
		const node *m = a->kids[i], *v = get(m, "value"), *mv = get(m, "move");
		place_of(m, &ps[i].place);
		if (v) ps[i].has_value = 1, ps[i].value = value_of(v);
		if (mv) ps[i].has_move = 1, place_of(mv, &ps[i].move);
	}
	return ps;
}

// a list's content: ids, and { "$symbol": name }
static nd_list *list_of(const node *a) {
	nd_list *l = palloc(sizeof *l);
	l->length = a && a->type == 'a' ? a->n : 0;
	nd_item *it = palloc(l->length * sizeof *it);
	for (size_t i = 0; i < l->length; i++) {
		const node *x = a->kids[i];
		if (x->type == 's') it[i].id = pstr(x->text);
		else it[i].symbol = pstr(str_of(get(x, "$symbol")));
	}
	l->items = it;
	return l;
}

static nd_object versions_of(const node *a, int islist) {
	nd_object o = {0};
	o.length = a && a->type == 'a' ? a->n : 0;
	nd_version *vs = palloc(o.length * sizeof *vs);
	for (size_t i = 0; i < o.length; i++) {
		const node *v = a->kids[i], *c = get(v, "content"), *ch = get(v, "change"), *b = get(v, "because");
		vs[i].content = islist ? (const void *)list_of(c) : (const void *)value_of(c);
		vs[i].change = ch ? clone(ch) : NULL;
		vs[i].because = b ? clone(b) : NULL;
	}
	o.versions = vs;
	return o;
}

static nd_entry *entries_of(const node *a, int islist, size_t *n) {
	*n = a && a->type == 'a' ? a->n : 0;
	nd_entry *es = palloc(*n * sizeof *es);
	for (size_t i = 0; i < *n; i++) {
		es[i].name = pstr(str_of(a->kids[i]->kids[0]));
		es[i].object = versions_of(a->kids[i]->kids[1], islist);
	}
	return es;
}

static nd_node *make(const node *j) {
	nd_node *n = palloc(sizeof *n);
	n->id = pstr(str_of(get(j, "id")));
	n->value = versions_of(get(j, "value"), 0);
	n->info = entries_of(get(j, "info"), 0, &n->info_length);
	n->children = entries_of(get(j, "children"), 1, &n->children_length);
	return n;
}

// out

static void out_str(const char *s, size_t n) {
	putchar('"');
	for (size_t i = 0; i < n; i++) {
		unsigned char c = (unsigned char)s[i];
		if (c == '"' || c == '\\') printf("\\%c", c);
		else if (c < 0x20) printf("\\u%04x", c);
		else putchar(c);
	}
	putchar('"');
}
static void out_s(const char *s) { out_str(s, strlen(s)); }

static void out_node(const node *v) {
	if (v == NULL) { fputs("null", stdout); return; }
	if (v->type == 's') { out_str(v->text, v->len); return; }
	if (v->type == 'v') { fwrite(v->text, 1, v->len, stdout); return; }
	putchar(v->type == 'a' ? '[' : '{');
	for (size_t i = 0; i < v->n; i++) {
		if (i) putchar(',');
		if (v->type == 'o') out_s(v->keys[i]), putchar(':');
		out_node(v->kids[i]);
	}
	putchar(v->type == 'a' ? ']' : '}');
}

static void out_number(double d) {
	if (d == 0) { putchar('0'); return; }
	if (d == floor(d) && fabs(d) < 1e21) { printf("%.0f", d); return; }
	char buf[40];
	for (int p = 1; p <= 17; p++) {
		snprintf(buf, sizeof buf, "%.*g", p, d);
		if (strtod(buf, NULL) == d) break;
	}
	fputs(buf, stdout);
}
static void out_value(const nt_value *v) {
	if (v == NULL || v->type == NT_NULL) { fputs("null", stdout); return; }
	if (v->type == NT_BOOL) { fputs(v->bool_ ? "true" : "false", stdout); return; }
	if (v->type == NT_NUM) { out_number(v->num); return; }
	if (v->type == NT_STR) { out_str(v->str, v->bytes); return; }
	// JSON only: nothing else is read in
	if (v->type != NT_LIST && v->type != NT_MAP) { fputs("null", stdout); return; }
	putchar(v->type == NT_MAP ? '{' : '[');
	for (size_t i = 0; i < v->count; i++) {
		if (i) putchar(',');
		if (v->type == NT_MAP) out_s(v->keys[i]), putchar(':');
		out_value(v->items[i]);
	}
	putchar(v->type == NT_MAP ? '}' : ']');
}

static void out_list(const nd_list *l) {
	putchar('[');
	for (size_t i = 0; i < l->length; i++) {
		if (i) putchar(',');
		if (l->items[i].id) out_s(l->items[i].id);
		else fputs("{\"$symbol\":", stdout), out_s(l->items[i].symbol), putchar('}');
	}
	putchar(']');
}

static void out_versions(const nd_version *vs, size_t n, int islist) {
	putchar('[');
	for (size_t i = 0; i < n; i++) {
		if (i) putchar(',');
		fputs("{\"content\":", stdout);
		if (islist) out_list(vs[i].content);
		else out_value(vs[i].content);
		fputs(",\"change\":", stdout);
		out_node(vs[i].change);
		if (vs[i].because) fputs(",\"because\":", stdout), out_node(vs[i].because);
		putchar('}');
	}
	putchar(']');
}

static void out_entries(const nd_entry *es, size_t n, int islist) {
	putchar('[');
	for (size_t i = 0; i < n; i++) {
		if (i) putchar(',');
		putchar('['), out_s(es[i].name), putchar(',');
		out_versions(es[i].object.versions, es[i].object.length, islist);
		putchar(']');
	}
	putchar(']');
}

static void out_dump(const nd_node *n) {
	fputs("{\"node\":{\"id\":", stdout);
	out_s(n->id);
	fputs(",\"value\":", stdout);
	out_versions(n->value.versions, n->value.length, 0);
	fputs(",\"info\":", stdout);
	out_entries(n->info, n->info_length, 0);
	fputs(",\"children\":", stdout);
	out_entries(n->children, n->children_length, 1);
	puts("}}");
}

static void out_names(const char *const *names, size_t n) {
	putchar('[');
	for (size_t i = 0; i < n; i++) {
		if (i) putchar(',');
		out_s(names[i]);
	}
	putchar(']');
}

static void out_item(const pl_item *it) {
	fputs("{\"id\":", stdout);
	out_s(it->id);
	fputs(",\"route\":[", stdout);
	for (size_t i = 0; i < it->nroute; i++) {
		const pl_step *s = &it->route[i];
		if (i) putchar(',');
		fputs("{\"node\":", stdout), out_s(s->node);
		fputs(",\"name\":", stdout), out_s(s->name);
		fputs(",\"id\":", stdout), out_s(s->id);
		printf(",\"at\":%zu}", s->at);
	}
	printf("],\"loaded\":%s", it->node ? "true" : "false");
	if (it->has_up) printf(",\"up\":%ld", it->up);
	if (it->has_versions) {
		fputs(",\"versions\":", stdout);
		out_versions(it->versions, it->nversions, 0);
	}
	putchar('}');
}

// what a read said to depend
typedef struct {
	const char *id;
	pl_part part;
} said;
static said *says;
static size_t nsays, capsays;
static void tell(void *ctx, const char *id, pl_part part) {
	(void)ctx;
	if (nsays == capsays) {
		said *s = alloc((capsays ? capsays * 2 : 16) * sizeof *s);
		if (nsays) memcpy(s, says, nsays * sizeof *s);
		says = s, capsays = capsays ? capsays * 2 : 16;
	}
	says[nsays++] = (said){id, part};
}
static void out_said(void) {
	fputs(",\"said\":[", stdout);
	for (size_t i = 0; i < nsays; i++) {
		if (i) putchar(',');
		putchar('['), out_s(says[i].id), putchar(',');
		pl_part q = says[i].part;
		if (q.kind == PL_LOADED) fputs("\"loaded\"", stdout);
		else if (q.kind == PL_VALUE) fputs("\"value\"", stdout);
		else {
			fputs(q.kind == PL_INFO ? "[\"info\"" : "[\"children\"", stdout);
			if (q.name) putchar(','), out_s(q.name);
			putchar(']');
		}
		putchar(']');
	}
	putchar(']');
}

// the heres cd made, by name
typedef struct {
	const char *name;
	pl_spot spot;
} here;
static here *heres;
static size_t nheres, capheres;

static int fail(int code) {
	fputs("{\"fail\":", stdout);
	out_s(pl_code_name(code));
	puts("}");
	return 0;
}
static int error(const char *text) {
	fputs("{\"error\":", stdout);
	out_s(text);
	puts("}");
	return 0;
}
static void out_change(const void *c) { out_node(c); }

static int istrue(const node *v) { return v && v->type == 'v' && !strcmp(v->text, "true"); }

// a span from a number or a pair; single: what one number means
static pl_span span_of(const node *v, int slot) {
	if (v->type == 'a' && v->n == 2) return (pl_span){num(v->kids[0]), num(v->kids[1])};
	long a = num(v);
	return (pl_span){a, slot ? a + 1 : a};
}

static int answer(void) {
	node *r = parse();
	const node *op = get(r, "op");
	const char *o = op && op->type == 's' ? op->text : "";
	persist = 0;
	nsays = 0, capsays = 0, says = NULL;
	pl_depend dd = {tell, NULL};
	const pl_depend *d = istrue(get(r, "depend")) ? &dd : NULL;
	int code = PL_OK;

	if (!strcmp(o, "graph")) {
		forget();
		ntable = 0, nheres = 0, ticks = 0;
		heres = NULL, capheres = 0;
		places.root = pstr(str_of(get(r, "root")));
		const node *ns = get(r, "nodes");
		for (size_t i = 0; ns && i < ns->n; i++) {
			if (ntable == captable) {
				captable = captable ? captable * 2 : 16;
				table = realloc(table, captable * sizeof *table);
				if (!table) abort();
			}
			table[ntable++] = make(ns->kids[i]);
		}
		puts("{}");
		return 0;
	}
	if (!strcmp(o, "intro")) {
		nd_node *n = make(get(r, "node"));
		if (lookup_id(NULL, n->id)) return fail(PL_ALREADY_THERE);
		if (ntable == captable) {
			captable = captable ? captable * 2 : 16;
			table = realloc(table, captable * sizeof *table);
			if (!table) abort();
		}
		table[ntable++] = n;
		puts("{}");
		return 0;
	}
	if (!strcmp(o, "outro")) {
		const char *id = str_of(get(r, "id"));
		for (size_t i = 0; i < ntable; i++)
			if (!strcmp(table[i]->id, id)) {
				memmove(&table[i], &table[i + 1], (ntable - i - 1) * sizeof *table);
				ntable--;
				puts("{}");
				return 0;
			}
		return fail(PL_NOTHING_THERE);
	}
	if (!strcmp(o, "node")) {
		nd_node *n = lookup_id(NULL, str_of(get(r, "id")));
		if (n) out_dump(n);
		else puts("{\"node\":null}");
		return 0;
	}

	// placing
	if (!strcmp(o, "insert") || !strcmp(o, "remove") || !strcmp(o, "pop") || !strcmp(o, "rename") || !strcmp(o, "move")) {
		persist = 1;
		const char *id = pstr(str_of(get(r, "id"))), *name = pstr(str_of(get(r, "name")));
		const void *c[2] = {0};
		size_t nc = 1;
		if (!strcmp(o, "insert")) {
			const node *ix = get(r, "index"), *sx = get(r, "slotindex");
			pl_span index, slotindex;
			if (ix) index = span_of(ix, 0);
			if (sx) slotindex = span_of(sx, 1);
			code = pl_insert(&places, id, name, pstr(str_of(get(r, "child"))), ix ? &index : NULL,
				sx ? &slotindex : NULL, &c[0]);
		} else if (!strcmp(o, "remove")) {
			const node *ix = get(r, "index"), *sx = get(r, "slotindex");
			if (!ix) return error("no index");
			pl_span slotindex;
			if (sx) slotindex = span_of(sx, 1);
			code = pl_remove(&places, id, name, span_of(ix, 1), sx ? &slotindex : NULL, &c[0]);
		} else if (!strcmp(o, "pop")) {
			const node *sx = get(r, "slotindex");
			if (!sx) return error("no slotindex");
			code = pl_pop(&places, id, name, span_of(sx, 1), &c[0]);
		} else if (!strcmp(o, "rename")) {
			nc = 2;
			code = pl_rename(&places, id, name, pstr(str_of(get(r, "to"))), c);
		} else {
			const node *tx = get(r, "toindex");
			long toindex = num(tx);
			code = pl_move(&places, id, name, num(get(r, "index")), pstr(str_of(get(r, "toid"))),
				pstr(str_of(get(r, "toname"))), tx ? &toindex : NULL, c, &nc);
		}
		if (code) return fail(code);
		if (!strcmp(o, "insert") || !strcmp(o, "remove") || !strcmp(o, "pop")) {
			fputs("{\"change\":", stdout);
			out_change(c[0]);
		} else {
			fputs("{\"changes\":[", stdout);
			for (size_t i = 0; i < nc; i++) {
				if (i) putchar(',');
				out_change(c[i]);
			}
			putchar(']');
		}
		puts("}");
		return 0;
	}

	// reads, at a place or at a here; cd also from a here
	int iscd = !strcmp(o, "cd");
	pl_spot spot = {0};
	const node *hn = get(r, "here");
	if (hn) {
		size_t i = 0;
		while (i < nheres && strcmp(heres[i].name, str_of(hn)) != 0) i++;
		if (i == nheres) {
			char buf[256];
			snprintf(buf, sizeof buf, "no here %s", str_of(hn));
			return error(buf);
		}
		spot = heres[i].spot;
	} else if (!iscd) {
		spot.names = strs(get(r, "place"), 0, &spot.nnames);
	}
	pl_items items = {0};
	size_t n;
	if (!strcmp(o, "write") || !strcmp(o, "set")) {
		persist = 1;
		const char **address = where(get(r, "address"), 1, &n);
		size_t np;
		const nt_patch *ps = patches_of(get(r, "patches"), &np);
		const node *ix = get(r, "index"), *sx = get(r, "slotindex");
		long index = num(ix);
		pl_span slotindex;
		if (sx) slotindex = span_of(sx, 1);
		const void *c = NULL;
		pl_mutated mutated;
		if (o[0] == 'w')
			code = pl_write(&places, &spot, address, n, ps, np, ix ? &index : NULL,
				sx ? &slotindex : NULL, &c, &mutated);
		else
			code = pl_set(&places, &spot, address, n, pstr(str_of(get(r, "name"))), ps, np,
				ix ? &index : NULL, sx ? &slotindex : NULL, &c, &mutated);
		if (code == PL_MUTATE) {
			fputs("{\"fail\":", stdout);
			out_s(mu_code_name(mutated.code));
			puts("}");
			return 0;
		}
		if (code) return fail(code);
		fputs("{\"change\":", stdout);
		out_change(c);
		puts("}");
		return 0;
	}
	if (iscd) {
		persist = 1;
		const char **address = strs(get(r, "address"), 1, &n);
		pl_spot out;
		code = pl_cd(&places, &spot, address, n, d, &out);
		if (code) return fail(code);
		const node *as = get(r, "as");
		const char *key = pstr(str_of(as));
		size_t i = 0;
		while (i < nheres && strcmp(heres[i].name, key) != 0) i++;
		if (i == nheres) {
			if (nheres == capheres) {
				here *hs = palloc((capheres ? capheres * 2 : 8) * sizeof *hs);
				if (nheres) memcpy(hs, heres, nheres * sizeof *hs);
				heres = hs, capheres = capheres ? capheres * 2 : 8;
			}
			nheres++;
		}
		heres[i] = (here){key, out};
		fputs("{\"names\":", stdout);
		out_names(out.names, out.nnames);
		fputs(",\"trail\":", stdout);
		out_names(out.trail, out.ntrail);
		if (d) out_said();
		puts("}");
		return 0;
	}
	if (!strcmp(o, "lookup") || !strcmp(o, "lookups")) {
		const char **path = strs(get(r, "path"), 0, &n);
		code = (o[6] ? pl_lookups : pl_lookup)(&places, &spot, path, n, d, &items);
	} else {
		const char **address = where(get(r, "address"), 0, &n);
		const node *name = get(r, "name");
		if (!strcmp(o, "look")) code = pl_look(&places, &spot, address, n, d, &items);
		else if (!strcmp(o, "content")) code = pl_content(&places, &spot, address, n, d, &items);
		else if (!strcmp(o, "info"))
			code = pl_info(&places, &spot, address, n, str_of(name), d, &items);
		else if (!strcmp(o, "children") && name)
			code = pl_children(&places, &spot, address, n, str_of(name), d, &items);
		else if (!strcmp(o, "children") || !strcmp(o, "names")) {
			pl_namelist ns;
			code = !strcmp(o, "names")
				? pl_names_of(&places, &spot, address, n, str_of(get(r, "part")), d, &ns)
				: pl_names(&places, &spot, address, n, d, &ns);
			if (code) return fail(code);
			fputs("{\"names\":", stdout);
			out_names(ns.names, ns.n);
			if (d) out_said();
			puts("}");
			return 0;
		} else {
			char buf[256];
			snprintf(buf, sizeof buf, "unknown op %s", o);
			return error(buf);
		}
	}
	if (code) return fail(code);
	fputs("{\"items\":[", stdout);
	for (size_t i = 0; i < items.n; i++) {
		if (i) putchar(',');
		out_item(&items.items[i]);
	}
	putchar(']');
	if (d) out_said();
	puts("}");
	return 0;
}

int main(void) {
	char *line = NULL;
	size_t cap = 0;
	while (getline(&line, &cap, stdin) > 0) {
		p = line;
		ws();
		if (!*p) continue;
		answer();
		release();
		fflush(stdout);
	}
	free(line);
	free(pool);
	forget();
	free(perm);
	free(table);
	return 0;
}
