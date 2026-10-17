// Whole hosts (sync.h) on the line protocol (conformance/c/harness.h), as extensions/sync/typescript/
// sync_harness.ts has them: each a table and sync over its own device and store, joined by in-memory
// pipes (wires_harness.h); its header lists the requests and answers. State lasts for the process. The C host
// has no places and no scheduler: reads are the table's, and sync is told the host's writes and the
// table's events as the TypeScript host tells it.
//
// Deterministic: a host's random is the harness's (each call's bytes the first of BLAKE3 of
// "<host>/<k>", k counting the host's calls from 0, across restarts); a write's change is the
// request's, or {time: 1760000000, actor: <host>, external: [{file: "scenario", line: 1}]}; what sync
// stamps with the time now has the request's time, default 1760000000; the devices (and sync's beats
// and ttl) run on the harness's clock, which quiet moves 2 ms a round and advance by its ms. A commit in an answer: its label (a write's
// name), else its name as hex. An id: a label minted (as), else the string as given
#include "egwalker.h"
#include "ids.h"
#include "sync.h"
#include "wires_harness.h"

#include "../../../conformance/c/protocol_harness.h"
#include "../../../core/node/c/update.h"
#include "../../../ermine/encoding/c/commit_form_harness.h"

#include <stdlib.h>
#include <string.h>

#define TIME 1760000000

// ---- hosts

typedef struct {
	char *name;
	uint8_t seed[32];
	bool zeros, has_tables, lazy;
	char **tables;
	size_t tables_length;
	// the rules it knows, and the one it merges by (NULL: none)
	const rp_rule *merges[1];
	size_t merges_length;
	char *merge;
	// the tables whose changes go out ephemerally
	char **ephemeral;
	size_t ephemeral_length;
	// whether sync is given a commit callback (none here does anything: the host has no places)
	bool commit;
	// sync's roots
	char **roots;
	size_t roots_length;
	// the table's events by "table id", since last asked
	struct {
		char *key;
		size_t count;
	} *events;
	size_t event_count;
	const ErmStore *store;
	tb_table *table;
	sy_sync *sync;
	// the entries the host made, its to free
	nd_entry **made;
	size_t made_count, made_room;
} host_t;

static host_t **hosts;
static size_t host_count;
// every store made: kept while the process lives, a memory store is never freed
static ErmStore **stores;
static size_t store_count;
// the lines whose requests an entry's change refers to, let go of at the end
static hh_line **lines;
static size_t line_count, line_room;
// each host's count of random calls, kept across restarts
static struct {
	char *name;
	size_t calls;
} *counts;
static size_t count_count;
// what sync stamps with the time now
static int64_t now_s = TIME;

static host_t *of(const op_value *r, const char *key, FILE *out) {
	const char *name = hh_str(r, key);
	for (size_t i = 0; name != NULL && i < host_count; i++)
		if (strcmp(hosts[i]->name, name) == 0) return hosts[i];
	hh_error(out, "no host %s", name ? name : "(none)");
	return NULL;
}

static void random_of(void *context, uint8_t *out, size_t n) {
	host_t *h = context;
	size_t i = 0;
	while (i < count_count && strcmp(counts[i].name, h->name) != 0) i++;
	if (i == count_count) {
		counts = realloc(counts, (count_count + 1) * sizeof *counts);
		if (counts == NULL) abort();
		counts[count_count].name = copyString(h->name);
		counts[count_count++].calls = 0;
	}
	char *text = formatString("%s/%zu", h->name, counts[i].calls++);
	uint8_t hash[32];
	cm_name((const uint8_t *)text, strlen(text), hash);
	free(text);
	memcpy(out, hash, n < 32 ? n : 32);
}

static int64_t time_of(void *context) {
	(void)context;
	return now_s;
}

static void made(host_t *h, nd_entry *e) {
	if (h->made_count == h->made_room) {
		h->made_room = h->made_room ? h->made_room * 2 : 16;
		h->made = realloc(h->made, h->made_room * sizeof *h->made);
		if (h->made == NULL) abort();
	}
	h->made[h->made_count++] = e;
}

// one of the host's entries let go of: false when it is not the host's
static bool unmade(host_t *h, nd_entry *e) {
	for (size_t i = 0; i < h->made_count; i++) {
		if (h->made[i] != e) continue;
		h->made[i] = h->made[--h->made_count];
		nd_free_entry(e);
		return true;
	}
	return false;
}

static void dropped(void *context, nd_entry *e) {
	unmade(context, e);
}

static bool ephemeral_of(void *context, const char *doc, const char *table) {
	(void)doc;
	host_t *h = context;
	for (size_t i = 0; i < h->ephemeral_length; i++)
		if (strcmp(h->ephemeral[i], table) == 0) return true;
	return false;
}

static void ephemeral_set(host_t *h, const op_value *tables) {
	for (size_t i = 0; i < h->ephemeral_length; i++) free(h->ephemeral[i]);
	free(h->ephemeral);
	h->ephemeral = NULL;
	h->ephemeral_length = 0;
	if (tables == NULL || tables->type != OP_LIST) return;
	h->ephemeral = calloc(tables->count + 1, sizeof *h->ephemeral);
	if (h->ephemeral == NULL) abort();
	for (size_t i = 0; i < tables->count; i++)
		if (tables->items[i]->type == OP_STR) h->ephemeral[h->ephemeral_length++] = copyString(tables->items[i]->str);
}

static void table_event(void *context, tb_key part, tb_key id) {
	host_t *h = context;
	if (part.string != NULL && id.string != NULL) {
		char *key = formatString("%s %s", part.string, id.string);
		size_t i = 0;
		while (i < h->event_count && strcmp(h->events[i].key, key) != 0) i++;
		if (i == h->event_count) {
			h->events = realloc(h->events, (h->event_count + 1) * sizeof *h->events);
			if (h->events == NULL) abort();
			h->events[h->event_count].key = key;
			h->events[h->event_count++].count = 0;
		} else free(key);
		h->events[i].count++;
	}
	if (h->sync != NULL) sy_table_changed(h->sync, part, id);
}

// the host's "a write landed": nothing to tell, with no places
static void landed(void *context, nd_entry *const *changed, size_t count) {
	(void)context, (void)changed, (void)count;
}

// the request's line kept: an entry's change refers to it
static void keep_line(void) {
	hh_line *l = hh_retain();
	for (size_t i = 0; i < line_count; i++)
		if (lines[i] == l) return;
	if (line_count == line_room) {
		line_room = line_room ? line_room * 2 : 16;
		lines = realloc(lines, line_room * sizeof *lines);
		if (lines == NULL) abort();
	}
	lines[line_count++] = l;
}

// ---- running

static void run_all(void) {
	for (size_t i = 0; i < host_count; i++) {
		sy_run(hosts[i]->sync);
		wr_drain(sy_device(hosts[i]->sync));
	}
}

// every host idle, and no message crossing for five rounds of 2 ms
static bool quiet(void) {
	size_t still = 0, last = (size_t)-1;
	for (int round = 0; round < 3000; round++) {
		run_all();
		bool idle = true;
		for (size_t i = 0; i < host_count; i++) idle = idle && sy_idle(hosts[i]->sync);
		wr_ms += 2;
		if (idle && wr_moved == last) {
			if (++still >= 5) return true;
		} else still = 0, last = wr_moved;
	}
	return false;
}

// everything runs until the host has what it waits on: what its store held taken in, its fetches
// answered, nothing queued
static void settle(host_t *h) {
	for (int round = 0; round < 3000; round++) {
		run_all();
		tp_device *d = sy_device(h->sync);
		if (tp_ready(d) && sy_idle(h->sync) && tp_fetching(d) == 0) return;
		wr_ms += 1;
	}
}

static void make(host_t *h) {
	h->table = tb_make(table_event, h);
	sy_options o = {.table = h->table, .store = h->store, .now = wr_clock, .random = random_of, .time = time_of,
		.zeros = h->zeros, .lazy = h->lazy, .tables = h->has_tables ? (const char *const *)h->tables : NULL,
		.tables_length = h->tables_length, .merges = h->merges, .merges_length = h->merges_length,
		.merge = h->merge, .drop = dropped, .ephemeral = ephemeral_of, .context = h,
		.commit = h->commit ? landed : NULL, .roots = (const char *const *)h->roots, .roots_length = h->roots_length};
	memcpy(o.seed, h->seed, 32);
	h->sync = sy_create(&o);
	if (h->sync == NULL) hh_fail("Subduction would not make a node");
}

// closed, its pipes cut: what it had queued stored first, then it and its table let go of
static void shut(host_t *h) {
	tp_device *d = sy_device(h->sync);
	wr_close(d);
	for (int round = 0; round < 3000 && !sy_idle(h->sync); round++) {
		sy_run(h->sync);
		wr_drain(d);
	}
	sy_free(h->sync);
	h->sync = NULL;
	for (size_t i = 0; i < h->made_count; i++) nd_free_entry(h->made[i]);
	h->made_count = 0;
	tb_free(h->table);
	h->table = NULL;
}

static void host_free(host_t *h) {
	if (h->sync != NULL) shut(h);
	for (size_t i = 0; i < h->tables_length; i++) free(h->tables[i]);
	free(h->tables);
	free(h->merge);
	ephemeral_set(h, NULL);
	for (size_t i = 0; i < h->roots_length; i++) free(h->roots[i]);
	free(h->roots);
	for (size_t i = 0; i < h->event_count; i++) free(h->events[i].key);
	free(h->events);
	free(h->made);
	free(h->name);
	free(h);
}

// ---- names

// ids by label
static struct {
	char *label, *id;
} *ids;
static size_t id_count;
// commit labels by name (the first), and names by label
static im_map labels;
static struct {
	char *label;
	uint8_t name[32];
} *names;
static size_t name_count;

static const char *id_of(const op_value *x) {
	const char *s = x != NULL && x->type == OP_STR ? x->str : NULL;
	for (size_t i = 0; s != NULL && i < id_count; i++)
		if (strcmp(ids[i].label, s) == 0) return ids[i].id;
	return s != NULL ? s : "";
}

static void put_label(FILE *out, const uint8_t name[32]) {
	const char *label = im_get(&labels, name);
	if (label != NULL) op_json_string(out, label);
	else cf_put_hex(out, name, 32);
}

static void put_name(void *context, FILE *out, const uint8_t name[32]) {
	(void)context;
	put_label(out, name);
}

static bool name_of(const op_value *x, uint8_t name[32], FILE *out) {
	const char *s = x != NULL && x->type == OP_STR ? x->str : NULL;
	for (size_t i = 0; s != NULL && i < name_count; i++) {
		if (strcmp(names[i].label, s) == 0) {
			memcpy(name, names[i].name, 32);
			return true;
		}
	}
	uint8_t *b;
	size_t n;
	if (s != NULL && strlen(s) == 64 && cf_unhex(s, &b, &n)) {
		memcpy(name, b, 32);
		return true;
	}
	hh_error(out, "no commit %s", s ? s : "(none)");
	return false;
}

static void label(const char *as, const uint8_t name[32]) {
	size_t i = 0;
	while (i < name_count && strcmp(names[i].label, as) != 0) i++;
	if (i == name_count) {
		names = realloc(names, (name_count + 1) * sizeof *names);
		if (names == NULL) abort();
		names[name_count++].label = copyString(as);
	}
	memcpy(names[i].name, name, 32);
	if (!im_has(&labels, name)) im_set(&labels, name, names[i].label);
}

// ---- writes

static const char *table_of(const op_value *r) {
	const char *t = hh_str(r, "table");
	return t ? t : "value";
}

// the request's change, else the host's default; the line's
static ch_header header_of(host_t *h, const op_value *r) {
	const op_value *change = op_get(r, "change");
	if (change != NULL) return hh_header(change);
	ch_site *site = hh_take(sizeof *site);
	*site = (ch_site){"scenario", 1, 0, NULL, 0};
	return (ch_header){.has_time = 1, .time = TIME, .actor = hh_hold(op_str(h->name)), .external = site, .external_length = 1};
}

static ch_header *hold_header(ch_header h) {
	ch_header *out = hh_take(sizeof *out);
	*out = h;
	return out;
}

// the patches to the entry at (part, id); none there: the first patch's value is the entry, the rest
// patches to it. false with the answer written when they do not apply
static bool write_entry(host_t *h, const char *part, const char *id, const op_patch *patches, size_t n, const ch_header *change,
	FILE *out) {
	tb_key p = tb_string(part), k = tb_string(id);
	keep_line();
	if (tb_get(h->table, p, k) == NULL) {
		nd_entry *e = nd_make_entry((op_value *)patches[0].value, change, NULL);
		if (e == NULL) abort();
		made(h, e);
		tb_add(h->table, p, k, e);
		if (n == 1) return true;
		patches++, n--;
	}
	nd_entry *e = tb_get(h->table, p, k);
	if (e == NULL) {
		hh_error(out, "nothing there");
		return false;
	}
	size_t failed;
	int code = nd_update(e, patches, n, *change, &failed);
	if (code != OP_OK) {
		hh_error(out, "%s", op_code_name(code));
		return false;
	}
	sy_wrote(h->sync, &e, 1);
	return true;
}

typedef enum { W_WRITE, W_TYPE, W_REMOVE, W_SETTLE } writing_t;

// what the host made: how many commits, the last labelled (name)
static void counting(const op_value *r, writing_t what, FILE *out) {
	host_t *h = of(r, "host", out);
	if (h == NULL) return;
	const char *id = id_of(op_get(r, "id"));
	uint8_t bytes[32];
	// an id that is not a document's has no history: nothing is made for it
	hy_history *history = tp_doc(id, bytes) ? tp_history(sy_device(h->sync), id, TP_STORED) : NULL;
	hy_history *eph = history ? tp_history(sy_device(h->sync), id, TP_EPHEMERAL) : NULL;
	const hy_kept **all = NULL;
	size_t before = history ? hy_all(history, &all) : 0;
	free(all);
	size_t eph_before = eph ? hy_all(eph, &all) : 0;
	if (eph) free(all);
	const op_value *time = op_get(r, "time");
	now_s = time != NULL && time->type == OP_NUM ? (int64_t)time->num : TIME;
	bool ok = true;
	const char *part = table_of(r);
	if (what == W_WRITE) {
		const op_value *ps = op_get(r, "patches");
		size_t n = ps != NULL && ps->type == OP_LIST ? ps->count : 0;
		op_patch *patches = hh_take((n + 1) * sizeof *patches);
		for (size_t i = 0; i < n; i++) hh_patch(ps->items[i], &patches[i]);
		ok = n > 0 && write_entry(h, part, id, patches, n, hold_header(header_of(h, r)), out);
		if (n == 0) hh_error(out, "no patches");
	} else if (what == W_TYPE) {
		const ch_header *change = hold_header(header_of(h, r));
		const op_value *text = op_get(r, "text"), *path = op_get(r, "path"), *at = op_get(r, "at");
		long from = at != NULL && at->type == OP_NUM ? (long)at->num : 0;
		const char *s = text != NULL && text->type == OP_STR ? text->str : "";
		size_t length = text != NULL && text->type == OP_STR ? text->bytes : 0;
		// each code point a write of its own: an insert at path, from at on
		for (size_t i = 0; i < length && ok;) {
			unsigned char lead = (unsigned char)s[i];
			size_t w = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
			if (i + w > length) w = length - i;
			op_value *m = hh_hold(op_map()), *range = op_list();
			op_set(m, "path", path != NULL ? op_ref((op_value *)path) : op_list());
			op_push(range, op_num((double)from));
			op_push(range, op_num((double)from));
			op_set(m, "range", range);
			op_set(m, "value", op_str_n(s + i, w));
			op_patch *patch = hh_take(sizeof *patch);
			hh_patch(m, patch);
			ok = write_entry(h, part, id, patch, 1, change, out);
			from++;
			i += w;
		}
	} else if (what == W_REMOVE) {
		nd_entry *e = tb_get(h->table, tb_string(part), tb_string(id));
		bool mine = false;
		for (size_t i = 0; e != NULL && i < h->made_count && !mine; i++) mine = h->made[i] == e;
		if (tb_del(h->table, tb_string(part), tb_string(id)) != 0) {
			hh_error(out, "nothing-there %s %s", part, id);
			ok = false;
		} else if (mine) unmade(h, e);
	} else {
		const op_value *change = op_get(r, "change");
		ch_header *given = change != NULL ? hold_header(hh_header(change)) : NULL;
		if (change != NULL) keep_line();
		sy_settle(h->sync, id, given);
	}
	now_s = TIME;
	if (!ok) return;
	size_t after = history ? hy_all(history, &all) : 0;
	size_t made_now = after - before;
	const hy_kept **eph_all = NULL;
	size_t eph_after = eph ? hy_all(eph, &eph_all) : 0;
	// the ephemeral history takes every stored commit too
	size_t fleeting = eph_after - eph_before - made_now;
	const char *as = hh_str(r, "name");
	if (made_now + fleeting > 0 && as != NULL)
		label(as, eph_after > eph_before ? eph_all[eph_after - 1]->name : all[after - 1]->name);
	if (history) free(all);
	if (eph) free(eph_all);
	if (fleeting > 0) fprintf(out, "{\"commits\":%zu,\"ephemeral\":%zu}", made_now, fleeting);
	else fprintf(out, "{\"commits\":%zu}", made_now);
}

// ---- requests

static void host(const op_value *r, FILE *out) {
	const char *name = hh_str(r, "name"), *seed = hh_str(r, "seed");
	for (size_t i = 0; name != NULL && i < host_count; i++) {
		if (strcmp(hosts[i]->name, name) == 0) {
			hh_error(out, "a host %s already", name);
			return;
		}
	}
	uint8_t *b;
	size_t n;
	if (name == NULL || seed == NULL || !cf_unhex(seed, &b, &n) || n != 32) {
		hh_error(out, "a host needs a name and a seed");
		return;
	}
	host_t *h = calloc(1, sizeof *h);
	if (h == NULL) abort();
	h->name = copyString(name);
	memcpy(h->seed, b, 32);
	const op_value *zeros = op_get(r, "zeros"), *tables = op_get(r, "tables"), *lazy = op_get(r, "lazy");
	h->zeros = zeros != NULL && zeros->type == OP_BOOL && zeros->bool_;
	h->lazy = lazy != NULL && lazy->type == OP_BOOL && lazy->bool_;
	const op_value *commit = op_get(r, "commit"), *roots = op_get(r, "roots");
	h->commit = commit == NULL || commit->type != OP_BOOL || commit->bool_;
	if (roots != NULL && roots->type == OP_LIST) {
		h->roots = calloc(roots->count + 1, sizeof *h->roots);
		if (h->roots == NULL) abort();
		for (size_t i = 0; i < roots->count; i++)
			if (roots->items[i]->type == OP_STR) h->roots[h->roots_length++] = copyString(roots->items[i]->str);
	}
	if (tables != NULL && tables->type == OP_LIST) {
		h->has_tables = true;
		h->tables = calloc(tables->count + 1, sizeof *h->tables);
		if (h->tables == NULL) abort();
		for (size_t i = 0; i < tables->count; i++)
			if (tables->items[i]->type == OP_STR) h->tables[h->tables_length++] = copyString(tables->items[i]->str);
	}
	// every rule a host may be given: eg-walker. merges: their names, default [merge] or none
	const op_value *merges = op_get(r, "merges"), *merge = op_get(r, "merge");
	if (merge != NULL && merge->type == OP_STR) h->merge = copyString(merge->str);
	size_t known = merges != NULL && merges->type == OP_LIST ? merges->count : merges == NULL && h->merge != NULL;
	for (size_t i = 0; i < known; i++) {
		const char *rule = merges != NULL ? merges->items[i]->type == OP_STR ? merges->items[i]->str : "" : h->merge;
		if (strcmp(rule, eg_rule.name) != 0) {
			hh_error(out, "no rule %s", rule);
			for (size_t t = 0; t < h->tables_length; t++) free(h->tables[t]);
			free(h->tables), free(h->merge), free(h->name), free(h);
			return;
		}
		h->merges[0] = &eg_rule;
		h->merges_length = 1;
	}
	ephemeral_set(h, op_get(r, "ephemeral"));
	ErmStore *s = malloc(sizeof *s);
	if (s == NULL) abort();
	*s = ermStoreMemory();
	stores = realloc(stores, (store_count + 1) * sizeof *stores);
	if (stores == NULL) abort();
	stores[store_count++] = s;
	h->store = s;
	make(h);
	hosts = realloc(hosts, (host_count + 1) * sizeof *hosts);
	if (hosts == NULL) abort();
	hosts[host_count++] = h;
	settle(h);
	fputs("{\"key\":", out);
	cf_put_hex(out, tp_key(sy_device(h->sync)), SL_KEY);
	fputc('}', out);
}

static void restart(const op_value *r, FILE *out) {
	host_t *h = of(r, "host", out);
	if (h == NULL) return;
	shut(h);
	make(h);
	settle(h);
	fputs("{}", out);
}

// sync.use: the rule it merges by from now (one it knows), or none; kept across restarts
static void use(const op_value *r, FILE *out) {
	host_t *h = of(r, "host", out);
	if (h == NULL) return;
	const char *merge = hh_str(r, "merge");
	if (!sy_use(h->sync, merge)) {
		hh_error(out, "no merge rule %s", merge);
		return;
	}
	free(h->merge);
	h->merge = merge != NULL ? copyString(merge) : NULL;
	fputs("{}", out);
}

static void close_host(const op_value *r, FILE *out) {
	host_t *h = of(r, "host", out);
	if (h == NULL) return;
	for (size_t i = 0; i < host_count; i++) {
		if (hosts[i] != h) continue;
		memmove(&hosts[i], &hosts[i + 1], (host_count - i - 1) * sizeof *hosts);
		host_count--;
		break;
	}
	host_free(h);
	fputs("{}", out);
}

static void join_hosts(const op_value *r, FILE *out) {
	host_t *a = of(r, "a", out), *b = a ? of(r, "b", out) : NULL;
	if (b == NULL) return;
	tp_device *x = sy_device(a->sync), *y = sy_device(b->sync);
	wr_connect(x, y);
	// the handshake done, and what each follows fetched over it
	for (int round = 0; round < 3000; round++) {
		run_all();
		if (wr_up(x, y) && tp_fetching(x) == 0 && tp_fetching(y) == 0) break;
		wr_ms += 1;
	}
	fputs("{}", out);
}

static void disconnect(const op_value *r, FILE *out) {
	host_t *a = of(r, "a", out), *b = a ? of(r, "b", out) : NULL;
	if (b == NULL) return;
	tp_device *x = sy_device(a->sync), *y = sy_device(b->sync);
	tp_disconnect(x, tp_key(y));
	tp_disconnect(y, tp_key(x));
	wr_cut(x, y);
	wr_drain(x);
	wr_drain(y);
	fputs("{}", out);
}

static void follow(const op_value *r, FILE *out) {
	host_t *h = of(r, "host", out);
	if (h == NULL) return;
	const char *id = id_of(op_get(r, "id"));
	if (!sy_follow(h->sync, id)) {
		hh_error(out, "not a document id: %s", id);
		return;
	}
	settle(h);
	fputs("{}", out);
}

// sync.stop: the host's standing ephemeral commit at (id, table) ends, default table value
static void stop(const op_value *r, FILE *out) {
	host_t *h = of(r, "host", out);
	if (h == NULL) return;
	const char *table = hh_str(r, "table");
	sy_stop(h->sync, id_of(op_get(r, "id")), table != NULL ? table : "value");
	fputs("{}", out);
}

static void mint(const op_value *r, FILE *out) {
	host_t *h = of(r, "host", out);
	if (h == NULL) return;
	char id[9 + 64 + 1];
	sy_mint(h->sync, id);
	const char *as = hh_str(r, "as");
	if (as != NULL) {
		ids = realloc(ids, (id_count + 1) * sizeof *ids);
		if (ids == NULL) abort();
		ids[id_count].label = copyString(as);
		ids[id_count++].id = copyString(id);
	}
	fputs("{\"id\":", out);
	op_json_string(out, id);
	fputc('}', out);
}

static nd_entry *entry_of(const op_value *r, FILE *out, host_t **h) {
	*h = of(r, "host", out);
	if (*h == NULL) return NULL;
	return tb_get((*h)->table, tb_string(table_of(r)), tb_string(id_of(op_get(r, "id"))));
}

static void read_entry(const op_value *r, FILE *out) {
	host_t *h;
	nd_entry *e = entry_of(r, out, &h);
	if (h == NULL) return;
	if (e == NULL || e->value == NULL) fputs("{}", out);
	else {
		fputs("{\"value\":", out);
		op_json_write(out, e->value);
		fputc('}', out);
	}
}

static void change(const op_value *r, FILE *out) {
	host_t *h;
	nd_entry *e = entry_of(r, out, &h);
	if (h == NULL) return;
	if (e == NULL) {
		fputs("{}", out);
		return;
	}
	ch_header c = e->change;
	c.has_op = 0;
	fputs("{\"change\":", out);
	hh_put_header(out, &c);
	fputc('}', out);
}

static void conflicts(const op_value *r, FILE *out) {
	host_t *h = of(r, "host", out);
	if (h == NULL) return;
	nd_entry *e = tb_get(h->table, tb_string("conflicts"), tb_string(id_of(op_get(r, "id"))));
	fputs("{\"conflicts\":[", out);
	const op_value *list = e != NULL ? e->value : NULL;
	for (size_t i = 0; list != NULL && list->type == OP_LIST && i < list->count; i++) {
		const op_value *c = list->items[i], *head = op_get(c, "head");
		if (i) fputc(',', out);
		fputs("{\"head\":", out);
		uint8_t *name;
		size_t n;
		if (head != NULL && head->type == OP_STR && cf_unhex(head->str, &name, &n) && n == 32) put_label(out, name);
		else op_json_write(out, head);
		fputs(",\"lamport\":", out);
		op_json_write(out, op_get(c, "lamport"));
		fputs(",\"actor\":", out);
		op_json_write(out, op_get(c, "actor"));
		fputs(",\"tables\":", out);
		op_json_write(out, op_get(c, "tables"));
		fputc('}', out);
	}
	fputs("]}", out);
}

// the "ephemeral" table's entry at the id: {under, on: [{by, name, tables, lamport}]}, name a commit
static void overlay(const op_value *r, FILE *out) {
	host_t *h = of(r, "host", out);
	if (h == NULL) return;
	nd_entry *e = tb_get(h->table, tb_string("ephemeral"), tb_string(id_of(op_get(r, "id"))));
	if (e == NULL || e->value == NULL) {
		fputs("{}", out);
		return;
	}
	fputs("{\"overlay\":{\"under\":", out);
	op_json_write(out, op_get(e->value, "under"));
	fputs(",\"on\":[", out);
	const op_value *list = op_get(e->value, "on");
	for (size_t i = 0; list != NULL && list->type == OP_LIST && i < list->count; i++) {
		const op_value *o = list->items[i], *name = op_get(o, "name");
		if (i) fputc(',', out);
		fputs("{\"by\":", out);
		op_json_write(out, op_get(o, "by"));
		fputs(",\"name\":", out);
		uint8_t *bytes;
		size_t n;
		if (name != NULL && name->type == OP_STR && cf_unhex(name->str, &bytes, &n) && n == 32) put_label(out, bytes);
		else op_json_write(out, name);
		fputs(",\"tables\":", out);
		op_json_write(out, op_get(o, "tables"));
		fputs(",\"lamport\":", out);
		op_json_write(out, op_get(o, "lamport"));
		fputc('}', out);
	}
	fputs("]}}", out);
}

// a commit's name (64 hex digits) as its label, else as it is
static void put_named(FILE *out, const op_value *v) {
	uint8_t *name;
	size_t n;
	if (v != NULL && v->type == OP_STR && strlen(v->str) == 64 && cf_unhex(v->str, &name, &n) && n == 32) put_label(out, name);
	else op_json_write(out, v);
}

// the "status" table's entry at the id: {waiting, refused, unsent, count}, each commit its label
static void status(const op_value *r, FILE *out) {
	host_t *h = of(r, "host", out);
	if (h == NULL) return;
	nd_entry *e = tb_get(h->table, tb_string("status"), tb_string(id_of(op_get(r, "id"))));
	if (e == NULL || e->value == NULL) {
		fputs("{}", out);
		return;
	}
	fputs("{\"status\":{", out);
	const char *lists[] = {"waiting", "refused"};
	for (int k = 0; k < 2; k++) {
		fprintf(out, "\"%s\":[", lists[k]);
		const op_value *list = op_get(e->value, lists[k]);
		for (size_t i = 0; list != NULL && list->type == OP_LIST && i < list->count; i++) {
			const op_value *row = list->items[i];
			if (i) fputc(',', out);
			fputc('{', out);
			for (size_t f = 0; row->type == OP_MAP && f < row->count; f++) {
				const char *key = row->keys[f];
				const op_value *v = row->items[f];
				if (f) fputc(',', out);
				fprintf(out, "\"%s\":", key);
				if (strcmp(key, "commit") == 0) put_named(out, v);
				else if (strcmp(key, "parents") == 0 && v->type == OP_LIST) {
					fputc('[', out);
					for (size_t p = 0; p < v->count; p++) {
						if (p) fputc(',', out);
						put_named(out, v->items[p]);
					}
					fputc(']', out);
				} else op_json_write(out, v);
			}
			fputc('}', out);
		}
		fputs("],", out);
	}
	fputs("\"unsent\":", out);
	op_json_write(out, op_get(e->value, "unsent"));
	fputs(",\"count\":", out);
	op_json_write(out, op_get(e->value, "count"));
	fputs("}}", out);
}

// the table's events at (table, id) since last asked
static void events(const op_value *r, FILE *out) {
	host_t *h = of(r, "host", out);
	if (h == NULL) return;
	char *key = formatString("%s %s", table_of(r), id_of(op_get(r, "id")));
	size_t count = 0;
	for (size_t i = 0; i < h->event_count; i++) {
		if (strcmp(h->events[i].key, key) != 0) continue;
		count = h->events[i].count;
		h->events[i].count = 0;
	}
	free(key);
	fprintf(out, "{\"events\":%zu}", count);
}

// each entry there already, its patches applied; then all told to sync at once: the commits made at
// the ids, in all
static void writes(const op_value *r, FILE *out) {
	host_t *h = of(r, "host", out);
	if (h == NULL) return;
	const op_value *ws = op_get(r, "writes");
	size_t n = ws != NULL && ws->type == OP_LIST ? ws->count : 0;
	nd_entry **changed = hh_take((n + 1) * sizeof *changed);
	const char **docs = hh_take((n + 1) * sizeof *docs);
	size_t doc_count = 0, before = 0, after = 0;
	keep_line();
	for (size_t i = 0; i < n; i++) {
		const op_value *w = ws->items[i];
		const char *part = table_of(w), *id = id_of(op_get(w, "id"));
		nd_entry *e = tb_get(h->table, tb_string(part), tb_string(id));
		if (e == NULL) {
			hh_error(out, "nothing at %s", id);
			return;
		}
		const op_value *ps = op_get(w, "patches");
		size_t pn = ps != NULL && ps->type == OP_LIST ? ps->count : 0;
		op_patch *patches = hh_take((pn + 1) * sizeof *patches);
		for (size_t k = 0; k < pn; k++) hh_patch(ps->items[k], &patches[k]);
		size_t failed;
		int code = nd_update(e, patches, pn, *hold_header(header_of(h, w)), &failed);
		if (code != OP_OK) {
			hh_error(out, "%s", op_code_name(code));
			return;
		}
		changed[i] = e;
		uint8_t bytes[32];
		bool seen = !tp_doc(id, bytes);
		for (size_t k = 0; k < doc_count && !seen; k++) seen = strcmp(docs[k], id) == 0;
		if (!seen) docs[doc_count++] = id;
	}
	const hy_kept **all;
	for (size_t k = 0; k < doc_count; k++) before += hy_all(tp_history(sy_device(h->sync), docs[k], TP_STORED), &all), free(all);
	sy_wrote(h->sync, changed, n);
	for (size_t k = 0; k < doc_count; k++) after += hy_all(tp_history(sy_device(h->sync), docs[k], TP_STORED), &all), free(all);
	fprintf(out, "{\"commits\":%zu}", after - before);
}

static hy_history *history_of(const op_value *r, FILE *out, host_t **h) {
	*h = of(r, "host", out);
	if (*h == NULL) return NULL;
	const char *id = id_of(op_get(r, "id"));
	const char *layer = hh_str(r, "layer");
	tp_layer l = layer != NULL && strcmp(layer, "ephemeral") == 0 ? TP_EPHEMERAL : TP_STORED;
	hy_history *history = tp_history(sy_device((*h)->sync), id, l);
	if (history == NULL) hh_error(out, "not a document id: %s", id);
	return history;
}

static void heads(const op_value *r, FILE *out) {
	host_t *h;
	hy_history *history = history_of(r, out, &h);
	if (history == NULL) return;
	const hy_kept **list;
	size_t n = hy_heads(history, &list);
	fputs("{\"heads\":[", out);
	for (size_t i = 0; i < n; i++) {
		if (i) fputc(',', out);
		put_label(out, list[i]->name);
	}
	fputs("]}", out);
	free(list);
}

static void commits(const op_value *r, FILE *out) {
	host_t *h;
	hy_history *history = history_of(r, out, &h);
	if (history == NULL) return;
	const hy_kept **all;
	size_t n = hy_all(history, &all);
	free(all);
	fprintf(out, "{\"commits\":%zu}", n);
}

static void commit(const op_value *r, FILE *out) {
	host_t *h;
	hy_history *history = history_of(r, out, &h);
	uint8_t name[32];
	if (history == NULL || !name_of(op_get(r, "commit"), name, out)) return;
	const hy_kept *k = hy_get(history, name);
	cm_commit c;
	if (k == NULL || cm_decode(k->bytes, k->length, &c, NULL) != CM_OK) {
		fputs("{}", out);
		return;
	}
	fputs("{\"commit\":", out);
	cf_put_commit(out, &c, put_name, NULL);
	fputc('}', out);
	cm_free(&c);
}

static void get(const op_value *r, FILE *out) {
	host_t *h;
	hy_history *history = history_of(r, out, &h);
	uint8_t name[32];
	if (history == NULL || !name_of(op_get(r, "commit"), name, out)) return;
	rp_tables t;
	if (sy_get(h->sync, id_of(op_get(r, "id")), name, &t) != RP_OK) {
		fputs("{}", out);
		return;
	}
	fputs("{\"tables\":{", out);
	for (size_t i = 0; i < t.length; i++) {
		if (i) fputc(',', out);
		op_json_string(out, t.slots[i].table);
		fputc(':', out);
		hh_put_entry(out, t.slots[i].entry);
	}
	fputs("}}", out);
	rp_free(&t);
}

static void stored(const op_value *r, FILE *out) {
	host_t *h;
	if (history_of(r, out, &h) == NULL) return;
	uint8_t(*list)[32];
	size_t n = tp_stored(sy_device(h->sync), id_of(op_get(r, "id")), &list);
	free(list);
	fprintf(out, "{\"stored\":%zu}", n);
}

static void fragments(const op_value *r, FILE *out) {
	host_t *h;
	if (history_of(r, out, &h) == NULL) return;
	const fragment **list;
	size_t n = tp_fragments(sy_device(h->sync), id_of(op_get(r, "id")), &list);
	free(list);
	fprintf(out, "{\"fragments\":%zu}", n);
}

// the host's ephemeral tables from now
static void ephemeral(const op_value *r, FILE *out) {
	host_t *h = of(r, "host", out);
	if (h == NULL) return;
	ephemeral_set(h, op_get(r, "tables"));
	fputs("{}", out);
}

// the clock moved on, every host run
static void advance(const op_value *r, FILE *out) {
	const op_value *ms = op_get(r, "ms");
	wr_ms += ms != NULL && ms->type == OP_NUM ? (uint64_t)ms->num : 0;
	run_all();
	fputs("{}", out);
}

static void standing(const op_value *r, FILE *out) {
	host_t *h = of(r, "host", out);
	if (h == NULL) return;
	sy_standing_row *rows;
	size_t n = sy_standing(h->sync, id_of(op_get(r, "id")), &rows);
	fputs("{\"standing\":[", out);
	for (size_t i = 0; i < n; i++) {
		if (i) fputc(',', out);
		fputc('[', out);
		cf_put_hex(out, rows[i].key, SL_KEY);
		fputc(',', out);
		put_label(out, rows[i].tip);
		fputc(']', out);
	}
	fputs("]}", out);
	free(rows);
}

void hh_finish(void) {
	for (size_t i = 0; i < host_count; i++) host_free(hosts[i]);
	free(hosts);
	wr_free();
	for (size_t i = 0; i < line_count; i++) hh_release(lines[i]);
	free(lines);
	for (size_t i = 0; i < count_count; i++) free(counts[i].name);
	free(counts);
	for (size_t i = 0; i < id_count; i++) free(ids[i].label), free(ids[i].id);
	free(ids);
	for (size_t i = 0; i < name_count; i++) free(names[i].label);
	free(names);
	im_free(&labels);
}

void hh_answer(const op_value *r, FILE *out) {
	const char *op = hh_str(r, "op");
	if (op == NULL) hh_unknown(out, r);
	else if (strcmp(op, "host") == 0) host(r, out);
	else if (strcmp(op, "restart") == 0) restart(r, out);
	else if (strcmp(op, "close") == 0) close_host(r, out);
	else if (strcmp(op, "use") == 0) use(r, out);
	else if (strcmp(op, "connect") == 0) join_hosts(r, out);
	else if (strcmp(op, "disconnect") == 0) disconnect(r, out);
	else if (strcmp(op, "follow") == 0) follow(r, out);
	else if (strcmp(op, "mint") == 0) mint(r, out);
	else if (strcmp(op, "write") == 0) counting(r, W_WRITE, out);
	else if (strcmp(op, "type") == 0) counting(r, W_TYPE, out);
	else if (strcmp(op, "remove") == 0) counting(r, W_REMOVE, out);
	else if (strcmp(op, "settle") == 0) counting(r, W_SETTLE, out);
	else if (strcmp(op, "quiet") == 0) {
		if (quiet()) fputs("{}", out);
		else hh_error(out, "never quiet");
	} else if (strcmp(op, "read") == 0) read_entry(r, out);
	else if (strcmp(op, "change") == 0) change(r, out);
	else if (strcmp(op, "conflicts") == 0) conflicts(r, out);
	else if (strcmp(op, "status") == 0) status(r, out);
	else if (strcmp(op, "events") == 0) events(r, out);
	else if (strcmp(op, "writes") == 0) writes(r, out);
	else if (strcmp(op, "heads") == 0) heads(r, out);
	else if (strcmp(op, "commits") == 0) commits(r, out);
	else if (strcmp(op, "commit") == 0) commit(r, out);
	else if (strcmp(op, "get") == 0) get(r, out);
	else if (strcmp(op, "stored") == 0) stored(r, out);
	else if (strcmp(op, "fragments") == 0) fragments(r, out);
	else if (strcmp(op, "ephemeral") == 0) ephemeral(r, out);
	else if (strcmp(op, "stop") == 0) stop(r, out);
	else if (strcmp(op, "advance") == 0) advance(r, out);
	else if (strcmp(op, "standing") == 0) standing(r, out);
	else if (strcmp(op, "overlay") == 0) overlay(r, out);
	else hh_unknown(out, r);
}
