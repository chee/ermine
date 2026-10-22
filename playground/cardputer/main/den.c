// the cardputer's den on tippet (den.h): host.ts in C, on the host's world (host.h)
#include "den.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "core/ed25519/c/ed25519.h"
#include "core/op/c/apply.h"
#include "core/op/c/json.h"
#include "ermine/encoding/c/cbor.h"
#include "ermine/processes/c/processes.h"
#include "ermine/encoding/c/blake3/blake3.h"
#include "experiments/tippet/c/history.h"
#include "fb.h"
#include "host.h"
#include "playground/encoding/c/pack.h"
#include "playground/trust/c/trust.h"
#include "things.h"

static const char *const KINDS[3] = {"keys", "screen", "pigs"};
static const char *const PROGRAMS[3] = {
	"keys: gives what was typed",
	"a screen: shows what it reads, big",
	"pigs: gives each pig's weight",
};
// host.ts' names: a thing's path in its den, on its shared node; a den's name
#define AT "thing.at"
#define NAME "ermine.den.name"
#define DEVICE "ermine.den.device"
#define DEN_ID "ermine.den.id"
#define AWAY "away"
#define OTHERS 16

// another den: its key's hex; whether the log has its steps; when it was last heard (-1: never,
// 0: it said bye)
typedef struct {
	char who[65];
	int logged;
	int64_t heard;
} other;

// a leaf in the away trie: its path, joined with "/" (its key), and the id there
typedef struct {
	char *key, *id;
	char **path;
	size_t n;
} leaf;

static struct {
	host_world w;
	hf *functions;
	// software: what runs here (experiments/software), the den's node the owner its runners are
	// offered under
	sw *software;
	inst_install install;
	char id[65], room[5];
	// the den's node and its shared nodes' ids, for the device's life
	char *node, *things, *inbox, *keys_node;
	// where the log is kept
	char *dir;
	tp_log *log;
	tp_history *history;
	tp_sync *sync;
	// this den's keys as only its own steps make them (host.ts' keys)
	op_value *keys;
	other others[OTHERS];
	size_t nothers;
	// marked when a device comes (host.ts' devices); and when a den is first heard
	int devices, heard_key;
	leaf *placed;
	size_t nplaced;
	// the asks taken in hand
	char **answered;
	size_t nanswered;
	// the den an ask came from last (its install's id), and its name
	char last[80], last_name[40];
	// what just happened, in words, shown till until
	char said[2][31];
	int hot;
	int64_t until;
	char net[32];
	int64_t now, beat;
	// the band as last drawn
	char shown[2][31];
	int shown_hot;
	// tippet's troubles said so far
	size_t failed, unkept;
	int kept_on_flash;
	// the log's store, synced (fsync) a second after this den writes: a FAT file's length is only on
	// flash once it is (store_file syncs only before its own steps leave on a link)
	tp_store *store;
	uint64_t synced, snapped, last_held;
	int64_t sync_at, still_since;
	unsigned asks;
	int code;
} me;

sw *den_software(void) { return me.software; }
const char *den_room(void) { return me.room; }
tp_sync *den_sync(void) { return me.sync; }

static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) abort();
	return p;
}
static char *xstrdup(const char *s) {
	char *c = strdup(s);
	if (c == NULL) abort();
	return c;
}
static char *joined(const char *a, const char *b) {
	char *c = xalloc(strlen(a) + strlen(b) + 1);
	strcpy(c, a), strcat(c, b);
	return c;
}

// ---- tippet's heap: counted, each part's (store, log, history, sync) and all ----

static const char *const PARTS[4] = {"store", "log", "history", "sync"};
static size_t part_now[4], part_most[4], heap_now, heap_most;
static void *counted(void *ctx, void *p, size_t old, size_t size) {
	size_t *part = ctx;
	if (size == 0) {
		free(p);
		heap_now -= old, *part -= old;
		return NULL;
	}
	void *q = realloc(p, size);
	if (q != NULL) {
		heap_now = heap_now - old + size, *part = *part - old + size;
		if (heap_now > heap_most) heap_most = heap_now;
		size_t i = (size_t)(part - part_now);
		if (*part > part_most[i]) part_most[i] = *part;
	}
	return q;
}
static tp_mem mem_of(int part) { return (tp_mem){counted, &part_now[part]}; }
size_t den_heap(size_t *most) {
	if (most) *most = heap_most;
	return heap_now;
}

// ---- values ----

static int is_map(const op_value *v) { return v != NULL && v->type == OP_MAP; }
static int is_str(const op_value *v) { return v != NULL && v->type == OP_STR; }
static int str_is(const op_value *v, const char *s) { return is_str(v) && strcmp(v->str, s) == 0; }
static void hex(char *out, const uint8_t *b, size_t n) {
	for (size_t i = 0; i < n; i++) sprintf(out + 2 * i, "%02x", b[i]);
	out[2 * n] = 0;
}

// a value's encoding (CBOR, canonical), new; NULL: it has none
static uint8_t *encoded(const op_value *v, size_t *n) {
	CborOut o = {NULL, 0, 0, true};
	if (!pk_put(&o, v)) {
		free(o.data);
		return NULL;
	}
	*n = o.length;
	return o.data;
}
static int same(const op_value *a, const op_value *b) {
	size_t x, y;
	uint8_t *p = encoded(a, &x), *q = encoded(b, &y);
	int is = p && q && x == y && memcmp(p, q, x) == 0;
	free(p), free(q);
	return is;
}

// a den's node: its install's id, from its key's hex; and back (NULL: not one)
static void install_of(const char *den, char out[80]) { snprintf(out, 80, "ermine:ed01%s", den); }
static const char *den_of(const char *install) {
	if (install == NULL || strncmp(install, "ermine:ed01", 11) != 0 || strlen(install) != 75) return NULL;
	for (int i = 11; i < 75; i++)
		if (!strchr("0123456789abcdef", install[i])) return NULL;
	return install + 11;
}
static int is_inbox(const char *n) {
	if (strncmp(n, "ermine:ed01", 11) != 0 || strlen(n) != 81) return 0;
	for (int i = 11; i < 75; i++)
		if (!strchr("0123456789abcdef", n[i])) return 0;
	return strcmp(n + 75, "/inbox") == 0;
}

// ---- writes, with the host's scope open ----

typedef struct {
	const char *part, *id;
	const char *const *path;
	size_t n;
	const op_value *v;
} upserting;

static void upsert_now(void *data) {
	upserting *u = data;
	pl *p = me.w.places;
	ch_header h;
	pl_made *made;
	char *bad = pl_header(p, NULL, 0, NULL, &h, &made);
	if (bad != NULL) {
		fprintf(stderr, "den: %s\n", bad);
		free(bad);
		return;
	}
	pl_changed changed = {0};
	nd_entry *born = NULL;
	int code = pl_upsert(p, tb_string(u->part), tb_string(u->id), u->path, u->n, u->v, h, &changed, &born);
	if (code) fprintf(stderr, "den: %s %s: %s\n", u->part, u->id, pl_code_name(code));
	if (changed.n > 0) pl_commit(p, &changed);
	for (size_t i = 0; i < changed.n; i++) pl_hold_also(p, changed.entries[i], pl_made_ref(made), pl_made_free);
	if (born != NULL) pl_hold(p, born, pl_made_ref(made), pl_made_free);
	pl_made_free(made);
}

// v at path in (part, id), made when not there; v taken
static void patch(const char *part, const char *id, const char *const *path, size_t n, op_value *v) {
	upserting u = {part, id, path, n, v};
	sc_run_with_scope(me.w.host, upsert_now, &u);
	op_free(v);
}
// a whole value, written only when it is another (as its encoding); v taken
static void put(const char *part, const char *id, op_value *v) {
	const nd_entry *was = tb_get(me.w.table, tb_string(part), tb_string(id));
	if (was != NULL && was->value != NULL && same(was->value, v)) {
		op_free(v);
		return;
	}
	patch(part, id, NULL, 0, v);
}
static void put1(const char *part, const char *id, const char *key, op_value *v) {
	const char *path[1] = {key};
	patch(part, id, path, 1, v);
}
static op_value *map1(const char *k, op_value *v) {
	op_value *m = op_map();
	op_set(m, k, v);
	return m;
}

typedef struct {
	const char *part, *id;
} deleting;
static void del_now(void *data) {
	deleting *d = data;
	tb_del(me.w.table, tb_string(d->part), tb_string(d->id));
}

// ---- what is said on the screen ----

static void say(int hot, const char *one, const char *two) {
	snprintf(me.said[0], sizeof me.said[0], "%s", one);
	snprintf(me.said[1], sizeof me.said[1], "%s", two ? two : "");
	me.hot = hot;
	me.until = me.now + 10000;
	printf("den: %s%s%s\n", one, two ? " " : "", two ? two : "");
}

// an install's name: its den's name, else its key's first 6 hex and … (host.ts' nameOf)
static void name_of(const char *install, char *out, size_t cap) {
	const nd_entry *e = tb_get(me.w.table, tb_string("attributes"), tb_string(install));
	const op_value *n = e && is_map(e->value) ? op_get(e->value, NAME) : NULL;
	if (is_str(n)) snprintf(out, cap, "%s", n->str);
	else {
		const char *d = den_of(install);
		snprintf(out, cap, "%.6s\xe2\x80\xa6", d ? d : install);
	}
}
// the same, for the screen's font: ASCII, short
static void short_name(const char *install, char *out, size_t cap) {
	char n[64];
	name_of(install, n, sizeof n);
	size_t k = 0;
	for (const char *c = n; *c && k + 1 < cap && k < 12; c++)
		if ((unsigned char)*c < 0x80) out[k++] = *c;
	out[k] = 0;
}

// ---- the others: devices the log has steps of, and dens heard ----

static other *other_of(const char *who, int make) {
	for (size_t i = 0; i < me.nothers; i++)
		if (strcmp(me.others[i].who, who) == 0) return &me.others[i];
	if (!make || me.nothers == OTHERS) return NULL;
	other *o = &me.others[me.nothers++];
	snprintf(o->who, sizeof o->who, "%s", who);
	o->heard = -1;
	return o;
}

// a device the log has steps of: marked, so the leaves are placed again
static void learn(const uint8_t device[32]) {
	if (memcmp(device, me.install.key, 32) == 0) return;
	char who[65];
	hex(who, device, 32);
	other *o = other_of(who, 1);
	if (o == NULL || o->logged) return;
	o->logged = 1;
	const void *key = &me.devices;
	sc_mark(me.w.s, &key, 1, NULL);
	host_pulse_soon();
}

// ---- this den's keys, as its own steps make them ----

// a patch's target from its map ({path, range?}); keys from *k on
static int target_of(const op_value *m, op_target *t, op_key **k) {
	const op_value *path = op_get(m, "path"), *range = op_get(m, "range");
	if (path == NULL || path->type != OP_LIST) return 0;
	t->path = *k, t->length = path->count;
	for (size_t i = 0; i < path->count; i++) {
		const op_value *x = path->items[i];
		(*k)[i] = x->type == OP_STR ? (op_key){.type = OP_STR_KEY, .s = x->str} : (op_key){.type = OP_NUM_KEY, .n = (long)x->num};
	}
	*k += path->count;
	if (range != NULL && range->type == OP_LIST && range->count == 2) {
		t->has_range = 1, t->from = (int64_t)range->items[0]->num, t->to = (int64_t)range->items[1]->num;
	}
	return 1;
}

// patches (a step's, as values) applied to *v; not a value it can be: as it was
static void apply_to(op_value **v, const op_value *ps) {
	if (ps == NULL || ps->type != OP_LIST) return;
	size_t keys = 0;
	for (size_t i = 0; i < ps->count; i++) {
		const op_value *p = op_get(ps->items[i], "path"), *m = op_get(ps->items[i], "move");
		keys += (p ? p->count : 0) + (m && op_get(m, "path") ? op_get(m, "path")->count : 0);
	}
	op_patch *patches = xalloc(ps->count * sizeof *patches);
	op_key *k = xalloc(keys * sizeof *k), *at = k;
	int ok = 1;
	for (size_t i = 0; i < ps->count && ok; i++) {
		const op_value *m = ps->items[i], *move = op_get(m, "move");
		ok = target_of(m, &patches[i].place, &at);
		patches[i].value = op_get(m, "value"), patches[i].has_value = patches[i].value != NULL;
		if (ok && move) patches[i].has_move = 1, ok = target_of(move, &patches[i].move, &at);
	}
	op_value *out = NULL;
	size_t failed;
	if (ok && op_apply(*v, patches, ps->count, NULL, &out, &failed) == OP_OK) {
		op_free(*v);
		*v = out ? out : op_map();
	}
	free(patches), free(k);
}

static int span_is(tp_span s, const char *c) { return s.n == strlen(c) && memcmp(s.p, c, s.n) == 0; }

// this den's step n: into its keys when it is a write there
static void keys_from(uint64_t n) {
	long length = tp_log_step(me.log, me.install.key, n, NULL, 0);
	if (length < 0) return;
	uint8_t *b = xalloc((size_t)length);
	tp_log_step(me.log, me.install.key, n, b, (size_t)length);
	tp_step s;
	if (tp_step_decode(b, (size_t)length, &s) == 0 && span_is(s.node, me.keys_node) && span_is(s.part, "value")) {
		op_value *ps = pk_get(s.patches.p, s.patches.n, NULL, NULL);
		apply_to(&me.keys, ps);
		if (ps) op_free(ps);
	}
	free(b);
}

static int trusts(const char *install) { return is_map(me.keys) && op_get(me.keys, install) != NULL; }

// ---- tippet: the log's told, the history's kept and run, the sync's heard ----

static void told(void *ctx, const uint8_t device[32], uint64_t from, size_t count) {
	(void)ctx;
	if (me.history) tp_history_told(me.history, device, from, count);
	if (me.sync) tp_sync_told(me.sync, device, from, count);
	if (memcmp(device, me.install.key, 32) == 0) {
		for (size_t i = 0; i < count; i++) keys_from(from + i);
	} else learn(device);
}

// host.ts' kept: the den's own nodes, and any den's inbox
static int kept(void *ctx, const char *n, const char *part) {
	(void)ctx;
	size_t t = strlen(me.things);
	if (strcmp(n, me.node) == 0) return strcmp(part, "attributes") == 0 || strcmp(part, "children") == 0;
	if (strcmp(n, me.things) == 0) return strcmp(part, "children") == 0;
	if (strncmp(n, me.things, t) == 0 && n[t] == '/') return strcmp(part, "attributes") == 0;
	if (strcmp(n, me.keys_node) == 0) return strcmp(part, "value") == 0;
	return is_inbox(n) && strcmp(part, "value") == 0;
}

static void hosted(void *ctx, void (*f)(void *data), void *data) {
	(void)ctx;
	sc_run_with_scope(me.w.host, f, data);
}

static void random_bytes(void *ctx, uint8_t *out, size_t n) {
	(void)ctx;
	den_random(out, n);
}

// a live heard: { den, bye? }
static void heard(void *ctx, const uint8_t *data, size_t length) {
	(void)ctx;
	op_value *m = pk_get(data, length, NULL, NULL);
	const op_value *den = is_map(m) ? op_get(m, "den") : NULL;
	if (is_str(den) && strcmp(den->str, me.id) != 0 && strlen(den->str) == 64) {
		other *o = other_of(den->str, 1);
		if (o && o->heard < 0) {
			const void *key = &me.heard_key;
			sc_mark(me.w.s, &key, 1, NULL);
			host_pulse_soon();
		}
		if (o) o->heard = op_get(m, "bye") ? 0 : me.now;
	}
	if (m) op_free(m);
}

static void beat(void) {
	op_value *m = map1("den", op_str(me.id));
	size_t n;
	uint8_t *b = encoded(m, &n);
	if (b && me.sync) tp_sync_live(me.sync, b, n);
	free(b);
	op_free(m);
}

// ---- the den ----

static op_value *attrs1(const char *k, op_value *v) { return map1(k, v); }

// the den: its node's attributes, placed at /system/den and /system/dens/<id> (process rows: the
// node's id there, as host.ts' addProcess), and software, its runners offered under the node
static const char *const HERE[2] = {"system", "den"};

typedef struct {
	const char *const *at;
	size_t n;
} row;
static void row_now(void *data) {
	row *r = data;
	ch_header h;
	pl_made *made;
	char *bad = pl_header(me.w.places, NULL, 0, NULL, &h, &made);
	if (bad) {
		fprintf(stderr, "den: %s\n", bad);
		free(bad);
		return;
	}
	pl_changed changed = {0};
	nd_entry *node = NULL;
	int code = pr_add(me.w.places, me.w.table, tb_string(HOST_ROOT), r->at, r->n, tb_string(me.node), h, &changed, &node);
	if (code) fprintf(stderr, "den: /%s/%s not placed: %s\n", r->at[0], r->at[1], pl_code_name(code));
	if (changed.n) pl_commit(me.w.places, &changed);
	for (size_t i = 0; i < changed.n; i++) pl_hold_also(me.w.places, changed.entries[i], pl_made_ref(made), pl_made_free);
	if (node) pl_hold(me.w.places, node, pl_made_ref(made), pl_made_free);
	pl_made_free(made);
}

static void make_den(void *data) {
	(void)data;
	op_value *a = op_map();
	op_set(a, "ermine.type", op_str("ermine.den"));
	op_set(a, DEN_ID, op_str(me.id));
	op_set(a, NAME, op_str("chee's cardputer"));
	op_set(a, DEVICE, op_str("cardputer"));
	put("attributes", me.node, a);
	const char *dens[3] = {"system", "dens", me.id};
	row here = {HERE, 2}, there = {dens, 3};
	row_now(&here), row_now(&there);
	me.software = sw_new(&(sw_setup){.scheduler = me.w.s, .table = me.w.table, .places = me.w.places,
		.scopes = me.w.scopes, .functions = me.functions, .scope = me.w.host, .sites = me.w.sites,
		.schedule = me.w.schedule});
	sw_place owner = {.id = me.node, .at = HERE, .nat = 2, .scope = me.w.host, .stored = 1};
	sw_refusal no;
	for (int i = 0; i < 3; i++) {
		char takes[32];
		snprintf(takes, sizeof takes, "thing.%s", KINDS[i]);
		op_value *t = attrs1(SW_TAKES, op_str(takes)), *fn = hf_value(KINDS[i]);
		if (sw_offer(me.software, &owner, SW_RUNNERS, KINDS[i], t, fn, &no) == NULL)
			fprintf(stderr, "den: runner %s refused: %s\n", KINDS[i], no.refused);
		op_free(t), op_free(fn);
	}
}

static void start_things(void *data) {
	(void)data;
	sw_refusal no;
	for (int i = 0; i < 3; i++) {
		const char *runner[4] = {"system", "den", "runners", KINDS[i]};
		const char *prog[2] = {"things", KINDS[i]};
		const char *at[2] = {"home", KINDS[i]};
		sw_program program = {.at = prog, .nat = 2, .has_at = 1};
		if (sw_run(me.software, runner, 4, &program, at, 2, &(sw_options){0}, &no) == NULL)
			fprintf(stderr, "den: /home/%s refused: %s\n", KINDS[i], no.refused);
	}
}

// ---- what the den runs, shared: each thing's attributes on a node of the den's ----

// what others see of the den (its things' attributes and paths, tracked), kept only as its
// encoding's hash: the effect holds its last value till the next
static sc_out nodes_f(void *previous, void *data) {
	(void)previous, (void)data;
	sw_process *const *procs;
	size_t count = sw_running(me.software, &procs);
	op_value *seen = op_map();
	for (size_t i = 0; i < count; i++) {
		const char *id = sw_process_id(procs[i]);
		const op_value *a = pl_read(me.w.places, tb_string("attributes"), tb_string(id), NULL, 0);
		const char *const *at;
		size_t nat = sw_process_at(procs[i], &at);
		op_value *one = op_list();
		op_push(one, a ? op_ref((op_value *)a) : op_null());
		for (size_t k = 0; k < nat; k++) op_push(one, op_str(at[k]));
		op_set(seen, id, one);
	}
	size_t n = 0;
	uint8_t *b = encoded(seen, &n), h[32] = {0};
	op_free(seen);
	if (b) {
		blake3_hasher x;
		blake3_hasher_init(&x);
		blake3_hasher_update(&x, b, n);
		blake3_hasher_finalize(&x, h, 32);
		free(b);
	}
	return (sc_out){.kind = SC_VALUE, .value = op_bytes(h, 32)};
}
static bool same_hash(const void *a, const void *b, void *data) {
	(void)data;
	const op_value *x = a, *y = b;
	return x && y && x->bytes == y->bytes && memcmp(x->data, y->data, x->bytes) == 0;
}

// a value that has an encoding (host.ts' shown leaves the rest out)
static int has_encoding(const op_value *v) {
	size_t n;
	uint8_t *b = encoded(v, &n);
	free(b);
	return b != NULL;
}

// each running thing's attributes, and thing.at, on <den>/things/<process id>; those gone, out
static void publish_now(void *data) {
	(void)data;
	sw_process *const *procs;
	size_t count = sw_running(me.software, &procs);
	op_value *want = op_map();
	for (size_t i = 0; i < count; i++) {
		const char *id = sw_process_id(procs[i]);
		const char *const *at;
		size_t nat = sw_process_at(procs[i], &at);
		char *shared = xalloc(strlen(me.things) + strlen(id) + 2);
		sprintf(shared, "%s/%s", me.things, id);
		op_set(want, id, op_str(shared));
		const nd_entry *e = tb_get(me.w.table, tb_string("attributes"), tb_string(id));
		const op_value *a = e ? e->value : NULL;
		op_value *attrs = op_map();
		for (size_t k = 0; is_map(a) && k < a->count; k++)
			if (a->items[k] && has_encoding(a->items[k])) op_set(attrs, a->keys[k], op_ref(a->items[k]));
		char path[160] = "";
		for (size_t k = 0; k < nat; k++) {
			size_t l = strlen(path);
			snprintf(path + l, sizeof path - l, "/%s", at[k]);
		}
		op_set(attrs, AT, op_str(path));
		put("attributes", shared, attrs);
		free(shared);
	}
	const nd_entry *e = tb_get(me.w.table, tb_string("children"), tb_string(me.things));
	op_value *was = e && e->value ? op_ref(e->value) : NULL, *wanted = op_ref(want);
	put("children", me.things, want);
	for (size_t k = 0; is_map(was) && k < was->count; k++) {
		const op_value *shared = was->items[k];
		if (!is_str(shared) || op_get(wanted, was->keys[k]) != NULL) continue;
		if (tb_get(me.w.table, tb_string("attributes"), tb_string(shared->str))) {
			deleting d = {"attributes", shared->str};
			del_now(&d);
		}
	}
	op_free(wanted);
	if (was) op_free(was);
}

static char *publish(void *value, void *previous, void *data) {
	(void)previous, (void)data;
	sc_run_with_scope(me.w.host, publish_now, NULL);
	return NULL;
}

// ---- the other dens, placed in this tree (the away trie, this world's alone): each den's node at
// /system/dens/<name>, each thing's shared node at its path ----

// "/home/x" as its steps, into out (at most most); how many
static size_t steps_of(const char *at, char **out, size_t most) {
	size_t n = 0;
	for (const char *p = at; *p && n < most;) {
		while (*p == '/') p++;
		const char *e = p;
		while (*e && *e != '/') e++;
		if (e > p) {
			out[n] = xalloc((size_t)(e - p) + 1);
			memcpy(out[n++], p, (size_t)(e - p));
		}
		p = e;
	}
	return n;
}

static void want_leaf(op_value *want, const char *path, const char *id) {
	if (op_get(want, path) == NULL) op_set(want, path, op_str(id));
}

static sc_out want_f(void *previous, void *data) {
	(void)previous, (void)data;
	sc_track(me.w.s, &me.devices);
	op_value *want = op_map();
	sc_track(me.w.s, &me.heard_key);
	for (size_t i = 0; i < me.nothers; i++) {
		// only the dens heard since this boot: an old tab's den, never back, is not placed (its
		// nodes are still in the graph, and in the log)
		if (!me.others[i].logged || me.others[i].heard < 0) continue;
		char n[80];
		install_of(me.others[i].who, n);
		if (pl_read(me.w.places, tb_string("attributes"), tb_string(n), NULL, 0) == NULL) continue;
		char path[100];
		snprintf(path, sizeof path, "/system/dens/%s", me.others[i].who);
		want_leaf(want, path, n);
		char things[96];
		snprintf(things, sizeof things, "%s/things", n);
		const op_value *kids = pl_read(me.w.places, tb_string("children"), tb_string(things), NULL, 0);
		for (size_t k = 0; is_map(kids) && k < kids->count; k++) {
			const op_value *shared = kids->items[k];
			if (!is_str(shared)) continue;
			op_key key = {.type = OP_STR_KEY, .s = AT};
			const op_value *at = pl_read(me.w.places, tb_string("attributes"), tb_string(shared->str), &key, 1);
			if (is_str(at)) want_leaf(want, at->str, shared->str);
		}
	}
	return (sc_out){.kind = SC_VALUE, .value = want};
}

// whether a leaf at path is in a local process's way: at or under its leaf, or on a level of the
// process trie (addLeaf's rule, on the process part)
static int shadowed(char *const *path, size_t n) {
	const nd_entry *e = tb_get(me.w.table, tb_string(PR_PART), tb_string(HOST_ROOT));
	const op_value *v = e ? e->value : NULL;
	for (size_t i = 0; i < n && is_map(v); i++) {
		v = op_get(v, path[i]);
		if (is_str(v)) return 1;
	}
	return is_map(v) && v->count > 0;
}

static void leaf_free(leaf *l) {
	for (size_t i = 0; i < l->n; i++) free(l->path[i]);
	free(l->path), free(l->key), free(l->id);
}

typedef struct {
	leaf *l;
	int add, code;
} leafing;
static void leaf_now(void *data) {
	leafing *x = data;
	ch_header h;
	pl_made *made;
	char *bad = pl_header(me.w.places, NULL, 0, NULL, &h, &made);
	if (bad) {
		free(bad);
		x->code = -1;
		return;
	}
	pl_changed changed = {0};
	nd_entry *node = NULL;
	x->code = x->add ? pr_add_in(me.w.places, me.w.table, AWAY, tb_string(HOST_ROOT), (const char *const *)x->l->path,
				   x->l->n, tb_string(x->l->id), h, &changed, &node)
			 : pr_remove_in(me.w.places, me.w.table, AWAY, tb_string(HOST_ROOT), (const char *const *)x->l->path,
				   x->l->n, h, &changed);
	if (x->code == 0 && changed.n > 0) pl_commit(me.w.places, &changed);
	for (size_t i = 0; i < changed.n; i++) pl_hold_also(me.w.places, changed.entries[i], pl_made_ref(made), pl_made_free);
	if (node) pl_hold(me.w.places, node, pl_made_ref(made), pl_made_free);
	pl_made_free(made);
}

static void place_now(void *data) {
	const op_value *want = data;
	for (size_t i = 0; i < me.nplaced;) {
		leaf *l = &me.placed[i];
		const op_value *w = op_get(want, l->key);
		if (is_str(w) && strcmp(w->str, l->id) == 0) {
			i++;
			continue;
		}
		leafing x = {l, 0, 0};
		leaf_now(&x);
		leaf_free(l);
		me.placed[i] = me.placed[--me.nplaced];
	}
	for (size_t k = 0; k < want->count; k++) {
		if (want->items[k] == NULL) continue;
		int there = 0;
		for (size_t i = 0; i < me.nplaced && !there; i++) there = strcmp(me.placed[i].key, want->keys[k]) == 0;
		if (there) continue;
		leaf l = {xstrdup(want->keys[k]), xstrdup(want->items[k]->str), xalloc(16 * sizeof(char *)), 0};
		l.n = steps_of(want->keys[k], l.path, 16);
		leafing x = {&l, 1, 0};
		if (l.n == 0 || shadowed(l.path, l.n) || (leaf_now(&x), x.code != 0)) {
			leaf_free(&l);
			continue;
		}
		me.placed = realloc(me.placed, (me.nplaced + 1) * sizeof *me.placed);
		if (me.placed == NULL) abort();
		me.placed[me.nplaced++] = l;
	}
}

static char *place(void *value, void *previous, void *data) {
	(void)previous, (void)data;
	sc_run_with_scope(me.w.host, place_now, value);
	return NULL;
}

// ---- asks: in this den's inbox, checked, done or not, the answer written beside each ----

static bool verify(void *ctx, const uint8_t key[32], const uint8_t *m, size_t n, const uint8_t sig[64]) {
	(void)ctx;
	return ermEd25519Verify(key, m, n, sig);
}

static int is_address(const op_value *v) { return v != NULL && (v->type == OP_STR || v->type == OP_LIST); }
static void copy_field(op_value *to, const op_value *from, const char *k) {
	const op_value *v = op_get(from, k);
	if (v) op_set(to, k, op_ref((op_value *)v));
}

static op_value *refusal(const char *who, const char *why) {
	op_value *r = op_map();
	op_set(r, "refused", op_str("not-trusted"));
	op_set(r, "who", op_str(who));
	op_set(r, "why", op_str(why));
	return r;
}
static op_value *error_of(const char *why) { return map1("error", op_str(why)); }

// an address (a string "/a/b" or a list of names) as its steps, into out (at most most, each
// strdup'd, the caller's to free); how many; -1: not an address
static long address_of(const op_value *v, char **out, size_t most) {
	if (is_str(v)) return (long)steps_of(v->str, out, most);
	if (v == NULL || v->type != OP_LIST || v->count > most) return -1;
	for (size_t i = 0; i < v->count; i++) {
		if (!is_str(v->items[i])) {
			for (size_t k = 0; k < i; k++) free(out[k]);
			return -1;
		}
		out[i] = xstrdup(v->items[i]->str);
	}
	return (long)v->count;
}
static void steps_free(char **v, long n) {
	for (long i = 0; i < n; i++) free(v[i]);
}

// an ask done on software (host.ts' done): start, stop, unpair; its answer, new
typedef struct {
	const op_value *a;
	const char *from;
	op_value *out;
} doing;
static void do_now(void *data) {
	doing *d = data;
	const op_value *a = d->a, *op = op_get(a, "op");
	if (str_is(op, "start")) {
		const op_value *program = op_get(a, "program"), *args = op_get(a, "args");
		char *runner[16], *at[16];
		long nr = address_of(op_get(a, "runner"), runner, 16), na = address_of(op_get(a, "at"), at, 16);
		if (nr < 0 || na < 0 || !is_map(program)) {
			d->out = error_of("not a start: it needs a runner, a program and an at");
		} else if (args != NULL && args->type != OP_LIST) {
			d->out = error_of("its args aren't words");
		} else {
			const char *words[32];
			size_t nargs = 0;
			int ok = 1;
			for (size_t i = 0; args && i < args->count && ok; i++) {
				ok = is_str(args->items[i]) && nargs < 32;
				if (ok) words[nargs++] = args->items[i]->str;
			}
			if (!ok) d->out = error_of("its args aren't words");
			else {
				const op_value *id = op_get(program, "id"), *hash = op_get(program, "hash"),
					       *type = op_get(program, "type"), *api = op_get(program, "api");
				sw_program pr = {.id = is_str(id) ? id->str : "", .hash = is_str(hash) ? hash->str : NULL,
					.code = op_get(program, "code"), .type = is_str(type) ? type->str : NULL,
					.api = is_str(api) ? api->str : NULL};
				sw_refusal no;
				sw_process *p = sw_run(me.software, (const char *const *)runner, (size_t)nr, &pr,
					(const char *const *)at, (size_t)na,
					&(sw_options){.args = words, .nargs = nargs, .has_args = args != NULL}, &no);
				if (p == NULL) d->out = sw_refusal_value(&no);
				else {
					const char *const *where;
					size_t n = sw_process_at(p, &where);
					op_value *steps = op_list();
					for (size_t k = 0; k < n; k++) op_push(steps, op_str(where[k]));
					d->out = op_map();
					op_set(d->out, "id", op_str(sw_process_id(p)));
					op_set(d->out, "at", steps);
				}
			}
		}
		if (nr > 0) steps_free(runner, nr);
		if (na > 0) steps_free(at, na);
	} else if (str_is(op, "stop") && is_str(op_get(a, "process"))) {
		const char *id = op_get(a, "process")->str;
		if (sw_find(me.software, id) == NULL) {
			d->out = op_map();
			op_set(d->out, "refused", op_str("not-there"));
			op_set(d->out, "process", op_str(id));
		} else {
			sw_stop(me.software, id, op_get(a, "reason"));
			d->out = op_map();
		}
	} else {
		char words[64];
		snprintf(words, sizeof words, "not an ask: %s", is_str(op) ? op->str : "undefined");
		d->out = error_of(words);
	}
}

// the runner's kind, for words: the last step of its address
static void kind_of(const op_value *runner, char *out, size_t cap) {
	const char *s = "";
	if (is_str(runner)) s = strrchr(runner->str, '/') ? strrchr(runner->str, '/') + 1 : runner->str;
	else if (runner && runner->type == OP_LIST && runner->count && is_str(runner->items[runner->count - 1]))
		s = runner->items[runner->count - 1]->str;
	snprintf(out, cap, "%s", s);
}

// whether a session's signature over the ask is good, its install in keys
static int signed_by(const op_value *keys, const char *from, const op_value *a, const op_value *session,
	const op_value *vouch, const op_value *sig) {
	size_t n = 0;
	uint8_t *m = encoded(a, &n);
	trust_claim claim = {.session = session->str, .install = from};
	int ok = m != NULL && vouch->bytes == 64 && sig->bytes == 64;
	if (ok) {
		memcpy(claim.vouch, vouch->data, 64);
		ok = trust_check(keys, &claim, m, n, sig->data, &(sess_verifying){.verify = verify});
	}
	free(m);
	return ok;
}

// a pair ask waiting for a person's yes (tab) or no (esc): its id, who, the name it gave
#define WANTING 4
static struct {
	char ask[80], from[80], name[40];
} wanting[WANTING];
static size_t nwanting;

// an answer beside its ask in this den's inbox
static void answer_with(const char *ask, op_value *out) {
	const char *path[2] = {ask, "answer"};
	patch("value", me.inbox, path, 2, out);
	host_pulse_soon();
}

// a den in this den's keys ({ name }), or out of them (name NULL): as host.ts' keep and drop
static void keep(const char *install, const char *name) {
	if (name) {
		put1("value", me.keys_node, install, map1("name", op_str(name)));
		return;
	}
	op_value *now = op_map();
	for (size_t k = 0; is_map(me.keys) && k < me.keys->count; k++)
		if (me.keys->items[k] && strcmp(me.keys->keys[k], install) != 0)
			op_set(now, me.keys->keys[k], op_ref(me.keys->items[k]));
	put("value", me.keys_node, now);
}

// one ask in the inbox (host.ts' answering): for here; a pair from whom it says, else put to a
// person; the rest from a den in this den's keys, signed by its session, then done; the answer
// beside it
static void answering(const char *ask, const op_value *e) {
	const op_value *a = op_get(e, "ask"), *c = op_get(e, "claim"), *sig = op_get(e, "sig");
	if (!is_map(a)) a = NULL;
	if (!is_map(c)) c = NULL;
	const op_value *from_v = a ? op_get(a, "from") : NULL;
	char from[80];
	snprintf(from, sizeof from, "%s", is_str(from_v) ? from_v->str : "undefined");
	char who[64], shown[16];
	name_of(from, who, sizeof who);
	short_name(from, shown, sizeof shown);
	const op_value *session = c ? op_get(c, "session") : NULL, *vouch = c ? op_get(c, "vouch") : NULL;
	const op_value *op = a ? op_get(a, "op") : NULL;
	const char *why = NULL;
	op_value *out = NULL;
	char kind[24] = "";
	snprintf(me.last, sizeof me.last, "%s", from);
	snprintf(me.last_name, sizeof me.last_name, "%s", shown);
	if (a == NULL || !str_is(op_get(a, "to"), me.node) || c == NULL || !str_is(op_get(c, "install"), from) ||
		!is_str(session) || vouch == NULL || vouch->type != OP_BYTES || sig == NULL || sig->type != OP_BYTES)
		why = "not-for-here";
	else if (str_is(op, "pair")) {
		// anyone may ask: checked only to be from whom it says
		op_value *only = map1(from, op_map());
		int ok = signed_by(only, from, a, session, vouch, sig);
		op_free(only);
		if (!ok) why = "bad-signature";
		else if (trusts(from)) out = map1("pair", op_str("yes"));
		else {
			// put to a person: tab yes, esc no
			const op_value *nm = op_get(a, "name");
			if (nwanting == WANTING) {
				nwanting--;
				memmove(&wanting[0], &wanting[1], nwanting * sizeof wanting[0]);
			}
			snprintf(wanting[nwanting].ask, sizeof wanting[0].ask, "%s", ask);
			snprintf(wanting[nwanting].from, sizeof wanting[0].from, "%s", from);
			snprintf(wanting[nwanting].name, sizeof wanting[0].name, "%s", is_str(nm) ? nm->str : who);
			nwanting++;
			char one[64], name[16];
			size_t k = 0;
			for (const char *x = is_str(nm) ? nm->str : shown; *x && k < 12; x++)
				if ((unsigned char)*x < 0x80) name[k++] = *x;
			name[k] = 0;
			snprintf(one, sizeof one, "%s wants to pair", name);
			me.until = 0;
			say(0, one, "tab: yes   esc: no");
			me.until = me.now + 60000;
			frame_again();
			return;
		}
	} else if (!trusts(from)) why = "not-in-keys";
	else if (!signed_by(me.keys, from, a, session, vouch, sig)) why = "bad-signature";
	if (why) out = refusal(who, why);
	else if (out == NULL && str_is(op, "unpair")) {
		keep(from, NULL);
		out = op_map();
	} else if (out == NULL) {
		doing x = {a, from, NULL};
		sc_run_with_scope(me.w.host, do_now, &x);
		out = x.out;
		size_t n;
		uint8_t *b = encoded(out, &n);
		if (b == NULL) op_free(out), out = error_of("its answer has no encoding");
		free(b);
		kind_of(op_get(a, "runner"), kind, sizeof kind);
	}
	op_value *said = op_ref(out);
	answer_with(ask, out);
	// told, in words
	char one[64], two[64];
	const op_value *refused = op_get(said, "refused"), *error = op_get(said, "error");
	if (why && strcmp(why, "not-in-keys") == 0) {
		snprintf(one, sizeof one, "no to %s: not paired", shown);
		say(1, one, "pair with it first");
	} else if (why && strcmp(why, "bad-signature") == 0) {
		snprintf(one, sizeof one, "no to %s: bad signature", shown);
		say(1, one, "its ask isn't signed right");
	} else if (why) {
		say(1, "an ask not made out to here", "so it was not done");
	} else if (str_is(op, "pair")) {
		snprintf(one, sizeof one, "%s asked to pair:", shown);
		say(0, one, "paired already, so yes");
	} else if (str_is(op, "unpair")) {
		snprintf(one, sizeof one, "%s unpaired:", shown);
		say(0, one, "its asks are locked again");
	} else if (is_str(error)) {
		snprintf(one, sizeof one, "%s's ask failed:", shown);
		say(1, one, error->str);
	} else if (is_str(refused)) {
		snprintf(one, sizeof one, "%s's ask: no,", shown);
		say(1, one, refused->str);
	} else if (str_is(op, "start")) {
		snprintf(one, sizeof one, "%s started", shown);
		snprintf(two, sizeof two, "a %s here", kind[0] ? kind : "thing");
		say(0, one, two);
	} else {
		snprintf(one, sizeof one, "%s stopped", shown);
		say(0, one, "a thing here");
	}
	op_free(said);
	me.asks++;
	frame_again();
}

int den_pair_waiting(void) { return nwanting > 0; }

unsigned den_asks(void) { return me.asks; }

uint64_t den_steps(void) {
	uint64_t n = 0;
	for (size_t i = 0; me.log && i < tp_log_devices(me.log); i++) {
		uint64_t have;
		n += tp_log_count(me.log, tp_log_have(me.log, i, &have));
	}
	return n;
}

// the oldest pair ask waiting: yes (the asker in this den's keys) or no, as its answer
void den_pair_answer(int yes) {
	if (nwanting == 0) {
		say(0, "nobody wants to pair", "an ask to pair shows here");
		frame_again();
		return;
	}
	char ask[80], from[80], name[40], one[64], shown[16];
	memcpy(ask, wanting[0].ask, sizeof ask), memcpy(from, wanting[0].from, sizeof from);
	memcpy(name, wanting[0].name, sizeof name);
	nwanting--;
	memmove(&wanting[0], &wanting[1], nwanting * sizeof wanting[0]);
	if (yes) keep(from, name);
	answer_with(ask, map1("pair", op_str(yes ? "yes" : "no")));
	host_settle();
	size_t k = 0;
	for (const char *x = name; *x && k < 12; x++)
		if ((unsigned char)*x < 0x80) shown[k++] = *x;
	shown[k] = 0;
	snprintf(one, sizeof one, yes ? "paired with %s:" : "not paired with %s", shown);
	say(0, one, yes ? "its asks are done now" : "you said no");
	me.asks++;
	frame_again();
}

typedef struct {
	char *ask;
	op_value *e;
} waiting;
static void answer_job(void *data) {
	waiting *w = data;
	answering(w->ask, w->e);
	op_free(w->e);
	free(w->ask), free(w);
}

static sc_out inbox_f(void *previous, void *data) {
	(void)previous, (void)data;
	const op_value *v = pl_read(me.w.places, tb_string("value"), tb_string(me.inbox), NULL, 0);
	return (sc_out){.kind = SC_VALUE, .value = v ? op_ref((op_value *)v) : op_null()};
}

static char *inbox_act(void *value, void *previous, void *data) {
	(void)previous, (void)data;
	const op_value *v = value;
	for (size_t i = 0; is_map(v) && i < v->count; i++) {
		const op_value *e = v->items[i];
		if (!is_map(e) || op_get(e, "answer") != NULL) continue;
		int seen = 0;
		for (size_t k = 0; k < me.nanswered && !seen; k++) seen = strcmp(me.answered[k], v->keys[i]) == 0;
		if (seen) continue;
		me.answered = realloc(me.answered, (me.nanswered + 1) * sizeof *me.answered);
		if (me.answered == NULL) abort();
		me.answered[me.nanswered++] = xstrdup(v->keys[i]);
		// answered after the pulse (its write lands on the node this reads)
		waiting *w = xalloc(sizeof *w);
		w->ask = xstrdup(v->keys[i]), w->e = op_ref((op_value *)e);
		me.w.schedule(NULL, answer_job, w);
	}
	return NULL;
}

static void effects(void *data) {
	(void)data;
	sc_create_effect(me.w.s, (sc_def){.f = nodes_f, .effect = publish, .equal = same_hash}, NULL, 0);
	sc_create_effect(me.w.s, (sc_def){.f = want_f, .effect = place}, NULL, 0);
	sc_create_effect(me.w.s, (sc_def){.f = inbox_f, .effect = inbox_act}, NULL, 0);
}

// ---- boot ----

static int promote(void);

int den_boot(const inst_install *install, const char *code, const char *dir, int64_t now) {
	me.now = me.beat = now;
	me.install = *install;
	snprintf(me.room, sizeof me.room, "%s", code);
	hex(me.id, install->key, 32);
	me.node = xstrdup(install->id);
	me.dir = xstrdup(dir);
	me.things = joined(me.node, "/things");
	me.inbox = joined(me.node, "/inbox");
	me.keys_node = joined(me.node, "/authorized_keys");
	me.keys = op_map();
	me.w = host_get();
	snprintf(me.net, sizeof me.net, "offline");

	// tippet: the log (the den's key), its history (what is kept), its sync
	tp_store *store = tp_file_store(&(tp_mem){counted, &part_now[0]}, dir, 1 << 20);
	me.kept_on_flash = store != NULL;
	if (store == NULL) store = tp_memory_store(&(tp_mem){counted, &part_now[0]}, 1 << 20);
	me.store = store;
	me.log = tp_log_new(&(tp_log_options){.mem = mem_of(1), .store = store, .seed = install->secret, .strict = 1,
		.told = told});
	int why = me.log ? tp_log_load(me.log) : TP_NOMEM;
	if (why) {
		fprintf(stderr, "den: the log didn't load: %s\n", tp_why(why));
		return 1;
	}
	// a snapshot written last time but not yet in place (a reset between), put in place first
	if (me.kept_on_flash) promote();
	me.history = tp_history_new(&(tp_history_options){.mem = mem_of(2), .log = me.log, .table = me.w.table,
		.places = me.w.places, .kept = kept, .run = hosted});
	if (me.history == NULL) return 1;
	den_mark("log loaded");
	{
		struct stat st;
		char *snap = joined(me.dir, "/snapshot"), *log = joined(me.dir, "/log");
		long sn = stat(snap, &st) == 0 ? (long)st.st_size : -1, ln = stat(log, &st) == 0 ? (long)st.st_size : -1;
		printf("den: the log %ld bytes, its snapshot %ld\n", ln, sn);
		free(snap), free(log);
	}
	if ((why = tp_history_load(me.history))) fprintf(stderr, "den: the history didn't load: %s\n", tp_why(why));
	den_mark("history loaded");
	// live ids remembered: 128, not 1024 (8 KB): one link, few dens beating
	me.sync = tp_sync_new(&(tp_sync_options){.mem = mem_of(3), .log = me.log, .heard = heard, .random = random_bytes,
		.seen = 128});
	if (me.sync == NULL) return 1;
	printf("den: log in %s%s, %llu steps of its own\n", dir, me.kept_on_flash ? "" : " (not kept: memory only)",
		(unsigned long long)tp_log_count(me.log, install->key));
	// the other dens: each device the log has steps of
	for (size_t i = 0; i < tp_log_devices(me.log); i++) {
		uint64_t have;
		learn(tp_log_have(me.log, i, &have));
	}
	// this den's keys as only its own steps make them
	for (uint64_t n = 1; n <= tp_log_count(me.log, install->key); n++) keys_from(n);
	me.synced = den_steps();

	// the programs, at /things/<kind>: a few words of what it is, its form the runner's takes
	me.functions = hf_new();
	things_add(me.functions);
	put1("children", HOST_ROOT, "things", op_str("things"));
	for (int i = 0; i < 3; i++) {
		char at[32], type[32];
		snprintf(at, sizeof at, "things/%s", KINDS[i]);
		snprintf(type, sizeof type, "thing.%s", KINDS[i]);
		put1("children", "things", KINDS[i], op_str(at));
		put("value", at, op_str(PROGRAMS[i]));
		put("attributes", at, attrs1("ermine.type", op_str(type)));
	}
	sc_run_with_scope(me.w.host, make_den, NULL);
	if (me.code) return me.code;
	den_mark("den made");
	// its shared nodes, under it; it trusts itself from the start
	const char *names[3] = {"things", "inbox", "authorized_keys"};
	const char *ids[3] = {me.things, me.inbox, me.keys_node};
	for (int i = 0; i < 3; i++) put1("children", me.node, names[i], op_str(ids[i]));
	if (tb_get(me.w.table, tb_string("value"), tb_string(me.inbox)) == NULL) put("value", me.inbox, op_map());
	if (!trusts(me.node)) put1("value", me.keys_node, me.node, map1("name", op_str("chee's cardputer")));
	sc_run_with_scope(me.w.host, effects, NULL);
	sc_run_with_scope(me.w.host, start_things, NULL);
	host_settle();
	den_mark("things started");
	// the history as it is now, kept: the next boot loads it whole (each node's value once) and lands
	// only the steps after it, where landing every step of the log, a node of each thing of each
	// boot among them, would hold a few KB a boot
	if (me.kept_on_flash && den_snapshot() == 0) den_mark("snapshot kept");
	beat();
	return 0;
}

// ---- each loop ----

void den_net(const char *state) {
	if (strcmp(me.net, state) == 0) return;
	snprintf(me.net, sizeof me.net, "%s", state);
	printf("den: %s\n", state);
}

// the band's lines, and whether they are hot (cherry); how many
static int band(char lines[2][31], int *hot) {
	memset(lines, 0, 2 * 31);
	*hot = 0;
	if (me.now < me.until) {
		snprintf(lines[0], 31, "%s", me.said[0]);
		snprintf(lines[1], 31, "%s", me.said[1]);
		*hot = me.hot;
		return lines[1][0] ? 2 : 1;
	}
	// who's here: those heard, as their attributes name them; those here first, then the quiet
	char line[128] = "";
	int any = 0;
	for (int quiet = 0; quiet < 2; quiet++) {
		for (size_t i = 0; i < me.nothers; i++) {
			const other *o = &me.others[i];
			if (o->heard < 0 || (o->heard > 0 && me.now - o->heard < DEN_QUIET) == quiet) continue;
			char n[80], name[16];
			install_of(o->who, n);
			if (tb_get(me.w.table, tb_string("attributes"), tb_string(n)) == NULL) continue;
			short_name(n, name, sizeof name);
			size_t l = strlen(line);
			snprintf(line + l, sizeof line - l, "%s%s %s%s", any ? ", " : "", name, quiet ? "quiet" : "here",
				trusts(n) ? " paired" : "");
			any = 1;
		}
	}
	if (!any) snprintf(line, sizeof line, "%s: nobody else", me.net);
	snprintf(lines[0], 31, "%s", line);
	if (strlen(line) > 30) snprintf(lines[1], 31, "%s", line + 30);
	return lines[1][0] ? 2 : 1;
}

void den_band(void) {
	char lines[2][31];
	int hot, n = band(lines, &hot);
	int top = FB_H - 10 * n - 1;
	fb_rect(0, top, FB_W, FB_H - top, hot ? FB_CHERRY : FB_INK);
	for (int i = 0; i < n; i++) fb_text(2, top + 1 + 10 * i, lines[i], FB_WHITE, 1);
	memcpy(me.shown, lines, sizeof me.shown);
	me.shown_hot = hot;
}

// tippet's troubles, in words: a step that wouldn't apply, a write not kept
static void troubles(void) {
	tp_failed f;
	size_t n = tp_history_failed(me.history, 0, &f);
	for (size_t i = me.failed; i < n; i++) {
		tp_history_failed(me.history, i, &f);
		char d[65] = "?";
		if (f.device) hex(d, f.device, 32);
		printf("den: a step from %.6s to %s wouldn't apply: %s\n", d, f.node, f.why);
		char one[64];
		snprintf(one, sizeof one, "a step from %.6s", d);
		say(1, one, "wouldn't apply");
	}
	me.failed = n;
	n = tp_history_unkept(me.history, 0, &f);
	for (size_t i = me.unkept; i < n; i++) {
		tp_history_unkept(me.history, i, &f);
		printf("den: a write to %s wasn't kept, so it stays here: %s\n", f.node, f.why);
		say(1, "a write wasn't kept:", f.why);
	}
	me.unkept = n;
}

void den_tick(int64_t now) {
	me.now = now;
	if (me.software == NULL) return;
	if (now - me.beat >= DEN_BEAT) {
		me.beat = now;
		beat();
	}
	host_settle();
	troubles();
	// a snapshot again once 16 steps have come since the last and none for 5 s, with the heap to
	// write it: a boot loads it, each node's value once, and lands only what came after it
	uint64_t held = den_steps();
	if (held != me.last_held || me.still_since == 0) me.last_held = held, me.still_since = now;
	if (me.kept_on_flash && held >= me.snapped + 16 && now - me.still_since > 5000 && den_free() > 50000) {
		den_mark("snapshot again");
		den_snapshot();
		den_mark("snapshot kept");
	}
	// what the log took since the last sync (its own steps, and others'), on flash within a second
	uint64_t steps = den_steps();
	if (steps != me.synced && me.sync_at == 0) me.sync_at = now + 1000;
	if (me.sync_at && now >= me.sync_at && me.store->sync) {
		me.sync_at = 0, me.synced = steps;
		if (me.store->sync(me.store->self)) fprintf(stderr, "den: the log wasn't synced to flash\n");
	}
	// the band drawn again when what it says changes (a den gone quiet, a word timed out)
	char lines[2][31];
	int hot;
	band(lines, &hot);
	if (memcmp(lines, me.shown, sizeof lines) != 0 || hot != me.shown_hot) frame_again();
}

typedef struct {
	const char *kind, *at;
	int ok;
} starting;
static void start_now(void *data) {
	starting *x = data;
	const char *runner[4] = {"system", "den", "runners", x->kind}, *prog[2] = {"things", x->kind};
	const char *at[2] = {"home", x->at};
	sw_program program = {.at = prog, .nat = 2, .has_at = 1};
	sw_refusal no;
	x->ok = sw_run(me.software, runner, 4, &program, at, 2, &(sw_options){0}, &no) != NULL;
}
int den_start(const char *kind, const char *at) {
	starting x = {kind, at, 0};
	sc_run_with_scope(me.w.host, start_now, &x);
	host_settle();
	return x.ok;
}

// a snapshot the store wrote beside the last (snapshot.new: FAT's rename won't replace a file)
// put in its place, once it reads back as one whole canonical CBOR item; else let go. 0: there is a
// snapshot now
static int promote(void) {
	char *now = joined(me.dir, "/snapshot"), *made = joined(me.dir, "/snapshot.new");
	FILE *f = fopen(made, "rb");
	int ok = 0;
	if (f != NULL) {
		fseek(f, 0, SEEK_END);
		long n = ftell(f);
		fseek(f, 0, SEEK_SET);
		uint8_t *b = n > 0 ? malloc((size_t)n) : NULL;
		ok = b != NULL && fread(b, 1, (size_t)n, f) == (size_t)n && cborCheck(b, (size_t)n, NULL, NULL);
		free(b);
		fclose(f);
		if (ok) {
			unlink(now);
			ok = rename(made, now) == 0;
		} else unlink(made);
	}
	FILE *there = fopen(now, "rb");
	int has = there != NULL;
	if (there) fclose(there);
	free(now), free(made);
	return has ? 0 : 1;
}

int den_snapshot(void) {
	int why = tp_history_snapshot(me.history);
	// on FAT: written as snapshot.new, its rename refused (TP_STORE); put in place here
	if (why == TP_STORE && promote() == 0) why = 0;
	printf("den: snapshot at %llu steps: %s\n", (unsigned long long)den_steps(), why ? tp_why(why) : "kept");
	if (why) fprintf(stderr, "den: no snapshot: %s\n", tp_why(why));
	else me.snapped = den_steps();
	return why;
}

void den_trust_last(void) { den_pair_answer(1); }

void den_print(void) {
	for (int i = 0; i < 3; i++) {
		const char *path[2] = {"home", KINDS[i]};
		tb_key id;
		const op_value *v = NULL;
		if (pl_get(me.w.places, path, 2, &id)) {
			op_key k = {.type = OP_STR_KEY, .s = THING_OUT};
			v = pl_read(me.w.places, tb_string("attributes"), id, &k, 1);
		}
		char *j = v ? op_json_text(v) : NULL;
		printf("/home/%s: %.80s\n", KINDS[i], j ? j : "-");
		free(j);
	}
	for (size_t i = 0; i < me.nothers; i++) {
		const other *o = &me.others[i];
		char n[80], name[64];
		install_of(o->who, n);
		name_of(n, name, sizeof name);
		uint8_t key[32];
		for (int k = 0; k < 32; k++) sscanf(o->who + 2 * k, "%2hhx", &key[k]);
		printf("den %.8s (%s): %s, %llu steps, %s\n", o->who, name,
			o->heard < 0 ? "never heard" : o->heard > 0 && me.now - o->heard < DEN_QUIET ? "here" : "quiet",
			(unsigned long long)tp_log_count(me.log, key), trusts(n) ? "trusted" : "not trusted");
	}
	printf("tippet heap by part, now (most):");
	for (int i = 0; i < 4; i++) printf(" %s %zu (%zu)", PARTS[i], part_now[i], part_most[i]);
	printf("\n");
	size_t most, now = den_heap(&most);
	printf("den %.8s in room %s (%s): %llu steps of its own, %zu devices, tippet heap %zu (most %zu)\n", me.id,
		me.room, me.net, (unsigned long long)tp_log_count(me.log, me.install.key), tp_log_devices(me.log), now,
		most);
}
