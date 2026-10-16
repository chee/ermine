// The integration with the table (sync.h), in C. Laid out as sync.ts is: what a commit carries of a
// change, the check (on the head shown: applied to the table; elsewhere: to that head's own tables, or
// a replay), what arrives, the conflicts, and what goes out
#include "sync.h"

#include "ids.h"
#include "snapshot.h"

#include "../../../core/node/c/update.h"
#include "../../../ermine/encoding/c/cbor.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SET ((void *)1)

static const char *const DEFAULT_TABLES[] = {"value", "attributes", "children"};

// ---- headers sync keeps

// a change header and everything it refers to, its own
typedef struct {
	ch_header h;
	op_value *actor;
	char *reader;
	ch_site *external;
	ch_entry *metadata;
} header_t;

static header_t *header_new(void) {
	header_t *c = calloc(1, sizeof *c);
	if (c == NULL) abort();
	return c;
}

// a copy of the header (never its op): the values held, the rest copied
static header_t *header_copy(const ch_header *in) {
	header_t *c = header_new();
	c->h.has_time = in->has_time;
	c->h.time = in->time;
	if (in->actor != NULL) c->h.actor = c->actor = op_ref((op_value *)in->actor);
	if (in->reader != NULL) c->h.reader = c->reader = copyString(in->reader);
	if (in->external != NULL) {
		c->external = calloc(in->external_length + 1, sizeof *c->external);
		if (c->external == NULL) abort();
		for (size_t i = 0; i < in->external_length; i++) {
			c->external[i] = in->external[i];
			c->external[i].file = copyString(in->external[i].file ? in->external[i].file : "");
			if (in->external[i].function != NULL) c->external[i].function = copyString(in->external[i].function);
		}
		c->h.external = c->external;
		c->h.external_length = in->external_length;
	}
	if (in->metadata != NULL) {
		c->metadata = calloc(in->metadata_length + 1, sizeof *c->metadata);
		if (c->metadata == NULL) abort();
		for (size_t i = 0; i < in->metadata_length; i++) {
			c->metadata[i].key = copyString(in->metadata[i].key);
			c->metadata[i].value = op_ref((op_value *)in->metadata[i].value);
		}
		c->h.metadata = c->metadata;
		c->h.metadata_length = in->metadata_length;
	}
	return c;
}

// what sync stamps itself: the time, and no actor
static header_t *stamp(int64_t time) {
	header_t *c = header_new();
	c->h.has_time = 1;
	c->h.time = time;
	c->h.actor = c->actor = op_null();
	return c;
}

static void header_free(header_t *c) {
	if (c == NULL) return;
	op_free(c->actor);
	free(c->reader);
	for (size_t i = 0; c->external != NULL && i < c->h.external_length; i++) {
		free((char *)c->external[i].file);
		free((char *)c->external[i].function);
	}
	free(c->external);
	for (size_t i = 0; c->metadata != NULL && i < c->h.metadata_length; i++) {
		free((char *)c->metadata[i].key);
		op_free((op_value *)c->metadata[i].value);
	}
	free(c->metadata);
	free(c);
}

// ---- state

// what an entry's change refers to, when sync wrote it, and where sync put it (by its key's hash);
// mine: sync made the entry
typedef struct {
	nd_entry *entry;
	bool mine, placed, has_commit;
	cm_commit commit;
	header_t *header;
	uint8_t at[32];
} hold_t;

// a stored entry under an overlaid table: its value (NULL: none) and change, sync's own
typedef struct {
	op_value *value;
	header_t *change;
} slot_t;

// a device's standing ephemeral commits at a node: its key, the newest (tip, the ephemeral
// history's), the highest lamport of the stored commits they went on (base), the tables they touched,
// the tables at the tip (sync's own), when it was last heard from (this device's: last sent), ms
typedef struct {
	uint8_t who[32];
	const hy_kept *tip;
	int64_t base;
	char **tables;
	size_t tables_count;
	rp_tables *node;
	uint64_t at;
} chain_t;

// a kept node: the head its tables show; its heads that don't show, each one's tables (sync's own,
// from replays and commits decoded, never shared); the bytes of its commits taken before each and it,
// by name, and in all; the last snapshot's place and size
typedef struct {
	char id[9 + 64 + 1];
	uint8_t bytes[32];
	const hy_kept *shown;
	im_map others;
	im_map placed;
	size_t total;
	bool has_last, dirty;
	size_t last_at, last_size;
	// with a rule: the heads whose merge the table shows, when it shows one (else shown's)
	const hy_kept **merged;
	size_t merged_count;
	bool has_merged;
	// with a rule, what the node showed, packed then, the last STATES: the tables at a merge commit
	// that was its one head, and the merge of heads shown (unless the rule keeps its work), by their
	// names (hex, sorted, spaced), oldest first. where a later merge starts from, and a replay through
	// them, without merging again
	struct state_t *states;
	size_t states_count;
	// the rule in use's state for this node, when it keeps one (create), and that rule
	void *walker;
	const rp_rule *walker_rule;
	// the rules handed to a replay or a merge: each known one, the rule in use with walker
	rp_merge *rules;
	// ephemeral: the standing chains, in the order they came; what each kept table shows when
	// overlaid (a tip's name as hex, "merge" and the names merged, "" to be shown again; NULL: the
	// stored), and the stored entry under it; the highest lamport (+1) of a stored commit from each
	// signer
	chain_t *chains;
	size_t chains_count;
	char **over;
	slot_t *under;
	im_map latest;
} node_t;

#define STATES 16
typedef struct state_t {
	char *key;
	uint8_t *bytes;
	size_t length;
} state_t;

struct sy_sync {
	tb_table *table;
	tp_device *device;
	sy_random_fn random;
	sy_time_fn time;
	tp_clock_fn now;
	void *clock;
	bool zeros;
	char **tables;
	size_t tables_length;
	// the rules known, and the one in use (NULL: none)
	const rp_rule **merges;
	size_t merges_length;
	const rp_rule *rule;
	sy_commit_fn commit;
	sy_drop_fn drop;
	sy_ephemeral_fn ephemeral;
	uint64_t beat, ttl;
	void *context;
	// an ephemeral commit's tables, made in its check, by name, until it arrives
	im_map fresh;
	// this device's count of commits, from a random start: two devices with one key don't count alike
	int64_t nonce;
	im_map followed;
	im_map nodes;
	node_t **list;
	size_t list_count, list_room;
	// commits applied to the table in their check, by name: they are the head shown once taken
	im_map stepped;
	// nodes whose conflicts are to be worked out again: once a batch, not once a commit
	node_t **dirty;
	size_t dirty_count, dirty_room;
	// by entry, and by key
	im_map holds, at;
	// writing what came in: the table's events are sync's own, and go out as nothing
	bool applying;
};

static void random_of(sy_sync *s, uint8_t *out, size_t n) {
	if (s->random != NULL) s->random(s->context, out, n);
	else erm_host_random(out, n);
}

static int64_t now_of(sy_sync *s) {
	if (s->time != NULL) return s->time(s->context);
	uint64_t ms = s->now != NULL ? s->now(s->clock) : erm_host_now();
	return (int64_t)(ms / 1000);
}

static bool kept_table(const sy_sync *s, const char *table) {
	for (size_t i = 0; table != NULL && i < s->tables_length; i++)
		if (strcmp(s->tables[i], table) == 0) return true;
	return false;
}

static bool kept(const sy_sync *s, tb_key part, tb_key id) {
	uint8_t bytes[32];
	return part.symbol == NULL && id.symbol == NULL && part.string != NULL && tp_doc(id.string, bytes) &&
		kept_table(s, part.string);
}

static node_t *node_of(sy_sync *s, const char *id) {
	uint8_t bytes[32];
	if (!tp_doc(id, bytes)) return NULL;
	node_t *nd = im_get(&s->nodes, bytes);
	if (nd != NULL) return nd;
	nd = calloc(1, sizeof *nd);
	if (nd == NULL) abort();
	memcpy(nd->bytes, bytes, 32);
	memcpy(nd->id, id, sizeof nd->id - 1);
	im_set(&s->nodes, bytes, nd);
	if (s->list_count == s->list_room) {
		s->list_room = s->list_room ? s->list_room * 2 : 8;
		s->list = realloc(s->list, s->list_room * sizeof *s->list);
		if (s->list == NULL) abort();
	}
	s->list[s->list_count++] = nd;
	return nd;
}

// the bytes of the node's commits taken before this one and it
static void grew(node_t *nd, const uint8_t name[32], size_t bytes) {
	nd->total += bytes;
	im_set(&nd->placed, name, (void *)(uintptr_t)nd->total);
}

static void tables_free(rp_tables *t) {
	if (t == NULL) return;
	rp_free(t);
	free(t);
}

// ---- overlays' state

// the kept table's index, or tables_length
static size_t table_index(const sy_sync *s, const char *table) {
	size_t i = 0;
	while (table != NULL && i < s->tables_length && strcmp(s->tables[i], table) != 0) i++;
	return table == NULL ? s->tables_length : i;
}

static bool overlaid(const node_t *nd, size_t i) {
	return nd->over != NULL && nd->over[i] != NULL;
}

static void overlay_room(const sy_sync *s, node_t *nd) {
	if (nd->over != NULL) return;
	nd->over = calloc(s->tables_length + 1, sizeof *nd->over);
	nd->under = calloc(s->tables_length + 1, sizeof *nd->under);
	if (nd->over == NULL || nd->under == NULL) abort();
}

static void slot_clear(slot_t *u) {
	op_free(u->value);
	header_free(u->change);
	*u = (slot_t){0};
}

static void over_set(node_t *nd, size_t i, const char *mark) {
	free(nd->over[i]);
	nd->over[i] = mark != NULL ? copyString(mark) : NULL;
}

static void chain_free(chain_t *c) {
	for (size_t i = 0; i < c->tables_count; i++) free(c->tables[i]);
	free(c->tables);
	tables_free(c->node);
}

static chain_t *chain_of(node_t *nd, const uint8_t who[32]) {
	for (size_t i = 0; i < nd->chains_count; i++)
		if (memcmp(nd->chains[i].who, who, 32) == 0) return &nd->chains[i];
	return NULL;
}

// what fleeting made for an arrival to come, by name: the chain's tables, gone with it
static void unfresh(sy_sync *s, const rp_tables *node) {
	uint8_t(*keys)[32] = malloc(s->fresh.count * 32 + 1);
	if (keys == NULL) abort();
	size_t n = 0;
	for (size_t i = 0; i < s->fresh.slots; i++)
		if (s->fresh.used[i] && s->fresh.values[i] == node) memcpy(keys[n++], s->fresh.keys[i], 32);
	for (size_t i = 0; i < n; i++) im_del(&s->fresh, keys[i]);
	free(keys);
}

static void chain_drop(sy_sync *s, node_t *nd, chain_t *c) {
	unfresh(s, c->node);
	chain_free(c);
	size_t i = (size_t)(c - nd->chains);
	memmove(&nd->chains[i], &nd->chains[i + 1], (nd->chains_count - i - 1) * sizeof *nd->chains);
	nd->chains_count--;
}

static bool touched(const chain_t *c, const char *table) {
	for (size_t i = 0; i < c->tables_count; i++)
		if (strcmp(c->tables[i], table) == 0) return true;
	return false;
}

static void touch(chain_t *c, const char *table) {
	if (touched(c, table)) return;
	c->tables = realloc(c->tables, (c->tables_count + 1) * sizeof *c->tables);
	if (c->tables == NULL) abort();
	c->tables[c->tables_count++] = copyString(table);
}

static void hex_name(const uint8_t name[32], char out[65]) {
	for (int b = 0; b < 32; b++) snprintf(out + 2 * b, 3, "%02x", name[b]);
}

// ---- merging's state

static const rp_rule *rule_named(const sy_sync *s, const char *name) {
	for (size_t i = 0; name != NULL && i < s->merges_length; i++)
		if (strcmp(s->merges[i]->name, name) == 0) return s->merges[i];
	return NULL;
}

static void merged_clear(node_t *nd) {
	free(nd->merged);
	nd->merged = NULL;
	nd->merged_count = 0;
	nd->has_merged = false;
}

static bool same_heads(const hy_kept *const *a, size_t n, const uint8_t (*b)[32], size_t m) {
	if (n != m) return false;
	for (size_t i = 0; i < n; i++) {
		bool found = false;
		for (size_t j = 0; !found && j < m; j++) found = memcmp(a[i]->name, b[j], 32) == 0;
		if (!found) return false;
	}
	return true;
}
static bool same_kept(const hy_kept *const *a, size_t n, const hy_kept *const *b, size_t m) {
	if (n != m) return false;
	for (size_t i = 0; i < n; i++) {
		bool found = false;
		for (size_t j = 0; !found && j < m; j++) found = memcmp(a[i]->name, b[j]->name, 32) == 0;
		if (!found) return false;
	}
	return true;
}

static int by_text(const void *a, const void *b) { return strcmp(*(char *const *)a, *(char *const *)b); }

// several commits' key: their names' hex, sorted, spaced; malloc'd
static char *names_key(const hy_kept *const *heads, const uint8_t (*names)[32], size_t n) {
	char **each = malloc((n + 1) * sizeof *each), *out = malloc(n * 65 + 1);
	if (each == NULL || out == NULL) abort();
	for (size_t i = 0; i < n; i++) {
		each[i] = malloc(65);
		if (each[i] == NULL) abort();
		const uint8_t *name = heads != NULL ? heads[i]->name : names[i];
		for (int b = 0; b < 32; b++) snprintf(each[i] + 2 * b, 3, "%02x", name[b]);
	}
	qsort(each, n, sizeof *each, by_text);
	size_t at = 0;
	for (size_t i = 0; i < n; i++) {
		if (i) out[at++] = ' ';
		memcpy(out + at, each[i], 64);
		at += 64;
		free(each[i]);
	}
	out[at] = 0;
	free(each);
	return out;
}

static void states_clear(node_t *nd) {
	for (size_t i = 0; i < nd->states_count; i++) free(nd->states[i].key), free(nd->states[i].bytes);
	free(nd->states);
	nd->states = NULL;
	nd->states_count = 0;
}

// the tables packed, kept under key (taken), the newest; the oldest let go of past STATES
static void keep_state(node_t *nd, char *key, const rp_tables *t) {
	uint8_t *bytes;
	size_t length;
	if (sn_snapshot(t, &bytes, &length) != PK_OK) {
		free(key);
		return;
	}
	for (size_t i = 0; i < nd->states_count; i++) {
		if (strcmp(nd->states[i].key, key) != 0) continue;
		free(nd->states[i].key), free(nd->states[i].bytes);
		memmove(&nd->states[i], &nd->states[i + 1], (nd->states_count - i - 1) * sizeof *nd->states);
		nd->states_count--;
		break;
	}
	nd->states = realloc(nd->states, (nd->states_count + 1) * sizeof *nd->states);
	if (nd->states == NULL) abort();
	nd->states[nd->states_count++] = (state_t){key, bytes, length};
	if (nd->states_count > STATES) {
		free(nd->states[0].key), free(nd->states[0].bytes);
		memmove(&nd->states[0], &nd->states[1], (nd->states_count - 1) * sizeof *nd->states);
		nd->states_count--;
	}
}

// the tables kept under key, new ones in out (rp_init'd, empty)
static bool state_of(const node_t *nd, const char *key, rp_tables *out) {
	for (size_t i = 0; i < nd->states_count; i++)
		if (strcmp(nd->states[i].key, key) == 0) return sn_tables(nd->states[i].bytes, nd->states[i].length, out) == PK_OK;
	return false;
}

static void walker_drop(node_t *nd) {
	if (nd->walker != NULL && nd->walker_rule->free != NULL) nd->walker_rule->free(nd->walker);
	nd->walker = NULL;
	nd->walker_rule = NULL;
}

// the node's rules: each known one; the one in use with its own state, when it keeps one
static rp_merges rules_of(sy_sync *s, node_t *nd) {
	if (s->rule != NULL && s->rule->create != NULL && nd->walker == NULL) {
		nd->walker = s->rule->create();
		nd->walker_rule = s->rule;
	}
	if (nd->rules == NULL) {
		nd->rules = calloc(s->merges_length + 1, sizeof *nd->rules);
		if (nd->rules == NULL) abort();
	}
	for (size_t i = 0; i < s->merges_length; i++)
		nd->rules[i] = (rp_merge){s->merges[i], s->merges[i] == s->rule ? nd->walker : NULL};
	return (rp_merges){nd->rules, s->merges_length};
}

// ---- what sync holds for entries

static void key_of(const void *entry, uint8_t key[32]) {
	uintptr_t p = (uintptr_t)entry;
	uint64_t mixed = (uint64_t)p * 0x9e3779b97f4a7c15ull;
	memset(key, 0, 32);
	memcpy(key, &mixed, sizeof mixed);
	memcpy(key + 8, &p, sizeof p);
}

static void where(const char *part, const char *id, uint8_t at[32]) {
	size_t a = strlen(part), b = strlen(id);
	char *both = malloc(a + b + 2);
	if (both == NULL) abort();
	memcpy(both, part, a + 1);
	memcpy(both + a + 1, id, b + 1);
	cm_name((const uint8_t *)both, a + b + 2, at);
	free(both);
}

static void forget(hold_t *h) {
	if (h->has_commit) cm_free(&h->commit);
	h->has_commit = false;
	header_free(h->header);
	h->header = NULL;
}

// the entry's hold, made when there is none: mine when sync made the entry; now at (part, id)
static hold_t *hold(sy_sync *s, nd_entry *e, const char *part, const char *id, bool mine) {
	uint8_t key[32], at[32];
	key_of(e, key);
	hold_t *h = im_get(&s->holds, key);
	if (h == NULL) {
		h = calloc(1, sizeof *h);
		if (h == NULL) abort();
		h->entry = e;
		h->mine = mine;
		im_set(&s->holds, key, h);
	}
	where(part, id, at);
	if (!h->placed || memcmp(h->at, at, 32) != 0) {
		if (h->placed && im_get(&s->at, h->at) == h) im_del(&s->at, h->at);
		memcpy(h->at, at, 32);
		h->placed = true;
	}
	im_set(&s->at, at, h);
	return h;
}

// what the entry's change refers to now: a commit (taken), or a header
static void hold_commit(hold_t *h, cm_commit *c) {
	forget(h);
	h->commit = *c;
	h->has_commit = true;
	*c = (cm_commit){0};
}

static void hold_header(hold_t *h, header_t *c) {
	forget(h);
	h->header = c;
}

// the hold let go of, and the entry with it when it is sync's and in the table no more
static void unhold(sy_sync *s, hold_t *h) {
	uint8_t key[32];
	key_of(h->entry, key);
	im_del(&s->holds, key);
	if (h->placed && im_get(&s->at, h->at) == h) im_del(&s->at, h->at);
	forget(h);
	if (h->mine) {
		size_t n;
		tb_who(s->table, h->entry, &n);
		if (n == 0) nd_free_entry(h->entry);
	}
	free(h);
}

// an entry sync took out of the table, or replaced: its own let go of, the host's given back
static void gone(sy_sync *s, nd_entry *e) {
	uint8_t key[32];
	key_of(e, key);
	hold_t *h = im_get(&s->holds, key);
	bool mine = h != NULL && h->mine;
	if (h != NULL) unhold(s, h);
	if (!mine && s->drop != NULL) s->drop(s->context, e);
}

// the host's event at a key where sync holds an entry: one no longer there is let go of
static void notice(sy_sync *s, tb_key part, tb_key id) {
	if (part.symbol != NULL || id.symbol != NULL || part.string == NULL || id.string == NULL) return;
	uint8_t at[32];
	where(part.string, id.string, at);
	hold_t *h = im_get(&s->at, at);
	if (h != NULL && tb_get(s->table, part, id) != h->entry) unhold(s, h);
}

// ---- what a commit carries of a change

// what of a change header a commit can carry: metadata pairs that encode, an actor that does (else
// null), the time (else now)
typedef struct {
	ch_header h;
	op_value *null;
	ch_entry *metadata;
} carried_t;

static bool carries(const void *value) {
	Json *j = pk_to_json(value);
	size_t n;
	const char *why;
	bool ok = j != NULL && cborEncode(j, NULL, 0, &n, &why);
	jsonFree(j);
	return ok;
}

static void carry(sy_sync *s, const ch_header *change, carried_t *out) {
	*out = (carried_t){0};
	out->h.has_time = 1;
	out->h.time = change != NULL && change->has_time ? change->time : now_of(s);
	const void *actor = change != NULL ? change->actor : NULL;
	if (actor == NULL || !carries(actor)) actor = out->null = op_null();
	out->h.actor = actor;
	if (change == NULL) return;
	out->h.reader = change->reader;
	if (change->external != NULL && change->external_length > 0) {
		out->h.external = change->external;
		out->h.external_length = change->external_length;
	}
	if (change->metadata != NULL) {
		out->metadata = malloc((change->metadata_length + 1) * sizeof *out->metadata);
		if (out->metadata == NULL) abort();
		size_t n = 0;
		for (size_t i = 0; i < change->metadata_length; i++)
			if (change->metadata[i].key != NULL && carries(change->metadata[i].value)) out->metadata[n++] = change->metadata[i];
		if (n > 0) out->h.metadata = out->metadata, out->h.metadata_length = n;
	}
}

static void carried_free(carried_t *c) {
	op_free(c->null);
	free(c->metadata);
}

// ---- replays

typedef struct {
	sy_sync *s;
	const char *doc;
} replaying_t;

// a node's tables at a commit when kept: a fragment's snapshot, or a state kept here
static bool snapshots(void *context, const uint8_t name[32], rp_tables *out) {
	const replaying_t *r = context;
	if (tp_snapshot(r->s->device, r->doc, name, out)) return true;
	char *key = names_key(NULL, (const uint8_t(*)[32])name, 1);
	bool got = state_of(node_of(r->s, r->doc), key, out);
	free(key);
	return got;
}

// the node's tables at a commit, new ones: none when it is not taken in
static void replayed(sy_sync *s, const char *doc, const uint8_t name[32], rp_tables *out) {
	replaying_t r = {s, doc};
	rp_merges m = rules_of(s, node_of(s, doc));
	if (rp_replay(tp_history(s->device, doc, TP_STORED), name, snapshots, &r, &m, out) != RP_OK) rp_init(out);
}

typedef struct {
	sy_sync *s;
	const char *doc;
	const rp_rule *by;
} merging_t;

// what a rule is given: one commit's tables had without merging; several, when the rule in use
// merged them here and kept them
static bool merge_get(void *context, const hy_kept *const *from, size_t n, rp_tables *out) {
	const merging_t *m = context;
	if (n == 1) {
		replaying_t r = {m->s, m->doc};
		rp_tables t;
		if (rp_plain(tp_history(m->s->device, m->doc, TP_STORED), from[0]->name, snapshots, &r, &t) != RP_OK)
			return false;
		rp_free(out);
		*out = t;
		return true;
	}
	if (m->by != m->s->rule) return false;
	char *key = names_key(from, NULL, n);
	bool got = state_of(node_of(m->s, m->doc), key, out);
	free(key);
	return got;
}

// heads merged by a rule: new tables in out
static void merge_of(sy_sync *s, const char *doc, const hy_kept *const *heads, size_t n, const rp_rule *by,
	rp_tables *out) {
	rp_merges rules = rules_of(s, node_of(s, doc));
	const rp_merge *m = rp_merge_find(&rules, by->name);
	merging_t c = {s, doc, by};
	rp_init(out);
	m->rule->merge(m->state, tp_history(s->device, doc, TP_STORED), heads, n, merge_get, &c, out);
}

static rp_tables *replayed_new(sy_sync *s, const char *doc, const uint8_t name[32]) {
	rp_tables *t = malloc(sizeof *t);
	if (t == NULL) abort();
	replayed(s, doc, name, t);
	return t;
}

// ---- the check

static hy_refusal fleeting(sy_sync *s, const char *doc, const hy_kept *kept, const cm_commit *commit);
static void heard(sy_sync *s, const char *doc, const hy_kept *kept);
static void ended(sy_sync *s, const char *doc, const hy_kept *kept);
static void landed(sy_sync *s, node_t *nd, const char *part, bool all, op_value *stored, const ch_header *change);
static void show(sy_sync *s, node_t *nd, bool again);

// a commit on the head shown, applied to its table's entry: update is its check
static bool step(sy_sync *s, const char *doc, const hy_kept *kept) {
	cm_commit own;
	if (cm_decode(kept->bytes, kept->length, &own, NULL) != CM_OK) return false;
	// overlaid: the stored entry is sync's own, under it
	node_t *nd = node_of(s, doc);
	size_t at = table_index(s, own.table);
	if (at < s->tables_length && overlaid(nd, at)) {
		slot_t *u = &nd->under[at];
		op_value *after;
		size_t failed;
		bool applies = op_apply(u->value, own.patches, own.patches_length, NULL, &after, &failed) == OP_OK;
		if (applies) {
			header_t *c = header_copy(&own.change);
			slot_clear(u);
			u->value = after;
			u->change = c;
		}
		cm_free(&own);
		if (!applies) return false;
		im_set(&s->stepped, kept->name, SET);
		return true;
	}
	tb_key part = tb_string(own.table), id = tb_string(doc);
	bool was = s->applying, ok = true;
	s->applying = true;
	nd_entry *e = tb_get(s->table, part, id);
	if (e == NULL) {
		op_value *after;
		size_t failed;
		if (op_apply(NULL, own.patches, own.patches_length, NULL, &after, &failed) != OP_OK) ok = false;
		else if (after != NULL) {
			nd_entry *n = nd_make_entry(after, &own.change, NULL);
			if (n == NULL) abort();
			op_free(after);
			hold_t *h = hold(s, n, own.table, doc, true);
			hold_commit(h, &own);
			tb_add(s->table, part, id, n);
		}
	} else {
		size_t failed;
		if (nd_update(e, own.patches, own.patches_length, own.change, &failed) != OP_OK) ok = false;
		else {
			hold_t *h = hold(s, e, own.table, doc, false);
			char *table = copyString(own.table);
			hold_commit(h, &own);
			if (e->value == NULL) {
				tb_del(s->table, tb_string(table), id);
				gone(s, e);
			} else if (s->commit != NULL) s->commit(s->context, &e, 1);
			free(table);
		}
	}
	cm_free(&own);
	s->applying = was;
	if (!ok) return false;
	im_set(&s->stepped, kept->name, SET);
	return true;
}

// the commit applied to new tables of its own, kept as the head's it makes (any its parent had let go
// of); false: it does not apply, nothing kept
static bool moved_on(node_t *nd, const hy_kept *kept, rp_tables *node) {
	cm_commit own;
	bool ok = cm_decode(kept->bytes, kept->length, &own, NULL) == CM_OK;
	if (ok && rp_apply(node, &own) != RP_OK) {
		cm_free(&own);
		ok = false;
	}
	if (!ok) return false;
	rp_tables *old = im_del(&nd->others, kept->name);
	if (old != node) tables_free(old);
	im_set(&nd->others, kept->name, node);
	return true;
}

// does a commit from elsewhere apply to its parent's node: on the head shown, applied to the table as
// it is checked; on a head that doesn't show, applied to that head's own tables; else on a replay,
// kept as the new head's. A merge: on the table when it shows that merge, else on the merge made now
static hy_refusal check(void *context, const char *doc, const hy_kept *kept, const cm_commit *commit,
	tp_layer layer) {
	sy_sync *s = context;
	const rp_rule *by = commit->merge != NULL ? rule_named(s, commit->merge) : NULL;
	if (commit->merge != NULL && by == NULL) return HY_MERGE;
	// the ephemeral history also holds every stored commit, checked already; what is only ephemeral
	// is checked on the tables it goes on
	if (layer != TP_STORED) {
		if (hy_get(tp_history(s->device, doc, TP_STORED), kept->name) != NULL) return 0;
		return fleeting(s, doc, kept, commit);
	}
	node_t *nd = node_of(s, doc);
	grew(nd, kept->name, kept->length);
	if (by != NULL) {
		if (nd->has_merged && by == s->rule &&
			same_heads(nd->merged, nd->merged_count, commit->parents, commit->parents_length) &&
			kept_table(s, commit->table))
			return step(s, doc, kept) ? 0 : HY_PATCHES;
		hy_history *history = tp_history(s->device, doc, TP_STORED);
		const hy_kept **heads = malloc((commit->parents_length + 1) * sizeof *heads);
		if (heads == NULL) abort();
		for (size_t i = 0; i < commit->parents_length; i++) heads[i] = hy_get(history, commit->parents[i]);
		rp_tables *node = malloc(sizeof *node);
		if (node == NULL) abort();
		merge_of(s, doc, heads, commit->parents_length, by, node);
		free(heads);
		if (!moved_on(nd, kept, node)) {
			tables_free(node);
			return HY_PATCHES;
		}
		return 0;
	}
	const hy_kept *head = nd->shown;
	bool single = commit->parents_length == 1;
	bool on = commit->parents_length == 0 ? head == NULL
					       : head != NULL && single && memcmp(commit->parents[0], head->name, 32) == 0;
	if (on && kept_table(s, commit->table)) return step(s, doc, kept) ? 0 : HY_PATCHES;
	// a head that doesn't show, moved on in place: what it held goes with it
	rp_tables *node = single ? im_get(&nd->others, commit->parents[0]) : NULL;
	bool fresh = node == NULL;
	if (fresh) {
		node = malloc(sizeof *node);
		if (node == NULL) abort();
		if (kept->has_base) replayed(s, doc, kept->base, node);
		else rp_init(node);
	}
	cm_commit own;
	bool ok = cm_decode(kept->bytes, kept->length, &own, NULL) == CM_OK;
	if (ok && rp_apply(node, &own) != RP_OK) {
		cm_free(&own);
		ok = false;
	}
	if (!ok) {
		if (fresh) tables_free(node);
		return HY_PATCHES;
	}
	if (!fresh) im_del(&nd->others, commit->parents[0]);
	rp_tables *old = im_del(&nd->others, kept->name);
	if (old != node) tables_free(old);
	im_set(&nd->others, kept->name, node);
	return 0;
}

// ---- snapshots

// the kept tables as the table holds them, each change as a commit carries it (so a snapshot reads as
// a replay would): the head shown's node, into t (made here). What the changes refer to: the list
// given back, carried_list_free it after t
static carried_t *from_table(sy_sync *s, const char *doc, rp_tables *t) {
	rp_init(t);
	carried_t *carried = calloc(s->tables_length + 1, sizeof *carried);
	if (carried == NULL) abort();
	node_t *nd = node_of(s, doc);
	for (size_t i = 0; i < s->tables_length; i++) {
		if (overlaid(nd, i)) {
			const slot_t *u = &nd->under[i];
			if (u->value == NULL) continue;
			carry(s, &u->change->h, &carried[i]);
			rp_put(t, s->tables[i], u->value, &carried[i].h);
			continue;
		}
		nd_entry *e = tb_get(s->table, tb_string(s->tables[i]), tb_string(doc));
		if (e == NULL || e->value == NULL) continue;
		carry(s, &e->change, &carried[i]);
		rp_put(t, s->tables[i], e->value, &carried[i].h);
	}
	return carried;
}

static void carried_list_free(sy_sync *s, carried_t *carried) {
	for (size_t i = 0; carried != NULL && i < s->tables_length; i++) carried_free(&carried[i]);
	free(carried);
}

// a merge commit the one head, shown: its tables kept
static void remember(sy_sync *s, node_t *nd) {
	const hy_kept **heads;
	size_t n = hy_heads(tp_history(s->device, nd->id, TP_STORED), &heads);
	if (n == 1 && heads[0]->merge != NULL && nd->shown == heads[0]) {
		rp_tables t;
		carried_t *carried = from_table(s, nd->id, &t);
		keep_state(nd, names_key(heads, NULL, 1), &t);
		rp_free(&t);
		carried_list_free(s, carried);
	}
	free(heads);
}

// the tables at a fragment's head, packed, when the commits since the last snapshot are worth one:
// about the node's size, so making them costs about what writing the commits did, and a replay walks
// back at most about a node's worth
static bool snapshot_of(void *context, const char *doc, const hy_kept *head, uint8_t **out, size_t *length) {
	sy_sync *s = context;
	node_t *nd = node_of(s, doc);
	size_t at = (size_t)(uintptr_t)im_get(&nd->placed, head->name);
	if (at == 0) at = nd->total;
	if (nd->has_last && (at > nd->last_at ? at - nd->last_at : nd->last_at - at) < nd->last_size) return false;
	rp_tables own, *t = &own;
	carried_t *carried = NULL;
	bool fresh = true;
	if (nd->shown == head) carried = from_table(s, doc, t);
	else if ((t = im_get(&nd->others, head->name)) != NULL) fresh = false;
	else {
		t = &own;
		replayed(s, doc, head->name, t);
	}
	pk_code code = sn_snapshot(t, out, length);
	if (fresh) rp_free(t);
	carried_list_free(s, carried);
	if (code != PK_OK) return false;
	nd->has_last = true;
	nd->last_at = at;
	nd->last_size = *length;
	return true;
}

// ---- what arrives

static void later(sy_sync *s, node_t *nd) {
	if (nd->dirty) return;
	nd->dirty = true;
	if (s->dirty_count == s->dirty_room) {
		s->dirty_room = s->dirty_room ? s->dirty_room * 2 : 8;
		s->dirty = realloc(s->dirty, s->dirty_room * sizeof *s->dirty);
		if (s->dirty == NULL) abort();
	}
	s->dirty[s->dirty_count++] = nd;
}

static bool among(const hy_kept *const *heads, size_t n, const uint8_t name[32]) {
	for (size_t i = 0; i < n; i++)
		if (memcmp(heads[i]->name, name, 32) == 0) return true;
	return false;
}

// the table holds these tables, whole
static void become(sy_sync *s, const char *doc, const rp_tables *node) {
	tb_key id = tb_string(doc);
	node_t *nd = node_of(s, doc);
	for (size_t i = 0; i < s->tables_length; i++) {
		tb_key part = tb_string(s->tables[i]);
		const nd_entry *want = rp_find(node, s->tables[i]);
		if (overlaid(nd, i)) {
			slot_t *u = &nd->under[i];
			slot_clear(u);
			if (want != NULL && want->value != NULL) {
				u->value = op_ref((op_value *)want->value);
				u->change = header_copy(&want->change);
			}
			continue;
		}
		nd_entry *have = tb_get(s->table, part, id);
		if (want == NULL) {
			if (have == NULL) continue;
			tb_del(s->table, part, id);
			gone(s, have);
			continue;
		}
		header_t *c = header_copy(&want->change);
		nd_entry *e = nd_make_entry(want->value, &c->h, NULL);
		if (e == NULL) abort();
		hold_header(hold(s, e, s->tables[i], doc, true), c);
		if (have == NULL) tb_add(s->table, part, id, e);
		else {
			tb_sub(s->table, part, id, e);
			gone(s, have);
		}
	}
}

// a commit taken in from elsewhere: the head shown moves on, or another comes in front of it. With a
// rule and several heads, their merge shows once the commits coming in now are all in
static void arrive(sy_sync *s, const char *doc, const hy_kept *kept) {
	node_t *nd = node_of(s, doc);
	if (im_del(&s->stepped, kept->name) != NULL) nd->shown = kept, merged_clear(nd);
	const hy_kept **heads;
	size_t n = hy_heads(tp_history(s->device, doc, TP_STORED), &heads);
	const hy_kept *first = n ? heads[0] : NULL;
	bool merging = s->rule != NULL && n > 1;
	if (!merging && first != NULL && nd->shown != first) {
		// the tables become the first head's own tables (or its replay), whole; the head that showed
		// becomes one that doesn't, replayed
		const hy_kept *was = nd->shown;
		rp_tables *node = im_del(&nd->others, first->name);
		if (node == NULL) node = replayed_new(s, doc, first->name);
		become(s, doc, node);
		tables_free(node);
		nd->shown = first;
		merged_clear(nd);
		if (was != NULL && among(heads, n, was->name)) {
			rp_tables *t = replayed_new(s, doc, was->name);
			tables_free(im_del(&nd->others, was->name));
			im_set(&nd->others, was->name, t);
		}
	}
	// only heads keep tables of their own
	uint8_t(*gone_ones)[32] = malloc(nd->others.count * 32 + 1);
	if (gone_ones == NULL) abort();
	size_t g = 0;
	for (size_t i = 0; i < nd->others.slots; i++)
		if (nd->others.used[i] && !among(heads, n, nd->others.keys[i])) memcpy(gone_ones[g++], nd->others.keys[i], 32);
	for (size_t i = 0; i < g; i++) tables_free(im_del(&nd->others, gone_ones[i]));
	free(gone_ones);
	free(heads);
	if (s->rule != NULL) remember(s, nd);
	later(s, nd);
}

// several heads, by the rule: the table shows their merge, unless it does already
static void show_merge(sy_sync *s, node_t *nd) {
	const hy_kept **heads;
	size_t n = hy_heads(tp_history(s->device, nd->id, TP_STORED), &heads);
	if (nd->has_merged && same_kept(nd->merged, nd->merged_count, heads, n)) {
		free(heads);
		return;
	}
	rp_tables node;
	merge_of(s, nd->id, heads, n, s->rule, &node);
	// a rule keeping its work starts the next merge where this one ended: not packed again
	if (s->rule->create == NULL) keep_state(nd, names_key(heads, NULL, n), &node);
	become(s, nd->id, &node);
	rp_free(&node);
	nd->shown = NULL;
	merged_clear(nd);
	nd->merged = heads;
	nd->merged_count = n;
	nd->has_merged = true;
}

static void arrived(void *context, const tp_arrival *a) {
	sy_sync *s = context;
	bool only = a->layer == TP_EPHEMERAL && hy_get(tp_history(s->device, a->doc, TP_STORED), a->kept->name) == NULL;
	if (a->layer != TP_STORED && !(a->heard && only)) return;
	bool was = s->applying;
	s->applying = true;
	if (a->layer == TP_STORED) arrive(s, a->doc, a->kept), ended(s, a->doc, a->kept);
	else heard(s, a->doc, a->kept);
	s->applying = was;
}

// ---- conflicts

// the same value, by structure (comparing two versions of a table)
static bool same(const op_value *a, const op_value *b) {
	if (a == NULL || b == NULL) return a == b;
	if (a == b) return true;
	Json *x = pk_to_json(a), *y = pk_to_json(b);
	bool equal = x != NULL && y != NULL && jsonEqual(x, y);
	jsonFree(x);
	jsonFree(y);
	return equal;
}

// a value of its own: the head's tables move on in place
static op_value *copied(const op_value *v) {
	Json *j = pk_to_json(v);
	op_value *out = j != NULL ? pk_of_json(j) : op_null();
	jsonFree(j);
	return out;
}

// several heads: the first shows, the others are listed in the conflicts table at the id, with the
// tables in which they differ from the one shown (a table one has not is left out of the list). With a
// rule, none: what shows is every head
static void conflicts(sy_sync *s, node_t *nd) {
	const hy_kept **heads;
	size_t n = hy_heads(tp_history(s->device, nd->id, TP_STORED), &heads);
	op_value *list = op_list();
	tb_key id = tb_string(nd->id);
	for (size_t i = 1; s->rule == NULL && i < n; i++) {
		const hy_kept *k = heads[i];
		rp_tables *node = im_get(&nd->others, k->name);
		if (node == NULL) im_set(&nd->others, k->name, node = replayed_new(s, nd->id, k->name));
		op_value *differ = op_map();
		for (size_t t = 0; t < s->tables_length; t++) {
			const nd_entry *theirs = rp_find(node, s->tables[t]);
			const nd_entry *ours = overlaid(nd, t) ? NULL : tb_get(s->table, tb_string(s->tables[t]), id);
			const op_value *a = theirs ? theirs->value : NULL;
			const op_value *b = overlaid(nd, t) ? nd->under[t].value : ours ? ours->value : NULL;
			if (a != NULL && !same(a, b)) op_set(differ, s->tables[t], copied(a));
		}
		op_value *actor = NULL;
		cm_commit c;
		if (cm_decode(k->bytes, k->length, &c, NULL) == CM_OK) {
			actor = op_ref((op_value *)c.change.actor);
			cm_free(&c);
		}
		char head[65];
		for (int b = 0; b < 32; b++) snprintf(head + 2 * b, 3, "%02x", k->name[b]);
		op_value *m = op_map();
		op_set(m, "head", op_str(head));
		op_set(m, "lamport", op_num((double)k->lamport));
		op_set(m, "actor", actor != NULL ? actor : op_null());
		op_set(m, "tables", differ);
		op_push(list, m);
	}
	free(heads);
	tb_key part = tb_string("conflicts");
	nd_entry *have = tb_get(s->table, part, id);
	if (list->count == 0) {
		op_free(list);
		if (have != NULL) {
			tb_del(s->table, part, id);
			gone(s, have);
		}
		return;
	}
	header_t *c = stamp(now_of(s));
	nd_entry *e = nd_make_entry(list, &c->h, NULL);
	if (e == NULL) abort();
	op_free(list);
	hold_header(hold(s, e, "conflicts", nd->id, true), c);
	if (have == NULL) tb_add(s->table, part, id, e);
	else {
		tb_sub(s->table, part, id, e);
		gone(s, have);
	}
}

// the conflicts worked out again, once the commits coming in now are all in
static void flush(sy_sync *s) {
	if (s->dirty_count == 0) return;
	bool was = s->applying;
	s->applying = true;
	for (size_t i = 0; i < s->dirty_count; i++) {
		node_t *nd = s->dirty[i];
		nd->dirty = false;
		if (s->rule != NULL) {
			const hy_kept **heads;
			size_t n = hy_heads(tp_history(s->device, nd->id, TP_STORED), &heads);
			free(heads);
			if (n > 1) show_merge(s, nd);
		}
		conflicts(s, nd);
	}
	s->dirty_count = 0;
	s->applying = was;
}

// ---- what goes out

static int by_name(const void *a, const void *b) {
	return memcmp(*(const uint8_t *const *)a, *(const uint8_t *const *)b, 32);
}

// one commit at the node, on what shows: the head shown, or with a rule, the heads merged. all: on
// every head, keeping the head shown. Encoded now, so nothing it carries is held after. The commit
// taken in, or NULL
static const hy_kept *send(sy_sync *s, const char *id, const char *part, const op_patch *patches, size_t count,
	const ch_header *change, bool all, cm_code *code) {
	*code = CM_OK;
	sy_follow(s, id);
	node_t *nd = node_of(s, id);
	if (nd == NULL) return NULL;
	hy_history *history = tp_history(s->device, id, TP_STORED);
	const hy_kept **heads;
	size_t n = hy_heads(history, &heads);
	const hy_kept *head = nd->shown != NULL ? nd->shown : n ? heads[0] : NULL;
	// the merged heads: the node's until the commit is taken, let go of then
	const hy_kept **merged = nd->has_merged ? nd->merged : NULL;
	bool on_merge = nd->has_merged;
	const hy_kept *const *on = on_merge ? merged : all ? heads : &head;
	size_t on_count = on_merge ? nd->merged_count : all ? n : head != NULL;
	const uint8_t **sorted = malloc((on_count + 1) * sizeof *sorted);
	uint8_t(*parents)[32] = malloc(on_count * 32 + 1);
	if (sorted == NULL || parents == NULL) abort();
	int64_t top = 0;
	for (size_t i = 0; i < on_count; i++) {
		sorted[i] = on[i]->name;
		if (on[i]->lamport > top) top = on[i]->lamport;
	}
	qsort(sorted, on_count, sizeof *sorted, by_name);
	for (size_t i = 0; i < on_count; i++) memcpy(parents[i], sorted[i], 32);
	// the table shows something else than the stored: the patches tried on the stored, the whole value
	// if they don't apply
	size_t at = table_index(s, part);
	op_value *stored = NULL;
	static const op_key root[1];
	op_patch whole = {.place = {.path = root, .length = 0}};
	if (!all && at < s->tables_length && overlaid(nd, at)) {
		size_t failed;
		if (op_apply(nd->under[at].value, patches, count, NULL, &stored, &failed) != OP_OK) {
			nd_entry *e = tb_get(s->table, tb_string(part), tb_string(id));
			if (e != NULL && e->value != NULL) whole.has_value = 1, whole.value = e->value;
			stored = e != NULL && e->value != NULL ? op_ref(e->value) : NULL;
			patches = &whole;
			count = 1;
		}
	}
	carried_t carried;
	carry(s, change, &carried);
	cm_commit c = {0};
	c.table = (char *)part;
	c.change = carried.h;
	memcpy(c.signer, tp_key(s->device), 32);
	c.nonce = s->nonce++;
	c.parents = (const uint8_t(*)[32])parents;
	c.parents_length = on_count;
	if (on_merge) c.merge = (char *)s->rule->name;
	else if (on_count > 1) c.has_base = 1, memcpy(c.base, head->name, 32);
	c.lamport = 1 + top;
	c.patches = (op_patch *)patches;
	c.patches_length = count;
	uint8_t *bytes;
	size_t length;
	char *field = NULL;
	*code = cm_encode(&c, &bytes, &length, &field);
	free(field);
	const hy_kept *taken = NULL;
	if (*code == CM_OK) {
		hy_made made = {.commit = &c};
		cm_name(bytes, length, made.name);
		grew(nd, made.name, length);
		hy_added a = tp_take(s->device, id, bytes, length, TP_STORED, &made);
		if (a.kind == HY_TAKEN) {
			taken = hy_get(history, made.name);
			nd->shown = taken;
			// kept until the end: on may be them
			if (on_merge) nd->merged = NULL;
			merged_clear(nd);
			if (on_count > 1) {
				for (size_t i = 0; i < on_count; i++) tables_free(im_del(&nd->others, on[i]->name));
				if (s->rule != NULL) remember(s, nd);
				later(s, nd);
			}
			if (on_merge) free(merged), merged = NULL;
			if (nd->over != NULL || nd->chains_count > 0) landed(s, nd, part, all, stored, &c.change);
		}
		hy_added_free(&a);
		free(bytes);
	}
	op_free(stored);
	carried_free(&carried);
	free(sorted);
	free(parents);
	free(heads);
	return taken;
}

// ---- ephemeral

static uint64_t ms_of(sy_sync *s) {
	return s->now != NULL ? s->now(s->clock) : erm_host_now();
}

// the later of two devices' tips: higher lamport, then the greater name
static bool after(const hy_kept *a, const hy_kept *b) {
	return a->lamport != b->lamport ? a->lamport > b->lamport : memcmp(a->name, b->name, 32) > 0;
}

// the rules known, each merged purely
static rp_merges pure(sy_sync *s, rp_merge *room) {
	for (size_t i = 0; i < s->merges_length; i++) room[i] = (rp_merge){s->merges[i], NULL};
	return (rp_merges){room, s->merges_length};
}

// whether to is from or one of its ancestors
static bool reaches(sy_sync *s, const char *doc, const hy_kept *from, const hy_kept *to) {
	hy_history *h = tp_history(s->device, doc, TP_EPHEMERAL);
	const hy_kept **todo = malloc(sizeof *todo);
	if (todo == NULL) abort();
	size_t n = 0, room = 1;
	todo[n++] = from;
	im_map seen = {0};
	bool found = false;
	while (n > 0 && !found) {
		const hy_kept *k = todo[--n];
		if (memcmp(k->name, to->name, 32) == 0) {
			found = true;
			break;
		}
		if (k->lamport <= to->lamport || im_has(&seen, k->name)) continue;
		im_set(&seen, k->name, SET);
		for (size_t i = 0; i < k->parents_length; i++) {
			const hy_kept *q = hy_get(h, k->parents[i]);
			if (q == NULL) continue;
			if (n == room) {
				room *= 2;
				todo = realloc(todo, room * sizeof *todo);
				if (todo == NULL) abort();
			}
			todo[n++] = q;
		}
	}
	free(todo);
	im_free(&seen);
	return found;
}

// an ephemeral commit's chain, walked back to the stored commits it went on: their highest lamport (0
// for none) in *base, and the tables its ephemeral commits touched into c
static void root_of(sy_sync *s, const char *doc, const hy_kept *kept, chain_t *c) {
	hy_history *eph = tp_history(s->device, doc, TP_EPHEMERAL), *stored = tp_history(s->device, doc, TP_STORED);
	const hy_kept **todo = malloc(sizeof *todo);
	if (todo == NULL) abort();
	size_t n = 0, room = 1;
	todo[n++] = kept;
	im_map seen = {0};
	c->base = 0;
	while (n > 0) {
		const hy_kept *k = todo[--n];
		if (im_has(&seen, k->name)) continue;
		im_set(&seen, k->name, SET);
		if (hy_get(stored, k->name) != NULL) {
			if (k->lamport > c->base) c->base = k->lamport;
			continue;
		}
		touch(c, k->table);
		for (size_t i = 0; i < k->parents_length; i++) {
			const hy_kept *q = hy_get(eph, k->parents[i]);
			if (q == NULL) continue;
			if (n == room) {
				room *= 2;
				todo = realloc(todo, room * sizeof *todo);
				if (todo == NULL) abort();
			}
			todo[n++] = q;
		}
	}
	free(todo);
	im_free(&seen);
}

// what a rule merging the ephemeral history is given: one commit's tables had without merging
static bool eph_get(void *context, const hy_kept *const *from, size_t n, rp_tables *out) {
	const replaying_t *r = context;
	if (n != 1) return false;
	rp_tables t;
	if (rp_plain(tp_history(r->s->device, r->doc, TP_EPHEMERAL), from[0]->name, snapshots, (void *)r, &t) != RP_OK)
		return false;
	rp_free(out);
	*out = t;
	return true;
}

// the tables at an ephemeral commit's parents, new, from the ephemeral history (which holds the
// stored commits too)
static rp_tables *start_of(sy_sync *s, const char *doc, const hy_kept *kept, const cm_commit *commit) {
	hy_history *eph = tp_history(s->device, doc, TP_EPHEMERAL);
	rp_tables *t = malloc(sizeof *t);
	if (t == NULL) abort();
	rp_init(t);
	replaying_t r = {s, doc};
	if (commit->merge != NULL) {
		const rp_rule *by = rule_named(s, commit->merge);
		const hy_kept **heads = malloc((commit->parents_length + 1) * sizeof *heads);
		if (heads == NULL) abort();
		for (size_t i = 0; i < commit->parents_length; i++) heads[i] = hy_get(eph, commit->parents[i]);
		by->merge(NULL, eph, heads, commit->parents_length, eph_get, &r, t);
		free(heads);
		return t;
	}
	if (!kept->has_base) return t;
	rp_merge *room = calloc(s->merges_length + 1, sizeof *room);
	if (room == NULL) abort();
	rp_merges m = pure(s, room);
	rp_free(t);
	if (rp_replay(eph, kept->base, snapshots, &r, &m, t) != RP_OK) rp_init(t);
	free(room);
	return t;
}

// an ephemeral commit from elsewhere: does it apply to the tables it goes on. They are kept for its
// arrival
static hy_refusal fleeting(sy_sync *s, const char *doc, const hy_kept *kept, const cm_commit *commit) {
	// signed with this device's key elsewhere: never stands here
	if (memcmp(commit->signer, tp_key(s->device), 32) == 0) return 0;
	node_t *nd = node_of(s, doc);
	chain_t *chain = chain_of(nd, commit->signer);
	bool on = chain != NULL && commit->merge == NULL && commit->parents_length == 1 &&
		memcmp(commit->parents[0], chain->tip->name, 32) == 0;
	rp_tables *node = on ? chain->node : start_of(s, doc, kept, commit);
	cm_commit own;
	bool ok = cm_decode(kept->bytes, kept->length, &own, NULL) == CM_OK;
	if (ok && rp_apply(node, &own) != RP_OK) {
		cm_free(&own);
		ok = false;
	}
	if (!ok) {
		if (!on) tables_free(node);
		return HY_PATCHES;
	}
	im_set(&s->fresh, kept->name, node);
	return 0;
}

// an ephemeral commit from elsewhere, taken in: its device's tip now, unless a stored commit of its
// follows it already. On the tip shown, its patches go to the table's entry
static void heard(sy_sync *s, const char *doc, const hy_kept *kept) {
	rp_tables *node = im_del(&s->fresh, kept->name);
	if (node == NULL) return;
	cm_commit own;
	if (cm_decode(kept->bytes, kept->length, &own, NULL) != CM_OK) return;
	node_t *nd = node_of(s, doc);
	chain_t *was = chain_of(nd, own.signer);
	bool on = was != NULL && kept->parents_length == 1 && memcmp(kept->parents[0], was->tip->name, 32) == 0;
	chain_t fresh = {0};
	memcpy(fresh.who, own.signer, 32);
	if (!on) root_of(s, doc, kept, &fresh);
	int64_t base = on ? was->base : fresh.base;
	uintptr_t latest = (uintptr_t)im_get(&nd->latest, own.signer);
	if (latest > 0 && (int64_t)latest - 1 > base) {
		chain_free(&fresh);
		if (node != (was ? was->node : NULL)) tables_free(node);
		cm_free(&own);
		return;
	}
	overlay_room(s, nd);
	char before[65];
	if (on) hex_name(was->tip->name, before);
	chain_t *c = was;
	if (on) {
		c->tip = kept;
	} else {
		if (was != NULL) {
			unfresh(s, was->node);
			chain_free(was);
			*was = fresh;
		} else {
			nd->chains = realloc(nd->chains, (nd->chains_count + 1) * sizeof *nd->chains);
			if (nd->chains == NULL) abort();
			nd->chains[nd->chains_count++] = fresh;
			c = &nd->chains[nd->chains_count - 1];
		}
		c->tip = kept;
		c->node = node;
	}
	touch(c, kept->table);
	c->at = ms_of(s);
	size_t at = table_index(s, kept->table);
	if (on && s->rule == NULL && at < s->tables_length && nd->over[at] != NULL && strcmp(nd->over[at], before) == 0) {
		nd_entry *e = tb_get(s->table, tb_string(own.table), tb_string(doc));
		if (e != NULL && e->value != NULL) {
			size_t failed;
			if (nd_update(e, own.patches, own.patches_length, own.change, &failed) == OP_OK) {
				hold_t *h = hold(s, e, own.table, doc, false);
				char *table = copyString(own.table);
				hold_commit(h, &own);
				if (e->value == NULL) {
					tb_del(s->table, tb_string(table), tb_string(doc));
					gone(s, e);
				} else if (s->commit != NULL) s->commit(s->context, &e, 1);
				free(table);
				char now[65];
				hex_name(kept->name, now);
				over_set(nd, at, now);
			}
		}
	}
	cm_free(&own);
	show(s, nd, false);
}

// a stored commit from elsewhere: its device's ephemeral commits it follows stop standing
static void ended(sy_sync *s, const char *doc, const hy_kept *kept) {
	cm_commit c;
	if (cm_decode(kept->bytes, kept->length, &c, NULL) != CM_OK) return;
	node_t *nd = node_of(s, doc);
	uintptr_t was = (uintptr_t)im_get(&nd->latest, c.signer);
	if (was == 0 || (int64_t)was - 1 < kept->lamport) im_set(&nd->latest, c.signer, (void *)(uintptr_t)(kept->lamport + 1));
	chain_t *chain = chain_of(nd, c.signer);
	cm_free(&c);
	if (chain != NULL && kept->lamport > chain->base) {
		chain_drop(s, nd, chain);
		show(s, nd, false);
	} else if (s->rule != NULL && nd->chains_count > 0) show(s, nd, false);
}

// the stored tables the table shows (under any overlay), new, into t
static void stored_now(sy_sync *s, node_t *nd, rp_tables *t) {
	if (nd->has_merged) {
		char *key = names_key(nd->merged, NULL, nd->merged_count);
		rp_init(t);
		bool got = state_of(nd, key, t);
		free(key);
		if (!got) {
			rp_free(t);
			merge_of(s, nd->id, nd->merged, nd->merged_count, s->rule, t);
		}
		return;
	}
	if (nd->shown != NULL) replayed(s, nd->id, nd->shown->name, t);
	else rp_init(t);
}

// the table at (part, doc) shows value (none: NULL) with the change: a new entry, sync's own
static void put_shown(sy_sync *s, const char *doc, const char *table, op_value *value, header_t *change) {
	tb_key part = tb_string(table), id = tb_string(doc);
	nd_entry *have = tb_get(s->table, part, id);
	if (value == NULL) {
		header_free(change);
		if (have == NULL) return;
		tb_del(s->table, part, id);
		gone(s, have);
		return;
	}
	nd_entry *e = nd_make_entry(value, &change->h, NULL);
	if (e == NULL) abort();
	op_free(value);
	hold_header(hold(s, e, table, doc, true), change);
	if (have == NULL) tb_add(s->table, part, id, e);
	else {
		tb_sub(s->table, part, id, e);
		gone(s, have);
	}
}

static int by_agreed(const void *a, const void *b) {
	return hy_agreed(*(const hy_kept *const *)a, *(const hy_kept *const *)b);
}

// the table shows, for each table a standing chain touched, the later tip's (with a rule, the stored
// heads and the tips merged), and the stored again where none stands. again: worked out again even
// where it shows the same tips
static void show(sy_sync *s, node_t *nd, bool again) {
	if (nd->over == NULL) return;
	bool was = s->applying;
	s->applying = true;
	rp_tables merged;
	bool has_merged = false;
	char *mark = NULL;
	if (s->rule != NULL && nd->chains_count > 0) {
		const hy_kept **heads;
		size_t n = hy_heads(tp_history(s->device, nd->id, TP_STORED), &heads);
		const hy_kept **all = malloc((n + nd->chains_count + 1) * sizeof *all);
		if (all == NULL) abort();
		size_t count = 0;
		for (size_t i = 0; i < n; i++) {
			bool covered = false;
			for (size_t c = 0; c < nd->chains_count && !covered; c++) covered = reaches(s, nd->id, nd->chains[c].tip, heads[i]);
			if (!covered) all[count++] = heads[i];
		}
		for (size_t c = 0; c < nd->chains_count; c++) all[count++] = nd->chains[c].tip;
		qsort(all, count, sizeof *all, by_agreed);
		hy_history *eph = tp_history(s->device, nd->id, TP_EPHEMERAL);
		replaying_t r = {s, nd->id};
		if (count == 1) {
			rp_merge *room = calloc(s->merges_length + 1, sizeof *room);
			if (room == NULL) abort();
			rp_merges m = pure(s, room);
			if (rp_replay(eph, all[0]->name, snapshots, &r, &m, &merged) != RP_OK) rp_init(&merged);
			free(room);
		} else {
			rp_init(&merged);
			s->rule->merge(NULL, eph, all, count, eph_get, &r, &merged);
		}
		has_merged = true;
		char *key = names_key(all, NULL, count);
		mark = formatString("merge %s", key);
		free(key);
		free(all);
		free(heads);
	}
	for (size_t i = 0; i < s->tables_length; i++) {
		const char *t = s->tables[i];
		const chain_t *top = NULL;
		for (size_t c = 0; c < nd->chains_count; c++)
			if (touched(&nd->chains[c], t) && (top == NULL || after(nd->chains[c].tip, top->tip))) top = &nd->chains[c];
		char want[65];
		const char *wanted = NULL;
		const nd_entry *entry = NULL;
		if (top != NULL && has_merged) wanted = mark, entry = rp_find(&merged, t);
		else if (top != NULL) hex_name(top->tip->name, want), wanted = want, entry = rp_find(top->node, t);
		const char *have = nd->over[i];
		bool same = wanted == NULL ? have == NULL : have != NULL && strcmp(wanted, have) == 0;
		if (same && !again) continue;
		if (wanted == NULL && have == NULL) continue;
		if (have == NULL) {
			nd_entry *e = tb_get(s->table, tb_string(t), tb_string(nd->id));
			slot_clear(&nd->under[i]);
			if (e != NULL && e->value != NULL) {
				nd->under[i].value = copied(e->value);
				nd->under[i].change = header_copy(&e->change);
			}
		}
		if (wanted == NULL) {
			slot_t u = nd->under[i];
			nd->under[i] = (slot_t){0};
			over_set(nd, i, NULL);
			put_shown(s, nd->id, t, u.value, u.change != NULL ? u.change : header_new());
		} else {
			over_set(nd, i, wanted);
			if (entry != NULL && entry->value != NULL) put_shown(s, nd->id, t, copied(entry->value), header_copy(&entry->change));
			else put_shown(s, nd->id, t, NULL, NULL);
		}
	}
	if (has_merged) rp_free(&merged);
	free(mark);
	s->applying = was;
}

// a stored commit of this device's at a node with an overlay: what the table shows of its table is
// stored now (stored: what the commit made of the stored), and this device's ephemeral commits there
// are followed
static void landed(sy_sync *s, node_t *nd, const char *part, bool all, op_value *stored, const ch_header *change) {
	size_t at = table_index(s, part);
	if (!all && at < s->tables_length && overlaid(nd, at)) {
		slot_clear(&nd->under[at]);
		if (stored != NULL) {
			nd->under[at].value = copied(stored);
			nd->under[at].change = header_copy(change);
		}
		// shown again, whatever it showed
		over_set(nd, at, "");
	}
	chain_t *mine = chain_of(nd, tp_key(s->device));
	if (mine != NULL) chain_drop(s, nd, mine);
	show(s, nd, false);
}

// a change to an ephemeral table here: one ephemeral commit on this device's tip at the node, or on
// what a stored write goes on. Lamport above every tip there, so the newest write is the later
static cm_code fleet(sy_sync *s, const char *id, const char *part, const op_patch *patches, size_t count,
	const ch_header *change) {
	sy_follow(s, id);
	node_t *nd = node_of(s, id);
	if (nd == NULL) return CM_OK;
	overlay_room(s, nd);
	size_t at = table_index(s, part);
	const uint8_t *me = tp_key(s->device);
	chain_t *mine = chain_of(nd, me);
	hy_history *history = tp_history(s->device, id, TP_STORED);
	const hy_kept **heads;
	size_t n = hy_heads(history, &heads);
	const hy_kept *head = nd->shown != NULL ? nd->shown : n ? heads[0] : NULL;
	const hy_kept *const *on;
	size_t on_count;
	const char *merge = NULL;
	if (mine != NULL) on = (const hy_kept *const *)&mine->tip, on_count = 1;
	else if (nd->has_merged) on = nd->merged, on_count = nd->merged_count, merge = s->rule->name;
	else on = &head, on_count = head != NULL;
	// the patches were made on what the table shows: what the commit goes on, or they are tried on that
	// (this device's tip, or the stored under others' commits)
	char tip[65] = "";
	if (mine != NULL) hex_name(mine->tip->name, tip);
	bool fine = mine != NULL ? nd->over[at] != NULL && strcmp(nd->over[at], tip) == 0 : !overlaid(nd, at);
	nd_entry *now = tb_get(s->table, tb_string(part), tb_string(id));
	op_value *value = now != NULL && now->value != NULL ? op_ref(now->value) : NULL;
	static const op_key root[1];
	op_patch whole = {.place = {.path = root, .length = 0}};
	if (!fine) {
		const nd_entry *base = mine != NULL ? rp_find(mine->node, part) : NULL;
		const op_value *from = mine != NULL ? (base != NULL ? base->value : NULL) : nd->under[at].value;
		op_value *after;
		size_t failed;
		if (op_apply(from, patches, count, NULL, &after, &failed) == OP_OK) {
			op_free(value);
			value = after;
		} else {
			if (now != NULL && now->value != NULL) whole.has_value = 1, whole.value = now->value;
			patches = &whole;
			count = 1;
		}
	}
	const uint8_t **sorted = malloc((on_count + 1) * sizeof *sorted);
	uint8_t(*parents)[32] = malloc(on_count * 32 + 1);
	if (sorted == NULL || parents == NULL) abort();
	int64_t top = 0, base = 0;
	for (size_t i = 0; i < on_count; i++) {
		sorted[i] = on[i]->name;
		if (on[i]->lamport > base) base = on[i]->lamport;
	}
	top = base;
	for (size_t c = 0; c < nd->chains_count; c++)
		if (nd->chains[c].tip->lamport > top) top = nd->chains[c].tip->lamport;
	qsort(sorted, on_count, sizeof *sorted, by_name);
	for (size_t i = 0; i < on_count; i++) memcpy(parents[i], sorted[i], 32);
	carried_t carried;
	carry(s, change, &carried);
	cm_commit c = {0};
	c.table = (char *)part;
	c.change = carried.h;
	memcpy(c.signer, me, 32);
	c.nonce = s->nonce++;
	c.parents = (const uint8_t(*)[32])parents;
	c.parents_length = on_count;
	if (merge != NULL) c.merge = (char *)merge;
	c.lamport = 1 + top;
	c.patches = (op_patch *)patches;
	c.patches_length = count;
	uint8_t *bytes;
	size_t length;
	char *field = NULL;
	cm_code code = cm_encode(&c, &bytes, &length, &field);
	free(field);
	if (code == CM_OK) {
		hy_made made = {.commit = &c};
		cm_name(bytes, length, made.name);
		hy_added a = tp_take(s->device, id, bytes, length, TP_EPHEMERAL, &made);
		if (a.kind == HY_TAKEN) {
			const hy_kept *kept = hy_get(tp_history(s->device, id, TP_EPHEMERAL), made.name);
			// the stored under it, as it was before this write
			if (!overlaid(nd, at)) {
				rp_tables pre;
				stored_now(s, nd, &pre);
				const nd_entry *e = rp_find(&pre, part);
				slot_clear(&nd->under[at]);
				if (e != NULL && e->value != NULL) {
					nd->under[at].value = op_ref((op_value *)e->value);
					nd->under[at].change = header_copy(&e->change);
				}
				rp_free(&pre);
			}
			mine = chain_of(nd, me);
			if (mine == NULL) {
				rp_tables t;
				carried_t *list = from_table(s, id, &t);
				uint8_t *packed;
				size_t size;
				rp_tables *node = malloc(sizeof *node);
				if (node == NULL) abort();
				rp_init(node);
				if (sn_snapshot(&t, &packed, &size) == PK_OK) {
					if (sn_tables(packed, size, node) != PK_OK) rp_free(node), rp_init(node);
					free(packed);
				}
				rp_free(&t);
				carried_list_free(s, list);
				nd->chains = realloc(nd->chains, (nd->chains_count + 1) * sizeof *nd->chains);
				if (nd->chains == NULL) abort();
				mine = &nd->chains[nd->chains_count++];
				*mine = (chain_t){0};
				memcpy(mine->who, me, 32);
				mine->base = base;
				mine->node = node;
			}
			if (value == NULL) rp_drop(mine->node, part);
			else {
				op_value *own = copied(value);
				rp_put_copy(mine->node, part, own, &c.change);
				op_free(own);
			}
			touch(mine, part);
			mine->tip = kept;
			mine->at = ms_of(s);
			// the table shows the new tip when the patches were made on the one before; else shown again
			char name[65];
			hex_name(made.name, name);
			over_set(nd, at, fine ? name : "");
			show(s, nd, false);
		}
		hy_added_free(&a);
		free(bytes);
	}
	op_free(value);
	carried_free(&carried);
	free(sorted);
	free(parents);
	free(heads);
	return code;
}

// the ms until a beat or a ttl is due, or -1
static int64_t wait_of(sy_sync *s, uint64_t now) {
	int64_t next = -1;
	const uint8_t *me = tp_key(s->device);
	for (size_t i = 0; i < s->list_count; i++) {
		node_t *nd = s->list[i];
		for (size_t c = 0; c < nd->chains_count; c++) {
			const chain_t *ch = &nd->chains[c];
			uint64_t due = ch->at + (memcmp(ch->who, me, 32) == 0 ? s->beat : s->ttl);
			int64_t w = due > now ? (int64_t)(due - now) : 0;
			if (next < 0 || w < next) next = w;
		}
	}
	return next;
}

// the beats due sent, the devices quiet past ttl dropped
static void tick(sy_sync *s, uint64_t now) {
	const uint8_t *me = tp_key(s->device);
	for (size_t i = 0; i < s->list_count; i++) {
		node_t *nd = s->list[i];
		bool dropped = false;
		for (size_t c = 0; c < nd->chains_count;) {
			chain_t *ch = &nd->chains[c];
			if (memcmp(ch->who, me, 32) == 0) {
				if (now >= ch->at + s->beat) tp_again(s->device, nd->id, ch->tip->name), ch->at = now;
			} else if (now >= ch->at + s->ttl) {
				chain_drop(s, nd, ch);
				dropped = true;
				continue;
			}
			c++;
		}
		if (dropped) show(s, nd, false);
	}
}

// an ephemeral commit heard: its sender still there
static void hearing(void *context, const char *doc, const uint8_t from[32], const uint8_t name[32]) {
	(void)name;
	sy_sync *s = context;
	uint8_t bytes[32];
	if (!tp_doc(doc, bytes) || memcmp(from, tp_key(s->device), 32) == 0) return;
	node_t *nd = im_get(&s->nodes, bytes);
	chain_t *c = nd != NULL ? chain_of(nd, from) : NULL;
	if (c != NULL) c->at = ms_of(s);
}

// ---- the integration

static int by_name_row(const void *a, const void *b) {
	return memcmp(((const sy_standing_row *)a)->key, ((const sy_standing_row *)b)->key, 32);
}

sy_sync *sy_create(const sy_options *o) {
	sy_sync *s = calloc(1, sizeof *s);
	if (s == NULL) abort();
	s->table = o->table;
	s->random = o->random;
	s->time = o->time;
	s->now = o->now;
	s->clock = o->clock;
	s->zeros = o->zeros;
	s->commit = o->commit;
	s->drop = o->drop;
	s->ephemeral = o->ephemeral;
	s->beat = o->beat ? o->beat : 1000;
	s->ttl = o->ttl ? o->ttl : 4000;
	s->context = o->context;
	const char *const *tables = o->tables != NULL ? o->tables : DEFAULT_TABLES;
	s->tables_length = o->tables != NULL ? o->tables_length : 3;
	s->tables = calloc(s->tables_length + 1, sizeof *s->tables);
	if (s->tables == NULL) abort();
	for (size_t i = 0; i < s->tables_length; i++) s->tables[i] = copyString(tables[i]);
	s->merges = calloc(o->merges_length + 1, sizeof *s->merges);
	if (s->merges == NULL) abort();
	for (size_t i = 0; i < o->merges_length; i++) s->merges[s->merges_length++] = o->merges[i];
	if (o->merge != NULL && (s->rule = rule_named(s, o->merge)) == NULL) {
		sy_free(s);
		return NULL;
	}
	uint8_t start[4];
	random_of(s, start, 4);
	s->nonce = (int64_t)((uint32_t)start[0] << 24 | (uint32_t)start[1] << 16 | (uint32_t)start[2] << 8 | start[3]);
	tp_options d = {.store = o->store, .now = o->now, .clock = o->clock, .check = check, .snapshot = snapshot_of, .context = s};
	memcpy(d.seed, o->seed, 32);
	s->device = tp_create(&d);
	if (s->device == NULL) {
		sy_free(s);
		return NULL;
	}
	tp_arrived(s->device, arrived, s);
	tp_hearing(s->device, hearing, s);
	return s;
}

void sy_free(sy_sync *s) {
	if (s == NULL) return;
	tp_free(s->device);
	for (size_t i = 0; i < s->list_count; i++) {
		node_t *nd = s->list[i];
		for (size_t k = 0; k < nd->others.slots; k++)
			if (nd->others.used[k]) tables_free(nd->others.values[k]);
		im_free(&nd->others);
		im_free(&nd->placed);
		states_clear(nd);
		walker_drop(nd);
		free(nd->merged);
		free(nd->rules);
		for (size_t c = 0; c < nd->chains_count; c++) chain_free(&nd->chains[c]);
		free(nd->chains);
		for (size_t t = 0; nd->over != NULL && t < s->tables_length; t++) free(nd->over[t]), slot_clear(&nd->under[t]);
		free(nd->over);
		free(nd->under);
		im_free(&nd->latest);
		free(nd);
	}
	free(s->list);
	// what fleeting made that never arrived (a chain's is the chain's, let go of above)
	im_free(&s->fresh);
	for (size_t i = 0; i < s->holds.slots; i++) {
		if (!s->holds.used[i]) continue;
		hold_t *h = s->holds.values[i];
		forget(h);
		if (h->mine) nd_free_entry(h->entry);
		free(h);
	}
	im_free(&s->holds);
	im_free(&s->at);
	im_free(&s->nodes);
	im_free(&s->followed);
	im_free(&s->stepped);
	for (size_t i = 0; i < s->tables_length; i++) free(s->tables[i]);
	free(s->tables);
	free(s->merges);
	free(s->dirty);
	free(s);
}

tp_device *sy_device(sy_sync *s) {
	return s->device;
}

void sy_mint(sy_sync *s, char out[9 + 64 + 1]) {
	uint8_t bytes[32];
	random_of(s, bytes, 32);
	if (s->zeros) memset(bytes + 16, 0, 16);
	memcpy(out, "ermine://", 9);
	for (int i = 0; i < 32; i++) snprintf(out + 9 + 2 * i, 3, "%02x", bytes[i]);
}

bool sy_follow(sy_sync *s, const char *id) {
	uint8_t bytes[32];
	if (!tp_doc(id, bytes)) return false;
	if (im_has(&s->followed, bytes)) return true;
	im_set(&s->followed, bytes, SET);
	return tp_follow(s->device, id);
}

cm_code sy_wrote(sy_sync *s, nd_entry *const *changed, size_t count) {
	cm_code first = CM_OK;
	if (s->applying) return first;
	for (size_t i = 0; i < count; i++) {
		nd_entry *e = changed[i];
		if (!e->change.has_op) continue;
		ch_header change = e->change;
		// the keys copied: a commit sent may change the table
		size_t n;
		const tb_where *w = tb_who(s->table, e, &n);
		char **keys = malloc((2 * n + 1) * sizeof *keys);
		if (keys == NULL) abort();
		size_t k = 0;
		for (size_t j = 0; j < n; j++) {
			if (!kept(s, w[j].part, w[j].id)) continue;
			keys[k++] = copyString(w[j].part.string);
			keys[k++] = copyString(w[j].id.string);
		}
		for (size_t j = 0; j < k; j += 2) {
			cm_code code;
			if (s->ephemeral != NULL && s->ephemeral(s->context, keys[j + 1], keys[j]))
				code = fleet(s, keys[j + 1], keys[j], change.patches, change.patches_length, &change);
			else send(s, keys[j + 1], keys[j], change.patches, change.patches_length, &change, false, &code);
			if (first == CM_OK) first = code;
		}
		for (size_t j = 0; j < k; j++) free(keys[j]);
		free(keys);
	}
	// what a write on several heads leaves to work out (sync.ts's microtask)
	flush(s);
	return first;
}

void sy_table_changed(sy_sync *s, tb_key part, tb_key id) {
	if (s->applying) return;
	notice(s, part, id);
	if (!kept(s, part, id)) return;
	nd_entry *e = tb_get(s->table, part, id);
	static const op_key root[1];
	op_patch patch = {.place = {.path = root, .length = 0}};
	if (e != NULL && e->value != NULL) patch.has_value = 1, patch.value = e->value;
	cm_code code;
	if (s->ephemeral != NULL && s->ephemeral(s->context, id.string, part.string))
		fleet(s, id.string, part.string, &patch, 1, e != NULL ? &e->change : NULL);
	else send(s, id.string, part.string, &patch, 1, e != NULL ? &e->change : NULL, false, &code);
	flush(s);
}

cm_code sy_settle(sy_sync *s, const char *id, const ch_header *change) {
	hy_history *history = tp_history(s->device, id, TP_STORED);
	if (history == NULL) return CM_OK;
	const hy_kept **heads;
	size_t n = hy_heads(history, &heads);
	free(heads);
	if (n < 2) return CM_OK;
	cm_code code;
	const hy_kept *k = send(s, id, "value", NULL, 0, change, true, &code);
	// a merge is a write to its table like any other: the entry shown carries its change, as a replay
	// of the merge (and so every other device) has it
	node_t *nd = node_of(s, id);
	size_t at = table_index(s, "value");
	cm_commit own;
	if (k != NULL && at < s->tables_length && overlaid(nd, at)) {
		slot_t *u = &nd->under[at];
		if (u->value != NULL && cm_decode(k->bytes, k->length, &own, NULL) == CM_OK) {
			header_t *c = header_copy(&own.change);
			header_free(u->change);
			u->change = c;
			cm_free(&own);
		}
		flush(s);
		return code;
	}
	nd_entry *e = k != NULL && kept_table(s, "value") ? tb_get(s->table, tb_string("value"), tb_string(id)) : NULL;
	if (e != NULL && cm_decode(k->bytes, k->length, &own, NULL) == CM_OK) {
		bool was = s->applying;
		s->applying = true;
		if (nd_update(e, NULL, 0, own.change, NULL) == OP_OK) {
			hold_commit(hold(s, e, "value", id, false), &own);
			if (s->commit != NULL) s->commit(s->context, &e, 1);
		}
		cm_free(&own);
		s->applying = was;
	}
	flush(s);
	return code;
}

rp_code sy_get(sy_sync *s, const char *id, const uint8_t name[32], rp_tables *out) {
	hy_history *history = tp_history(s->device, id, TP_STORED);
	if (history == NULL) return RP_NOT_TAKEN;
	replaying_t r = {s, id};
	rp_merges m = rules_of(s, node_of(s, id));
	return rp_replay(history, name, snapshots, &r, &m, out);
}

bool sy_use(sy_sync *s, const char *name) {
	const rp_rule *rule = NULL;
	if (name != NULL && (rule = rule_named(s, name)) == NULL) return false;
	if (rule == s->rule) return true;
	s->rule = rule;
	// what was kept was merged by the rule before
	for (size_t i = 0; i < s->list_count; i++) states_clear(s->list[i]), walker_drop(s->list[i]);
	bool was = s->applying;
	s->applying = true;
	for (size_t i = 0; i < s->list_count; i++) {
		node_t *nd = s->list[i];
		if (!im_has(&s->followed, nd->bytes)) continue;
		const hy_kept **heads;
		size_t n = hy_heads(tp_history(s->device, nd->id, TP_STORED), &heads);
		merged_clear(nd);
		if (n > 1) {
			if (s->rule != NULL) show_merge(s, nd);
			else {
				rp_tables *node = im_del(&nd->others, heads[0]->name);
				if (node == NULL) node = replayed_new(s, nd->id, heads[0]->name);
				become(s, nd->id, node);
				tables_free(node);
				nd->shown = heads[0];
			}
		}
		free(heads);
		conflicts(s, nd);
	}
	// merged, or the later: what overlays shows again
	for (size_t i = 0; i < s->list_count; i++) show(s, s->list[i], true);
	s->applying = was;
	return true;
}

size_t sy_standing(sy_sync *s, const char *id, sy_standing_row **out) {
	uint8_t bytes[32];
	node_t *nd = tp_doc(id, bytes) ? im_get(&s->nodes, bytes) : NULL;
	size_t n = nd != NULL ? nd->chains_count : 0;
	*out = malloc((n + 1) * sizeof **out);
	if (*out == NULL) abort();
	for (size_t i = 0; i < n; i++) {
		memcpy((*out)[i].key, nd->chains[i].who, 32);
		memcpy((*out)[i].tip, nd->chains[i].tip->name, 32);
	}
	qsort(*out, n, sizeof **out, by_name_row);
	return n;
}

int64_t sy_run(sy_sync *s) {
	tick(s, ms_of(s));
	int64_t wait = tp_run(s->device);
	flush(s);
	int64_t due = wait_of(s, ms_of(s));
	if (due >= 0 && (wait < 0 || due < wait)) wait = due;
	return wait;
}

bool sy_idle(const sy_sync *s) {
	return tp_idle(s->device) && s->dirty_count == 0;
}
