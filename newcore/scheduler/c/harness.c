// The C scheduler on the line protocol: one JSON request per line in, one answer per line out, in
// order. Same as ../conformance/harness.ts (its header says the requests and answers).
//
// memory: the values a request builds (nt_value) are handed to the scheduler, which holds its own; the
// request's hold is never let go, so the leak checker is told (below). Each line ends with a sweep
// (sc_sweep). The scheduler is freed at the next "new" and at the end.
#define _POSIX_C_SOURCE 200809L
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "scheduler.h"
#include "steps.h"

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

// at the opening quote: a decoded string, malloc'd; p after the closing quote
static char *str(size_t *len) {
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
	if (len) *len = (size_t)(o - out);
	if (*p == '"') p++;
	else bad = 1;
	return out;
}

static nt_value *value(void) {
	ws();
	if (*p == '"') {
		char *s = str(NULL);
		nt_value *v = nt_str(s);
		free(s);
		return v;
	}
	if (*p == '[') {
		nt_value *l = nt_list();
		p++;
		for (ws(); *p && *p != ']'; ws()) {
			nt_push(l, value());
			ws();
			if (*p == ',') p++;
			else if (*p != ']') { bad = 1; break; }
		}
		if (*p == ']') p++;
		else bad = 1;
		return l;
	}
	if (*p == '{') {
		nt_value *m = nt_map();
		p++;
		for (ws(); *p && *p != '}'; ws()) {
			if (*p != '"') { bad = 1; break; }
			char *k = str(NULL);
			ws();
			if (*p == ':') p++;
			else bad = 1;
			nt_set(m, k, value());
			free(k);
			ws();
			if (*p == ',') p++;
			else if (*p != '}') { bad = 1; break; }
		}
		if (*p == '}') p++;
		else bad = 1;
		return m;
	}
	if (!strncmp(p, "true", 4)) { p += 4; return nt_bool(1); }
	if (!strncmp(p, "false", 5)) { p += 5; return nt_bool(0); }
	if (!strncmp(p, "null", 4)) { p += 4; return nt_null(); }
	char *end;
	double d = strtod(p, &end);
	if (end == p) { bad = 1; p++; return nt_null(); }
	p = end;
	return nt_num(d);
}

// the state

static sc_sched *sched;
static int64_t clk;
static pr_arena may_arena;
static pr_may may;

typedef struct {
	char **v;
	size_t n, cap;
} lines;
static lines moments, logged;

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

static void on_log(void *ctx, nt_value *v) {
	(void)ctx;
	nt_value *j = st_json(v);
	st_buf b = {0};
	st_dump(&b, j);
	add(&logged, b.s);
	nt_free(j);
}

// a moment, as SCHEDULER.tex's: a read's without its items, an error as its code
static void on_moment(void *ctx, const sc_moment *m) {
	(void)ctx;
	nt_value *o = nt_map();
	switch (m->kind) {
	case SC_DUE:
		nt_set(o, "due", nt_str(m->id));
		nt_set(o, "by", nt_num((double)m->by));
		break;
	case SC_STARTS:
		nt_set(o, "starts", nt_str(m->id));
		if (m->has_run) nt_set(o, "run", nt_num((double)m->run));
		if (m->handler) nt_set(o, "handler", nt_str(m->handler));
		if (m->has_rank) nt_set(o, "rank", nt_num((double)m->rank));
		break;
	case SC_READS:
		nt_set(o, "reads", nt_str(m->id));
		if (m->has_run) nt_set(o, "run", nt_num((double)m->run));
		if (m->handler) nt_set(o, "handler", nt_str(m->handler));
		if (m->cleanup) nt_set(o, "cleanup", nt_bool(1));
		nt_set(o, "op", nt_str(m->op));
		nt_set(o, "tracked", nt_bool(m->tracked));
		break;
	case SC_ENDS: {
		static const char *const ended[] = {"done", "pending", "failed", "stopped", "looping"};
		nt_set(o, "ends", nt_str(m->id));
		if (m->has_run) nt_set(o, "run", nt_num((double)m->run));
		if (m->handler) nt_set(o, "handler", nt_str(m->handler));
		nt_set(o, "ended", nt_str(ended[m->ended]));
		if (m->has_equal) nt_set(o, "equal", nt_bool(m->equal));
		if (m->error) nt_set(o, "error", nt_str(st_code(m->error)));
		if (m->waits) nt_set(o, "waits", nt_str(m->waits));
	}
	}
	st_buf b = {0};
	st_dump(&b, o);
	add(&moments, b.s);
	nt_free(o);
}

static void on_log_env(void *ctx, nt_value *v) { on_log(ctx, v); }
static st_env env;

// the host's code: the program at the path, read as the process
static const sc_error *finder(void *ctx, const sc_process *pr, sc_api *view, sc_found *out) {
	(void)ctx;
	sc_items items;
	const sc_error *e = sc_content(view, pr->program, pr->nprogram, &items);
	if (e) return e;
	for (size_t i = 0; i < items.n; i++) {
		const pl_item *it = &items.items[i].it;
		if (!it->has_versions || it->nversions == 0) continue;
		const nd_version *v = &it->versions[0];
		e = st_load(&env, v->content, &out->code);
		if (e) return e;
		out->node = it->id;
		out->time = ((const sc_change *)v->change)->time;
		return NULL;
	}
	out->pending = 1;
	return NULL;
}

static void make(nt_value *q) {
	if (sched) sc_free(sched);
	pr_free(&may_arena);
	clear(&moments);
	clear(&logged);
	clk = 0;
	nt_value *rules = nt_get(q, "rules");
	sc_hook hook = {on_moment, NULL};
	sc_options o = {0};
	o.root = "root";
	o.clock = &clk;
	o.hooks = &hook;
	o.nhooks = 1;
	o.finder = finder;
	if (rules) {
		may = pr_rules(&may_arena, "rules");
		o.may = &may;
	}
	sched = sc_new(&o);
	env = (st_env){sched, on_log_env, NULL};
	if (!rules) return;
	// a node "rules" is made (intro), placed in the root, then given them
	nd_node *n = calloc(1, sizeof *n);
	n->id = "rules";
	nd_version *v = sc_alloc(sched, sizeof *v);
	*v = (nd_version){nt_list(), sc_change_new(sched, 0, "rules"), NULL};
	n->value = (nd_object){v, 1};
	sc_intro(sched, n);
	sc_api *host = sc_host(sched);
	sc_insert(host, "root", "rules", "rules", NULL, NULL, NULL);
	nt_key path[1];
	nt_patch patch = {0};
	patch.place.path = path;
	patch.has_value = 1;
	patch.value = rules;
	const char *const address[] = {"rules"};
	sc_write(host, address, 1, &patch, 1, NULL, NULL, 0, NULL);
}

static const char *const *names_of(const nt_value *l, size_t *n) {
	*n = l && l->type == NT_LIST ? l->count : 0;
	const char **out = sc_alloc(sched, (*n + 1) * sizeof *out);
	for (size_t i = 0; i < *n; i++) out[i] = l->items[i]->type == NT_STR ? l->items[i]->str : "";
	return out;
}

static nt_value *version_json(const nd_version *v, int list) {
	if (!list) return st_version(sched, v);
	const nd_list *l = v->content;
	nt_value *m = nt_map(), *c = nt_list();
	for (size_t i = 0; i < l->length; i++)
		nt_push(c, l->items[i].id ? nt_str(l->items[i].id) : nt_null());
	nt_set(m, "content", c);
	const sc_change *ch = v->change;
	nt_set(m, "time", ch ? nt_num((double)ch->time) : nt_null());
	return m;
}
static nt_value *object_json(const nd_object *o, int list) {
	nt_value *l = nt_list();
	for (size_t i = 0; i < o->length; i++) nt_push(l, version_json(&o->versions[i], list));
	return l;
}
static nt_value *entries_json(const nd_entry *es, size_t n, int list) {
	nt_value *m = nt_map();
	for (size_t i = 0; i < n; i++) nt_set(m, es[i].name, object_json(&es[i].object, list));
	return m;
}

typedef struct {
	nt_value *ops;
	nt_value *out;
} batch;
static const sc_error *answer(nt_value *q, nt_value **out, int *undefined);

static const sc_error *batch_fn(void *ctx) {
	batch *b = ctx;
	for (size_t i = 0; i < b->ops->count; i++) {
		nt_value *a;
		int undef = 0;
		const sc_error *e = answer(b->ops->items[i], &a, &undef);
		if (e) return e;
		nt_push(b->out, undef ? nt_null() : a);
	}
	return NULL;
}

static const sc_error *answer(nt_value *q, nt_value **out, int *undefined) {
	nt_value *opv = nt_get(q, "op");
	const char *op = opv && opv->type == NT_STR ? opv->str : "";
	const sc_error *e;
	*out = NULL;
	if (!strcmp(op, "new")) {
		make(q);
		*undefined = 1;
		return NULL;
	}
	if (!strcmp(op, "start")) {
		sc_startop so = {0};
		size_t n;
		so.address = names_of(nt_get(q, "address"), &n);
		so.naddress = n;
		e = st_program(&env, nt_get(q, "program"), &so);
		if (e) return e;
		nt_value *x;
		if ((x = nt_get(q, "name")) && x->type == NT_STR) so.name = x->str;
		if ((x = nt_get(q, "id")) && x->type == NT_STR) so.id = x->str;
		const char *id;
		e = sc_start(sched, &so, &id);
		if (e) return e;
		*out = nt_str(id);
		return NULL;
	}
	if (!strcmp(op, "call")) {
		sc_callop co = {0};
		size_t n;
		co.address = names_of(nt_get(q, "address"), &n);
		co.naddress = n;
		nt_value *x;
		if ((x = nt_get(q, "args"))) co.args = x;
		if ((x = nt_get(q, "actor")) && x->type == NT_STR) co.actor = sc_agent_of(sched, x->str);
		if ((x = nt_get(q, "person")) && x->type == NT_STR) co.person = x->str;
		if ((x = nt_get(q, "trusted"))) co.has_trusted = 1, co.trusted = x->type == NT_BOOL && x->bool_;
		nt_value *res;
		e = sc_call(sched, &co, &res);
		if (e) return e;
		*out = st_json(res);
		return NULL;
	}
	if (!strcmp(op, "replace")) {
		size_t n;
		const char *const *a = names_of(nt_get(q, "address"), &n);
		e = sc_replace(sched, a, n);
		if (e) return e;
		*out = nt_null();
		return NULL;
	}
	if (!strcmp(op, "outro")) {
		nt_value *id = nt_get(q, "id");
		e = sc_outro(sched, id && id->type == NT_STR ? id->str : "");
		if (e) return e;
		*out = nt_null();
		return NULL;
	}
	if (!strcmp(op, "batch")) {
		batch b = {nt_get(q, "ops"), nt_list()};
		if (!b.ops || b.ops->type != NT_LIST) b.ops = nt_list();
		e = sc_batch(sched, batch_fn, &b);
		if (e) return e;
		*out = b.out;
		return NULL;
	}
	if (!strcmp(op, "moments") || !strcmp(op, "log")) {
		lines *l = !strcmp(op, "log") ? &logged : &moments;
		st_buf b = {0};
		st_put(&b, "[", 1);
		for (size_t i = 0; i < l->n; i++) {
			if (i) st_put(&b, ",", 1);
			st_put(&b, l->v[i], strlen(l->v[i]));
		}
		st_put(&b, "]", 1);
		clear(l);
		// the list is printed whole: carried as a string the printer does not quote
		nt_value *raw = nt_str(b.s);
		free(b.s);
		raw->count = 0x7a77; // marks raw text, below
		*out = raw;
		return NULL;
	}
	if (!strcmp(op, "node")) {
		nt_value *id = nt_get(q, "id");
		nd_node *n = sc_get(sched, id && id->type == NT_STR ? id->str : "");
		if (!n) {
			*out = nt_null();
			return NULL;
		}
		nt_value *m = nt_map();
		nt_set(m, "value", object_json(&n->value, 0));
		nt_set(m, "info", entries_json(n->info, n->info_length, 0));
		nt_set(m, "children", entries_json(n->children, n->children_length, 1));
		nt_set(m, "ephemeral", nt_bool(sc_ephemeral(sched, n->id)));
		*out = m;
		return NULL;
	}
	if (!strcmp(op, "clock")) {
		*out = nt_num((double)clk);
		return NULL;
	}
	nt_value *fields = nt_map();
	for (size_t i = 0; i < q->count; i++)
		if (strcmp(q->keys[i], "op")) nt_set(fields, q->keys[i], q->items[i]);
	return st_operate(sched, sc_host(sched), op, fields, out);
}

// out: raw text marked above is printed as it is
static void print(const nt_value *v, st_buf *b) {
	if (v && v->type == NT_STR && v->count == 0x7a77) {
		st_put(b, v->str, v->bytes);
		return;
	}
	if (v && v->type == NT_LIST) {
		st_put(b, "[", 1);
		for (size_t i = 0; i < v->count; i++) {
			if (i) st_put(b, ",", 1);
			print(v->items[i], b);
		}
		st_put(b, "]", 1);
		return;
	}
	if (v && v->type == NT_MAP) {
		st_buf k = {0};
		st_put(b, "{", 1);
		for (size_t i = 0; i < v->count; i++) {
			if (i) st_put(b, ",", 1);
			nt_value *key = nt_str(v->keys[i]);
			st_dump(b, key);
			nt_free(key);
			st_put(b, ":", 1);
			print(v->items[i], b);
		}
		st_put(b, "}", 1);
		free(k.s);
		return;
	}
	st_dump(b, v);
}

int main(void) {
	make(nt_map());
	char *line = NULL;
	size_t cap = 0;
	ssize_t got;
	while ((got = getline(&line, &cap, stdin)) != -1) {
		p = line;
		ws();
		if (!*p) continue;
		bad = 0;
		nt_value *q = value();
		st_buf b = {0};
		if (bad || q->type != NT_MAP) {
			st_put(&b, "{\"error\":\"thrown\"}", 17);
		} else {
			nt_value *a;
			int undef = 0;
			const sc_error *e = answer(q, &a, &undef);
			if (e) {
				st_put(&b, "{\"error\":", 9);
				nt_value *c = nt_str(st_code(e));
				st_dump(&b, c);
				nt_free(c);
				st_put(&b, "}", 1);
			} else if (undef) st_put(&b, "{}", 2);
			else {
				st_put(&b, "{\"ok\":", 6);
				print(a, &b);
				st_put(&b, "}", 1);
			}
		}
		puts(b.s);
		fflush(stdout);
		free(b.s);
		// nothing the scheduler gave is held past a line: what it let go of goes
		sc_sweep(sched);
	}
	free(line);
	sc_free(sched);
	pr_free(&may_arena);
	return 0;
}
