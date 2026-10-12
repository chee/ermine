// Programs as data, and the JSON forms of what the scheduler gives (see steps.h)
#include "steps.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// a growing string

void st_put(st_buf *b, const char *x, size_t n) {
	if (b->n + n + 1 > b->cap) {
		b->cap = (b->n + n + 1) * 2;
		b->s = realloc(b->s, b->cap);
		if (!b->s) abort();
	}
	memcpy(b->s + b->n, x, n);
	b->n += n;
	b->s[b->n] = 0;
}

static void put_string(st_buf *b, const char *s, size_t n) {
	st_put(b, "\"", 1);
	for (size_t i = 0; i < n; i++) {
		unsigned char c = (unsigned char)s[i];
		char t[8];
		switch (c) {
		case '"': st_put(b, "\\\"", 2); break;
		case '\\': st_put(b, "\\\\", 2); break;
		case '\n': st_put(b, "\\n", 2); break;
		case '\r': st_put(b, "\\r", 2); break;
		case '\t': st_put(b, "\\t", 2); break;
		default:
			if (c < 0x20) {
				snprintf(t, sizeof t, "\\u%04x", c);
				st_put(b, t, 6);
			} else st_put(b, s + i, 1);
		}
	}
	st_put(b, "\"", 1);
}

void st_dump(st_buf *b, const nt_value *v) {
	char t[40];
	if (v == NULL) st_put(b, "null", 4);
	else if (sc_live_fn(v)) st_put(b, "\"<live>\"", 8);
	else
		switch (v->type) {
		case NT_NULL: st_put(b, "null", 4); break;
		case NT_BOOL: st_put(b, v->bool_ ? "true" : "false", v->bool_ ? 4 : 5); break;
		case NT_NUM:
			if (isnan(v->num) || isinf(v->num)) st_put(b, "null", 4);
			else {
				if (v->num == floor(v->num) && fabs(v->num) < 1e15) snprintf(t, sizeof t, "%.0f", v->num);
				else snprintf(t, sizeof t, "%.17g", v->num);
				if (!strcmp(t, "-0")) strcpy(t, "0");
				st_put(b, t, strlen(t));
			}
			break;
		case NT_STR: put_string(b, v->str, v->bytes); break;
		case NT_LIST:
			st_put(b, "[", 1);
			for (size_t i = 0; i < v->count; i++) {
				if (i) st_put(b, ",", 1);
				st_dump(b, v->items[i]);
			}
			st_put(b, "]", 1);
			break;
		default:
			st_put(b, "{", 1);
			for (size_t i = 0; i < v->count; i++) {
				if (i) st_put(b, ",", 1);
				put_string(b, v->keys[i], strlen(v->keys[i]));
				st_put(b, ":", 1);
				st_dump(b, v->items[i]);
			}
			st_put(b, "}", 1);
		}
}

const char *st_code(const sc_error *e) { return e && e->code ? e->code : "thrown"; }

static const sc_error *thrown(sc_sched *s, const char *code) {
	return sc_error_new(s, sc_dup(s, code), sc_dup(s, code), 0);
}

// normal.ts: json, version, item

nt_value *st_json(const nt_value *v) {
	if (v == NULL) return nt_null();
	if (sc_live_fn(v)) return nt_str("<live>");
	switch (v->type) {
	case NT_NULL: return nt_null();
	case NT_BOOL: return nt_bool(v->bool_);
	case NT_NUM: return nt_num(v->num);
	case NT_STR: return nt_str(v->str);
	case NT_LIST: {
		nt_value *l = nt_list();
		for (size_t i = 0; i < v->count; i++) nt_push(l, st_json(v->items[i]));
		return l;
	}
	default: {
		nt_value *m = nt_map();
		for (size_t i = 0; i < v->count; i++) nt_set(m, v->keys[i], st_json(v->items[i]));
		return m;
	}
	}
}

// a status as JSON: an error as its code
static nt_value *status_json(const nt_value *s) {
	nt_value *out = st_json(s);
	nt_value *e = nt_get(s, "error");
	if (e) {
		nt_value *c = nt_get(e, "code");
		nt_value *code = nt_str(c && c->type == NT_STR ? c->str : "thrown");
		nt_set(out, "error", code);
	}
	return out;
}

nt_value *st_version(sc_sched *s, const nd_version *v) {
	(void)s;
	int status = v->because == sc_status_because;
	nt_value *m = nt_map();
	nt_set(m, "content", status ? status_json(v->content) : st_json(v->content));
	const sc_change *c = v->change;
	nt_set(m, "time", c ? nt_num((double)c->time) : nt_null());
	if (status) nt_set(m, "status", nt_bool(1));
	return m;
}

// content: the item has an object's versions (content, info); else look's
nt_value *st_item(sc_sched *s, const sc_item *it, int content) {
	nt_value *m = nt_map();
	nt_set(m, "id", nt_str(it->it.id));
	if (content) {
		if (it->it.has_versions) {
			nt_value *vs = nt_list();
			for (size_t i = 0; i < it->it.nversions; i++) nt_push(vs, st_version(s, &it->it.versions[i]));
			nt_set(m, "versions", vs);
		}
	} else nt_set(m, "loaded", nt_bool(it->it.node != NULL));
	if (it->refused) {
		/* protect's why as JSON */
		nt_value *w = nt_map();
		const pr_value *r = it->refused;
		for (size_t i = 0; i < r->n; i++) {
			const pr_value *x = &r->items[i];
			nt_value *y = NULL;
			switch (x->kind) {
			case PR_BOOL: y = nt_bool(x->yes); break;
			case PR_NUM: y = nt_num(x->num); break;
			case PR_STR: y = nt_str(x->str); break;
			default: y = nt_null();
			}
			nt_set(w, r->keys[i], y);
		}
		nt_set(m, "refused", w);
	}
	return m;
}

// the interpreter

typedef struct {
	const char **k;
	nt_value **v;
	size_t n, cap;
} vars;

static vars vars_copy(sc_sched *s, const vars *a) {
	vars c = {0};
	c.n = c.cap = a->n;
	c.k = sc_alloc(s, (a->n + 4) * sizeof *c.k);
	c.v = sc_alloc(s, (a->n + 4) * sizeof *c.v);
	c.cap = a->n + 4;
	if (a->n) {
		memcpy(c.k, a->k, a->n * sizeof *c.k);
		memcpy(c.v, a->v, a->n * sizeof *c.v);
	}
	return c;
}
static void vars_set(sc_sched *s, vars *a, const char *k, nt_value *v) {
	for (size_t i = 0; i < a->n; i++)
		if (!strcmp(a->k[i], k)) {
			a->v[i] = v;
			return;
		}
	if (a->n == a->cap) {
		size_t cap = a->cap ? a->cap * 2 : 8;
		const char **nk = sc_alloc(s, cap * sizeof *nk);
		nt_value **nv = sc_alloc(s, cap * sizeof *nv);
		if (a->n) {
			memcpy(nk, a->k, a->n * sizeof *nk);
			memcpy(nv, a->v, a->n * sizeof *nv);
		}
		a->k = nk;
		a->v = nv;
		a->cap = cap;
	}
	a->k[a->n] = k;
	a->v[a->n++] = v;
}
static nt_value *vars_get(const vars *a, const char *k) {
	for (size_t i = 0; i < a->n; i++)
		if (!strcmp(a->k[i], k)) return a->v[i];
	return NULL;
}

// a run of steps
typedef struct {
	st_env *env;
	sc_sched *s;
	sc_given *g;
	vars *vars;
	nt_value *ret;
} rctx;

typedef struct {
	sc_fn fn;
	st_env *env;
	const nt_value *steps;
	vars snapshot;
	int merge; // a cleanup: the maker's given, with the cleanup's own over it
	sc_given maker;
} closure;

static const sc_error *eval(rctx *r, const nt_value *e, nt_value **out);
static const sc_error *steps_run(rctx *r, const nt_value *list, int *flow);

static int truthy(const nt_value *v) {
	if (!v || v->type == NT_NULL) return sc_live_fn(v) != NULL;
	if (v->type == NT_BOOL) return v->bool_;
	if (v->type == NT_NUM) return v->num != 0 && !isnan(v->num);
	if (v->type == NT_STR) return v->bytes > 0;
	return 1;
}

static int same_json(const nt_value *a, const nt_value *b) {
	st_buf x = {0}, y = {0};
	st_dump(&x, a);
	st_dump(&y, b);
	int same = !strcmp(x.s, y.s);
	free(x.s);
	free(y.s);
	return same;
}

static const sc_error *call_closure(sc_fn *self, sc_given *g, nt_value **out, int *pending) {
	closure *c = (closure *)self;
	sc_sched *s = c->env->s;
	sc_given merged;
	if (c->merge) {
		// the maker's fields, read; what calls the scheduler is the cleanup's own (the maker's is gone)
		merged = c->maker;
		merged.ctx = g->ctx;
		merged.peep = g->peep;
		merged.api = g->api;
		merged.has_killed = g->has_killed;
		merged.killed = g->killed;
		g = &merged;
	}
	vars v = vars_copy(s, &c->snapshot);
	rctx r = {c->env, s, g, &v, NULL};
	int flow = 0;
	*out = NULL;
	*pending = 0;
	const sc_error *e = steps_run(&r, c->steps, &flow);
	if (e) return e;
	if (flow == 1) *out = r.ret;
	else if (flow == 2) *pending = 1;
	else *out = nt_null();
	return NULL;
}

static closure *closure_new(st_env *env, const nt_value *steps, const vars *snap) {
	closure *c = sc_alloc(env->s, sizeof *c);
	c->fn.call = call_closure;
	c->env = env;
	// the steps are part of a value: held as long as the closure (never let go)
	c->steps = nt_ref((nt_value *)steps);
	if (snap) c->snapshot = vars_copy(env->s, snap);
	return c;
}

static nt_value *given_field(rctx *r, const char *f) {
	sc_given *g = r->g;
	if (!strcmp(f, "value")) return g->value ? st_json(g->value) : nt_null();
	if (!strcmp(f, "previous")) return g->previous ? st_json(g->previous) : nt_null();
	if (!strcmp(f, "args")) return g->args ? st_json(g->args) : nt_null();
	if (!strcmp(f, "self")) return g->self ? nt_str(g->self) : nt_null();
	if (!strcmp(f, "name")) return g->name ? nt_str(g->name) : nt_null();
	if (!strcmp(f, "killed")) return g->has_killed ? nt_bool(g->killed) : nt_null();
	if (!strcmp(f, "by") && g->by) {
		nt_value *l = nt_list();
		for (size_t i = 0; i < g->nby; i++) {
			nt_value *m = nt_map();
			nt_set(m, "time", nt_num((double)g->by[i]));
			nt_push(l, m);
		}
		return l;
	}
	return nt_null();
}

static double to_num(const nt_value *v) {
	if (!v) return NAN;
	switch (v->type) {
	case NT_NUM: return v->num;
	case NT_BOOL: return v->bool_;
	case NT_NULL: return sc_live_fn(v) ? NAN : 0;
	case NT_STR: {
		char *end;
		if (v->bytes == 0) return 0;
		double d = strtod(v->str, &end);
		return *end ? NAN : d;
	}
	default: return NAN;
	}
}

static const sc_error *eval(rctx *r, const nt_value *e, nt_value **out) {
	sc_sched *s = r->s;
	if (e == NULL) {
		*out = nt_null();
		return NULL;
	}
	if (e->type == NT_LIST) {
		nt_value *l = nt_list();
		for (size_t i = 0; i < e->count; i++) {
			nt_value *x;
			const sc_error *er = eval(r, e->items[i], &x);
			if (er) return er;
			nt_push(l, x);
		}
		*out = l;
		return NULL;
	}
	if (e->type != NT_MAP) {
		*out = (nt_value *)e;
		return NULL;
	}
	if (e->count == 1 && e->keys[0][0] == '$') {
		const char *k = e->keys[0];
		const nt_value *a = e->items[0];
		if (!strcmp(k, "$var")) {
			nt_value *v = a && a->type == NT_STR ? vars_get(r->vars, a->str) : NULL;
			*out = v ? v : nt_null();
			return NULL;
		}
		if (!strcmp(k, "$given")) {
			*out = given_field(r, a && a->type == NT_STR ? a->str : "");
			return NULL;
		}
		if (!strcmp(k, "$get")) {
			if (!a || a->type != NT_LIST || a->count == 0) {
				*out = nt_null();
				return NULL;
			}
			nt_value *v;
			const sc_error *er = eval(r, a->items[0], &v);
			if (er) return er;
			nt_value *keys[64];
			size_t nk = a->count - 1 < 64 ? a->count - 1 : 64;
			for (size_t i = 0; i < nk; i++) {
				er = eval(r, a->items[i + 1], &keys[i]);
				if (er) return er;
			}
			for (size_t i = 0; i < nk; i++) {
				if (!v || (v->type != NT_LIST && v->type != NT_MAP) || sc_live_fn(v)) {
					*out = nt_null();
					return NULL;
				}
				nt_value *key = keys[i], *next = NULL;
				if (v->type == NT_LIST) {
					if (key->type == NT_NUM && key->num >= 0 && key->num == floor(key->num) &&
						(size_t)key->num < v->count)
						next = v->items[(size_t)key->num];
				} else {
					char t[40];
					const char *ks = NULL;
					if (key->type == NT_STR) ks = key->str;
					else if (key->type == NT_NUM) {
						snprintf(t, sizeof t, "%.0f", key->num);
						ks = t;
					}
					if (ks) next = nt_get(v, ks);
				}
				if (!next) {
					*out = nt_null();
					return NULL;
				}
				v = next;
			}
			*out = v;
			return NULL;
		}
		if (!strcmp(k, "$add") || !strcmp(k, "$eq")) {
			nt_value *x = NULL, *y = NULL;
			if (a && a->type == NT_LIST && a->count >= 2) {
				const sc_error *er = eval(r, a->items[0], &x);
				if (er) return er;
				er = eval(r, a->items[1], &y);
				if (er) return er;
			}
			if (!strcmp(k, "$eq")) *out = nt_bool(x && y && same_json(x, y));
			else if (x && y && x->type == NT_STR && y->type == NT_STR) {
				char *t = malloc(x->bytes + y->bytes + 1);
				memcpy(t, x->str, x->bytes);
				memcpy(t + x->bytes, y->str, y->bytes);
				t[x->bytes + y->bytes] = 0;
				*out = nt_str(t);
				free(t);
			} else *out = nt_num(to_num(x) + to_num(y));
			return NULL;
		}
		if (!strcmp(k, "$not")) {
			nt_value *x;
			const sc_error *er = eval(r, a, &x);
			if (er) return er;
			*out = nt_bool(!truthy(x));
			return NULL;
		}
		if (!strcmp(k, "$len")) {
			nt_value *x;
			const sc_error *er = eval(r, a, &x);
			if (er) return er;
			*out = nt_num(x && !sc_live_fn(x) && (x->type == NT_LIST) ? (double)x->count
				: x && x->type == NT_STR ? (double)x->bytes : 0);
			return NULL;
		}
		if (!strcmp(k, "$steps")) {
			closure *c = closure_new(r->env, a, r->vars);
			*out = sc_live(&c->fn);
			return NULL;
		}
		if (!strcmp(k, "$quote")) {
			*out = (nt_value *)a;
			return NULL;
		}
		return thrown(s, "not-a-step");
	}
	nt_value *m = nt_map();
	for (size_t i = 0; i < e->count; i++) {
		nt_value *x;
		const sc_error *er = eval(r, e->items[i], &x);
		if (er) return er;
		nt_set(m, e->keys[i], x);
	}
	*out = m;
	return NULL;
}

// names of a list of strings, in the arena
static const char *const *names_of(sc_sched *s, const nt_value *l, size_t *n) {
	*n = l && l->type == NT_LIST ? l->count : 0;
	const char **out = sc_alloc(s, (*n + 1) * sizeof *out);
	for (size_t i = 0; i < *n; i++) out[i] = l->items[i]->type == NT_STR ? l->items[i]->str : "";
	return out;
}

const sc_error *st_program(st_env *env, const nt_value *p, sc_startop *op) {
	if (p && p->type == NT_LIST) {
		op->has_path = 1;
		op->path = names_of(env->s, p, &op->npath);
		return NULL;
	}
	return st_load(env, p, &op->code);
}

static const sc_error *start_step(rctx *r, const nt_value *st, nt_value **idout) {
	sc_startop op = {0};
	nt_value *address, *program;
	const sc_error *e = eval(r, nt_get(st, "address"), &address);
	if (e) return e;
	e = eval(r, nt_get(st, "program"), &program);
	if (e) return e;
	op.address = names_of(r->s, address, &op.naddress);
	e = st_program(r->env, program, &op);
	if (e) return e;
	nt_value *x;
	if (nt_get(st, "name")) {
		e = eval(r, nt_get(st, "name"), &x);
		if (e) return e;
		op.name = x->type == NT_STR ? x->str : NULL;
	}
	if (nt_get(st, "id")) {
		e = eval(r, nt_get(st, "id"), &x);
		if (e) return e;
		op.id = x->type == NT_STR ? x->str : NULL;
	}
	const char *id;
	e = sc_given_start(r->g, &op, &id);
	if (e) return e;
	*idout = nt_str(id);
	return NULL;
}

static const sc_error *steps_run(rctx *r, const nt_value *list, int *flow) {
	sc_sched *s = r->s;
	if (!list || list->type != NT_LIST) return NULL;
	for (size_t i = 0; i < list->count; i++) {
		const nt_value *st = list->items[i];
		const nt_value *d = nt_get(st, "do");
		const char *what = d && d->type == NT_STR ? d->str : "";
		const nt_value *var = nt_get(st, "var");
		const char *vname = var && var->type == NT_STR ? var->str : NULL;
		nt_value *x = NULL;
		const sc_error *e;
		if (!strcmp(what, "let")) {
			e = eval(r, nt_get(st, "value"), &x);
			if (e) return e;
			if (var && var->type == NT_STR) vars_set(s, r->vars, var->str, x);
		} else if (!strcmp(what, "return")) {
			const nt_value *v = nt_get(st, "value");
			if (v) {
				e = eval(r, v, &x);
				if (e) return e;
			} else x = nt_null();
			r->ret = x;
			*flow = 1;
			return NULL;
		} else if (!strcmp(what, "pending")) {
			*flow = 2;
			return NULL;
		} else if (!strcmp(what, "log")) {
			e = eval(r, nt_get(st, "value"), &x);
			if (e) return e;
			r->env->log(r->env->ctx, x);
		} else if (!strcmp(what, "throw")) {
			e = eval(r, nt_get(st, "code"), &x);
			if (e) return e;
			st_buf b = {0};
			if (x && x->type == NT_STR) st_put(&b, x->str, x->bytes);
			else st_dump(&b, x);
			const sc_error *t = thrown(s, b.s ? b.s : "");
			free(b.s);
			return t;
		} else if (!strcmp(what, "if")) {
			e = eval(r, nt_get(st, "test"), &x);
			if (e) return e;
			e = steps_run(r, truthy(x) ? nt_get(st, "then") : nt_get(st, "else"), flow);
			if (e) return e;
			if (*flow) return NULL;
		} else if (!strcmp(what, "cleanup")) {
			closure *c = closure_new(r->env, nt_get(st, "steps"), r->vars);
			c->merge = 1;
			// the maker's given outlives its call: what it points to that is scratch, kept
			c->maker = *r->g;
			nt_ref(c->maker.value);
			nt_ref(c->maker.previous);
			nt_ref(c->maker.args);
			c->maker.marks = NULL;
			if (r->g->by) {
				c->maker.by = sc_alloc(s, (r->g->nby + 1) * sizeof *c->maker.by);
				memcpy(c->maker.by, r->g->by, r->g->nby * sizeof *c->maker.by);
			}
			e = sc_given_cleanup(r->g, &c->fn);
			if (e) return e;
		} else if (!strcmp(what, "start")) {
			e = start_step(r, st, &x);
			if (e) return e;
			if (vname) vars_set(s, r->vars, vname, x);
		} else if (!strcmp(what, "call")) {
			nt_value *address, *args = NULL;
			e = eval(r, nt_get(st, "address"), &address);
			if (e) return e;
			if (nt_get(st, "args")) {
				e = eval(r, nt_get(st, "args"), &args);
				if (e) return e;
			}
			size_t n;
			const char *const *names = names_of(s, address, &n);
			nt_value *res;
			e = sc_given_call(r->g, names, n, args, &res);
			if (e) return e;
			if (vname) vars_set(s, r->vars, vname, st_json(res));
		} else {
			const nt_value *peep = nt_get(st, "peep");
			sc_api *api = truthy(peep) ? r->g->peep : r->g->api;
			nt_value *fields = nt_map();
			for (size_t k = 0; k < st->count; k++) {
				if (!strcmp(st->keys[k], "do") || !strcmp(st->keys[k], "var") ||
					!strcmp(st->keys[k], "peep"))
					continue;
				e = eval(r, st->items[k], &x);
				if (e) return e;
				nt_set(fields, st->keys[k], x);
			}
			if (!api) return thrown(s, "thrown");
			e = st_operate(s, api, what, fields, &x);
			if (e) return e;
			if (vname) vars_set(s, r->vars, vname, x);
		}
	}
	return NULL;
}

const sc_error *st_load(st_env *env, const nt_value *p, sc_code *out) {
	memset(out, 0, sizeof *out);
	if (!p || p->type != NT_MAP) return thrown(env->s, "not-a-program");
	const nt_value *setup = nt_get(p, "setup"), *compute = nt_get(p, "compute"),
		       *effect = nt_get(p, "effect");
	if (setup && setup->type == NT_LIST) {
		out->setup = &closure_new(env, setup, NULL)->fn;
		return NULL;
	}
	if (compute && compute->type == NT_LIST) {
		out->compute = &closure_new(env, compute, NULL)->fn;
		if (effect && effect->type == NT_LIST) out->effect = &closure_new(env, effect, NULL)->fn;
		return NULL;
	}
	return thrown(env->s, "not-a-program");
}

// operate (normal.ts)

static const nt_value *field(const nt_value *f, const char *k) {
	const nt_value *v = nt_get(f, k);
	return v && v->type == NT_NULL && !sc_live_fn(v) ? NULL : v;
}
static pl_span span_of(const nt_value *v) {
	if (v->type == NT_LIST && v->count == 2)
		return (pl_span){(long)v->items[0]->num, (long)v->items[1]->num};
	return (pl_span){(long)v->num, (long)v->num + 1};
}
static pl_span gap_of(const nt_value *v) {
	// an index to insert at: one number a is {a, a}
	if (v->type == NT_LIST && v->count == 2)
		return (pl_span){(long)v->items[0]->num, (long)v->items[1]->num};
	return (pl_span){(long)v->num, (long)v->num};
}

static const sc_error *key_error(sc_sched *s) { return sc_error_new(s, "not-a-patch", "not-a-patch", 0); }

static const sc_error *place_of_json(sc_sched *s, const nt_value *path, const nt_value *range,
	nt_place *pl) {
	if (!path || path->type != NT_LIST) return key_error(s);
	nt_key *ks = sc_alloc(s, (path->count + 1) * sizeof *ks);
	for (size_t i = 0; i < path->count; i++) {
		const nt_value *k = path->items[i];
		if (k->type == NT_STR) ks[i] = (nt_key){NT_STR_KEY, 0, k->str, 0, 0};
		else if (k->type == NT_NUM && k->num >= 0 && k->num == floor(k->num))
			ks[i] = (nt_key){NT_NUM_KEY, (long)k->num, NULL, 0, 0};
		else return key_error(s);
	}
	pl->path = ks;
	pl->length = path->count;
	if (range) {
		if (range->type != NT_LIST || range->count != 2 || range->items[0]->type != NT_NUM ||
			range->items[1]->type != NT_NUM)
			return key_error(s);
		pl->has_range = 1;
		pl->from = (long)range->items[0]->num;
		pl->to = (long)range->items[1]->num;
	}
	return NULL;
}

static const sc_error *patches_of(sc_sched *s, const nt_value *l, nt_patch **out, size_t *n) {
	*n = 0;
	*out = NULL;
	if (!l || l->type != NT_LIST) return key_error(s);
	nt_patch *ps = sc_alloc(s, (l->count + 1) * sizeof *ps);
	for (size_t i = 0; i < l->count; i++) {
		const nt_value *p = l->items[i];
		if (p->type != NT_MAP) return key_error(s);
		const sc_error *e = place_of_json(s, nt_get(p, "path"), nt_get(p, "range"), &ps[i].place);
		if (e) return e;
		const nt_value *v = nt_get(p, "value"), *mv = nt_get(p, "move");
		if (v) ps[i].has_value = 1, ps[i].value = v;
		if (mv) {
			if (mv->type != NT_MAP) return key_error(s);
			e = place_of_json(s, nt_get(mv, "path"), nt_get(mv, "range"), &ps[i].move);
			if (e) return e;
			ps[i].has_move = 1;
		}
	}
	*n = l->count;
	*out = ps;
	return NULL;
}

static nt_value *times_json(int64_t *t, size_t n, int list) {
	if (!list) return nt_num((double)t[0]);
	nt_value *l = nt_list();
	for (size_t i = 0; i < n; i++) nt_push(l, nt_num((double)t[i]));
	return l;
}

static nt_value *items_json(sc_sched *s, const sc_items *it, int content) {
	nt_value *l = nt_list();
	for (size_t i = 0; i < it->n; i++) nt_push(l, st_item(s, &it->items[i], content));
	return l;
}

const sc_error *st_operate(sc_sched *s, sc_api *api, const char *op, const nt_value *f,
	nt_value **out) {
	const sc_error *e;
	sc_items items;
	size_t n, np;
	const nt_value *address = nt_get(f, "address");
	const char *const *names = NULL;
	if (address) names = names_of(s, address, &n);
	else n = 0;
	nt_patch *ps;
	long idx;
	const long *index = NULL;
	pl_span slot, ispan;
	const pl_span *slotp = NULL;
	int span = 0;
	int64_t t[2];
	const nt_value *x;
	if ((x = field(f, "index")) && x->type == NT_NUM) idx = (long)x->num, index = &idx;
	if ((x = field(f, "slotindex"))) slot = span_of(x), slotp = &slot, span = x->type == NT_LIST;
	const char *id = (x = nt_get(f, "id")) && x->type == NT_STR ? x->str : NULL;
	const char *name = (x = nt_get(f, "name")) && x->type == NT_STR ? x->str : NULL;
	if (!strcmp(op, "look") || !strcmp(op, "lookup") || !strcmp(op, "lookups")) {
		const nt_value *path = !strcmp(op, "look") ? address : nt_get(f, "path");
		names = names_of(s, path, &n);
		e = !strcmp(op, "look") ? sc_look(api, names, n, &items)
			: !strcmp(op, "lookup") ? sc_lookup(api, names, n, &items)
			: sc_lookups(api, names, n, &items);
		if (e) return e;
		*out = items_json(s, &items, 0);
		return NULL;
	}
	if (!strcmp(op, "children")) {
		if (!name) {
			pl_namelist nl;
			e = sc_names(api, names, n, &nl);
			if (e) return e;
			nt_value *l = nt_list();
			for (size_t i = 0; i < nl.n; i++) nt_push(l, nt_str(nl.names[i]));
			*out = l;
			return NULL;
		}
		e = sc_children(api, names, n, name, &items);
		if (e) return e;
		*out = items_json(s, &items, 0);
		return NULL;
	}
	if (!strcmp(op, "content")) {
		e = sc_content(api, names, n, &items);
		if (e) return e;
		*out = items_json(s, &items, 1);
		return NULL;
	}
	if (!strcmp(op, "info")) {
		e = sc_info(api, names, n, name ? name : "", &items);
		if (e) return e;
		*out = items_json(s, &items, 1);
		return NULL;
	}
	if (!strcmp(op, "write") || !strcmp(op, "set")) {
		e = patches_of(s, nt_get(f, "patches"), &ps, &np);
		if (e) return e;
		if (!strcmp(op, "write")) e = sc_write(api, names, n, ps, np, index, slotp, span, &t[0]);
		else e = sc_set(api, names, n, name ? name : "", ps, np, index, slotp, span, &t[0]);
		if (e) return e;
		*out = times_json(t, 1, 0);
		return NULL;
	}
	if (!strcmp(op, "insert")) {
		const nt_value *c = nt_get(f, "child");
		const pl_span *isp = NULL;
		if ((x = field(f, "index"))) ispan = gap_of(x), isp = &ispan;
		e = sc_insert(api, id, name, c && c->type == NT_STR ? c->str : "", isp, slotp, &t[0]);
		if (e) return e;
		*out = times_json(t, 1, 0);
		return NULL;
	}
	if (!strcmp(op, "remove")) {
		pl_span sp = span_of(nt_get(f, "index"));
		e = sc_remove(api, id, name, sp, slotp, &t[0]);
		if (e) return e;
		*out = times_json(t, 1, 0);
		return NULL;
	}
	if (!strcmp(op, "pop")) {
		e = sc_pop(api, id, name, slotp ? *slotp : (pl_span){0, 1}, &t[0]);
		if (e) return e;
		*out = times_json(t, 1, 0);
		return NULL;
	}
	if (!strcmp(op, "rename")) {
		const nt_value *to = nt_get(f, "to");
		e = sc_rename(api, id, name, to && to->type == NT_STR ? to->str : "", t);
		if (e) return e;
		*out = times_json(t, 2, 1);
		return NULL;
	}
	if (!strcmp(op, "move")) {
		long ti;
		const long *toi = NULL;
		if ((x = field(f, "toindex")) && x->type == NT_NUM) ti = (long)x->num, toi = &ti;
		const nt_value *in = nt_get(f, "index"), *tid = nt_get(f, "toid"), *tn = nt_get(f, "toname");
		size_t nt_;
		e = sc_move(api, id, name, in ? (long)in->num : 0, tid ? tid->str : "", tn ? tn->str : "", toi,
			t, &nt_);
		if (e) return e;
		*out = times_json(t, nt_, 1);
		return NULL;
	}
	if (!strcmp(op, "create")) {
		const nt_value *value = nt_get(f, "value");
		const nt_value *eph = nt_get(f, "ephemeral");
		const char *made;
		e = sc_create(api, value, id, eph && truthy(eph), &made);
		if (e) return e;
		*out = nt_str(made);
		return NULL;
	}
	return sc_error_new(s, "unknown-op", "unknown op", 0);
}
