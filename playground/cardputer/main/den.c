// the cardputer's den on tippet (den.h): host.ts in C, on the host's world (host.h)
#include "den.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include "core/ed25519/c/ed25519.h"
#include "core/op/c/apply.h"
#include "core/op/c/json.h"
#include "ermine/encoding/c/cbor.h"
#include "ermine/processes/c/processes.h"
#include "ermine/encoding/c/blake3/blake3.h"
#include "experiments/tippet/c/history.h"
#include "experiments/tippet/c/store.h"
#include "fb.h"
#include "host.h"
#include "playground/encoding/c/pack.h"
#include "playground/trust/c/trust.h"
#include "things.h"
#include "menu.h"

// the kinds offered here: keys, screen and pigs run at boot (/home/<kind>), the speaker too (at
// /system/speaker, on the den's card), the parts (parts.h) only when a paired den adds one (each
// running costs about 10 KB of heap)
#define BOOTS 3
#define OFFERED 11
static const char *const KINDS[OFFERED] = {"keys", "screen", "pigs", "speaker", "tilt", "loudness", "led", "ir",
	"battery", "sd", "grove"};
static const char *const PROGRAMS[OFFERED] = {
	"keys: gives what was typed",
	"a screen: shows what it reads, big",
	"pigs: gives each pig's weight",
	"a speaker: plays each change of what is wired into it",
	"tilt: gives x and y, -10 to 10, as the cardputer leans",
	"loudness: gives how loud it is here, 0 to 10",
	"an LED: shows the colour wired into it",
	"IR: sends the NEC code wired into it",
	"battery: gives how full it is, a percentage",
	"microSD: gives the card's top folder",
	"Grove: gives the I2C addresses that answer on Port A",
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
	// why the den isn't up, in words ("": it is); again: a boot again would mend it
	char why[112];
	int again;
	// the room holds more of this den's steps than its log: lost on flash (0: none)
	uint64_t lost;
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
// a map, written as only the keys that are another (one patch each), or whole when it is new or
// a key went; v taken
static void put_keys(const char *part, const char *id, op_value *v) {
	const nd_entry *e = tb_get(me.w.table, tb_string(part), tb_string(id));
	const op_value *was = e ? e->value : NULL;
	int whole = !is_map(was) || !is_map(v);
	for (size_t k = 0; !whole && k < was->count; k++)
		if (was->items[k] && op_get(v, was->keys[k]) == NULL) whole = 1;
	if (whole) {
		put(part, id, v);
		return;
	}
	for (size_t k = 0; k < v->count; k++) {
		const op_value *old = op_get(was, v->keys[k]);
		if (v->items[k] == NULL || (old != NULL && same(old, v->items[k]))) continue;
		put1(part, id, v->keys[k], op_ref(v->items[k]));
	}
	op_free(v);
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

void den_say(int hot, const char *one, const char *two);
static void say(int hot, const char *one, const char *two) { den_say(hot, one, two); }
void den_say(int hot, const char *one, const char *two) {
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
void den_short_name(const char *install, char *out, size_t cap);
static void short_name(const char *install, char *out, size_t cap) { den_short_name(install, out, cap); }
void den_short_name(const char *install, char *out, size_t cap) {
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

static void step_said(uint64_t n);
// the send path's times on the log (trace: lines), when 1 (ctrl-t on the serial line)
int getenv_trace = 0;
// the store's calls, timed (ms) and counted: tippet's file store on FAT
typedef struct {
	int64_t sync, append, read;
	int nsync, nappend, nread, tailed;
} store_times;
static store_times times;
static void told(void *ctx, const uint8_t device[32], uint64_t from, size_t count) {
	(void)ctx;
	int own = memcmp(device, me.install.key, 32) == 0;
	int64_t t0 = den_clock();
	store_times was = times;
	if (me.history) tp_history_told(me.history, device, from, count);
	int64_t t1 = den_clock();
	if (me.sync) tp_sync_told(me.sync, device, from, count);
	if (own && getenv_trace) printf("trace: pushed at %lld\n", (long long)den_clock());
	if (own && getenv_trace) {
		// the push: tippet's sync of the store, the run closed (its steps read back, signed, packed,
		// appended), its message read back and handed to the link. the store's parts timed here; the
		// rest (sign, pack, the encodings) is tippet's own
		int64_t t2 = den_clock();
		printf("trace: step %llu written at %lld; pushed in %lld ms: sync %lld (%d), append %lld (%d), read %lld (%d), "
		       "from memory %d, the rest (sign, pack) %lld\n",
			(unsigned long long)from, (long long)t0, (long long)(t2 - t1), (long long)(times.sync - was.sync),
			times.nsync - was.nsync, (long long)(times.append - was.append), times.nappend - was.nappend,
			(long long)(times.read - was.read), times.nread - was.nread, times.tailed - was.tailed,
			(long long)((t2 - t1) - (times.sync - was.sync) - (times.append - was.append) - (times.read - was.read)));
	}
	// each step of this den's, as written: its node, part and patches, and how its bytes go
	if (own && getenv_trace) step_said(from);
	if (own) {
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
	for (int i = 0; i < OFFERED; i++) {
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
	// the speaker, on the den's card: where every den has its own (main.ts' SPEAKER)
	{
		const char *runner[4] = {"system", "den", "runners", "speaker"}, *prog[2] = {"things", "speaker"};
		const char *at[2] = {"system", "speaker"};
		sw_program program = {.at = prog, .nat = 2, .has_at = 1};
		if (sw_run(me.software, runner, 4, &program, at, 2, &(sw_options){0}, &no) == NULL)
			fprintf(stderr, "den: /system/speaker refused: %s\n", no.refused);
	}
	for (int i = 0; i < BOOTS; i++) {
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

// each running thing's attributes, and thing.at, on <den>/things<its path> (the same node each
// boot, and short: /things/home/keys); those gone, out
static void publish_now(void *data) {
	(void)data;
	sw_process *const *procs;
	size_t count = sw_running(me.software, &procs);
	op_value *want = op_map();
	for (size_t i = 0; i < count; i++) {
		const char *id = sw_process_id(procs[i]);
		const char *const *at;
		size_t nat = sw_process_at(procs[i], &at);
		char path[160] = "";
		for (size_t k = 0; k < nat; k++) {
			size_t l = strlen(path);
			snprintf(path + l, sizeof path - l, "/%s", at[k]);
		}
		char *shared = xalloc(strlen(me.things) + strlen(path) + 1);
		sprintf(shared, "%s%s", me.things, path);
		op_set(want, id, op_str(shared));
		const nd_entry *e = tb_get(me.w.table, tb_string("attributes"), tb_string(id));
		const op_value *a = e ? e->value : NULL;
		op_value *attrs = op_map();
		for (size_t k = 0; is_map(a) && k < a->count; k++)
			if (a->items[k] && has_encoding(a->items[k])) op_set(attrs, a->keys[k], op_ref(a->items[k]));
		op_set(attrs, AT, op_str(path));
		put_keys("attributes", shared, attrs);
		free(shared);
	}
	const nd_entry *e = tb_get(me.w.table, tb_string("children"), tb_string(me.things));
	op_value *was = e && e->value ? op_ref(e->value) : NULL, *wanted = op_ref(want);
	put("children", me.things, want);
	// a shared node gone: none of the running things' (a thing started again at the same path has
	// another process id, the same node)
	for (size_t k = 0; is_map(was) && k < was->count; k++) {
		const op_value *shared = was->items[k];
		if (!is_str(shared)) continue;
		int kept = 0;
		for (size_t j = 0; !kept && j < wanted->count; j++)
			kept = is_str(wanted->items[j]) && strcmp(wanted->items[j]->str, shared->str) == 0;
		if (kept) continue;
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
	if (str_is(op, "start") && den_free() < DEN_ROOM) {
		d->out = error_of("too little memory here to start a thing");
	} else if (str_is(op, "start")) {
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
	} else if (str_is(op, "menu") && is_str(op_get(a, "name"))) {
		// a menu item (menu.h): its handler an ask of these, done when it's picked; none: out
		const op_value *h = op_get(a, "handler");
		const op_value *hop = is_map(h) ? op_get(h, "op") : NULL;
		if (h != NULL && h->type != OP_NULL && !(str_is(hop, "start") || str_is(hop, "stop")))
			d->out = error_of("a menu item's handler: a start or a stop ask");
		else d->out = menu_ask(d->from, op_get(a, "name")->str, h && h->type != OP_NULL ? h : NULL);
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

static char **menued;
static size_t nmenued;
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
	if (str_is(op, "menu")) {
		menued = realloc(menued, (nmenued + 1) * sizeof *menued);
		if (menued == NULL) abort();
		menued[nmenued++] = xstrdup(ask);
	}
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
	} else if (str_is(op, "menu")) {
		const op_value *h = op_get(a, "handler");
		snprintf(one, sizeof one, h && h->type != OP_NULL ? "%s put in the menu:" : "%s took out of the menu:",
			shown);
		snprintf(two, sizeof two, "\"%.24s\" (G0)", op_get(a, "name")->str);
		say(0, one, two);
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

static void menu_job(void *data) {
	waiting *w = data;
	const op_value *a = op_get(w->e, "ask"), *h = op_get(a, "handler");
	op_value *r = menu_ask(op_get(a, "from")->str, op_get(a, "name")->str, is_map(h) ? h : NULL);
	if (op_get(r, "refused") || op_get(r, "error")) printf("den: a menu item not put in again: %s\n", op_get(a, "name")->str);
	op_free(r);
	op_free(w->e);
	free(w->ask), free(w);
}

// the menu items paired dens put in before this boot (their asks answered {}), in again: checked as
// when they came (made out to here, from a den in keys, signed by its session)
static void menu_again(const char *ask, const op_value *e) {
	const op_value *a = op_get(e, "ask"), *c = op_get(e, "claim"), *sig = op_get(e, "sig"), *ans = op_get(e, "answer");
	if (!is_map(a) || !str_is(op_get(a, "op"), "menu") || !is_map(ans) || ans->count != 0 || !is_map(c)) return;
	for (size_t k = 0; k < nmenued; k++)
		if (strcmp(menued[k], ask) == 0) return;
	menued = realloc(menued, (nmenued + 1) * sizeof *menued);
	if (menued == NULL) abort();
	menued[nmenued++] = xstrdup(ask);
	const op_value *from = op_get(a, "from"), *session = op_get(c, "session"), *vouch = op_get(c, "vouch");
	const op_value *name = op_get(a, "name");
	if (!is_str(from) || !is_str(name) || !str_is(op_get(a, "to"), me.node) || !str_is(op_get(c, "install"), from->str) ||
		!is_str(session) || vouch == NULL || vouch->type != OP_BYTES || sig == NULL || sig->type != OP_BYTES ||
		!trusts(from->str) || !signed_by(me.keys, from->str, a, session, vouch, sig))
		return;
	// put in after the pulse, as an answer is (its write lands in the folder)
	waiting *w = xalloc(sizeof *w);
	w->ask = xstrdup(ask), w->e = op_ref((op_value *)e);
	me.w.schedule(NULL, menu_job, w);
}

// an ask id's clock and count ("<8 hex>-<ms, base 36>-<count>"), for the order asks were made in
static const op_value *sorting;
static void made_of(const char *id, uint64_t *ms, uint64_t *count) {
	const char *a = strchr(id, '-'), *b = a ? strchr(a + 1, '-') : NULL;
	*ms = a ? strtoull(a + 1, NULL, 36) : 0;
	*count = b ? strtoull(b + 1, NULL, 10) : 0;
}
static int by_made(const void *x, const void *y) {
	uint64_t ma, ca, mb, cb;
	made_of(sorting->keys[*(const size_t *)x], &ma, &ca);
	made_of(sorting->keys[*(const size_t *)y], &mb, &cb);
	return ma != mb ? (ma < mb ? -1 : 1) : ca != cb ? (ca < cb ? -1 : 1) : 0;
}

static char *inbox_act(void *value, void *previous, void *data) {
	(void)previous, (void)data;
	const op_value *v = value;
	// the menu asks answered before, in the order they were made (an item put in, then out)
	size_t *order = xalloc((is_map(v) ? v->count : 0) * sizeof *order), n = 0;
	for (size_t i = 0; is_map(v) && i < v->count; i++)
		if (is_map(v->items[i]) && op_get(v->items[i], "answer") != NULL &&
			str_is(op_get(op_get(v->items[i], "ask"), "op"), "menu"))
			order[n++] = i;
	sorting = v;
	qsort(order, n, sizeof *order, by_made);
	for (size_t k = 0; k < n; k++) menu_again(v->keys[order[k]], v->items[order[k]]);
	free(order);
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

const char *den_why(void) { return me.why; }
int den_again(void) { return me.again; }

// what the server says it has (tippet's have): more of this den's own steps than its log holds
// means the log lost some (a reset, a mended tail) that went out: steps written from here on fork
// the chain, and the room refuses them. said on the screen, in words, from then on
void den_heard(const uint8_t *message, size_t length) {
	// ["refused", device, n]: the server refused this den's runs (its chain there goes another way)
	if (length > 10 && message[0] == 0x83 && memcmp(message + 1, "\x67refused", 8) == 0 && me.log) {
		op_value *m = pk_get(message, length, NULL, NULL);
		if (m && m->type == OP_LIST && m->count == 3 && m->items[1]->type == OP_BYTES && m->items[1]->bytes == 32 &&
			memcmp(m->items[1]->data, me.install.key, 32) == 0 && !me.lost) {
			me.lost = (uint64_t)m->items[2]->num;
			if (me.lost == 0) me.lost = 1;
			printf("den: the room refused this den's steps (it has %llu, the log here %llu): its chain there "
			       "goes another way\n",
				(unsigned long long)m->items[2]->num, (unsigned long long)tp_log_count(me.log, me.install.key));
		}
		if (m) op_free(m);
		return;
	}
	if (length < 6 || message[0] != 0x82 || memcmp(message + 1, "\x64have", 5) != 0 || me.log == NULL) return;
	op_value *m = pk_get(message, length, NULL, NULL);
	const op_value *list = m && m->type == OP_LIST && m->count == 2 ? m->items[1] : NULL;
	for (size_t i = 0; list && list->type == OP_LIST && i < list->count; i++) {
		const op_value *e = list->items[i];
		if (e->type != OP_LIST || e->count != 2 || e->items[0]->type != OP_BYTES || e->items[0]->bytes != 32) continue;
		if (memcmp(e->items[0]->data, me.install.key, 32) != 0) continue;
		uint64_t theirs = (uint64_t)e->items[1]->num, mine = tp_log_count(me.log, me.install.key);
		if (theirs > mine && me.lost != theirs) {
			me.lost = theirs;
			printf("den: the room has %llu of this den's steps, its log %llu: the rest lost on flash\n",
				(unsigned long long)theirs, (unsigned long long)mine);
		}
	}
	if (m) op_free(m);
}

// a frame of the log at at: 4 bytes of length, then one whole canonical CBOR item (a step, a run,
// a signature, a drop). its length, or 0 when it isn't one
static long frame_at(int fd, long at, long size, uint8_t **buf, size_t *room) {
	uint8_t head[4];
	if (at + 4 > size || pread(fd, head, 4, at) != 4) return 0;
	long length = (long)head[0] << 24 | (long)head[1] << 16 | (long)head[2] << 8 | head[3];
	if (length <= 0 || length > (1 << 20) || length > size - at - 4) return 0;
	if ((size_t)length > *room) {
		uint8_t *more = realloc(*buf, (size_t)length);
		if (more == NULL) return 0;
		*buf = more, *room = (size_t)length;
	}
	if (pread(fd, *buf, (size_t)length, at + 4) != length) return 0;
	return cborCheck(*buf, (size_t)length, NULL, NULL) ? length : 0;
}

// the store's files, checked before tippet loads them, so a reset at any moment leaves one that
// loads, losing at most what it hadn't synced:
// - the key file: the install's secret, 32 bytes: written again whole when it isn't
// - log.new left by a reset in the middle of what's below: the log put back from it, or let go
// - the log's frames: a frame a reset cut short (or a tail never written) is passed over, and the
//   frames after it kept: on FAT a load's cut (store_file's ftruncate, never synced) can come undone
//   at a reset, and the frames a later boot appended land after the torn one. the whole frames,
//   back to back, written to log.new, synced, then put in place of the log
// what it finds, and any errno, said
static void check_store(const char *dir, const uint8_t secret[32]) {
	char p[80], q[80];
	struct stat st;
	snprintf(p, sizeof p, "%s/key", dir);
	if (stat(p, &st) == 0 && st.st_size != 32) {
		printf("den: %s is %ld bytes, not 32: written again from the install's secret\n", p, (long)st.st_size);
		FILE *f = fopen(p, "wb");
		int ok = f != NULL && fwrite(secret, 1, 32, f) == 32;
		if (f) ok = fclose(f) == 0 && ok;
		if (!ok) printf("den: %s not written: %s\n", p, strerror(errno));
	}
	snprintf(p, sizeof p, "%s/log", dir);
	snprintf(q, sizeof q, "%s/log.new", dir);
	if (stat(q, &st) == 0) {
		if (stat(p, &st) != 0 && rename(q, p) == 0) printf("den: %s put back from log.new\n", p);
		else unlink(q);
	}
	errno = 0;
	int fd = open(p, O_RDONLY);
	if (fd < 0) {
		if (errno != ENOENT) printf("den: %s won't open: %s\n", p, strerror(errno));
		return;
	}
	if (fstat(fd, &st)) {
		printf("den: %s: no size: %s\n", p, strerror(errno));
		close(fd);
		return;
	}
	long size = (long)st.st_size, at = 0, frames = 0, torn = 0, skipped = 0, n;
	uint8_t *buf = NULL;
	size_t room = 0;
	// the whole frames first, then past each torn stretch to the next frame that is whole
	while (at < size) {
		if ((n = frame_at(fd, at, size, &buf, &room))) {
			at += 4 + n, frames++;
			continue;
		}
		long from = at;
		while (++at + 4 <= size && !frame_at(fd, at, size, &buf, &room)) {
		}
		if (at + 4 > size) at = size;
		torn++, skipped += at - from;
	}
	printf("den: %s: %ld bytes, %ld frames whole, %ld torn (%ld bytes)\n", p, size, frames, torn, skipped);
	if (torn == 0) {
		free(buf), close(fd);
		return;
	}
	// the whole frames, written again back to back
	errno = 0;
	int out = open(q, O_WRONLY | O_CREAT | O_TRUNC, 0644);
	const char *failed = out < 0 ? "open log.new" : NULL;
	for (at = 0; !failed && at < size;) {
		if ((n = frame_at(fd, at, size, &buf, &room))) {
			uint8_t head[4] = {(uint8_t)(n >> 24), (uint8_t)(n >> 16), (uint8_t)(n >> 8), (uint8_t)n};
			if (write(out, head, 4) != 4 || write(out, buf, (size_t)n) != n) failed = "write log.new (full?)";
			at += 4 + n;
		} else at++;
	}
	if (!failed && fsync(out)) failed = "sync log.new";
	if (out >= 0 && close(out) && !failed) failed = "close log.new";
	free(buf), close(fd);
	if (!failed && unlink(p)) failed = "let the log go";
	if (!failed && rename(q, p)) failed = "rename log.new";
	if (!failed) printf("den: %s: its torn frames left out, the rest kept\n", p);
	else {
		printf("den: %s not mended: %s: %s\n", p, failed, strerror(errno));
		// the log still there: log.new let go; else log.new is the log (a boot puts it back)
		if (stat(p, &st) == 0) unlink(q);
		else if (rename(q, p) == 0) printf("den: %s put back from log.new\n", p);
	}
}

static int promote(void);
static int (*store_snapshot)(void *self, const uint8_t *bytes, size_t length);
static int snapshot_in_place(void *self, const uint8_t *bytes, size_t length);
static int forgetting;
// the store's sync (fsync), timed: on FAT each costs flash writes, and tippet syncs this den's steps
// before any leave
static int (*store_sync)(void *self);
static int64_t sync_ms, syncs;
static int (*store_append)(void *self, const uint8_t *record, size_t length, const tp_at *at);
static long (*store_get)(void *self, const uint8_t device[32], uint64_t n, uint8_t *out, size_t cap);
static long (*store_run)(void *self, const uint8_t device[32], uint64_t n, uint8_t *out, size_t cap, uint64_t *first,
	uint64_t *last);
static long (*store_drop)(void *self, const uint8_t device[32], uint64_t n);

// this den's own records appended last, kept in memory too (TAIL of them, TAIL_BYTES at most; others'
// are never read back on the way out, so never held): a step written
// is read straight back when its run closes, and the run when it goes out, and on FAT each read
// there seeks off the file's unsynced last sector and so writes it first (about 50 ms each). the
// newest record holding a step is the one the store's own index holds for it, so the newest here
// holding it answers as the store would
#define TAIL 4
#define TAIL_BYTES 2048
static struct {
	uint8_t *bytes;
	size_t length;
	uint8_t device[32];
	uint64_t first, last;
	int run;
} tail[TAIL];
static size_t ntail;
static void tail_clear(void) {
	for (size_t i = 0; i < ntail; i++) free(tail[i].bytes);
	ntail = 0;
}
static void tail_hold(const uint8_t *record, size_t length, const tp_at *at) {
	if (at == NULL || length > TAIL_BYTES || memcmp(at->device, me.install.key, 32) != 0) return;
	uint8_t *b = malloc(length);
	if (b == NULL) return;
	memcpy(b, record, length);
	size_t bytes = length;
	for (size_t i = 0; i < ntail; i++) bytes += tail[i].length;
	// the oldest let go, till it fits
	while (ntail && (ntail == TAIL || bytes > TAIL_BYTES)) {
		bytes -= tail[0].length;
		free(tail[0].bytes);
		memmove(&tail[0], &tail[1], --ntail * sizeof tail[0]);
	}
	tail[ntail].bytes = b, tail[ntail].length = length;
	memcpy(tail[ntail].device, at->device, 32);
	tail[ntail].first = at->first, tail[ntail].last = at->last, tail[ntail].run = tp_is_run(record, length);
	ntail++;
}
// the newest record here holding device's step n, or -1
static long tail_find(const uint8_t device[32], uint64_t n) {
	for (size_t i = ntail; i-- > 0;)
		if (tail[i].first <= n && n <= tail[i].last && memcmp(tail[i].device, device, 32) == 0) return (long)i;
	return -1;
}

static int timed_append(void *self, const uint8_t *record, size_t length, const tp_at *at) {
	int64_t t = den_clock();
	int why = store_append(self, record, length, at);
	times.append += den_clock() - t, times.nappend++;
	if (getenv_trace) {
		// what it was: a run (its steps, its device's), or a step kept alone; and the log's size now
		char who[9] = "?";
		if (at) hex(who, at->device, 4);
		char *log = joined(me.dir, "/log");
		struct stat st;
		long size = stat(log, &st) == 0 ? (long)st.st_size : -1;
		free(log);
		printf("trace: appended %u bytes (+4 framing) in %lld ms at %lld: %s of %s%s, steps %llu..%llu; the log %ld bytes\n",
			(unsigned)length, (long long)(den_clock() - t), (long long)den_clock(),
			tp_is_run(record, length) ? "a run" : "a step alone", who,
			at && memcmp(at->device, me.install.key, 32) == 0 ? " (this den's)" : "", at ? (unsigned long long)at->first : 0,
			at ? (unsigned long long)at->last : 0, size);
	}
	if (why == 0) tail_hold(record, length, at);
	return why;
}
static long timed_get(void *self, const uint8_t device[32], uint64_t n, uint8_t *out, size_t cap) {
	// a step kept alone, held here: its record is the step, the same bytes once its run has closed
	// too (this den reads its own step back for its keys just after the run goes out)
	long i = -1;
	for (size_t k = ntail; k-- > 0 && i < 0;)
		if (!tail[k].run && tail[k].first == n && memcmp(tail[k].device, device, 32) == 0) i = (long)k;
	if (i >= 0) {
		if (out && tail[i].length <= cap) memcpy(out, tail[i].bytes, tail[i].length);
		times.tailed++;
		return (long)tail[i].length;
	}
	int64_t t = den_clock();
	long got = store_get(self, device, n, out, cap);
	times.read += den_clock() - t, times.nread++;
	return got;
}
static long timed_run(void *self, const uint8_t device[32], uint64_t n, uint8_t *out, size_t cap, uint64_t *first,
	uint64_t *last) {
	long i = tail_find(device, n);
	if (i >= 0) {
		if (out) memcpy(out, tail[i].bytes, tail[i].length < cap ? tail[i].length : cap);
		*first = tail[i].first, *last = tail[i].last;
		times.tailed++;
		return (long)tail[i].length;
	}
	int64_t t = den_clock();
	long got = store_run(self, device, n, out, cap, first, last);
	times.read += den_clock() - t, times.nread++;
	return got;
}
// forgetting: what is let go is never read from here either
static long tail_drop(void *self, const uint8_t device[32], uint64_t n) {
	tail_clear();
	return store_drop(self, device, n);
}
static int timed_sync(void *self) {
	int64_t t = den_clock();
	int why = store_sync(self);
	times.sync += den_clock() - t, times.nsync++;
	sync_ms += den_clock() - t, syncs++;
	if (getenv_trace) printf("trace: synced in %lld ms at %lld\n", (long long)(den_clock() - t), (long long)den_clock());
	return why;
}

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

	// tippet: the log (the den's key), its history (what is kept), its sync. a store that can't be
	// had is no den: one in memory would start its chain at step 1 again, in a room that has its
	// steps, and the room would pass over every step after
	check_store(dir, install->secret);
	tp_store *store = tp_file_store(&(tp_mem){counted, &part_now[0]}, dir, 1 << 20);
	me.kept_on_flash = store != NULL;
	if (store == NULL) {
		// FAT says EACCES (FR_DENIED) when a folder can't be made for want of a free cluster: a full
		// flash, said as one
		size_t left = den_disk_free();
		if ((errno == EACCES || errno == ENOSPC) && left < 16 * 1024)
			snprintf(me.why, sizeof me.why, "the flash is full (%uK free): no room for room %s's log",
				(unsigned)(left / 1024), code);
		else snprintf(me.why, sizeof me.why, "its log on flash won't open (%s)", strerror(errno));
		fprintf(stderr, "den: %s\n", me.why);
		return 1;
	} else {
		// the file store, its snapshot put in place on FAT (snapshot_in_place)
		static tp_store wrapped;
		wrapped = *store, store_snapshot = store->snapshot, wrapped.snapshot = snapshot_in_place;
		store_sync = store->sync, wrapped.sync = timed_sync;
		store_append = store->append, wrapped.append = timed_append;
		store_get = store->get, wrapped.get = timed_get;
		store_run = store->run, wrapped.run = timed_run;
		if (store->drop) store_drop = store->drop, wrapped.drop = tail_drop;
		store = &wrapped;
	}
	me.store = store;
	me.log = tp_log_new(&(tp_log_options){.mem = mem_of(1), .store = store, .seed = install->secret, .strict = 1,
		.told = told});
	int why = me.log ? tp_log_load(me.log) : TP_NOMEM;
	if (why) {
		snprintf(me.why, sizeof me.why, "its log didn't load: %s (%s)", tp_why(why), errno ? strerror(errno) : "-");
		fprintf(stderr, "den: %s\n", me.why);
		return 1;
	}
	// a snapshot written last time but not yet in place (a reset between), put in place first
	if (me.kept_on_flash) promote();
	me.history = tp_history_new(&(tp_history_options){.mem = mem_of(2), .log = me.log, .table = me.w.table,
		.places = me.w.places, .kept = kept, .run = hosted, .forgets = forgetting});
	if (me.history == NULL) return 1;
	den_mark("log loaded");
	{
		struct stat st;
		char *snap = joined(me.dir, "/snapshot"), *log = joined(me.dir, "/log");
		long sn = stat(snap, &st) == 0 ? (long)st.st_size : -1, ln = stat(log, &st) == 0 ? (long)st.st_size : -1;
		printf("den: the log %ld bytes, its snapshot %ld\n", ln, sn);
		free(snap), free(log);
	}
	if ((why = tp_history_load(me.history))) {
		// a snapshot that doesn't read back: let go, and the boot again lands every step from the log
		// (a boot that went on would snapshot what it has, an empty graph, over it)
		char *snap = joined(me.dir, "/snapshot");
		unlink(snap);
		free(snap);
		snprintf(me.why, sizeof me.why, "its snapshot didn't load (%s): let go, so it starts again from its log",
			tp_why(why));
		fprintf(stderr, "den: %s\n", me.why);
		me.again = 1;
		return 1;
	}
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
	// this den's keys as only its own steps make them. forgetting, the steps in the snapshot are let
	// go: its keys as the snapshot has them, then the own steps still held on top (a put again is
	// the same put)
	if (forgetting) {
		const nd_entry *k = tb_get(me.w.table, tb_string("value"), tb_string(me.keys_node));
		if (k && is_map(k->value)) op_free(me.keys), me.keys = op_ref(k->value);
	}
	for (uint64_t n = 1; n <= tp_log_count(me.log, install->key); n++) keys_from(n);
	me.synced = den_steps();

	// the programs, at /things/<kind>: a few words of what it is, its form the runner's takes
	me.functions = hf_new();
	things_add(me.functions);
	put1("children", HOST_ROOT, "things", op_str("things"));
	// the programs of those it starts itself (keys, screen, pigs, the speaker): a paired den's start
	// carries its program's code, so the parts need none here (each node costs about 1 KB of heap)
	for (int i = 0; i < BOOTS + 1; i++) {
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
	// the G0 menu, /system/menu, before the inbox is read (its items paired dens put in, in again)
	menu_start();
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

// 1: the log's own sync waits for 3 s with no steps; 0: a second after the first (as before)
int den_lazy = 1;

void den_net(const char *state) {
	if (strcmp(me.net, state) == 0) return;
	snprintf(me.net, sizeof me.net, "%s", state);
	printf("den: %s\n", state);
}

// the band's lines, and whether they are hot (cherry); how many
static int band(char lines[2][31], int *hot) {
	memset(lines, 0, 2 * 31);
	*hot = 0;
	if (me.lost) {
		snprintf(lines[0], 31, "room has %llu steps, I %llu:", (unsigned long long)me.lost,
			(unsigned long long)tp_log_count(me.log, me.install.key));
		snprintf(lines[1], 31, "lost here: use another room");
		*hot = 1;
		return 2;
	}
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
	// the room's code, always, at the top right
	if (me.room[0]) {
		fb_rect(FB_W - 44, 1, 42, 11, FB_WHITE);
		fb_text(FB_W - 39, 3, me.room, FB_CHERRY, 1);
	}
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
	// what the log took since the last sync (its own steps, and others'), on flash once none have
	// come for 3 s. tippet syncs this den's own steps itself before any leave (tp_log_run), so this
	// one is for the rest (others' steps, its own runs closed): never in the way of typing
	uint64_t steps = den_steps();
	if (steps != me.synced && den_lazy) me.sync_at = now + 3000;
	else if (steps != me.synced && me.sync_at == 0) me.sync_at = now + 1000;
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
// put in its place, once it reads back as one whole canonical CBOR item; else let go. 1: put in
// place
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
	free(now), free(made);
	return ok;
}

// the store's snapshot, with promote after it: on FAT the store's rename onto the old snapshot is
// refused (TP_STORE), its new one left beside it, put in place here
static int snapshot_in_place(void *self, const uint8_t *bytes, size_t length) {
	int why = store_snapshot(self, bytes, length);
	if (why == TP_STORE && promote()) why = 0;
	return why;
}

// forgetting (tippet's try-out, history.h): set before den_boot
void den_forgets(int yes) { forgetting = yes; }

int den_snapshot(void) {
	// forgetting: the snapshot, then the runs in it that have passed on (to galaxy) let go
	int why = forgetting ? tp_history_forget(me.history, me.sync) : tp_history_snapshot(me.history);
	printf("den: snapshot at %llu steps: %s\n", (unsigned long long)den_steps(), why ? tp_why(why) : "kept");
	if (why) {
		fprintf(stderr, "den: no snapshot: %s\n", tp_why(why));
		// what it left (FAT's rename refused, or the flash full) let go; tried again 16 steps on, not
		// every loop
		char *made = joined(me.dir, "/snapshot.new");
		unlink(made);
		free(made);
		say(1, "no snapshot kept:", why == TP_STORE ? "the flash may be full" : tp_why(why));
	}
	me.snapped = den_steps();
	return why;
}

void den_trust_last(void) { den_pair_answer(1); }

void den_print(void) {
	for (int i = 0; i < BOOTS; i++) {
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
	printf("store syncs: %lld, %lld ms in all\n", (long long)syncs, (long long)sync_ms);
	printf("tippet heap by part, now (most):");
	for (int i = 0; i < 4; i++) printf(" %s %zu (%zu)", PARTS[i], part_now[i], part_most[i]);
	printf("\n");
	size_t most, now = den_heap(&most);
	printf("den %.8s in room %s (%s): %llu steps of its own, %zu devices, tippet heap %zu (most %zu)\n", me.id,
		me.room, me.net, (unsigned long long)tp_log_count(me.log, me.install.key), tp_log_devices(me.log), now,
		most);
}

// ---- the menu's: a paired den's item picked, and a room left ----

op_value *den_do(const char *from, const char *name, const op_value *handler) {
	char shown[16], one[64], two[64];
	short_name(from, shown, sizeof shown);
	if (!trusts(from)) {
		snprintf(one, sizeof one, "\"%.20s\" is %s's:", name, shown);
		say(1, one, "not paired now, so not done");
		frame_again();
		return refusal(shown, "not-in-keys");
	}
	// a thing started with the heap nearly gone would stop the den (an allocation that fails ends
	// it): refused, in words
	if (str_is(op_get(handler, "op"), "start") && den_free() < DEN_ROOM) {
		snprintf(one, sizeof one, "\"%.20s\" not done:", name);
		snprintf(two, sizeof two, "%uK free, too little", (unsigned)(den_free() / 1024));
		say(1, one, two);
		frame_again();
		return error_of("too little memory here to start a thing");
	}
	doing x = {handler, from, NULL};
	sc_run_with_scope(me.w.host, do_now, &x);
	host_settle();
	const op_value *refused = op_get(x.out, "refused"), *error = op_get(x.out, "error");
	char kind[24] = "";
	kind_of(op_get(handler, "runner"), kind, sizeof kind);
	snprintf(one, sizeof one, "%.24s:", name);
	if (is_str(error)) snprintf(two, sizeof two, "%s", error->str);
	else if (is_str(refused)) snprintf(two, sizeof two, "no, %s", refused->str);
	else if (str_is(op_get(handler, "op"), "start")) snprintf(two, sizeof two, "a %s started", kind[0] ? kind : "thing");
	else snprintf(two, sizeof two, "a thing stopped");
	say(is_str(error) || is_str(refused), one, two);
	frame_again();
	return x.out;
}

void den_leave(void) {
	if (me.sync) {
		op_value *m = map1("den", op_str(me.id));
		op_set(m, "bye", op_bool(1));
		size_t n;
		uint8_t *b = encoded(m, &n);
		if (b) tp_sync_live(me.sync, b, n);
		free(b);
		op_free(m);
	}
	if (me.store && me.store->sync && me.store->sync(me.store->self)) fprintf(stderr, "den: the log wasn't synced to flash\n");
}

long den_own_step(uint64_t n, uint8_t *out, size_t cap) {
	if (n == 0) n = tp_log_count(me.log, me.install.key);
	return n ? tp_log_step(me.log, me.install.key, n, out, cap) : -1;
}
const uint8_t *den_seed(void) { return me.install.secret; }

// the thing at /home/<at> stopped (the sim's, to measure what a start and stop leave behind): 1 done
int den_stop(const char *at) {
	sw_process *const *procs;
	size_t n = sw_running(me.software, &procs);
	for (size_t i = 0; i < n; i++) {
		const char *const *where;
		size_t k = sw_process_at(procs[i], &where);
		if (k == 2 && strcmp(where[0], "home") == 0 && strcmp(where[1], at) == 0) {
			char *id = xstrdup(sw_process_id(procs[i]));
			sw_stop(me.software, id, NULL);
			free(id);
			host_settle();
			return 1;
		}
	}
	return 0;
}

// a step of this den's, said on the log (the trace's): its node, part, patches (as JSON, bytes as
// base64), its bytes in all and their parts
static void step_said(uint64_t n) {
	long length = tp_log_step(me.log, me.install.key, n, NULL, 0);
	if (length < 0) return;
	uint8_t *b = xalloc((size_t)length);
	tp_log_step(me.log, me.install.key, n, b, (size_t)length);
	tp_step s;
	if (tp_step_decode(b, (size_t)length, &s) == 0) {
		op_value *ps = pk_get(s.patches.p, s.patches.n, NULL, NULL);
		char *j = ps ? op_json_text(ps) : NULL;
		printf("trace: step %llu: %ld bytes: node %.*s (%u), part %.*s (%u), patches %u bytes, %u of them: %s\n",
			(unsigned long long)n, length, (int)s.node.n, (const char *)s.node.p, (unsigned)s.node.n, (int)s.part.n,
			(const char *)s.part.p, (unsigned)s.part.n, (unsigned)s.patches.n, (unsigned)s.count, j ? j : "?");
		free(j);
		if (ps) op_free(ps);
	}
	free(b);
}
uint64_t den_steps_own(void) { return me.log ? tp_log_count(me.log, me.install.key) : 0; }
