// dylib.c: native programs (dylib.h; CLOADER.md, Native). A C program pinned to /loaders/clang-native
// (ermine.programs.loader) is compiled to an arm64 dylib (loader.c, cc.c), cached by the build as a wasm
// module is, and run by the runner "dlopen": extensions/programs' dlopen runner (dlopen.h), whose pieces
// are wrapped here so a library's run is given, as its api, a table of its own (image/lib/c/
// ermine_host.h), not newOS's ap_api. The table is ermine.h's entry points, the wasm imports' (js/
// wasm.ts), done against newOS's API: so one C source builds to wasm or to native.
//
// As wasm.ts's: a value crosses as a number naming it in the part's table, good until the part returns,
// 0 null; every entry point acts through the part running (in a handler, the call's own); an operation
// that fails ends the part with its error (a longjmp back to where the part was entered: the library's
// frames between are let go, as a trap's are), said at <process>/failed until the program says a line or
// starts over; what it says goes to <process>/log, its last LOG lines.
//
// Not as wasm.ts's: the library runs in the OS's own process, so a crash in it is the OS's. A value the
// part made is changed in place; one it read (or an item of one) is copied before it is changed, so a
// change never reaches the graph's own. Each process loads its own copy of the library (dlopen.c writes
// each load a file of its own, in a folder of this OS's that power off empties), so each has its own
// statics, as each wasm instance does. A library is let go (dlclose) at the end of the turn its process
// stopped in (dylibTurn), once the process's cleanups have run.

#include "dylib.h"

#include "image/lib/c/ermine_host.h"

#include "../../../extensions/programs/c/dlopen.h"

#include <dirent.h>
#include <errno.h>
#include <setjmp.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/** <process>/log keeps this many of what the program said */
#define LOG 50

// ermine.h's er_kind
enum { K_NULL, K_BOOL, K_NUM, K_TEXT, K_BYTES, K_LIST, K_MAP, K_OTHER };

/** a value in a part's table: its own (made by the part: changed in place, let go as the part ends), or borrowed (a read) */
typedef struct {
	op_value *v;
	int own;
} Held;

/** a part running: its given, its table of values, the cause its changes carry, where a failure goes */
typedef struct {
	ap_given *g;
	Held *held;
	size_t n, room;
	op_value *cause;
	jmp_buf out;
	const ap_error *error;
} Frame;

/** one process's library: its table, its parts running, what it said */
typedef struct {
	er_host table;
	Host *host;
	ap_api *api;
	Frame **frames;
	size_t nframes, room;
	char *lines[LOG];
	int nlines;
	int failing, alive, timers;
	char *error;
} Instance;

/** a function of the program's as a part: a handler, a timer, a cleanup; or its setup */
typedef struct {
	ap_fn base;
	Instance *in;
	er_host_fn f;
	int (*setup)(void);
	char *what;
	// a timer's: its node in on/, let go as it is called
	char *on, *list;
} NativeFn;

static struct {
	Host *host;
	dlr *d;
	char *dir;
} D;

// --- small things

static char *format(const char *f, ...) {
	va_list a;
	va_start(a, f);
	int n = vsnprintf(NULL, 0, f, a);
	va_end(a);
	char *s = malloc((size_t)n + 1);
	va_start(a, f);
	vsnprintf(s, (size_t)n + 1, f, a);
	va_end(a);
	return s;
}

/** a copy, all the way down: the part's own */
static op_value *twin(const op_value *v) {
	if (!v) return op_null();
	switch (v->type) {
	case OP_NULL: return op_null();
	case OP_BOOL: return op_bool(v->bool_);
	case OP_NUM: return op_num(v->num);
	case OP_STR: return op_str_n(v->str, v->bytes);
	case OP_BYTES: return op_bytes(v->data, v->bytes);
	case OP_TYPED: return op_typed(v->kind, v->data, op_length(v));
	case OP_STAND: return op_stand(twin(v->count ? v->items[0] : NULL));
	case OP_LIST: {
		op_value *l = op_list();
		for (size_t i = 0; i < v->count; i++) op_push(l, twin(v->items[i]));
		return l;
	}
	case OP_MAP: {
		op_value *m = op_map();
		for (size_t i = 0; i < v->count; i++) op_set(m, v->keys[i], twin(v->items[i]));
		return m;
	}
	}
	return op_null();
}

/** bytes as the graph takes text: valid UTF-8, each byte that is not (and a NUL) U+FFFD, as TextDecoder does */
static op_value *textOf(const char *s, size_t n) {
	const unsigned char *b = (const unsigned char *)s;
	char *out = malloc(n * 3 + 1);
	size_t k = 0;
	for (size_t i = 0; i < n;) {
		unsigned c = b[i];
		size_t len = c < 0x80 ? 1 : (c >> 5) == 6 ? 2 : (c >> 4) == 14 ? 3 : (c >> 3) == 30 ? 4 : 0;
		int ok = len && c && i + len <= n;
		for (size_t j = 1; ok && j < len; j++) ok = (b[i + j] >> 6) == 2;
		if (ok && len > 1) {
			// not overlong, not a surrogate, not past U+10FFFF
			unsigned cp = len == 2 ? (c & 0x1f) << 6 | (b[i + 1] & 0x3f)
			            : len == 3 ? (c & 0x0f) << 12 | (b[i + 1] & 0x3f) << 6 | (b[i + 2] & 0x3f)
			                       : (c & 0x07) << 18 | (b[i + 1] & 0x3f) << 12 | (b[i + 2] & 0x3f) << 6 | (b[i + 3] & 0x3f);
			ok = (len == 2 && cp >= 0x80) || (len == 3 && cp >= 0x800 && (cp < 0xd800 || cp > 0xdfff)) || (len == 4 && cp >= 0x10000 && cp <= 0x10ffff);
		}
		if (ok) {
			memcpy(out + k, b + i, len);
			k += len, i += len;
		} else {
			memcpy(out + k, "\xef\xbf\xbd", 3);
			k += 3, i++;
		}
	}
	out[k] = 0;
	return op_str_take(out, k);
}

static const char *str(const op_value *v) { return v && v->type == OP_STR ? v->str : NULL; }
static double num(const op_value *v) { return v && v->type == OP_NUM ? v->num : v && v->type == OP_BOOL ? v->bool_ : 0; }
static const op_value *arg(const op_value *a, size_t i) { return a && a->type == OP_LIST && i < a->count ? a->items[i] : NULL; }
static int truthy(const op_value *v) {
	return v && (v->type == OP_BOOL ? v->bool_ : v->type == OP_NUM ? v->num != 0 : v->type == OP_STR ? v->bytes > 0 : v->type != OP_NULL);
}

// --- the part running, and its table

static Frame *top(Instance *in) { return in->nframes ? in->frames[in->nframes - 1] : NULL; }

static Frame *enter(Instance *in, ap_given *g) {
	Frame *f = calloc(1, sizeof *f);
	f->g = g;
	f->room = 16;
	f->held = malloc(sizeof *f->held * f->room);
	f->held[0] = (Held){ NULL, 0 };
	f->n = 1;
	if (in->nframes == in->room) {
		in->room = in->room ? in->room * 2 : 8;
		in->frames = realloc(in->frames, sizeof *in->frames * in->room);
	}
	in->frames[in->nframes++] = f;
	return f;
}

static void leave(Instance *in, Frame *f) {
	for (size_t i = 1; i < f->n; i++)
		if (f->held[i].own) op_free(f->held[i].v);
	op_free(f->cause);
	free(f->held);
	in->nframes--;
	free(f);
}

/** the part ends with e, back where it was entered */
static void fail(Instance *in, const ap_error *e) {
	Frame *f = top(in);
	f->error = e;
	longjmp(f->out, 1);
}

static void wrong(Instance *in, const char *code, const char *message) { fail(in, ap_error_new(hostOs(in->host), code, message)); }

/** an entry point called with no part of the program running (from a thread of its own): said, and nothing done */
static Frame *running(Instance *in) {
	Frame *f = top(in);
	if (!f) hostSay(in->host, "a native program called the OS with no part of it running: nothing done");
	return f;
}

static int hold(Frame *f, op_value *v, int own) {
	if (f->n == f->room) {
		f->room *= 2;
		f->held = realloc(f->held, sizeof *f->held * f->room);
	}
	f->held[f->n] = (Held){ v, own };
	return (int)f->n++;
}

static const op_value *at(Frame *f, int h) { return h > 0 && (size_t)h < f->n ? f->held[h].v : NULL; }

/** the part's own value of that type at h, to change: a borrowed one copied first; NULL if it is not one */
static op_value *writable(Frame *f, int h, op_type type) {
	const op_value *v = at(f, h);
	if (!v || v->type != type) return NULL;
	if (!f->held[h].own) f->held[h] = (Held){ twin(v), 1 };
	return f->held[h].v;
}

/** v to go inside a value of the part's own: one of its own, held twice; else a copy */
static op_value *inside(Frame *f, int h) {
	const op_value *v = at(f, h);
	if (!v) return op_null();
	return f->held[h].own ? op_ref(f->held[h].v) : twin(v);
}

// --- what a part says, and what failed

/** the value at <process>/<name> written whole, or made (ephemeral, the process's) */
static void beside(ap_given *g, const char *name, const op_value *value) {
	const char *at[] = { g->name, name };
	if (hostLook(g->api, at, 2)) hostSnap(g->api, at, 2, value);
	else if (value && value->type != OP_NULL) {
		const char *made = NULL;
		if (!ap_create(g->api, value, NULL, 1, &made)) ap_insert(g->api, g->self, name, made, NULL, NULL);
	}
}

/** a part that failed: said at <process>/failed until the program says a line or starts over (text NULL) */
static void failed(Instance *in, ap_given *g, const char *text) {
	if (!g->self || !g->name || (!text && !in->failing)) return;
	op_value *v = text ? op_str(text) : op_null();
	beside(g, "failed", v);
	op_free(v);
	in->failing = text != NULL;
}

// --- the table: values

#define IN Instance *in = ctx
#define FRAME(none) \
	Frame *f = running(in); \
	if (!f) return none

static int tNum(void *ctx, double n) {
	IN;
	FRAME(0);
	return hold(f, op_num(n), 1);
}

static int tText(void *ctx, const char *s, int n) {
	IN;
	FRAME(0);
	return hold(f, textOf(s, n > 0 ? (size_t)n : 0), 1);
}

static int tBytes(void *ctx, const void *p, int n) {
	IN;
	FRAME(0);
	return hold(f, op_bytes(p, n > 0 ? (size_t)n : 0), 1);
}

static int tBool(void *ctx, int b) {
	IN;
	FRAME(0);
	return hold(f, op_bool(b != 0), 1);
}

static int tList(void *ctx) {
	IN;
	FRAME(0);
	return hold(f, op_list(), 1);
}

static int tMap(void *ctx) {
	IN;
	FRAME(0);
	return hold(f, op_map(), 1);
}

static void tPush(void *ctx, int list, int v) {
	IN;
	FRAME();
	op_value *l = writable(f, list, OP_LIST);
	if (l) op_push(l, inside(f, v));
}

static void tPut(void *ctx, int map, const char *key, int n, int v) {
	IN;
	FRAME();
	op_value *m = writable(f, map, OP_MAP);
	if (!m) return;
	op_value *k = textOf(key, n > 0 ? (size_t)n : 0);
	op_set(m, k->str, inside(f, v));
	op_free(k);
}

static int tKind(void *ctx, int h) {
	IN;
	FRAME(K_NULL);
	const op_value *v = at(f, h);
	if (!v) return K_NULL;
	switch (v->type) {
	case OP_NULL: return K_NULL;
	case OP_BOOL: return K_BOOL;
	case OP_NUM: return K_NUM;
	case OP_STR: return K_TEXT;
	case OP_BYTES:
	case OP_TYPED: return K_BYTES;
	case OP_LIST: return K_LIST;
	case OP_MAP: return K_MAP;
	default: return K_OTHER;
	}
}

static double tNumber(void *ctx, int h) {
	IN;
	FRAME(0);
	return num(at(f, h));
}

static int tLength(void *ctx, int h) {
	IN;
	FRAME(0);
	const op_value *v = at(f, h);
	if (!v) return 0;
	if (v->type == OP_STR || v->type == OP_BYTES || v->type == OP_TYPED) return (int)v->bytes;
	if (v->type == OP_LIST || v->type == OP_MAP) return (int)v->count;
	return 0;
}

static int tCopy(void *ctx, int h, void *out, int room) {
	IN;
	FRAME(0);
	const op_value *v = at(f, h);
	if (!v || room < 0) return 0;
	const void *from = v->type == OP_STR ? (const void *)v->str : v->type == OP_BYTES || v->type == OP_TYPED ? (const void *)v->data : NULL;
	if (!from) return 0;
	size_t n = v->bytes;
	memcpy(out, from, n < (size_t)room ? n : (size_t)room);
	if (v->type == OP_STR && n < (size_t)room) ((char *)out)[n] = 0;
	return (int)n;
}

static int tItem(void *ctx, int h, int i) {
	IN;
	FRAME(0);
	const op_value *v = at(f, h);
	if (!v || v->type != OP_LIST || i < 0 || (size_t)i >= v->count) return hold(f, op_null(), 1);
	return hold(f, v->items[i], 0);
}

static int tGet(void *ctx, int h, const char *key, int n) {
	IN;
	FRAME(0);
	const op_value *v = at(f, h);
	if (!v || v->type != OP_MAP) return hold(f, op_null(), 1);
	op_value *k = textOf(key, n > 0 ? (size_t)n : 0);
	op_value *x = op_get(v, k->str);
	op_free(k);
	return x ? hold(f, x, 0) : hold(f, op_null(), 1);
}

static int tKeys(void *ctx, int h) {
	IN;
	FRAME(0);
	const op_value *v = at(f, h);
	op_value *l = op_list();
	for (size_t i = 0; v && v->type == OP_MAP && i < v->count; i++) op_push(l, op_str(v->keys[i]));
	return hold(f, l, 1);
}

static int tShow(void *ctx, int h, char *out, int room) {
	IN;
	FRAME(0);
	const op_value *v = at(f, h);
	Json *j = v ? jsonOfVal(v) : jsonNull();
	char *text = jsonPrint(j);
	jsonFree(j);
	size_t n = strlen(text);
	if (room > 0) memcpy(out, text, n < (size_t)room ? n : (size_t)room);
	free(text);
	return (int)n;
}

// --- the table: what a part says

static void tSay(void *ctx, const char *s, int n) {
	IN;
	FRAME();
	op_value *line = textOf(s, n > 0 ? (size_t)n : 0);
	if (in->nlines == LOG) {
		free(in->lines[0]);
		memmove(in->lines, in->lines + 1, sizeof *in->lines * (LOG - 1));
		in->nlines--;
	}
	in->lines[in->nlines++] = strdup(line->str);
	op_free(line);
	op_value *list = op_list();
	for (int i = 0; i < in->nlines; i++) op_push(list, op_str(in->lines[i]));
	beside(f->g, "log", list);
	op_free(list);
	failed(in, f->g, NULL);
}

// --- the table: the graph and the process (ermine.h's words)

static op_value *changeVal(const ap_change *c) {
	op_value *o = op_map();
	op_set(o, "time", op_num((double)c->time));
	if (c->actor) op_set(o, "actor", twin(c->actor));
	if (c->reader) op_set(o, "reader", op_str(c->reader));
	if (c->site) op_set(o, "site", twin(c->site));
	if (c->cause) op_set(o, "cause", twin(c->cause));
	return o;
}

/** items, as core's (places.ts Item), as exec.c gives them */
static op_value *itemsVal(const ap_items *items) {
	op_value *a = op_list();
	for (size_t i = 0; i < items->n; i++) {
		const ap_item *it = &items->items[i];
		op_value *o = op_map(), *route = op_list();
		op_set(o, "id", op_str(it->id));
		for (size_t r = 0; r < it->nroute; r++) {
			op_value *step = op_map();
			op_set(step, "name", op_str(it->route[r]));
			op_push(route, step);
		}
		op_set(o, "route", route);
		if (it->node) {
			op_value *node = op_map();
			op_set(node, "id", op_str(it->id));
			op_set(o, "node", node);
			op_set(o, "ephemeral", op_bool(it->ephemeral));
		}
		if (it->node && it->has_versions) {
			op_value *vs = op_list();
			for (size_t k = 0; k < it->nversions; k++) {
				const ap_version *v = &it->versions[k];
				op_value *ver = op_map();
				op_set(ver, "content", twin(v->content));
				op_set(ver, "change", changeVal(&v->change));
				if (v->status) {
					op_value *because = op_map();
					op_set(because, "layer", op_str("scheduler"));
					op_set(because, "place", op_str("status"));
					op_set(ver, "because", because);
				}
				op_push(vs, ver);
			}
			op_set(o, "versions", vs);
		}
		op_push(a, o);
	}
	return a;
}

/** a place in a value ({path, range?}), its keys for this turn */
static op_target targetOf(const op_value *p) {
	op_target t = { 0 };
	const op_value *path = p && p->type == OP_MAP ? op_get(p, "path") : NULL, *range = p && p->type == OP_MAP ? op_get(p, "range") : NULL;
	size_t n = path && path->type == OP_LIST ? path->count : 0;
	op_key *keys = ap_temp(hostOs(D.host), sizeof *keys * (n ? n : 1));
	for (size_t i = 0; i < n; i++) {
		const op_value *k = path->items[i];
		keys[i] = k->type == OP_NUM ? (op_key){ .type = OP_NUM_KEY, .n = (long)k->num } : (op_key){ .type = OP_STR_KEY, .s = k->type == OP_STR ? k->str : "" };
	}
	t.path = keys, t.length = n;
	if (range && range->type == OP_LIST && range->count == 2 && range->items[0]->type == OP_NUM && range->items[1]->type == OP_NUM)
		t.has_range = 1, t.from = (long)range->items[0]->num, t.to = (long)range->items[1]->num;
	return t;
}

/** core's patches ({path, range?, value?, move?}), their values borrowed from list */
static op_patch *patchesOf(const op_value *list, size_t *n) {
	*n = list && list->type == OP_LIST ? list->count : 0;
	op_patch *ps = ap_temp(hostOs(D.host), sizeof *ps * (*n ? *n : 1));
	for (size_t i = 0; i < *n; i++) {
		const op_value *p = list->items[i], *value = p->type == OP_MAP ? op_get(p, "value") : NULL, *move = p->type == OP_MAP ? op_get(p, "move") : NULL;
		ps[i] = (op_patch){ .place = targetOf(p) };
		if (value) ps[i].has_value = 1, ps[i].value = value;
		if (move) ps[i].has_move = 1, ps[i].move = targetOf(move);
	}
	return ps;
}

/** an address as names from the root: as wasm.ts' absolute, from the process's folder */
static const char *const *absolute(Instance *in, ap_given *g, const char *const *names, size_t n, size_t *out) {
	ap_os *os = hostOs(in->host);
	size_t nhere = 0;
	const char *const *here = n && !strcmp(names[0], "/") ? NULL : ap_here(os, g->self, &nhere);
	const char **a = ap_temp(os, sizeof *a * (nhere + n + 1));
	size_t k = 0;
	if (here)
		for (size_t i = 0; i + 1 < nhere; i++) a[k++] = here[i];
	for (size_t i = 0; i < n; i++) {
		if (!strcmp(names[i], "..")) {
			if (k > 1) k--;
		} else a[k++] = names[i];
	}
	*out = k;
	return a;
}

static const ap_error *calling(ap_fn *self, ap_given *g, op_value **out, int *pending);

static NativeFn *fnOf(Instance *in, const op_value *n, const char *what) {
	uintptr_t p = (uintptr_t)num(n);
	if (!p) wrong(in, "wrong-field", "a function of the program's is its address");
	NativeFn *fn = calloc(1, sizeof *fn);
	fn->base.call = calling;
	fn->in = in;
	memcpy(&fn->f, &p, sizeof p);
	fn->what = strdup(what);
	return fn;
}

/** f placed at <process>/on/<list>, as kit's handler: its on folder's id */
static const char *place(Instance *in, ap_api *api, ap_given *g, const char *list, NativeFn *fn) {
	const char *at[] = { g->name, "on" };
	const ap_item *it = hostLook(api, at, 2);
	const char *on = it ? it->id : NULL;
	const ap_error *e = NULL;
	if (!on) {
		const char *made = NULL;
		if (!(e = ap_create(api, NULL, NULL, 1, &made)) && !(e = ap_insert(api, g->self, "on", made, NULL, NULL))) on = made;
	}
	if (e) fail(in, e);
	op_value *live = ap_live(api, &fn->base);
	const char *made = NULL;
	if (!(e = ap_create(api, live, NULL, 1, &made))) e = ap_insert(api, on, list, made, NULL, NULL);
	op_free(live);
	if (e) fail(in, e);
	return on;
}

/** er__op: core's words, and the process's own (ermine.h). *own: the answer is the part's (else the turn's: a read,
 * a node, a call's answer, which api.c keeps till the turn ends) */
static op_value *perform(Instance *in, Frame *f, const char *word, const char *const *names, int n, const op_value *a, int *own) {
	ap_given *g = f->g;
	ap_os *os = hostOs(in->host);
	ap_api *api = f->cause ? ap_as(g->api, f->cause) : g->api;
	size_t k = n > 0 ? (size_t)n : 0;
	int64_t time = 0;
	ap_items items = { 0 };
	const ap_error *e = NULL;
	op_value *out = NULL;
	*own = 1;
#define ADDRESS \
	if (n < 0) { \
		char *t_ = format("%s takes an address", word); \
		const ap_error *e_ = ap_error_new(os, "wrong-field", t_); \
		free(t_); \
		fail(in, e_); \
	}
#define TEXT(x, i, what) \
	const char *x = str(arg(a, i)); \
	if (!x) wrong(in, "wrong-field", what)
#define DONE(call) \
	if ((e = (call))) fail(in, e)
	if (!strcmp(word, "read")) {
		ADDRESS;
		*own = 0;
		return (op_value *)ap_read(api, names, k);
	} else if (!strcmp(word, "id")) {
		ADDRESS;
		const ap_item *it = hostLook(api, names, k);
		out = it ? op_str(it->id) : op_null();
	} else if (!strcmp(word, "write")) {
		ADDRESS;
		op_value *v = twin(arg(a, 0));
		if (hostLook(api, names, k)) {
			op_patch p = { .has_value = 1, .value = v };
			e = ap_write(api, names, k, &p, 1, NULL, &time);
		} else {
			// made in its parent, by its last name
			size_t m;
			const char *const *to = absolute(in, g, names, k, &m);
			const ap_item *parent = m > 1 ? hostLook(api, to, m - 1) : NULL;
			const char *made = NULL;
			if (!parent) {
				op_free(v);
				char *t = format("write: nothing at the parent of %s", m ? to[m - 1] : "nothing");
				const ap_error *x = ap_error_new(os, "nothing-there", t);
				free(t);
				fail(in, x);
			}
			if (!(e = ap_create(api, v, NULL, 0, &made))) e = ap_insert(api, parent->id, to[m - 1], made, NULL, &time);
		}
		op_free(v);
		if (e) fail(in, e);
		out = op_num((double)time);
	} else if (!strcmp(word, "patch")) {
		ADDRESS;
		size_t np;
		op_value *list = twin(arg(a, 0));
		op_patch *ps = patchesOf(list, &np);
		e = ap_write(api, names, k, ps, np, NULL, &time);
		op_free(list);
		if (e) fail(in, e);
		out = op_num((double)time);
	} else if (!strcmp(word, "set")) {
		ADDRESS;
		TEXT(name, 0, "set takes a name");
		op_value *v = twin(arg(a, 1));
		op_patch p = { .has_value = 1, .value = v };
		e = ap_set(api, names, k, name, &p, 1, NULL, &time);
		op_free(v);
		if (e) fail(in, e);
		out = op_num((double)time);
	} else if (!strcmp(word, "look") || !strcmp(word, "lookup") || !strcmp(word, "lookups") || !strcmp(word, "content")) {
		ADDRESS;
		DONE(!strcmp(word, "look") ? ap_look(api, names, k, &items) : !strcmp(word, "lookup") ? ap_lookup(api, names, k, &items)
		     : !strcmp(word, "lookups") ? ap_lookups(api, names, k, &items) : ap_content(api, names, k, &items));
		out = itemsVal(&items);
	} else if (!strcmp(word, "info")) {
		ADDRESS;
		TEXT(name, 0, "info takes a name");
		DONE(ap_info(api, names, k, name, &items));
		out = itemsVal(&items);
	} else if (!strcmp(word, "children")) {
		ADDRESS;
		const char *name = str(arg(a, 0));
		if (name) {
			DONE(ap_children(api, names, k, name, &items));
			out = itemsVal(&items);
		} else {
			ap_namelist list = { 0 };
			DONE(ap_names(api, names, k, &list));
			out = op_list();
			for (size_t i = 0; i < list.n; i++) op_push(out, op_str(list.names[i]));
		}
	} else if (!strcmp(word, "create")) {
		op_value *v = twin(arg(a, 0));
		const char *made = NULL;
		e = ap_create(api, v, NULL, truthy(arg(a, 1)), &made);
		op_free(v);
		if (e) fail(in, e);
		out = op_str(made);
	} else if (!strcmp(word, "insert")) {
		TEXT(id, 0, "insert takes an id, a name and a child");
		TEXT(name, 1, "insert takes an id, a name and a child");
		TEXT(child, 2, "insert takes an id, a name and a child");
		DONE(ap_insert(api, id, name, child, NULL, &time));
		out = op_num((double)time);
	} else if (!strcmp(word, "remove") || !strcmp(word, "pop")) {
		TEXT(id, 0, "remove takes an id, a name and an index");
		TEXT(name, 1, "remove takes an id, a name and an index");
		DONE(ap_remove(api, id, name, (long)num(arg(a, 2)), &time));
		out = op_num((double)time);
	} else if (!strcmp(word, "rename")) {
		TEXT(id, 0, "rename takes an id, a name and to");
		TEXT(name, 1, "rename takes an id, a name and to");
		TEXT(to, 2, "rename takes an id, a name and to");
		DONE(ap_rename(api, id, name, to, &time));
		out = op_num((double)time);
	} else if (!strcmp(word, "move")) {
		TEXT(id, 0, "move takes an id, a name, an index, to and toname");
		TEXT(name, 1, "move takes an id, a name, an index, to and toname");
		TEXT(to, 3, "move takes an id, a name, an index, to and toname");
		TEXT(toname, 4, "move takes an id, a name, an index, to and toname");
		DONE(ap_move(api, id, name, (long)num(arg(a, 2)), to, toname, NULL, &time));
		out = op_num((double)time);
	} else if (!strcmp(word, "node")) {
		TEXT(id, 0, "node takes an id");
		DONE(ap_node(api, id, &out));
		*own = out == NULL;
	} else if (!strcmp(word, "as")) {
		op_free(f->cause);
		const op_value *c = arg(a, 0);
		f->cause = c && c->type != OP_NULL ? twin(c) : NULL;
	} else if (!strcmp(word, "self")) {
		out = g->self ? op_str(g->self) : op_null();
	} else if (!strcmp(word, "name")) {
		out = g->name ? op_str(g->name) : op_null();
	} else if (!strcmp(word, "handler")) {
		TEXT(name, 0, "handler takes a name and a function");
		if (!*name || strchr(name, '/')) wrong(in, "wrong-field", "a handler's name is one name");
		place(in, api, g, name, fnOf(in, arg(a, 1), name));
		out = op_list();
		op_push(out, op_str(g->name)), op_push(out, op_str("on")), op_push(out, op_str(name));
	} else if (!strcmp(word, "after")) {
		// as os.ts' after: a handler at on/timer.<n>, let go as it is called, called by the host's timer
		double ms = num(arg(a, 0));
		NativeFn *fn = fnOf(in, arg(a, 1), "a timer");
		char list[32];
		snprintf(list, sizeof list, "timer.%d", ++in->timers);
		fn->on = strdup(place(in, api, g, list, fn));
		fn->list = strdup(list);
		size_t nhere;
		const char *const *here = ap_here(os, g->self, &nhere);
		Json *to = jsonArray();
		for (size_t i = 0; here && i < nhere; i++) jsonPush(to, jsonString(here[i]));
		jsonPush(to, jsonString("on")), jsonPush(to, jsonString(list));
		hostAfter(in->host, hostNow(in->host) + (int64_t)(ms < 0 ? 0 : ms * 1000), to);
	} else if (!strcmp(word, "cleanup")) {
		DONE(ap_cleanup(g, &fnOf(in, arg(a, 0), "cleanup")->base));
	} else if (!strcmp(word, "start")) {
		ADDRESS;
		const op_value *program = arg(a, 0);
		if (!program || program->type != OP_LIST || !program->count) wrong(in, "wrong-field", "start takes a program's path, a list of names");
		const char **path = ap_temp(os, sizeof *path * program->count);
		for (size_t i = 0; i < program->count; i++)
			if (!(path[i] = str(program->items[i]))) wrong(in, "wrong-field", "a program's path is names");
		ap_startop o = { .address = names, .naddress = k, .name = str(arg(a, 1)), .program = path, .nprogram = program->count };
		const char *pid = NULL;
		DONE(ap_start(g, &o, &pid));
		out = op_str(pid);
	} else if (!strcmp(word, "call")) {
		ADDRESS;
		op_value *args = twin(arg(a, 0));
		e = ap_call(g, names, k, args, &out);
		op_free(args);
		if (e) fail(in, e);
		*own = out == NULL;
	} else if (!strcmp(word, "end")) {
		hostKill(in->host, g->self);
	} else {
		char *t = format("no such operation: %s", word);
		const ap_error *x = ap_error_new(os, "wrong-field", t);
		free(t);
		fail(in, x);
	}
#undef ADDRESS
#undef TEXT
#undef DONE
	return out ? out : op_null();
}

static int tOp(void *ctx, const char *op, int nop, const char *const *names, int n, int args) {
	IN;
	FRAME(0);
	char word[32];
	snprintf(word, sizeof word, "%.*s", nop > 0 && nop < (int)sizeof word ? nop : 0, op);
	int own;
	op_value *out = perform(in, f, word, names, n, at(f, args), &own);
	return hold(f, out, own && out);
}

// --- parts

/** a part of the program: entered with its own table, its failure said */
static const ap_error *part(Instance *in, ap_given *g, NativeFn *fn, op_value **out) {
	Frame *f = enter(in, g);
	const ap_error *e = NULL;
	if (setjmp(f->out) == 0) {
		if (fn->setup) {
			// started over: what failed before is gone
			in->failing = 1;
			failed(in, g, NULL);
			const op_value *v = at(f, fn->setup());
			*out = twin(v);
		} else fn->f((er_host_value){ hold(f, g->args ? twin(g->args) : op_list(), 1) });
	} else e = f->error;
	leave(in, f);
	if (e) {
		char *text = format("failed in %s: %s%s%s", fn->what, e->code ? e->code : "thrown", e->message ? ": " : "", e->message ? e->message : "");
		failed(in, g, text);
		free(text);
	}
	return e;
}

static const ap_error *calling(ap_fn *self, ap_given *g, op_value **out, int *pending) {
	(void)pending;
	NativeFn *fn = (NativeFn *)self;
	*out = NULL;
	if (!fn->in->alive) return ap_error_new(g->os, "stopped", "the program has ended");
	// a timer: its node let go first, as os.ts' is
	if (fn->on) {
		ap_remove(g->api, fn->on, fn->list, 0, NULL);
		free(fn->on), free(fn->list);
		fn->on = fn->list = NULL;
	}
	return part(fn->in, g, fn, out);
}

static int tSetup(void *ctx, int (*setup)(void)) {
	IN;
	NativeFn *fn = calloc(1, sizeof *fn);
	fn->base.call = calling;
	fn->in = in;
	fn->setup = setup;
	fn->what = strdup("setup");
	const ap_error *e = ap_run_setup(in->api, &fn->base);
	if (!e) return 0;
	free(in->error);
	in->error = format("%s%s%s", e->code ? e->code : "thrown", e->message ? ": " : "", e->message ? e->message : "");
	return 1;
}

static Instance *instance(ap_api *api) {
	Instance *in = calloc(1, sizeof *in);
	in->host = D.host;
	in->api = api;
	in->alive = 1;
	in->table = (er_host){ sizeof(er_host), in, tNum, tText, tBytes, tBool, tList, tMap, tPush, tPut, tKind, tNumber, tLength,
	                       tCopy, tItem, tGet, tKeys, tShow, tOp, tSay, tSetup };
	return in;
}

// --- the runner: dlopen.c's, wrapped

/** what is let go at the next turn: a library's stop (its process's), or a load's close */
typedef struct Later {
	Instance *in;
	void (*f)(void *ctx);
	void *ctx;
	struct Later *next;
} Later;
static Later *later;

static void defer(Instance *in, void (*f)(void *), void *ctx) {
	Later *l = malloc(sizeof *l);
	*l = (Later){ in, f, ctx, later };
	later = l;
}

void dylibTurn(Host *host) {
	(void)host;
	while (later) {
		Later *l = later;
		later = l->next;
		if (l->in) l->in->alive = 0;
		if (l->f) l->f(l->ctx);
		free(l);
	}
}

typedef struct {
	Instance *in;
	hf_handle handle;
} Stop;

static void stopping(void *ctx) {
	Stop *s = ctx;
	defer(s->in, s->handle.stop, s->handle.ctx);
	free(s);
}

/** a run's answer: its error as setup said it; its stop deferred to the next turn */
static hf_run wrap(Instance *in, hf_run r) {
	if (r.error) {
		if (in->error) {
			free(r.error);
			r.error = strdup(in->error);
		}
		in->alive = 0;
		return r;
	}
	Stop *s = malloc(sizeof *s);
	*s = (Stop){ in, r.handle };
	return (hf_run){ .handle = { stopping, s } };
}

/** a library run as a program: its run given the table */
static hf_run dylibRun(const op_value *code, void *api, void *data) {
	(void)data;
	Instance *in = instance(api);
	return wrap(in, dlr_run(code, &in->table, D.d));
}

/** a library as a step (a compiler, or a runner of other programs): its live form, a run given the table */
typedef struct {
	hf_live live;
} Live;

static hf_out liveCompile(const op_value *input, void *data) {
	Live *l = data;
	return l->live.compile(input, l->live.data);
}

static hf_run liveRun(const op_value *code, void *api, void *data) {
	Live *l = data;
	Instance *in = instance(api);
	return wrap(in, l->live.run(code, &in->table, l->live.data));
}

static void closing(void *data) {
	Live *l = data;
	if (l->live.close) l->live.close(l->live.data);
	free(l);
}

static void liveClose(void *data) { defer(NULL, closing, data); }

static hf_loaded dylibLoad(const op_value *code, void *data) {
	(void)data;
	hf_loaded out = dlr_load(code, D.d);
	if (out.error) return out;
	Live *l = malloc(sizeof *l);
	l->live = out.live;
	return (hf_loaded){ .live = { .compile = out.live.compile ? liveCompile : NULL, .run = out.live.run ? liveRun : NULL, .close = liveClose, .data = l } };
}

static void noted(const char *what, const char *detail, void *ctx) { hostSay(ctx, "dlopen: %s: %s", what, detail); }

void dylibAdd(Host *host, hf *functions, const char *name) {
	D.host = host;
	if (!D.d) {
		// a folder of this OS's own, so what a power off leaves loaded goes with it (dylibStop)
		const char *tmp = getenv("TMPDIR");
		D.dir = format("%s/ermineOS-dylib.%d", tmp && *tmp ? tmp : "/tmp", (int)getpid());
		if (mkdir(D.dir, 0700) && errno != EEXIST) hostSay(host, "dlopen: no folder %s: %s", D.dir, strerror(errno));
		D.d = dlr_new(&(dlr_setup){ .dir = D.dir, .note = noted, .ctx = host });
	}
	hf_add_loader(functions, name, dylibRun, dylibLoad, NULL);
}

void dylibStop(Host *host) {
	dylibTurn(host);
	if (!D.dir) return;
	DIR *dir = opendir(D.dir);
	for (struct dirent *e; dir && (e = readdir(dir));) {
		if (e->d_name[0] == '.') continue;
		char *path = format("%s/%s", D.dir, e->d_name);
		unlink(path);
		free(path);
	}
	if (dir) closedir(dir);
	rmdir(D.dir);
}
