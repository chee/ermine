// The C sessions (sessions.h) on the line protocol of typescript/sessions_harness.ts, which documents
// it (conformance/c/harness.h has the loop). One world for the run: a table, places, a scheduler and a
// root scope the beats are written in. Sessions are named in requests and answers by the name they
// were started with.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../../conformance/c/harness.h"
#include "sessions.h"

#define PUSH(v, n, cap, x) \
	do { \
		if ((n) == (cap)) { \
			(cap) = (cap) ? (cap) * 2 : 16; \
			(v) = realloc((v), (cap) * sizeof *(v)); \
			if ((v) == NULL) abort(); \
		} \
		(v)[(n)++] = (x); \
	} while (0)

static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) abort();
	return p;
}
static char *xdup(const char *s) { return strcpy(xalloc(strlen(s) + 1), s); }

static tb_table *table;
static pt_paths *paths;
static pl *places;
static sc_scheduler *scheduler;
static sc_scope *scope;
static sc_pair info;
static sess_world world;
static int begun;
// every line is kept: what the table holds refers into it (the nodes, the installs)
static hh_line **lines;
static size_t nlines, caplines;

static void drop(void *value, void *data) {
	(void)data;
	op_free(value);
}

static void begin(void) {
	if (begun) return;
	begun = 1;
	places = pl_new();
	scheduler = sc_new((sc_options){.drop = drop});
	sc_on_tracking_end(scheduler, pl_forget, places);
	table = tb_make(pl_event, places);
	paths = pt_new();
	pl_connect(places, &(pl_setup){.root = tb_string("R"), .table = table, .paths = paths, .scheduler = scheduler});
	info = (sc_pair){"actor", op_str("host")};
	scope = sc_create_root_scope(scheduler, &info, 1);
	world = (sess_world){.table = table, .places = places, .scheduler = scheduler, .scope = scope};
}

// the sessions, by name
typedef struct {
	char *name;
	sess_session session;
} named;
static named *sessions;
static size_t nsessions, capsessions;

static named *session_named(const char *name) {
	for (size_t i = 0; name != NULL && i < nsessions; i++) {
		if (strcmp(sessions[i].name, name) == 0) return &sessions[i];
	}
	return NULL;
}

// the name a session id was started with, else the id itself
static const char *name_of(const char *id) {
	for (size_t i = 0; i < nsessions; i++) {
		if (strcmp(sessions[i].session.id, id) == 0) return sessions[i].name;
	}
	return id;
}

// what the watch saw at each of its runs since the last pulse (lists of names)
static op_value *seen;

static op_value *names_of(sess_heres *here) {
	op_value *list = op_list();
	for (size_t i = 0; i < here->n; i++) op_push(list, op_str(name_of(here->items[i].session)));
	return list;
}

typedef struct {
	const char *node;
	int64_t now;
} watching;

static sc_out watch_f(void *previous, void *data) {
	(void)previous;
	watching *w = data;
	sess_heres here = sess_online(&world, w->node, w->now);
	op_value *v = names_of(&here);
	sess_heres_free(&here);
	// the reads told: a stop means the run ends now, giving nothing
	if (pl_status(places) == SC_STOP) {
		op_free(v);
		return (sc_out){.kind = SC_VALUE};
	}
	return (sc_out){.kind = SC_VALUE, .value = v};
}

static char *watch_act(void *value, void *previous, void *data) {
	(void)previous, (void)data;
	op_push(seen, op_ref(value));
	return NULL;
}

static void make_watch(void *data) {
	sc_def def = {.f = watch_f, .effect = watch_act, .data = data};
	sc_create_effect(scheduler, def, NULL, 0);
}

// online, untracked: the values only
typedef struct {
	const char *node;
	int64_t now;
	sess_heres here;
} reading;

static void read_peep(void *data) {
	reading *r = data;
	r->here = sess_online(&world, r->node, r->now);
}

static int by_name(const void *a, const void *b) {
	const char *x = name_of(((const sess_here *)a)->session), *y = name_of(((const sess_here *)b)->session);
	return strcmp(x, y);
}

// the whole number at key; false when it is not there
static bool whole(const op_value *r, const char *key, int64_t *out) {
	const op_value *v = op_get(r, key);
	if (v == NULL || v->type != OP_NUM) return false;
	*out = (int64_t)v->num;
	return true;
}

static const char *kinds[] = {NULL, "fresh", "hashed", "key"};

void hh_start(void) {}

void hh_answer(const op_value *r, FILE *out) {
	const char *op = hh_str(r, "op");
	if (op == NULL) {
		hh_unknown(out, r);
		return;
	}
	begin();
	// the line is kept: the table holds strings of it
	hh_line *line = hh_retain();
	if (nlines == 0 || lines[nlines - 1] != line) PUSH(lines, nlines, caplines, line);
	if (seen == NULL) seen = op_list();
	const char *node = hh_str(r, "node");
	int64_t n = 0;
	if (strcmp(op, "start") == 0) {
		const char *name = hh_str(r, "name"), *install = hh_str(r, "install");
		if (name == NULL || install == NULL) {
			hh_error(out, "start: no name or install");
			return;
		}
		uint8_t random[16];
		arc4random_buf(random, sizeof random);
		sess_session s = sess_start(random, install);
		bool differs = true;
		for (size_t i = 0; i < nsessions; i++) {
			if (strcmp(sessions[i].session.id, s.id) == 0) differs = false;
		}
		PUSH(sessions, nsessions, capsessions, ((named){xdup(name), s}));
		uint8_t id[ID_MAX];
		size_t m = id_parse(s.id, strlen(s.id), id);
		const char *k = kinds[m ? id_kind_of(id, m) : ID_NONE];
		fputs("{\"kind\":", out);
		if (k) op_json_string(out, k);
		else fputs("null", out);
		fprintf(out, ",\"differs\":%s}", differs ? "true" : "false");
	} else if (strcmp(op, "beat") == 0 || strcmp(op, "leave") == 0) {
		named *s = session_named(hh_str(r, "session"));
		if (s == NULL) {
			hh_error(out, "no session %s", hh_str(r, "session") ? hh_str(r, "session") : "");
			return;
		}
		if (node == NULL) {
			hh_error(out, "%s: no node", op);
			return;
		}
		if (op[0] == 'b') {
			if (!whole(r, "until", &n)) {
				hh_error(out, "beat: no until");
				return;
			}
			sess_beat(&world, &s->session, node, n);
		} else sess_leave(&world, &s->session, node);
		fputs("{}", out);
	} else if (strcmp(op, "sweep") == 0) {
		if (node == NULL || !whole(r, "now", &n)) {
			hh_error(out, "sweep: no node or now");
			return;
		}
		sess_sweep(&world, node, n);
		fputs("{}", out);
	} else if (strcmp(op, "online") == 0) {
		if (node == NULL || !whole(r, "now", &n)) {
			hh_error(out, "online: no node or now");
			return;
		}
		reading rd = {node, n, {0}};
		pl_peep(places, read_peep, &rd);
		// online promises no order: by session name
		qsort(rd.here.items, rd.here.n, sizeof *rd.here.items, by_name);
		fputs("{\"here\":[", out);
		for (size_t i = 0; i < rd.here.n; i++) {
			if (i) fputc(',', out);
			fputs("{\"session\":", out);
			op_json_string(out, name_of(rd.here.items[i].session));
			fputs(",\"install\":", out);
			op_json_string(out, rd.here.items[i].install);
			fprintf(out, ",\"until\":%lld}", (long long)rd.here.items[i].until);
		}
		fputs("]}", out);
		sess_heres_free(&rd.here);
	} else if (strcmp(op, "entry") == 0) {
		if (node == NULL) {
			hh_error(out, "entry: no node");
			return;
		}
		const nd_entry *there = tb_get(table, tb_string(SESS_PART), tb_string(node));
		op_value *o = op_map();
		if (there != NULL && there->value != NULL && there->value->type == OP_MAP) {
			op_value *v = op_map();
			for (size_t i = 0; i < there->value->count; i++) {
				op_set(v, name_of(there->value->keys[i]), op_ref(there->value->items[i]));
			}
			op_set(o, "value", v);
		} else op_set(o, "value", op_null());
		op_json_write(out, o);
		op_free(o);
	} else if (strcmp(op, "watch") == 0) {
		if (node == NULL || !whole(r, "now", &n)) {
			hh_error(out, "watch: no node or now");
			return;
		}
		watching *w = xalloc(sizeof *w);
		*w = (watching){node, n};
		sc_run_with_scope(scope, make_watch, w);
		fputs("{}", out);
	} else if (strcmp(op, "pulse") == 0) {
		sc_pulse(scheduler);
		op_value *o = op_map();
		op_set(o, "seen", seen);
		seen = op_list();
		op_json_write(out, o);
		op_free(o);
	} else hh_unknown(out, r);
}

void hh_finish(void) {
	if (!begun) return;
	sc_free(scheduler);
	tb_free(table);
	pt_free(paths);
	pl_free(places);
	op_free((op_value *)info.value);
	op_free(seen);
	for (size_t i = 0; i < nsessions; i++) free(sessions[i].name);
	free(sessions);
	for (size_t i = 0; i < nlines; i++) hh_release(lines[i]);
	free(lines);
}
