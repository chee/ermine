#include <stdarg.h>
#include <stdlib.h>
#include <string.h>

#include "pw.h"

es_ermine *pw_ermine;
sc_scheduler *pw_scheduler;
tb_table *pw_table;
pl *pw_places;
sc_scope *pw_host;
static sc_pair host_info;

#define PUSH(v, n, cap, x) \
	do { \
		if ((n) == (cap)) { \
			(cap) = (cap) ? (cap) * 2 : 16; \
			(v) = realloc((v), (cap) * sizeof *(v)); \
			if ((v) == NULL) abort(); \
		} \
		(v)[(n)++] = (x); \
	} while (0)

static hh_line **lines;
static size_t nlines, caplines;
static pw_watch **watches;
static size_t nwatches, capwatches;
static sc_scope **named;
static size_t nnamed, capnamed;

void *pw_alloc(size_t size) {
	void *p = calloc(1, size ? size : 1);
	if (p == NULL) abort();
	return p;
}
char *pw_copy(const char *text) { return strcpy(pw_alloc(strlen(text) + 1), text); }
char *pw_format(const char *format, ...) {
	char *text;
	size_t size;
	FILE *s = open_memstream(&text, &size);
	if (s == NULL) abort();
	va_list args;
	va_start(args, format);
	vfprintf(s, format, args);
	va_end(args);
	fclose(s);
	return text;
}

const char *pw_text(const op_value *v) { return v && v->type == OP_STR ? v->str : NULL; }
bool pw_is(const op_value *v, op_type type) { return v && v->type == type; }
tb_key pw_key(const op_value *v) { return tb_string(pw_text(v)); }
const char *pw_part(const op_value *v) {
	const char *s = pw_text(v);
	return s ? s : "value";
}
const char **pw_address(const op_value *list, size_t *n) {
	*n = pw_is(list, OP_LIST) ? (size_t)list->count : 0;
	const char **names = pw_alloc((*n + 1) * sizeof *names);
	for (size_t i = 0; i < *n; i++) names[i] = pw_text(list->items[i]);
	return names;
}
op_value *pw_error(const char *why) {
	op_value *o = op_map();
	op_set(o, "error", op_str(why));
	return o;
}
op_value *pw_error_take(char *why) {
	op_value *o = pw_error(why);
	free(why);
	return o;
}

const char *pw_hosted(void (*f)(void *data), void *data) { return sc_run_with_scope(pw_host, f, data); }

void pw_put_entry(const char *part, tb_key id, const op_value *value) {
	ch_header h;
	pl_made *made;
	char *bad = pl_header(pw_places, NULL, 0, CH_HERE, &h, &made);
	if (bad) {
		free(bad);
		return;
	}
	nd_entry *node = nd_make_entry((op_value *)value, &h);
	pl_own(pw_places, node);
	pl_hold(pw_places, node, made, pl_made_free);
	tb_sub(pw_table, tb_string(part), id, node);
}

// scopes and computers by name
static sc_scope *scope_named(const char *name) {
	for (size_t i = 0; name != NULL && i < nnamed; i++) {
		if (strcmp((char *)sc_scope_user(named[i]), name) == 0) return named[i];
	}
	return NULL;
}
static char *name_scope(sc_scope *o, const char *name) {
	if (scope_named(name)) return pw_format("name taken: %s", name);
	sc_scope_set(o, pw_copy(name));
	PUSH(named, nnamed, capnamed, o);
	return NULL;
}

char *pw_set(void *value, void *data) {
	pw_watch *w = data;
	op_value *was = w->value;
	w->value = op_ref(value);
	op_free(was);
	return NULL;
}
bool pw_equal(const void *a, const void *b, void *data) {
	(void)data;
	char *x = op_json_text(a), *y = op_json_text(b);
	bool same = strcmp(x, y) == 0;
	free(x);
	free(y);
	return same;
}

typedef struct {
	sc_def def;
	sc_computer *made;
} making;
static void make_in_scope(void *data) {
	making *m = data;
	m->made = sc_create_computer(pw_scheduler, m->def, NULL, 0);
}
char *pw_make(pw_watch *w, const char *name, const char *scope, sc_def def) {
	sc_scope *o = scope ? scope_named(scope) : NULL;
	if (o == NULL) return pw_copy("no such scope");
	w->name = pw_copy(name);
	PUSH(watches, nwatches, capwatches, w);
	making m = {.def = def};
	const char *bad = sc_run_with_scope(o, make_in_scope, &m);
	if (bad) return pw_copy(bad);
	if (m.made == NULL) return pw_copy(SC_DISPOSED);
	return name_scope((sc_scope *)m.made, name);
}

// the world's requests ------------------------------------------------------------------------------

typedef struct {
	const op_value *r;
	op_value *out;
} hosting;
static void entering(void *data) {
	hosting *c = data;
	const char *op = pw_text(op_get(c->r, "op"));
	pw_put_entry(op[0] == 'k' ? "children" : "value", pw_key(op_get(c->r, "id")), op_get(c->r, "value"));
	c->out = op_map();
}

static op_value *answer_world(const op_value *r) {
	const char *op = pw_text(op_get(r, "op"));
	if (op == NULL) return NULL;
	if (strcmp(op, "kids") == 0 || strcmp(op, "value") == 0) {
		hosting c = {r, NULL};
		pw_hosted(entering, &c);
		return c.out;
	}
	if (strcmp(op, "root") == 0) {
		const op_value *map = op_get(r, "info");
		size_t n = 0;
		sc_pair *info = NULL;
		if (pw_is(map, OP_MAP) && map->count > 0) {
			info = hh_take(map->count * sizeof *info);
			for (size_t i = 0; i < map->count; i++) info[n++] = (sc_pair){map->keys[i], map->items[i]};
		}
		sc_scope *o = sc_create_root_scope(pw_scheduler, info, n);
		if (o == NULL) return pw_error(SC_EMPTY);
		char *bad = name_scope(o, pw_text(op_get(r, "name")));
		if (bad) return pw_error_take(bad);
		return op_map();
	}
	if (strcmp(op, "pulse") == 0) {
		sc_pulse(pw_scheduler);
		free(sc_escaped(pw_scheduler));
		return op_map();
	}
	return NULL;
}

void pw_start(void) {
	if (pw_ermine != NULL) return;
	host_info = (sc_pair){"actor", op_str("test")};
	if (es_create(&(es_options){.root = "R", .info = &host_info, .ninfo = 1}, &pw_ermine) != 0) {
		fputs("no ermine\n", stderr);
		abort();
	}
	pw_scheduler = pw_ermine->scheduler, pw_table = pw_ermine->table, pw_places = pw_ermine->places;
	pw_host = pw_ermine->host_scope;
}

void pw_line(const op_value *r, FILE *out, op_value *(*answer)(const op_value *request)) {
	pw_start();
	// the line is kept: what the world holds refers into it
	hh_line *line = hh_retain();
	if (nlines == 0 || lines[nlines - 1] != line) PUSH(lines, nlines, caplines, line);
	op_value *a = answer(r);
	if (a == NULL) a = answer_world(r);
	if (a == NULL) {
		hh_unknown(out, r);
		return;
	}
	op_json_write(out, a);
	op_free(a);
}

void pw_close(void) {
	if (pw_ermine == NULL) return;
	for (size_t i = 0; i < nnamed; i++) free(sc_scope_user(named[i]));
	free(named);
	named = NULL;
	nnamed = capnamed = 0;
	es_close(pw_ermine);
}

void pw_free(void) {
	if (pw_ermine == NULL) return;
	es_free(pw_ermine);
	pw_ermine = NULL;
	for (size_t i = 0; i < nwatches; i++) {
		op_free(watches[i]->value);
		free(watches[i]->name);
	}
	free(watches);
	watches = NULL;
	nwatches = capwatches = 0;
	for (size_t i = 0; i < nlines; i++) hh_release(lines[i]);
	free(lines);
	lines = NULL;
	nlines = caplines = 0;
	op_free((op_value *)host_info.value);
}
