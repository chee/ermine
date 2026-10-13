// The C scheduler on the line protocol: one JSON request per line in, one answer per line out, in
// order. Same as ../conformance/harness.ts (its header says the requests and answers).
//
// memory: the values a request builds (op_value) are handed to the scheduler, which holds its own; the
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

static op_value *value(void) {
	ws();
	if (*p == '"') {
		char *s = str(NULL);
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
			char *k = str(NULL);
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

static void on_log(void *ctx, op_value *v) {
	(void)ctx;
	op_value *j = st_json(v);
	st_buf b = {0};
	st_dump(&b, j);
	add(&logged, b.s);
	op_free(j);
}

// a moment, as SCHEDULER.tex's: a read's without its items, an error as its code
static void on_moment(void *ctx, const sc_moment *m) {
	(void)ctx;
	op_value *o = op_map();
	switch (m->kind) {
	case SC_DUE:
		op_set(o, "due", op_str(m->id));
		op_set(o, "by", op_num((double)m->by));
		break;
	case SC_STARTS:
		op_set(o, "starts", op_str(m->id));
		if (m->has_run) op_set(o, "run", op_num((double)m->run));
		if (m->handler) op_set(o, "handler", op_str(m->handler));
		if (m->has_rank) op_set(o, "rank", op_num((double)m->rank));
		break;
	case SC_READS:
		op_set(o, "reads", op_str(m->id));
		if (m->has_run) op_set(o, "run", op_num((double)m->run));
		if (m->handler) op_set(o, "handler", op_str(m->handler));
		if (m->cleanup) op_set(o, "cleanup", op_bool(1));
		op_set(o, "op", op_str(m->op));
		op_set(o, "tracked", op_bool(m->tracked));
		break;
	case SC_ENDS: {
		static const char *const ended[] = {"done", "pending", "failed", "stopped", "looping"};
		op_set(o, "ends", op_str(m->id));
		if (m->has_run) op_set(o, "run", op_num((double)m->run));
		if (m->handler) op_set(o, "handler", op_str(m->handler));
		op_set(o, "ended", op_str(ended[m->ended]));
		if (m->has_equal) op_set(o, "equal", op_bool(m->equal));
		if (m->error) op_set(o, "error", op_str(st_code(m->error)));
		if (m->waits) op_set(o, "waits", op_str(m->waits));
	}
	}
	st_buf b = {0};
	st_dump(&b, o);
	add(&moments, b.s);
	op_free(o);
}

static void on_log_env(void *ctx, op_value *v) { on_log(ctx, v); }
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

// the host's site, from new's "site"
static const pr_value *site;
static const pr_value *on_site(void *ctx) {
	(void)ctx;
	return site;
}

static void make(op_value *q) {
	if (sched) sc_free(sched);
	pr_free(&may_arena);
	clear(&moments);
	clear(&logged);
	clk = 0;
	op_value *rules = op_get(q, "rules");
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
	op_value *sv = op_get(q, "site");
	if (sv) o.site = on_site;
	sched = sc_new(&o);
	site = sv ? st_pr(sched, sv) : NULL;
	env = (st_env){sched, on_log_env, NULL};
	if (!rules) return;
	// a node "rules" is made (intro), placed in the root, then given them
	nd_node *n = calloc(1, sizeof *n);
	n->id = "rules";
	nd_version *v = sc_alloc(sched, sizeof *v);
	*v = (nd_version){op_list(), sc_change_new(sched, 0, "rules"), NULL};
	n->value = (nd_object){v, 1};
	sc_intro(sched, n);
	sc_api *host = sc_host(sched);
	sc_insert(host, "root", "rules", "rules", NULL, NULL, NULL);
	op_key path[1];
	op_patch patch = {0};
	patch.place.path = path;
	patch.has_value = 1;
	patch.value = rules;
	const char *const address[] = {"rules"};
	sc_write(host, address, 1, &patch, 1, NULL, NULL, 0, NULL);
}

static const char *const *names_of(const op_value *l, size_t *n) {
	*n = l && l->type == OP_LIST ? l->count : 0;
	const char **out = sc_alloc(sched, (*n + 1) * sizeof *out);
	for (size_t i = 0; i < *n; i++) out[i] = l->items[i]->type == OP_STR ? l->items[i]->str : "";
	return out;
}

typedef struct {
	op_value *ops;
	op_value *out;
} batch;
static const sc_error *answer(op_value *q, op_value **out, int *undefined);

static const sc_error *batch_fn(void *ctx) {
	batch *b = ctx;
	for (size_t i = 0; i < b->ops->count; i++) {
		op_value *a;
		int undef = 0;
		const sc_error *e = answer(b->ops->items[i], &a, &undef);
		if (e) return e;
		op_push(b->out, undef ? op_null() : a);
	}
	return NULL;
}

static const sc_error *answer(op_value *q, op_value **out, int *undefined) {
	op_value *opv = op_get(q, "op");
	const char *op = opv && opv->type == OP_STR ? opv->str : "";
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
		so.address = names_of(op_get(q, "address"), &n);
		so.naddress = n;
		e = st_program(&env, op_get(q, "program"), &so);
		if (e) return e;
		op_value *x;
		if ((x = op_get(q, "name")) && x->type == OP_STR) so.name = x->str;
		if ((x = op_get(q, "id")) && x->type == OP_STR) so.id = x->str;
		const char *id;
		e = sc_start(sched, &so, &id);
		if (e) return e;
		*out = op_str(id);
		return NULL;
	}
	if (!strcmp(op, "call")) {
		sc_callop co = {0};
		size_t n;
		co.address = names_of(op_get(q, "address"), &n);
		co.naddress = n;
		op_value *x;
		if ((x = op_get(q, "args"))) co.args = x;
		if ((x = op_get(q, "actor")) && x->type == OP_STR) co.actor = sc_agent_of(sched, x->str);
		if ((x = op_get(q, "person")) && x->type == OP_STR) co.person = x->str;
		if ((x = op_get(q, "trusted"))) co.has_trusted = 1, co.trusted = x->type == OP_BOOL && x->bool_;
		op_value *res;
		e = sc_call(sched, &co, &res);
		if (e) return e;
		*out = st_json(res);
		return NULL;
	}
	if (!strcmp(op, "replace")) {
		size_t n;
		const char *const *a = names_of(op_get(q, "address"), &n);
		e = sc_replace(sched, a, n);
		if (e) return e;
		*out = op_null();
		return NULL;
	}
	if (!strcmp(op, "outro")) {
		op_value *id = op_get(q, "id");
		e = sc_outro(sched, id && id->type == OP_STR ? id->str : "");
		if (e) return e;
		*out = op_null();
		return NULL;
	}
	if (!strcmp(op, "batch")) {
		batch b = {op_get(q, "ops"), op_list()};
		if (!b.ops || b.ops->type != OP_LIST) b.ops = op_list();
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
		op_value *raw = op_str(b.s);
		free(b.s);
		raw->count = 0x7a77; // marks raw text, below
		*out = raw;
		return NULL;
	}
	if (!strcmp(op, "node")) {
		op_value *id = op_get(q, "id");
		nd_node *n = sc_get(sched, id && id->type == OP_STR ? id->str : "");
		if (!n) {
			*out = op_null();
			return NULL;
		}
		op_value *m = st_node(sched, n);
		op_set(m, "ephemeral", op_bool(sc_ephemeral(sched, n->id)));
		*out = m;
		return NULL;
	}
	if (!strcmp(op, "header")) {
		op_value *id = op_get(q, "id");
		nd_node *n = sc_get(sched, id && id->type == OP_STR ? id->str : "");
		if (!n || !n->value.length || !n->value.versions[0].change) {
			*out = op_null();
			return NULL;
		}
		const sc_change *c = n->value.versions[0].change;
		op_value *m = op_map();
		op_set(m, "time", op_num((double)c->time));
		if (c->cause) op_set(m, "cause", st_pr_json(c->cause));
		if (c->site) op_set(m, "site", st_pr_json(c->site));
		*out = m;
		return NULL;
	}
	if (!strcmp(op, "clock")) {
		*out = op_num((double)clk);
		return NULL;
	}
	op_value *fields = op_map();
	for (size_t i = 0; i < q->count; i++)
		if (strcmp(q->keys[i], "op")) op_set(fields, q->keys[i], q->items[i]);
	return st_operate(sched, sc_host(sched), op, fields, out);
}

// out: raw text marked above is printed as it is
static void print(const op_value *v, st_buf *b) {
	if (v && v->type == OP_STR && v->count == 0x7a77) {
		st_put(b, v->str, v->bytes);
		return;
	}
	if (v && v->type == OP_LIST) {
		st_put(b, "[", 1);
		for (size_t i = 0; i < v->count; i++) {
			if (i) st_put(b, ",", 1);
			print(v->items[i], b);
		}
		st_put(b, "]", 1);
		return;
	}
	if (v && v->type == OP_MAP) {
		st_buf k = {0};
		st_put(b, "{", 1);
		for (size_t i = 0; i < v->count; i++) {
			if (i) st_put(b, ",", 1);
			op_value *key = op_str(v->keys[i]);
			st_dump(b, key);
			op_free(key);
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
	make(op_map());
	char *line = NULL;
	size_t cap = 0;
	ssize_t got;
	while ((got = getline(&line, &cap, stdin)) != -1) {
		p = line;
		ws();
		if (!*p) continue;
		bad = 0;
		op_value *q = value();
		st_buf b = {0};
		if (bad || q->type != OP_MAP) {
			st_put(&b, "{\"error\":\"thrown\"}", 17);
		} else {
			op_value *a;
			int undef = 0;
			const sc_error *e = answer(q, &a, &undef);
			if (e) {
				st_put(&b, "{\"error\":", 9);
				op_value *c = op_str(st_code(e));
				st_dump(&b, c);
				op_free(c);
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
