// The C presence (presence.h) on the line protocol of typescript/presence_harness.ts, which documents
// it (conformance/c/harness.h has the loop). Two devices, "a" and "b", each with a table, places and
// scheduler of its own, joined by the in-memory channel (channel.h), and one clock they share, which
// only the "now" request moves.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../../conformance/c/harness.h"
#include "presence.h"
#include "../../../ermine/encoding/c/cbor.h"
#include "../../../ermine/encoding/c/pack.h"

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

// the devices ------------------------------------------------------------------------------------

typedef struct {
	char *name;
	tb_table *table;
	pt_paths *paths;
	pl *places;
	sc_scheduler *scheduler;
	sc_scope *scope;
	sc_pair info;
	pres_world world;
	chn_channel *channel;
} device;

static device devices[2];
static chn_pair *pair;
static int64_t clock_ms;
static int begun;
// every line is kept: what the table holds refers into it (strings, values)
static hh_line **lines;
static size_t nlines, caplines;

static int64_t read_clock(void *ctx) {
	(void)ctx;
	return clock_ms;
}

static void drop(void *value, void *data) {
	(void)data;
	op_free(value);
}

static void device_start(device *d, const char *name, chn_channel *channel) {
	d->name = xdup(name);
	d->places = pl_new();
	d->scheduler = sc_new((sc_options){.drop = drop});
	sc_on_tracking_end(d->scheduler, pl_forget, d->places);
	d->table = tb_make(pl_event, d->places);
	d->paths = pt_new();
	pl_connect(d->places, &(pl_setup){.root = tb_string("R"), .table = d->table, .paths = d->paths,
		.scheduler = d->scheduler});
	d->info = (sc_pair){"actor", op_str(name)};
	d->scope = sc_create_root_scope(d->scheduler, &d->info, 1);
	d->channel = channel;
	d->world = (pres_world){.table = d->table, .places = d->places, .scheduler = d->scheduler,
		.scope = d->scope, .now = read_clock};
}

static void begin(void) {
	if (begun) return;
	begun = 1;
	pair = chn_pair_new("a", "b");
	device_start(&devices[0], "a", chn_pair_a(pair));
	device_start(&devices[1], "b", chn_pair_b(pair));
}

// the device a request names: NULL, and why
static device *dev(const op_value *r, const char **why) {
	const char *name = hh_str(r, "dev");
	if (name != NULL && strcmp(name, "a") == 0) return &devices[0];
	if (name != NULL && strcmp(name, "b") == 0) return &devices[1];
	*why = "no such device";
	return NULL;
}

// small helpers ----------------------------------------------------------------------------------

static op_value *error(const char *why) {
	op_value *o = op_map();
	op_set(o, "error", op_str(why));
	return o;
}

// the whole number at key; false when it is not there
static bool whole(const op_value *r, const char *key, int64_t *out) {
	const op_value *v = op_get(r, key);
	if (v == NULL || v->type != OP_NUM) return false;
	*out = (int64_t)v->num;
	return true;
}

static op_value *live_json(const pres_live *l) {
	op_value *o = op_map();
	op_set(o, "who", op_str(l->who));
	op_set(o, "value", op_ref(l->value));
	op_set(o, "until", op_num((double)l->until));
	return o;
}

// connections, watches, path watches: by name ------------------------------------------------------

typedef struct {
	char *name;
	pres_conn *conn;
} named_conn;
static named_conn *conns;
static size_t nconns, capconns;

static pres_conn *conn_named(const char *name) {
	for (size_t i = 0; i < nconns; i++) {
		if (name != NULL && strcmp(conns[i].name, name) == 0) return conns[i].conn;
	}
	return NULL;
}

// a compute: its runs counted, its result kept
typedef struct {
	char *name;
	device *d;
	char *anchor;
	// NULL: all the rows
	char *who;
	unsigned runs;
	op_value *value;
} watch;
static watch **watches;
static size_t nwatches, capwatches;

static sc_out watch_f(void *previous, void *data) {
	(void)previous;
	watch *w = data;
	w->runs++;
	op_value *v;
	if (w->who == NULL) {
		pres_lives rows = pres_read(&w->d->world, w->anchor);
		v = op_list();
		for (size_t i = 0; i < rows.n; i++) op_push(v, live_json(&rows.items[i]));
		pres_lives_free(&rows);
	} else {
		pres_live row;
		if (pres_read_row(&w->d->world, w->anchor, w->who, &row)) {
			v = live_json(&row);
			pres_live_free(&row);
		} else v = op_null();
	}
	// the reads told: a stop means the run ends now, giving nothing
	if (pl_status(w->d->places) == SC_STOP) {
		op_free(v);
		return (sc_out){.kind = SC_VALUE};
	}
	return (sc_out){.kind = SC_VALUE, .value = v};
}

static char *watch_set(void *value, void *data) {
	watch *w = data;
	op_value *was = w->value;
	w->value = op_ref(value);
	op_free(was);
	return NULL;
}

static bool watch_equal(const void *a, const void *b, void *data) {
	(void)data;
	char *x = op_json_text(a), *y = op_json_text(b);
	bool same = strcmp(x, y) == 0;
	free(x);
	free(y);
	return same;
}

static void make_watch(void *data) {
	watch *w = data;
	sc_def def = {.f = watch_f, .set = watch_set, .equal = watch_equal, .data = w};
	sc_create_computer(w->d->scheduler, def, NULL, 0);
}

// a path watch: the patches it was told, counted
typedef struct {
	char *name;
	pl_watch *watch;
	size_t patches;
} told;
static told **toldlist;
static size_t ntold, captold;

static void told_fact(const pl_fact *f, void *ctx) {
	told *t = ctx;
	t->patches += f->patches_length;
}

// the mount: the children entry "R" has the id under the name --------------------------------------

typedef struct {
	device *d;
	const char *name;
	const char *id;
} mounting;

static void mount_in(void *data) {
	mounting *m = data;
	device *d = m->d;
	ch_header h;
	pl_made *made;
	char *bad = pl_header(d->places, NULL, 0, CH_HERE, &h, &made);
	if (bad != NULL) abort();
	op_value *empty = op_map();
	nd_entry *kids = nd_make_entry(empty, &h);
	op_free(empty);
	pl_hold(d->places, kids, made, pl_made_free);
	pl_own(d->places, kids);
	tb_add(d->table, tb_string("children"), tb_string("R"), kids);
	bad = pl_header(d->places, NULL, 0, CH_HERE, &h, &made);
	if (bad != NULL) abort();
	pl_changed changed = {0};
	pl_place(d->places, kids, m->name, tb_string(m->id), h, &changed);
	for (size_t i = 0; i < changed.n; i++) {
		pl_hold_also(d->places, changed.entries[i], pl_made_ref(made), pl_made_free);
	}
	pl_made_free(made);
	pl_commit(d->places, &changed);
}

// requests ---------------------------------------------------------------------------------------

static op_value *answer(const op_value *r) {
	const char *op = hh_str(r, "op");
	if (op == NULL) return error("no op");
	const char *why = NULL;
	if (strcmp(op, "now") == 0) {
		int64_t t;
		if (!whole(r, "t", &t)) return error("no t");
		clock_ms = t;
		return op_map();
	}
	if (strcmp(op, "sent") == 0) {
		size_t n;
		const chn_sent *sent = chn_pair_sent(pair, &n);
		op_value *list = op_list();
		for (size_t i = 0; i < n; i++) {
			op_value *m = op_map();
			op_set(m, "from", op_str(sent[i].from));
			op_set(m, "topic", op_str(sent[i].topic));
			Json *j = cborDecode(sent[i].bytes, sent[i].n, NULL, NULL);
			op_value *message = j != NULL ? pk_of_json(j) : NULL;
			jsonFree(j);
			op_set(m, "message", message != NULL ? message : op_null());
			op_push(list, m);
		}
		op_value *o = op_map();
		op_set(o, "sent", list);
		return o;
	}
	if (strcmp(op, "bytes") == 0) {
		size_t n;
		const chn_sent *sent = chn_pair_sent(pair, &n);
		op_value *list = op_list();
		for (size_t i = 0; i < n; i++) {
			char *hex = xalloc(sent[i].n * 2 + 1);
			for (size_t k = 0; k < sent[i].n; k++) sprintf(hex + k * 2, "%02x", sent[i].bytes[k]);
			op_push(list, op_str(hex));
			free(hex);
		}
		op_value *o = op_map();
		op_set(o, "bytes", list);
		return o;
	}
	if (strcmp(op, "sizes") == 0) {
		size_t n;
		const chn_sent *sent = chn_pair_sent(pair, &n);
		op_value *list = op_list();
		for (size_t i = 0; i < n; i++) op_push(list, op_num((double)sent[i].n));
		op_value *o = op_map();
		op_set(o, "sizes", list);
		return o;
	}
	if (strcmp(op, "stop") == 0 || strcmp(op, "announce") == 0) {
		pres_conn *c = conn_named(hh_str(r, "name"));
		if (c == NULL) return error("no such connection");
		if (op[0] == 's') pres_stop(c);
		else pres_announce(c);
		return op_map();
	}
	if (strcmp(op, "state") == 0) {
		const char *name = hh_str(r, "name");
		for (size_t i = 0; i < nwatches; i++) {
			if (name == NULL || strcmp(watches[i]->name, name) != 0) continue;
			op_value *o = op_map();
			op_set(o, "runs", op_num((double)watches[i]->runs));
			op_set(o, "value", watches[i]->value ? op_ref(watches[i]->value) : op_null());
			return o;
		}
		return error("no such watch");
	}
	if (strcmp(op, "told") == 0) {
		const char *name = hh_str(r, "name");
		for (size_t i = 0; i < ntold; i++) {
			if (name == NULL || strcmp(toldlist[i]->name, name) != 0) continue;
			op_value *o = op_map();
			op_set(o, "patches", op_num((double)toldlist[i]->patches));
			return o;
		}
		return error("no such watch");
	}
	if (strcmp(op, "keep") == 0) {
		const char *part = hh_str(r, "part");
		if (part == NULL) return error("no part");
		pres_world given = {0};
		const pres_world *w = &given;
		const op_value *save = op_get(r, "save");
		if (op_get(r, "dev") != NULL) {
			device *d = dev(r, &why);
			if (d == NULL) return error(why);
			w = &d->world;
		} else if (save != NULL && save->type == OP_BOOL) given.save = save->bool_;
		op_value *o = op_map();
		op_set(o, "keep", op_bool(pres_keep(w, part)));
		return o;
	}
	// the rest name a device
	device *d = dev(r, &why);
	if (d == NULL) return error(why);
	const char *anchor = hh_str(r, "anchor"), *who = hh_str(r, "who");
	int64_t ttl = 0;
	if (strcmp(op, "connect") == 0) {
		const char *name = hh_str(r, "name"), *topic = hh_str(r, "topic");
		if (name == NULL || topic == NULL) return error("no name or topic");
		const op_value *patches = op_get(r, "patches");
		pres_conn *c = pres_connect_patches(&d->world, d->channel, topic, anchor,
			patches != NULL && patches->type == OP_BOOL && patches->bool_);
		PUSH(conns, nconns, capconns, ((named_conn){xdup(name), c}));
		return op_map();
	}
	if (strcmp(op, "save") == 0) {
		const op_value *save = op_get(r, "save");
		d->world.save = save != NULL && save->type == OP_BOOL && save->bool_;
		return op_map();
	}
	if (strcmp(op, "pulse") == 0) {
		sc_pulse(d->scheduler);
		return op_map();
	}
	if (strcmp(op, "sweep") == 0) {
		int64_t at;
		pres_swept swept = whole(r, "at", &at) ? pres_sweep(&d->world, at) : pres_sweep_now(&d->world);
		op_value *list = op_list();
		for (size_t i = 0; i < swept.n; i++) {
			op_value *m = op_map();
			op_set(m, "anchor", op_str(swept.items[i].anchor));
			op_set(m, "who", op_str(swept.items[i].who));
			op_push(list, m);
		}
		pres_swept_free(&swept);
		op_value *o = op_map();
		op_set(o, "swept", list);
		return o;
	}
	if (strcmp(op, "mount") == 0) {
		const char *name = hh_str(r, "name"), *id = hh_str(r, "id");
		if (name == NULL || id == NULL) return error("no name or id");
		mounting m = {d, name, id};
		sc_run_with_scope(d->scope, mount_in, &m);
		return op_map();
	}
	if (strcmp(op, "watchPath") == 0) {
		const op_value *path = op_get(r, "path");
		if (path == NULL || path->type != OP_LIST) return error("no path");
		const char **names = xalloc((path->count + 1) * sizeof *names);
		for (size_t i = 0; i < path->count; i++) {
			names[i] = path->items[i]->type == OP_STR ? path->items[i]->str : "";
		}
		told *t = xalloc(sizeof *t);
		t->name = xdup(hh_str(r, "name") ? hh_str(r, "name") : "");
		pl_watching options = {.has_part = 1, .part = tb_string(PRES_PART)};
		t->watch = pl_watch_path(d->places, names, path->count, told_fact, t, &options);
		free(names);
		PUSH(toldlist, ntold, captold, t);
		return op_map();
	}
	if (strcmp(op, "watch") == 0) {
		const op_value *f = op_get(r, "f");
		const op_value *all = f ? op_get(f, "presence") : NULL, *row = f ? op_get(f, "row") : NULL;
		watch *w = xalloc(sizeof *w);
		w->name = xdup(hh_str(r, "name") ? hh_str(r, "name") : "");
		w->d = d;
		if (all != NULL && all->type == OP_STR) w->anchor = xdup(all->str);
		else if (row != NULL && row->type == OP_LIST && row->count == 2 && row->items[0]->type == OP_STR &&
			row->items[1]->type == OP_STR) {
			w->anchor = xdup(row->items[0]->str);
			w->who = xdup(row->items[1]->str);
		} else {
			free(w->name);
			free(w);
			return error("no such program");
		}
		PUSH(watches, nwatches, capwatches, w);
		sc_run_with_scope(d->scope, make_watch, w);
		return op_map();
	}
	if (anchor == NULL) return error("no anchor");
	whole(r, "ttl", &ttl);
	if (strcmp(op, "set") == 0) {
		const op_value *value = op_get(r, "value");
		if (who == NULL) return error("no who");
		pres_set(&d->world, anchor, who, value != NULL ? value : NULL, ttl);
		return op_map();
	}
	if (strcmp(op, "edit") == 0) {
		if (who == NULL) return error("no who");
		op_value *o = op_map();
		op_set(o, "ok", op_bool(pres_edit(&d->world, anchor, who, op_get(r, "patches"), ttl)));
		return o;
	}
	if (strcmp(op, "renew") == 0) {
		if (who == NULL) return error("no who");
		op_value *o = op_map();
		op_set(o, "ok", op_bool(pres_renew(&d->world, anchor, who, ttl)));
		return o;
	}
	if (strcmp(op, "clear") == 0) {
		if (who == NULL) return error("no who");
		pres_clear(&d->world, anchor, who);
		return op_map();
	}
	if (strcmp(op, "ensure") == 0) {
		pres_ensure(&d->world, anchor);
		return op_map();
	}
	if (strcmp(op, "presence") == 0) {
		pres_lives rows = pres_read(&d->world, anchor);
		pl_status(d->places);
		op_value *list = op_list();
		for (size_t i = 0; i < rows.n; i++) op_push(list, live_json(&rows.items[i]));
		pres_lives_free(&rows);
		op_value *o = op_map();
		op_set(o, "rows", list);
		return o;
	}
	if (strcmp(op, "row") == 0) {
		if (who == NULL) return error("no who");
		pres_live row;
		bool found = pres_read_row(&d->world, anchor, who, &row);
		pl_status(d->places);
		op_value *o = op_map();
		if (found) {
			op_set(o, "row", live_json(&row));
			pres_live_free(&row);
		}
		return o;
	}
	if (strcmp(op, "table") == 0) {
		const nd_entry *n = tb_get(d->table, tb_string(PRES_PART), tb_string(anchor));
		op_value *o = op_map();
		if (n != NULL && n->value != NULL) op_set(o, "value", op_ref(n->value));
		return o;
	}
	return NULL;
}

void hh_start(void) {}

void hh_answer(const op_value *request, FILE *out) {
	begin();
	// the line is kept: the table holds strings and values of it
	hh_line *line = hh_retain();
	if (nlines == 0 || lines[nlines - 1] != line) PUSH(lines, nlines, caplines, line);
	op_value *a = answer(request);
	if (a == NULL) {
		hh_unknown(out, request);
		return;
	}
	op_json_write(out, a);
	op_free(a);
}

void hh_finish(void) {
	if (!begun) return;
	for (size_t i = 0; i < 2; i++) pres_free(&devices[i].world);
	for (size_t i = 0; i < ntold; i++) {
		pl_stop(toldlist[i]->watch);
		free(toldlist[i]->name);
		free(toldlist[i]);
	}
	free(toldlist);
	for (size_t i = 0; i < nwatches; i++) {
		op_free(watches[i]->value);
		free(watches[i]->name);
		free(watches[i]->anchor);
		free(watches[i]->who);
		free(watches[i]);
	}
	free(watches);
	for (size_t i = 0; i < nconns; i++) free(conns[i].name);
	free(conns);
	for (size_t i = 0; i < 2; i++) {
		device *d = &devices[i];
		sc_free(d->scheduler);
		tb_free(d->table);
		pt_free(d->paths);
		pl_free(d->places);
		op_free((op_value *)d->info.value);
		free(d->name);
	}
	chn_pair_free(pair);
	for (size_t i = 0; i < nlines; i++) hh_release(lines[i]);
	free(lines);
}
