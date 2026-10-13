// The C graph on the line protocol: one JSON request per line in, one answer line out, in order.
// Same as ../conformance/harness.ts (its header says the requests and answers; normal.ts what is
// seen).
//
// memory: the values a request builds (op_value) are handed to the graph, which holds its own; the
// request's hold is never let go, so the leak checker is told (below). Each line ends with a sweep
// (gr_sweep). The graph is freed at the next "new" and at the end.
#define _POSIX_C_SOURCE 200809L
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "main.h"

// values made and shared into nodes are never freed: not a leak to report
#if defined(__has_feature)
#if __has_feature(address_sanitizer)
const char *__asan_default_options(void) { return "detect_leaks=0"; }
#endif
#elif defined(__SANITIZE_ADDRESS__)
const char *__asan_default_options(void) { return "detect_leaks=0"; }
#endif

// json in

static const char *p; // the parser's place in the line
static int bad;

static void ws(void) {
	while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
}

// U+0000 held as C0 80, as json.h holds it
static int put8(char *o, unsigned long c) {
	if (c == 0) { o[0] = (char)0xC0; o[1] = (char)0x80; return 2; }
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

// at the opening quote: a decoded string, malloc'd; p after the closing quote
static char *str(void) {
	const char *s = ++p;
	while (*p && *p != '"') p += *p == '\\' && p[1] ? 2 : 1;
	char *out = malloc((size_t)(p - s) + 1), *o = out;
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
		default: *o++ = *s++;
		}
	}
	*o = 0;
	if (*p == '"') p++;
	else bad = 1;
	return out;
}

static op_value *value(void) {
	ws();
	if (*p == '"') {
		char *s = str();
		op_value *v = op_str(s);
		free(s);
		return v;
	}
	if (*p == '[') {
		op_value *l = op_list();
		p++;
		for (ws(); *p && *p != ']'; ws()) {
			op_push(l, value());
			ws();
			if (*p == ',') p++;
			else if (*p != ']') { bad = 1; break; }
		}
		if (*p == ']') p++;
		else bad = 1;
		return l;
	}
	if (*p == '{') {
		op_value *m = op_map();
		p++;
		for (ws(); *p && *p != '}'; ws()) {
			if (*p != '"') { bad = 1; break; }
			char *k = str();
			ws();
			if (*p == ':') p++;
			else bad = 1;
			op_set(m, k, value());
			free(k);
			ws();
			if (*p == ',') p++;
			else if (*p != '}') { bad = 1; break; }
		}
		if (*p == '}') p++;
		else bad = 1;
		return m;
	}
	if (!strncmp(p, "true", 4)) { p += 4; return op_bool(1); }
	if (!strncmp(p, "false", 5)) { p += 5; return op_bool(0); }
	if (!strncmp(p, "null", 4)) { p += 4; return op_null(); }
	char *end;
	double d = strtod(p, &end);
	if (end == p) { bad = 1; p++; return op_null(); }
	p = end;
	return op_num(d);
}

// json out: a growing string

typedef struct {
	char *s;
	size_t n, cap;
} buf;

static void put(buf *b, const char *x, size_t n) {
	if (b->n + n + 1 > b->cap) {
		b->cap = (b->n + n + 1) * 2;
		b->s = realloc(b->s, b->cap);
		if (!b->s) abort();
	}
	memcpy(b->s + b->n, x, n);
	b->n += n;
	b->s[b->n] = 0;
}
static void puts_(buf *b, const char *x) { put(b, x, strlen(x)); }

static void put_string(buf *b, const char *s, size_t n) {
	put(b, "\"", 1);
	for (size_t i = 0; i < n; i++) {
		unsigned char c = (unsigned char)s[i];
		char t[8];
		switch (c) {
		case '"': put(b, "\\\"", 2); break;
		case '\\': put(b, "\\\\", 2); break;
		case '\n': put(b, "\\n", 2); break;
		case '\r': put(b, "\\r", 2); break;
		case '\t': put(b, "\\t", 2); break;
		default:
			if (c == 0xC0 && i + 1 < n && (unsigned char)s[i + 1] == 0x80) {
				put(b, "\\u0000", 6);
				i++;
			} else if (c < 0x20) {
				snprintf(t, sizeof t, "\\u%04x", c);
				put(b, t, 6);
			} else put(b, s + i, 1);
		}
	}
	put(b, "\"", 1);
}

static void put_num(buf *b, double d) {
	char t[40];
	if (isnan(d) || isinf(d)) {
		puts_(b, "null");
		return;
	}
	if (d == floor(d) && fabs(d) < 1e15) snprintf(t, sizeof t, "%.0f", d);
	else snprintf(t, sizeof t, "%.17g", d);
	if (!strcmp(t, "-0")) strcpy(t, "0");
	puts_(b, t);
}

static void put_nt(buf *b, const op_value *v) {
	if (v == NULL) puts_(b, "null");
	else
		switch (v->type) {
		case OP_NULL: puts_(b, "null"); break;
		case OP_BOOL: puts_(b, v->bool_ ? "true" : "false"); break;
		case OP_NUM: put_num(b, v->num); break;
		case OP_STR: put_string(b, v->str, v->bytes); break;
		case OP_LIST:
			put(b, "[", 1);
			for (size_t i = 0; i < v->count; i++) {
				if (i) put(b, ",", 1);
				put_nt(b, v->items[i]);
			}
			put(b, "]", 1);
			break;
		default:
			put(b, "{", 1);
			for (size_t i = 0; i < v->count; i++) {
				if (i) put(b, ",", 1);
				put_string(b, v->keys[i], strlen(v->keys[i]));
				put(b, ":", 1);
				put_nt(b, v->items[i]);
			}
			put(b, "}", 1);
		}
}

// protect's values
static void put_pr(buf *b, const pr_value *v) {
	if (v == NULL) puts_(b, "null");
	else
		switch (v->kind) {
		case PR_BOOL: puts_(b, v->yes ? "true" : "false"); break;
		case PR_NUM: put_num(b, v->num); break;
		case PR_STR: put_string(b, v->str, v->n); break;
		case PR_LIST:
			put(b, "[", 1);
			for (size_t i = 0; i < v->n; i++) {
				if (i) put(b, ",", 1);
				put_pr(b, &v->items[i]);
			}
			put(b, "]", 1);
			break;
		case PR_MAP:
			put(b, "{", 1);
			for (size_t i = 0; i < v->n; i++) {
				if (i) put(b, ",", 1);
				put_string(b, v->keys[i], strlen(v->keys[i]));
				put(b, ":", 1);
				put_pr(b, &v->items[i]);
			}
			put(b, "}", 1);
			break;
		default: puts_(b, "null");
		}
}

// the state

static gr_graph *g;
static int64_t clk;
static pr_arena harena; // what the harness keeps for the graph: actors, the host, rules
static pr_may may;
static pr_value *host;
static pr_value *site;

// protect's value from ours, in harena
static pr_value pr_of(const op_value *v) {
	if (v == NULL || v->type == OP_NULL) return pr_null();
	switch (v->type) {
	case OP_BOOL: return pr_bool(v->bool_);
	case OP_NUM: return pr_num(v->num);
	case OP_STR: return pr_str(&harena, v->str, v->bytes);
	case OP_LIST: {
		pr_value l = pr_list();
		for (size_t i = 0; i < v->count; i++) pr_push(&harena, &l, pr_of(v->items[i]));
		return l;
	}
	default: {
		pr_value m = pr_map();
		for (size_t i = 0; i < v->count; i++) pr_put(&harena, &m, v->keys[i], pr_of(v->items[i]));
		return m;
	}
	}
}
static pr_value *prp(const op_value *v) {
	pr_value *x = pr_alloc(&harena, sizeof *x);
	*x = pr_of(v);
	return x;
}

// names are owners and readers: one pointer each
typedef struct {
	char *name;
	gr_reader *reader;
} named;
static named *names;
static size_t nnames, capnames;
static named *name_of(const char *s) {
	for (size_t i = 0; i < nnames; i++)
		if (!strcmp(names[i].name, s)) return &names[i];
	if (nnames == capnames) {
		// pointers into names are not kept: only the name
		capnames = capnames ? capnames * 2 : 16;
		names = realloc(names, capnames * sizeof *names);
		if (!names) abort();
	}
	names[nnames] = (named){strdup(s), NULL};
	return &names[nnames++];
}
static char *owner_of(const char *s) { return name_of(s)->name; }
static gr_reader *reader_of(const char *s) {
	named *n = name_of(s);
	if (!n->reader) n->reader = gr_reader_new(g, n->name);
	return n->reader;
}

typedef struct {
	char *name;
	int alive;
	gr_times wrote;
	gr_api *api;
} iface;
static iface **ifaces;
static size_t nifaces, capifaces;
static iface *iface_of(const char *s, int make) {
	for (size_t i = 0; i < nifaces; i++)
		if (!strcmp(ifaces[i]->name, s)) return ifaces[i];
	if (!make) return NULL;
	if (nifaces == capifaces) {
		capifaces = capifaces ? capifaces * 2 : 16;
		ifaces = realloc(ifaces, capifaces * sizeof *ifaces);
		if (!ifaces) abort();
	}
	iface *f = calloc(1, sizeof *f);
	f->name = strdup(s);
	ifaces[nifaces++] = f;
	return f;
}

typedef struct {
	char **v;
	size_t n, cap;
} lines;
static lines events;

static void add(lines *l, char *s) {
	if (l->n == l->cap) {
		l->cap = l->cap ? l->cap * 2 : 16;
		l->v = realloc(l->v, l->cap * sizeof *l->v);
		if (!l->v) abort();
	}
	l->v[l->n++] = s;
}
static void clear(lines *l) {
	for (size_t i = 0; i < l->n; i++) free(l->v[i]);
	l->n = 0;
}

// a by: the change's header as JSON, and node, which
static void put_by(buf *b, const gr_change *c) {
	puts_(b, "{\"actor\":");
	put_pr(b, c->actor);
	puts_(b, ",\"time\":");
	put_num(b, (double)c->time);
	if (c->reader) {
		puts_(b, ",\"reader\":");
		put_string(b, c->reader, strlen(c->reader));
	}
	if (c->cause) {
		puts_(b, ",\"cause\":");
		put_pr(b, c->cause);
	}
	if (c->site) {
		puts_(b, ",\"site\":");
		put_pr(b, c->site);
	}
	puts_(b, ",\"node\":");
	put_string(b, c->node, strlen(c->node));
	puts_(b, ",\"which\":");
	switch (c->where) {
	case GR_VALUE: puts_(b, "\"value\""); break;
	case GR_LOADED: puts_(b, "\"loaded\""); break;
	case GR_INFO:
	case GR_CHILDREN:
		puts_(b, c->where == GR_INFO ? "[\"info\"," : "[\"children\",");
		put_string(b, c->name, strlen(c->name));
		puts_(b, "]");
		break;
	default: puts_(b, "null");
	}
	puts_(b, "}");
}

static void on_marked(void *ctx, void *owner, const gr_change *by, const void *tag) {
	(void)ctx;
	buf b = {0};
	puts_(&b, "{\"marked\":");
	put_string(&b, owner, strlen(owner));
	puts_(&b, ",\"by\":");
	put_by(&b, by);
	if (tag) {
		puts_(&b, ",\"tag\":");
		put_nt(&b, tag);
	}
	puts_(&b, "}");
	add(&events, b.s);
}
static void on_owned(void *ctx, void *owner, const char *id) {
	(void)ctx;
	buf b = {0};
	puts_(&b, "{\"owned\":");
	put_string(&b, owner, strlen(owner));
	puts_(&b, ",\"id\":");
	put_string(&b, id, strlen(id));
	puts_(&b, "}");
	add(&events, b.s);
}
static void on_released(void *ctx, const char *id, void *owner) {
	(void)ctx;
	buf b = {0};
	puts_(&b, "{\"released\":");
	put_string(&b, id, strlen(id));
	if (owner) {
		puts_(&b, ",\"owner\":");
		put_string(&b, owner, strlen(owner));
	}
	puts_(&b, "}");
	add(&events, b.s);
}
static const pr_value *on_site(void *ctx) {
	(void)ctx;
	return site;
}

static const gr_error *thrown(const char *code) {
	static gr_error e;
	e.code = code;
	e.message = code;
	e.why = NULL;
	return &e;
}

// the nodes
static const gr_change *at0(nd_node *n) {
	return gr_change_new(g, 0, prp(&(op_value){.type = OP_STR, .str = "host", .bytes = 4}), n->id);
}

static nd_node *node_of(const op_value *q) {
	const op_value *idv = op_get(q, "id");
	nd_node *n = gr_alloc(g, sizeof *n);
	n->id = gr_dup(g, idv->str);
	const gr_change *ch = at0(n);
	const op_value *v = op_get(q, "value"), *info = op_get(q, "info"), *kids = op_get(q, "children");
	if (v) {
		nd_version *vs = gr_alloc(g, sizeof *vs);
		*vs = (nd_version){v, ch, NULL};
		n->value = (nd_object){vs, 1};
	}
	if (info && info->type == OP_MAP) {
		n->info = gr_alloc(g, (info->count + 1) * sizeof *n->info);
		for (size_t i = 0; i < info->count; i++) {
			nd_version *vs = gr_alloc(g, sizeof *vs);
			*vs = (nd_version){info->items[i], ch, NULL};
			n->info[i] = (nd_entry){gr_dup(g, info->keys[i]), {vs, 1}};
		}
		n->info_length = info->count;
	}
	if (kids && kids->type == OP_MAP) {
		n->children = gr_alloc(g, (kids->count + 1) * sizeof *n->children);
		for (size_t i = 0; i < kids->count; i++) {
			const op_value *l = kids->items[i];
			nd_list *list = gr_alloc(g, sizeof *list);
			nd_item *its = gr_alloc(g, (l->count + 1) * sizeof *its);
			for (size_t k = 0; k < l->count; k++)
				if (l->items[k]->type == OP_STR) its[k].id = gr_dup(g, l->items[k]->str);
			list->items = its;
			list->length = l->count;
			nd_version *vs = gr_alloc(g, sizeof *vs);
			*vs = (nd_version){list, ch, NULL};
			n->children[i] = (nd_entry){gr_dup(g, kids->keys[i]), {vs, 1}};
		}
		n->children_length = kids->count;
	}
	return n;
}

static const char *s_of(const op_value *x) { return x && x->type == OP_STR ? x->str : NULL; }

static void make(const op_value *q) {
	if (g) gr_free(g);
	pr_free(&harena);
	clear(&events);
	for (size_t i = 0; i < nnames; i++) names[i].reader = NULL;
	for (size_t i = 0; i < nifaces; i++) {
		free(ifaces[i]->wrote.v);
		free(ifaces[i]->name);
		free(ifaces[i]);
	}
	nifaces = 0;
	clk = 0;
	const op_value *x;
	host = prp((x = op_get(q, "actor")) ? x : &(op_value){.type = OP_STR, .str = "host", .bytes = 4});
	site = (x = op_get(q, "site")) ? prp(x) : NULL;
	const op_value *rules = op_get(q, "rules");
	gr_options o = {0};
	o.root = (x = op_get(q, "root")) && s_of(x) ? s_of(x) : "root";
	o.actor = host;
	o.clock = &clk;
	if (rules) {
		may = pr_rules(&harena, "rules");
		o.may = &may;
	}
	o.marked = on_marked;
	o.owned = on_owned;
	o.released = on_released;
	if (site) o.site = on_site;
	g = gr_new(&o);
	if (rules) {
		op_value *m = op_map();
		op_set(m, "id", op_str("rules"));
		op_set(m, "value", (op_value *)rules);
		gr_intro(g, node_of(m), NULL);
	}
	iface *h = iface_of("host", 1);
	h->alive = 1;
	gr_bind b = {0};
	b.agent = host;
	b.site = site != NULL;
	b.writes = 1;
	b.alive = &h->alive;
	h->api = gr_bound(g, &b);
}

static void bind(const char *name, const op_value *q) {
	iface *f = iface_of(name, 1);
	f->alive = 1;
	gr_bind b = {0};
	const op_value *x;
	size_t n = 0;
	const char **place = NULL;
	if ((x = op_get(q, "place")) && x->type == OP_LIST) {
		place = gr_alloc(g, (x->count + 1) * sizeof *place);
		for (size_t i = 0; i < x->count; i++) place[i] = s_of(x->items[i]) ? x->items[i]->str : "";
		n = x->count;
	}
	b.place = place;
	b.nplace = n;
	b.agent = (x = op_get(q, "agent")) ? prp(x) : host;
	if ((x = op_get(q, "reader")) && s_of(x)) b.reader = x->str;
	if ((x = op_get(q, "cause"))) b.cause = prp(x);
	if ((x = op_get(q, "site")) && x->type == OP_BOOL && x->bool_) b.site = 1;
	b.writes = (x = op_get(q, "writes")) ? (x->type == OP_BOOL && x->bool_) : 1;
	b.alive = &f->alive;
	if ((x = op_get(q, "owner")) && s_of(x)) b.owner = owner_of(x->str);
	if ((x = op_get(q, "tag"))) b.tag = x;
	if ((x = op_get(q, "track")) && s_of(x)) b.depend = gr_depend(reader_of(x->str));
	f->wrote.n = 0;
	if ((x = op_get(q, "wrote")) && x->type == OP_BOOL && x->bool_) b.wrote = &f->wrote;
	f->api = gr_bound(g, &b);
}

// the fields of a request

static const char *const *names_of(const op_value *l, size_t *n) {
	*n = l && l->type == OP_LIST ? l->count : 0;
	const char **out = gr_alloc(g, (*n + 1) * sizeof *out);
	for (size_t i = 0; i < *n; i++) out[i] = l->items[i]->type == OP_STR ? l->items[i]->str : "";
	return out;
}

// an address, or an id given as a string (places.h, pl_id)
static const char *const *where_of(const op_value *a, size_t *n) {
	if (a == NULL || a->type != OP_STR) return names_of(a, n);
	const char **out = gr_alloc(g, 2 * sizeof *out);
	out[0] = pl_id, out[1] = a->str;
	*n = 2;
	return out;
}

static const op_value *field(const op_value *f, const char *k) {
	const op_value *v = op_get(f, k);
	return v && v->type == OP_NULL ? NULL : v;
}
static pl_span span_of(const op_value *v) {
	if (v->type == OP_LIST && v->count == 2)
		return (pl_span){(long)v->items[0]->num, (long)v->items[1]->num};
	return (pl_span){(long)v->num, (long)v->num + 1};
}
static pl_span gap_of(const op_value *v) {
	// an index to insert at: one number a is {a, a}
	if (v->type == OP_LIST && v->count == 2)
		return (pl_span){(long)v->items[0]->num, (long)v->items[1]->num};
	return (pl_span){(long)v->num, (long)v->num};
}

static const gr_error *place_of_json(const op_value *path, const op_value *range, op_target *pl) {
	if (!path || path->type != OP_LIST) return thrown("not-a-patch");
	op_key *ks = gr_alloc(g, (path->count + 1) * sizeof *ks);
	for (size_t i = 0; i < path->count; i++) {
		const op_value *k = path->items[i];
		if (k->type == OP_STR) ks[i] = (op_key){OP_STR_KEY, 0, k->str, 0, 0};
		else if (k->type == OP_NUM && k->num >= 0 && k->num == floor(k->num))
			ks[i] = (op_key){OP_NUM_KEY, (long)k->num, NULL, 0, 0};
		else return thrown("not-a-patch");
	}
	pl->path = ks;
	pl->length = path->count;
	if (range) {
		if (range->type != OP_LIST || range->count != 2 || range->items[0]->type != OP_NUM ||
			range->items[1]->type != OP_NUM)
			return thrown("not-a-patch");
		pl->has_range = 1;
		pl->from = (long)range->items[0]->num;
		pl->to = (long)range->items[1]->num;
	}
	return NULL;
}

static const gr_error *patches_of(const op_value *l, op_patch **out, size_t *n) {
	*n = 0;
	*out = NULL;
	if (!l || l->type != OP_LIST) return thrown("not-a-patch");
	op_patch *ps = gr_alloc(g, (l->count + 1) * sizeof *ps);
	for (size_t i = 0; i < l->count; i++) {
		const op_value *pt = l->items[i];
		if (pt->type != OP_MAP) return thrown("not-a-patch");
		const gr_error *e = place_of_json(op_get(pt, "path"), op_get(pt, "range"), &ps[i].place);
		if (e) return e;
		const op_value *v = op_get(pt, "value"), *mv = op_get(pt, "move");
		if (v) ps[i].has_value = 1, ps[i].value = v;
		if (mv) {
			if (mv->type != OP_MAP) return thrown("not-a-patch");
			e = place_of_json(op_get(mv, "path"), op_get(mv, "range"), &ps[i].move);
			if (e) return e;
			ps[i].has_move = 1;
		}
	}
	*n = l->count;
	*out = ps;
	return NULL;
}

// what is seen

static void put_time(buf *b, const void *change) {
	if (change) put_num(b, (double)((const gr_change *)change)->time);
	else puts_(b, "null");
}

static void put_version(buf *b, const nd_version *v, int list) {
	puts_(b, "{\"content\":");
	if (!list) put_nt(b, v->content);
	else {
		const nd_list *l = v->content;
		puts_(b, "[");
		for (size_t i = 0; l && i < l->length; i++) {
			if (i) puts_(b, ",");
			if (l->items[i].id) put_string(b, l->items[i].id, strlen(l->items[i].id));
			else puts_(b, "null");
		}
		puts_(b, "]");
	}
	puts_(b, ",\"time\":");
	put_time(b, v->change);
	puts_(b, "}");
}
static void put_object(buf *b, const nd_object *o, int list) {
	puts_(b, "[");
	for (size_t i = 0; i < o->length; i++) {
		if (i) puts_(b, ",");
		put_version(b, &o->versions[i], list);
	}
	puts_(b, "]");
}
static void put_entries(buf *b, const nd_entry *es, size_t n, int list) {
	puts_(b, "{");
	for (size_t i = 0; i < n; i++) {
		if (i) puts_(b, ",");
		put_string(b, es[i].name, strlen(es[i].name));
		puts_(b, ":");
		put_object(b, &es[i].object, list);
	}
	puts_(b, "}");
}

// an item: look's, or with the versions of an object
static void put_item(buf *b, const gr_item *it, int content) {
	puts_(b, "{\"id\":");
	put_string(b, it->it.id, strlen(it->it.id));
	if (content) {
		if (it->it.has_versions) {
			puts_(b, ",\"versions\":[");
			for (size_t i = 0; i < it->it.nversions; i++) {
				if (i) puts_(b, ",");
				put_version(b, &it->it.versions[i], 0);
			}
			puts_(b, "]");
		}
	} else {
		puts_(b, ",\"loaded\":");
		puts_(b, it->it.node ? "true" : "false");
	}
	if (it->refused) {
		puts_(b, ",\"refused\":");
		put_pr(b, it->refused);
	}
	puts_(b, "}");
}
static void put_items(buf *b, const gr_items *items, int content) {
	puts_(b, "[");
	for (size_t i = 0; i < items->n; i++) {
		if (i) puts_(b, ",");
		put_item(b, &items->items[i], content);
	}
	puts_(b, "]");
}
static void put_times(buf *b, const int64_t *t, size_t n, int list) {
	if (!list) {
		put_num(b, (double)t[0]);
		return;
	}
	puts_(b, "[");
	for (size_t i = 0; i < n; i++) {
		if (i) puts_(b, ",");
		put_num(b, (double)t[i]);
	}
	puts_(b, "]");
}

// an interface's operation, by name: its answer in out
static const gr_error *operate(gr_api *api, const char *op, const op_value *f, buf *out) {
	const gr_error *e;
	gr_items items;
	size_t n = 0, np;
	const op_value *address = op_get(f, "address");
	const char *const *adr = address ? where_of(address, &n) : NULL;
	op_patch *ps;
	long idx = 0;
	const long *index = NULL;
	pl_span slot, ispan;
	const pl_span *slotp = NULL;
	int sl_span = 0;
	int64_t t[2] = {0, 0};
	const op_value *x;
	if ((x = field(f, "index")) && x->type == OP_NUM) idx = (long)x->num, index = &idx;
	if ((x = field(f, "slotindex"))) slot = span_of(x), slotp = &slot, sl_span = x->type == OP_LIST;
	const char *id = s_of(op_get(f, "id"));
	const char *name = s_of(op_get(f, "name"));
	if (!strcmp(op, "look") || !strcmp(op, "lookup") || !strcmp(op, "lookups")) {
		const op_value *path = !strcmp(op, "look") ? address : op_get(f, "path");
		adr = !strcmp(op, "look") ? where_of(path, &n) : names_of(path, &n);
		e = !strcmp(op, "look") ? gr_look(api, adr, n, &items)
			: !strcmp(op, "lookup") ? gr_lookup(api, adr, n, &items)
			: gr_lookups(api, adr, n, &items);
		if (e) return e;
		put_items(out, &items, 0);
		return NULL;
	}
	if (!strcmp(op, "whole")) {
		const nd_node *nd;
		e = gr_node(api, id ? id : "", &nd);
		if (e) return e;
		if (!nd) {
			puts_(out, "null");
			return NULL;
		}
		puts_(out, "{\"value\":");
		put_object(out, &nd->value, 0);
		puts_(out, ",\"info\":");
		put_entries(out, nd->info, nd->info_length, 0);
		puts_(out, ",\"children\":");
		put_entries(out, nd->children, nd->children_length, 1);
		puts_(out, "}");
		return NULL;
	}
	if (!strcmp(op, "as")) {
		const op_value *d = op_get(f, "do");
		const char *inner = d ? s_of(op_get(d, "op")) : NULL;
		x = op_get(f, "cause");
		return operate(gr_as(api, x ? prp(x) : NULL), inner ? inner : "", d, out);
	}
	if (!strcmp(op, "names")) {
		pl_namelist nl;
		e = gr_names_of(api, adr, n, s_of(field(f, "part")) ? s_of(field(f, "part")) : "", &nl);
		if (e) return e;
		puts_(out, "[");
		for (size_t i = 0; i < nl.n; i++) {
			if (i) puts_(out, ",");
			put_string(out, nl.names[i], strlen(nl.names[i]));
		}
		puts_(out, "]");
		return NULL;
	}
	if (!strcmp(op, "children")) {
		if (!(x = field(f, "name")) || !s_of(x)) {
			pl_namelist nl;
			e = gr_names(api, adr, n, &nl);
			if (e) return e;
			puts_(out, "[");
			for (size_t i = 0; i < nl.n; i++) {
				if (i) puts_(out, ",");
				put_string(out, nl.names[i], strlen(nl.names[i]));
			}
			puts_(out, "]");
			return NULL;
		}
		e = gr_children(api, adr, n, s_of(x), &items);
		if (e) return e;
		put_items(out, &items, 0);
		return NULL;
	}
	if (!strcmp(op, "content")) {
		e = gr_content(api, adr, n, &items);
		if (e) return e;
		put_items(out, &items, 1);
		return NULL;
	}
	if (!strcmp(op, "info")) {
		e = gr_info(api, adr, n, name ? name : "", &items);
		if (e) return e;
		put_items(out, &items, 1);
		return NULL;
	}
	if (!strcmp(op, "write") || !strcmp(op, "set")) {
		e = patches_of(op_get(f, "patches"), &ps, &np);
		if (e) return e;
		if (!strcmp(op, "write")) e = gr_write(api, adr, n, ps, np, index, slotp, sl_span, &t[0]);
		else e = gr_set(api, adr, n, name ? name : "", ps, np, index, slotp, sl_span, &t[0]);
		if (e) return e;
		put_times(out, t, 1, 0);
		return NULL;
	}
	if (!strcmp(op, "insert")) {
		const pl_span *isp = NULL;
		if ((x = field(f, "index"))) ispan = gap_of(x), isp = &ispan;
		e = gr_insert(api, id ? id : "", name ? name : "", s_of(op_get(f, "child")) ? s_of(op_get(f, "child")) : "", isp, slotp, &t[0]);
		if (e) return e;
		put_times(out, t, 1, 0);
		return NULL;
	}
	if (!strcmp(op, "remove")) {
		pl_span sp = (x = op_get(f, "index")) ? span_of(x) : (pl_span){0, 1};
		e = gr_remove(api, id ? id : "", name ? name : "", sp, slotp, &t[0]);
		if (e) return e;
		put_times(out, t, 1, 0);
		return NULL;
	}
	if (!strcmp(op, "pop")) {
		pl_span sp = (x = op_get(f, "slotindex")) ? span_of(x) : (pl_span){0, 1};
		e = gr_pop(api, id ? id : "", name ? name : "", sp, &t[0]);
		if (e) return e;
		put_times(out, t, 1, 0);
		return NULL;
	}
	if (!strcmp(op, "rename")) {
		e = gr_rename(api, id ? id : "", name ? name : "", s_of(op_get(f, "to")) ? s_of(op_get(f, "to")) : "", t);
		if (e) return e;
		put_times(out, t, 2, 1);
		return NULL;
	}
	if (!strcmp(op, "move")) {
		long mi = (x = op_get(f, "index")) && x->type == OP_NUM ? (long)x->num : 0;
		long ti = 0;
		const long *tip = NULL;
		if ((x = field(f, "toindex")) && x->type == OP_NUM) ti = (long)x->num, tip = &ti;
		size_t nt = 0;
		e = gr_move(api, id ? id : "", name ? name : "", mi, s_of(op_get(f, "toid")) ? s_of(op_get(f, "toid")) : "",
			s_of(op_get(f, "toname")) ? s_of(op_get(f, "toname")) : "", tip, t, &nt);
		if (e) return e;
		put_times(out, t, nt, 1);
		return NULL;
	}
	if (!strcmp(op, "create")) {
		const op_value *v = op_get(f, "value");
		const op_value *eph = op_get(f, "ephemeral");
		const char *made;
		e = gr_create(api, v, v != NULL, s_of(field(f, "id")), eph && eph->type == OP_BOOL && eph->bool_,
			&made);
		if (e) return e;
		put_string(out, made, strlen(made));
		return NULL;
	}
	return thrown("unknown-op");
}

// the graph's changing, around inner ops run straight on places (place [])

typedef struct {
	const op_value *ops;
	buf *out;
} inner_t;

static gr_where which_of(const op_value *w, const char **name) {
	*name = NULL;
	if (w->type == OP_STR) return !strcmp(w->str, "value") ? GR_VALUE : GR_NOWHERE;
	if (w->type == OP_LIST && w->count == 2 && w->items[0]->type == OP_STR) {
		*name = w->items[1]->str;
		return !strcmp(w->items[0]->str, "info") ? GR_INFO : GR_CHILDREN;
	}
	return GR_NOWHERE;
}

static const gr_error *inner_op(const op_value *q, buf *out) {
	const char *op = s_of(op_get(q, "op"));
	if (!op) return thrown("unknown-op");
	size_t n = 0, np;
	const op_value *address = op_get(q, "address"), *x;
	const char *const *adr = address ? where_of(address, &n) : NULL;
	long idx = 0, ti = 0;
	const long *index = NULL, *tip = NULL;
	pl_span slot, ispan;
	const pl_span *slotp = NULL, *isp = NULL;
	int sl_span = 0;
	int64_t t[2] = {0, 0};
	const gr_error *e;
	if ((x = field(q, "index")) && x->type == OP_NUM) idx = (long)x->num, index = &idx;
	if ((x = field(q, "slotindex"))) slot = span_of(x), slotp = &slot, sl_span = x->type == OP_LIST;
	const char *id = s_of(op_get(q, "id")), *name = s_of(op_get(q, "name"));
	if (!id) id = "";
	if (!strcmp(op, "versions")) {
		nd_node *node = gr_get(g, id);
		if (!node) return thrown("nothing-there");
		const gr_change *c = gr_by(g, id);
		if (!c) return thrown("thrown");
		const op_value *w = op_get(q, "which"), *cs = op_get(q, "contents");
		const char *wname;
		gr_where where = which_of(w, &wname);
		size_t cnt = cs ? cs->count : 0;
		nd_version *vs = gr_alloc(g, (cnt + 1) * sizeof *vs);
		for (size_t i = 0; i < cnt; i++) {
			const void *content = cs->items[i];
			if (where == GR_CHILDREN) {
				const op_value *l = cs->items[i];
				nd_list *list = gr_alloc(g, sizeof *list);
				nd_item *its = gr_alloc(g, (l->count + 1) * sizeof *its);
				for (size_t k = 0; k < l->count; k++)
					if (l->items[k]->type == OP_STR) its[k].id = gr_dup(g, l->items[k]->str);
				list->items = its;
				list->length = l->count;
				content = list;
			}
			vs[i] = (nd_version){content, c, NULL};
		}
		gr_object_set(g, node, where, wname, vs, cnt);
		put_num(out, (double)c->time);
		return NULL;
	}
	if (!strcmp(op, "insert")) {
		if ((x = field(q, "index"))) ispan = gap_of(x), isp = &ispan;
		e = gr_do_insert(g, id, name ? name : "", s_of(op_get(q, "child")) ? s_of(op_get(q, "child")) : "", isp, slotp, &t[0]);
		if (e) return e;
		put_times(out, t, 1, 0);
		return NULL;
	}
	if (!strcmp(op, "remove")) {
		pl_span sp = (x = op_get(q, "index")) ? span_of(x) : (pl_span){0, 1};
		e = gr_do_remove(g, id, name ? name : "", sp, slotp, &t[0]);
		if (e) return e;
		put_times(out, t, 1, 0);
		return NULL;
	}
	if (!strcmp(op, "pop")) {
		pl_span sp = (x = op_get(q, "slotindex")) ? span_of(x) : (pl_span){0, 1};
		e = gr_do_pop(g, id, name ? name : "", sp, &t[0]);
		if (e) return e;
		put_times(out, t, 1, 0);
		return NULL;
	}
	if (!strcmp(op, "rename")) {
		e = gr_do_rename(g, id, name ? name : "", s_of(op_get(q, "to")) ? s_of(op_get(q, "to")) : "", t);
		if (e) return e;
		put_times(out, t, 2, 1);
		return NULL;
	}
	if (!strcmp(op, "move")) {
		long mi = (x = op_get(q, "index")) && x->type == OP_NUM ? (long)x->num : 0;
		if ((x = field(q, "toindex")) && x->type == OP_NUM) ti = (long)x->num, tip = &ti;
		size_t nt = 0;
		e = gr_do_move(g, id, name ? name : "", mi, s_of(op_get(q, "toid")) ? s_of(op_get(q, "toid")) : "",
			s_of(op_get(q, "toname")) ? s_of(op_get(q, "toname")) : "", tip, t, &nt);
		if (e) return e;
		put_times(out, t, nt, 1);
		return NULL;
	}
	if (!strcmp(op, "write") || !strcmp(op, "set")) {
		op_patch *ps;
		e = patches_of(op_get(q, "patches"), &ps, &np);
		if (e) return e;
		if (!strcmp(op, "write")) e = gr_do_write(g, adr, n, ps, np, index, slotp, sl_span, &t[0]);
		else e = gr_do_set(g, adr, n, name ? name : "", ps, np, index, slotp, sl_span, &t[0]);
		if (e) return e;
		put_times(out, t, 1, 0);
		return NULL;
	}
	return thrown("unknown-op");
}

static const gr_error *inner_run(void *ctx) {
	inner_t *in = ctx;
	for (size_t i = 0; i < in->ops->count; i++) {
		if (i) puts_(in->out, ",");
		const gr_error *e = inner_op(in->ops->items[i], in->out);
		if (e) return e;
	}
	return NULL;
}

static const gr_error *changing(const op_value *q, buf *out) {
	const op_value *x;
	gr_acting who = {0};
	who.actor = (x = op_get(q, "actor")) ? prp(x) : prp(&(op_value){.type = OP_NULL});
	if ((x = op_get(q, "reader")) && s_of(x)) who.reader = x->str;
	if ((x = op_get(q, "cause"))) who.cause = prp(x);
	gr_changing_opts o = {0};
	if ((x = op_get(q, "own")) && s_of(x)) o.own = owner_of(x->str);
	if ((x = op_get(q, "tag"))) o.tag = x;
	if ((x = op_get(q, "snap")) && x->type == OP_LIST) {
		gr_snap *snaps = gr_alloc(g, (x->count + 1) * sizeof *snaps);
		for (size_t i = 0; i < x->count; i++) {
			const op_value *pair = x->items[i];
			snaps[i].id = s_of(pair->items[0]);
			snaps[i].where = which_of(pair->items[1], &snaps[i].name);
		}
		o.has_snap = 1;
		o.snap = snaps;
		o.nsnap = x->count;
	}
	op_value *none = op_list();
	const op_value *ops = op_get(q, "do");
	inner_t in = {ops && ops->type == OP_LIST ? ops : none, out};
	puts_(out, "[");
	const gr_error *e = gr_changing(g, &who, &o, inner_run, &in);
	puts_(out, "]");
	return e;
}

static const gr_error *answer(const op_value *q, buf *out, int *undefined) {
	const char *op = s_of(op_get(q, "op"));
	if (!op) op = "";
	const op_value *x;
	if (!strcmp(op, "new")) {
		make(q);
		*undefined = 1;
		return NULL;
	}
	if (!strcmp(op, "bind")) {
		bind(s_of(op_get(q, "as")) ? s_of(op_get(q, "as")) : "", q);
		*undefined = 1;
		return NULL;
	}
	if (!strcmp(op, "stop")) {
		iface *f = iface_of(s_of(op_get(q, "as")) ? s_of(op_get(q, "as")) : "", 1);
		f->alive = 0;
		*undefined = 1;
		return NULL;
	}
	if (!strcmp(op, "wrote")) {
		iface *f = iface_of(s_of(op_get(q, "as")) ? s_of(op_get(q, "as")) : "", 1);
		put_times(out, f->wrote.v, f->wrote.n, 1);
		f->wrote.n = 0;
		return NULL;
	}
	if (!strcmp(op, "reader") || !strcmp(op, "begin") || !strcmp(op, "end") ||
		!strcmp(op, "untrack")) {
		gr_reader *r = reader_of(s_of(op_get(q, "owner")) ? s_of(op_get(q, "owner")) : "");
		if (!strcmp(op, "begin")) gr_begin(r);
		else if (!strcmp(op, "end")) gr_end(r);
		else if (!strcmp(op, "untrack")) gr_untrack(r);
		*undefined = 1;
		return NULL;
	}
	if (!strcmp(op, "intro")) {
		gr_acting who = {(x = op_get(q, "actor")) ? prp(x) : host, NULL, NULL, NULL};
		gr_intro(g, node_of(q), &who);
		put_num(out, (double)clk);
		return NULL;
	}
	if (!strcmp(op, "release")) {
		const char *id = s_of(op_get(q, "id")) ? s_of(op_get(q, "id")) : "";
		int64_t time = ++clk;
		gr_change *c = gr_alloc(g, sizeof *c);
		c->time = time;
		c->actor = host;
		c->node = gr_dup(g, id);
		c->where = GR_LOADED;
		gr_release(g, c->node, c);
		put_num(out, (double)time);
		return NULL;
	}
	if (!strcmp(op, "make")) {
		gr_acting who = {(x = op_get(q, "actor")) ? prp(x) : host, NULL, NULL, NULL};
		const op_value *v = op_get(q, "value");
		const char *made;
		const gr_error *e = gr_make(g, s_of(field(q, "id")), v, v != NULL, &who, &made);
		if (e) return e;
		put_string(out, made, strlen(made));
		return NULL;
	}
	if (!strcmp(op, "own")) {
		gr_own(g, s_of(op_get(q, "id")) ? s_of(op_get(q, "id")) : "",
			(x = field(q, "owner")) && s_of(x) ? owner_of(x->str) : NULL);
		*undefined = 1;
		return NULL;
	}
	if (!strcmp(op, "asking")) {
		const op_value *as = op_get(q, "asks");
		size_t n = as && as->type == OP_LIST ? as->count : 0;
		pr_ask *asks = gr_alloc(g, (n + 1) * sizeof *asks);
		for (size_t i = 0; i < n; i++) {
			asks[i].op = s_of(op_get(as->items[i], "op")) ? s_of(op_get(as->items[i], "op")) : "";
			asks[i].args = (x = op_get(as->items[i], "args")) ? pr_of(x) : pr_map();
		}
		const pr_value *actor = (x = op_get(q, "actor")) ? prp(x) : prp(&(op_value){.type = OP_NULL});
		const gr_error *e = gr_asking(g, actor, asks, n, "asking");
		if (e) return e;
		puts_(out, "null");
		return NULL;
	}
	if (!strcmp(op, "changing")) return changing(q, out);
	if (!strcmp(op, "node")) {
		const char *id = s_of(op_get(q, "id")) ? s_of(op_get(q, "id")) : "";
		nd_node *n = gr_get(g, id);
		if (!n) {
			puts_(out, "null");
			return NULL;
		}
		puts_(out, "{\"value\":");
		put_object(out, &n->value, 0);
		puts_(out, ",\"info\":");
		put_entries(out, n->info, n->info_length, 0);
		puts_(out, ",\"children\":");
		put_entries(out, n->children, n->children_length, 1);
		puts_(out, ",\"ephemeral\":");
		puts_(out, gr_ephemeral(g, id) ? "true" : "false");
		const char *o = gr_owner(g, id);
		if (o) {
			puts_(out, ",\"owner\":");
			put_string(out, o, strlen(o));
		}
		puts_(out, "}");
		return NULL;
	}
	if (!strcmp(op, "events")) {
		puts_(out, "[");
		for (size_t i = 0; i < events.n; i++) {
			if (i) puts_(out, ",");
			puts_(out, events.v[i]);
		}
		puts_(out, "]");
		clear(&events);
		return NULL;
	}
	if (!strcmp(op, "clock")) {
		put_num(out, (double)clk);
		return NULL;
	}
	// an interface's operation
	const char *as = s_of(op_get(q, "as"));
	iface *f = iface_of(as ? as : "host", 0);
	if (!f || !f->api) return thrown("no-interface");
	op_value *fields = op_map();
	for (size_t i = 0; i < q->count; i++)
		if (strcmp(q->keys[i], "op") && strcmp(q->keys[i], "as")) op_set(fields, q->keys[i], q->items[i]);
	return operate(f->api, op, fields, out);
}

int main(void) {
	op_value *empty = op_map();
	make(empty);
	char *line = NULL;
	size_t cap = 0;
	ssize_t got;
	while ((got = getline(&line, &cap, stdin)) != -1) {
		p = line;
		ws();
		if (!*p) continue;
		bad = 0;
		op_value *q = value();
		buf b = {0};
		if (bad || q->type != OP_MAP) {
			puts_(&b, "{\"error\":\"thrown\"}");
		} else {
			buf out = {0};
			int undef = 0;
			const gr_error *e = answer(q, &out, &undef);
			if (e) {
				puts_(&b, "{\"error\":");
				put_string(&b, e->code ? e->code : "thrown", strlen(e->code ? e->code : "thrown"));
				if (e->why) {
					puts_(&b, ",\"why\":");
					put_pr(&b, e->why);
				}
				puts_(&b, "}");
			} else if (undef) puts_(&b, "{}");
			else {
				puts_(&b, "{\"ok\":");
				puts_(&b, out.s ? out.s : "null");
				puts_(&b, "}");
			}
			free(out.s);
		}
		puts(b.s);
		fflush(stdout);
		free(b.s);
		// nothing the graph gave is held past a line: what it let go of goes
		if (g) gr_sweep(g);
	}
	free(line);
	gr_free(g);
	pr_free(&harena);
	return 0;
}
