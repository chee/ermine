// The C sessions (sessions.h) on the line protocol of typescript/sessions_harness.ts, which documents
// it (conformance/c/harness.h has the loop). One world for the run: a table, places, a scheduler and a
// root scope the beats are written in. Sessions and installs are named in requests and answers by the
// name they were started with. An install named N has the secret BLAKE3 of N's UTF-8, its id its
// key's; Ed25519 is the repo's (core/ed25519/c: this harness's only, sessions knows none).
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../../conformance/c/harness.h"
#include "../../../core/ed25519/c/ed25519.h"
#include "../../../ermine/encoding/c/blake3/blake3.h"
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
// the watches made, freed at the end
static void **watches;
static size_t nwatches, capwatches;

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

// the installs, by name: each kept whole, a session borrows its id
typedef struct {
	char *name;
	char id[ID_TEXT];
	sess_install install;
} installed;
static installed **installs;
static size_t ninstalls, capinstalls;

static bool ed25519_of(void *ctx, const uint8_t secret[32], uint8_t out[32]) {
	(void)ctx;
	ermEd25519Public(secret, out);
	return true;
}

static bool ed25519_sign(void *ctx, const uint8_t secret[32], const uint8_t *message, size_t length, uint8_t out[64]) {
	(void)ctx;
	ermEd25519Sign(secret, message, length, out);
	return true;
}

static bool ed25519_verify(void *ctx, const uint8_t key[32], const uint8_t *message, size_t length,
	const uint8_t signature[64]) {
	(void)ctx;
	return ermEd25519Verify(key, message, length, signature);
}

static const sess_signing signing = {.public_key_of = ed25519_of, .sign = ed25519_sign};
static const sess_verifying verifying = {.verify = ed25519_verify};

// the install a name stands for, made the first time
static installed *install_named(const char *name) {
	for (size_t i = 0; i < ninstalls; i++) {
		if (strcmp(installs[i]->name, name) == 0) return installs[i];
	}
	installed *in = xalloc(sizeof *in);
	in->name = xdup(name);
	blake3_hasher h;
	blake3_hasher_init(&h);
	blake3_hasher_update(&h, name, strlen(name));
	blake3_hasher_finalize(&h, in->install.secret, 32);
	uint8_t id[34] = {0xed, 0x01};
	ermEd25519Public(in->install.secret, id + 2);
	id_text(id, sizeof id, in->id);
	in->install.id = in->id;
	PUSH(installs, ninstalls, capinstalls, in);
	return in;
}

// the name a session or install id was started with, else the id itself
static const char *name_of(const char *id) {
	for (size_t i = 0; i < ninstalls; i++) {
		if (strcmp(installs[i]->id, id) == 0) return installs[i]->name;
	}
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
	char *node;
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

// the number "NaN" or "Infinity" stands for; NULL: v is neither. new
static op_value *number_of(const op_value *v) {
	if (v->type != OP_STR) return NULL;
	if (strcmp(v->str, "NaN") == 0) return op_num(NAN);
	if (strcmp(v->str, "Infinity") == 0) return op_num(INFINITY);
	return NULL;
}

typedef struct {
	const char *node, *key;
	const op_value *value;
} put_t;

// the value at key in the node's online entry, as a carrier might bring it
static void put_in(void *data) {
	put_t *p = data;
	ch_header h;
	pl_made *made;
	char *bad = pl_header(places, NULL, 0, CH_HERE, &h, &made);
	if (bad != NULL) abort();
	const char *path[1] = {p->key};
	pl_changed changed;
	nd_entry *node;
	pl_upsert(places, tb_string(SESS_PART), tb_string(p->node), path, 1, p->value, h, &changed, &node);
	for (size_t i = 0; i < changed.n; i++) pl_hold_also(places, changed.entries[i], pl_made_ref(made), pl_made_free);
	if (node != NULL) pl_hold(places, node, made, pl_made_free);
	else pl_made_free(made);
	pl_commit(places, &changed);
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
	if (seen == NULL) seen = op_list();
	const char *node = hh_str(r, "node");
	int64_t n = 0;
	if (strcmp(op, "start") == 0) {
		const char *name = hh_str(r, "name"), *install = hh_str(r, "install");
		if (name == NULL || install == NULL) {
			hh_error(out, "start: no name or install");
			return;
		}
		installed *in = install_named(install);
		uint8_t random[32];
		arc4random_buf(random, sizeof random);
		sess_session s;
		if (sess_start(random, &in->install, &signing, &s) != SESS_OK) {
			hh_error(out, "start: no session");
			return;
		}
		bool differs = true;
		for (size_t i = 0; i < nsessions; i++) {
			if (strcmp(sessions[i].session.id, s.id) == 0) differs = false;
		}
		bool vouched = sess_vouched(s.id, s.install, s.vouch, &verifying);
		PUSH(sessions, nsessions, capsessions, ((named){xdup(name), s}));
		uint8_t id[ID_MAX];
		size_t m = id_parse(s.id, strlen(s.id), id);
		const char *k = kinds[m ? id_kind_of(id, m) : ID_NONE];
		fputs("{\"kind\":", out);
		if (k) op_json_string(out, k);
		else fputs("null", out);
		fprintf(out, ",\"differs\":%s,\"vouched\":%s}", differs ? "true" : "false", vouched ? "true" : "false");
	} else if (strcmp(op, "vouched") == 0) {
		named *s = session_named(hh_str(r, "session"));
		if (s == NULL) {
			hh_error(out, "no session %s", hh_str(r, "session") ? hh_str(r, "session") : "");
			return;
		}
		const char *as = hh_str(r, "as"), *from = hh_str(r, "from");
		named *taken = from ? session_named(from) : s;
		if (taken == NULL) {
			hh_error(out, "no session %s", from);
			return;
		}
		const char *install = as ? install_named(as)->id : s->session.install;
		bool ok = sess_vouched(s->session.id, install, taken->session.vouch, &verifying);
		fprintf(out, "{\"vouched\":%s}", ok ? "true" : "false");
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
			op_json_string(out, name_of(rd.here.items[i].install));
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
				// the beat as stored, its install by name
				const op_value *beat = there->value->items[i];
				if (beat->type != OP_MAP) {
					op_set(v, name_of(there->value->keys[i]), op_ref((op_value *)beat));
					continue;
				}
				op_value *b = op_map();
				const op_value *install = op_get(beat, "install");
				op_set(b, "install", op_str(install && install->type == OP_STR ? name_of(install->str) : ""));
				if (op_get(beat, "until")) op_set(b, "until", op_ref(op_get(beat, "until")));
				op_set(v, name_of(there->value->keys[i]), b);
			}
			op_set(o, "value", v);
		} else op_set(o, "value", op_null());
		op_json_write(out, o);
		op_free(o);
	} else if (strcmp(op, "put") == 0) {
		const char *key = hh_str(r, "key");
		const op_value *value = op_get(r, "value");
		if (node == NULL || key == NULL || value == NULL) {
			hh_error(out, "put: no node, key or value");
			return;
		}
		// "NaN" and "Infinity" stand for those numbers, as a value or as a map's until
		op_value *v = number_of(value);
		if (v == NULL) {
			v = op_map();
			for (size_t i = 0; i < value->count && value->type == OP_MAP; i++) {
				op_value *x = strcmp(value->keys[i], "until") == 0 ? number_of(value->items[i]) : NULL;
				op_set(v, value->keys[i], x != NULL ? x : op_ref((op_value *)value->items[i]));
			}
			if (value->type != OP_MAP) {
				op_free(v);
				v = op_ref((op_value *)value);
			}
		}
		put_t p = {node, key, v};
		sc_run_with_scope(scope, put_in, &p);
		op_free(v);
		fputs("{}", out);
	} else if (strcmp(op, "watch") == 0) {
		if (node == NULL || !whole(r, "now", &n)) {
			hh_error(out, "watch: no node or now");
			return;
		}
		watching *w = xalloc(sizeof *w);
		*w = (watching){xdup(node), n};
		PUSH(watches, nwatches, capwatches, w);
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
	for (size_t i = 0; i < ninstalls; i++) {
		free(installs[i]->name);
		free(installs[i]);
	}
	free(installs);
	for (size_t i = 0; i < nwatches; i++) {
		free(((watching *)watches[i])->node);
		free(watches[i]);
	}
	free(watches);
}
