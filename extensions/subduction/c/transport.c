#include "transport.h"

#include "apply.h"
#include "id.h"
#include "seal.h"

#include "ed25519/ed25519.h"
#include "../../../ermine/encoding/c/blop.h"
#include "../../../ermine/encoding/c/blake3/blake3.h"
#include "../../../ermine/encoding/c/cbor.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *refusals[] = {"lock", "shape", "signature", "stored", "document", "parents"};

const char *transport_refusal_name(transport_refusal refusal) {
	return refusals[refusal];
}

static void *grab(size_t n) {
	void *p = malloc(n ? n : 1);
	if (p == NULL) abort();
	return p;
}

// room for one more of an array of count items of size bytes, capacity *room
static void *more(void *items, size_t count, size_t *room, size_t size) {
	if (count < *room) return items;
	*room = *room ? *room * 2 : 8;
	items = realloc(items, *room * size);
	if (items == NULL) abort();
	return items;
}

// a seal taken in, or being taken in; the document owns it. parents: the stored ids of its blop's
// parents' seals, once they are all here. blop: decoded while held back, let go once taken in or
// refused (the histories hold what they need, decoded again from sealed: see decoded)
typedef struct {
	uint8_t name[32], stored[32];
	Json *blop;
	uint8_t *sealed; // heard: the blop's own bytes
	size_t length;
	uint8_t (*parents)[32];
	size_t parent_count;
	int64_t lamport;
	bool child; // a seal here names it as a parent
	bool heard; // an ephemeral message heard, not a seal
} entry;

// entries by their blop's name or by their stored id: open addressing, the ids being hashes already
typedef struct {
	entry **slots;
	size_t size, count;
	bool by_stored;
} table;

static const uint8_t *key(const table *t, const entry *e) {
	return t->by_stored ? e->stored : e->name;
}

static size_t start(const uint8_t id[32]) {
	size_t h;
	memcpy(&h, id, sizeof h);
	return h;
}

static entry *table_get(const table *t, const uint8_t id[32]) {
	if (t->size == 0) return NULL;
	for (size_t i = start(id) & (t->size - 1); t->slots[i]; i = (i + 1) & (t->size - 1)) {
		if (memcmp(key(t, t->slots[i]), id, 32) == 0) return t->slots[i];
	}
	return NULL;
}

static void table_put(table *t, entry *e) {
	if ((t->count + 1) * 2 > t->size) {
		table old = *t;
		t->size = old.size ? old.size * 2 : 64;
		t->slots = calloc(t->size, sizeof *t->slots);
		if (t->slots == NULL) abort();
		for (size_t i = 0; i < old.size; i++) {
			if (old.slots[i] == NULL) continue;
			size_t at = start(key(t, old.slots[i])) & (t->size - 1);
			while (t->slots[at]) at = (at + 1) & (t->size - 1);
			t->slots[at] = old.slots[i];
		}
		free(old.slots);
	}
	size_t at = start(key(t, e)) & (t->size - 1);
	while (t->slots[at]) at = (at + 1) & (t->size - 1);
	t->slots[at] = e;
	t->count++;
}

// a commit, or a seal alone, whose parents' seals are not all here yet (or never will be)
typedef struct pending {
	uint8_t id[32];
	bool commit; // a loose commit: its parents are compared; given are its
	uint8_t (*given)[32];
	size_t given_count;
	entry *e;
	bool stuck; // a parent refused here
	bool dead; // no longer held: taken in, refused, or replaced
	size_t slot; // its place in the layer's waiting array
	uint64_t seq; // arrival order: the order it is looked at in
	uint64_t mark; // the round it was last picked in
	size_t refs; // the waiting array, each parent list it is in, the fresh list, a round's picks
} pending;

// a map from 32 bytes to a pointer; a key stays once put
typedef struct {
	uint8_t key[32];
	void *val;
	bool used;
} mapslot;

typedef struct {
	mapslot *slots;
	size_t size, count;
} bytemap;

// what the layer knows of a name: the pending seals with it as a parent, and whether seals of it are
// refused or stuck here (a child of it is stuck)
typedef struct {
	struct pending **list;
	size_t count, room;
	size_t stuck; // pending seals of this name that are stuck
	bool refused;
} bucket;

// one layer of a document: its histories, the seals taken in to them, and what is held back
typedef struct {
	histories *histories;
	table names, stored;
	entry **taken; // in the order taken in
	size_t taken_count, taken_room;
	pending **waiting;
	size_t waiting_count, waiting_room;
	bytemap by_id; // pending seals by id
	bytemap by_name; // buckets by name
	pending **fresh; // pending seals new since the last settle
	size_t fresh_count, fresh_room;
	uint8_t (*moved)[32]; // names taken in, refused, stuck or no longer stuck since the last settle
	size_t moved_count, moved_room;
	uint64_t seq, round;
	transport_refused *refused;
	size_t refused_count, refused_room;
	bool ephemeral;
} layer;

typedef struct doc {
	char id[ID_LENGTH + 1];
	uint8_t tree[32];
	bool followed;
	layer stored, ephemeral;
	bool has_ephemeral;
	entry **all;
	size_t all_count, all_room;
	fragment *fragments;
	size_t fragment_count, fragment_room;
	bool dirty; // seals taken in since fragments were built
	// blops transport_take put straight into the histories: their bytes, till their seal is here (e)
	struct {
		uint8_t *bytes;
		size_t length;
		uint8_t name[32];
		bool stored;
		const entry *e;
	} *direct;
	size_t direct_count, direct_room;
	struct transport *t;
	struct doc *next;
} doc;

// the parts of one ephemeral payload (Ephemeral blops, TRANSPORT.tex) from one sender, kept until all are here
typedef struct joining {
	struct doc *d;
	uint8_t from[32], whole[32];
	size_t parts;
	uint8_t **bytes; // by part; NULL: not here yet
	size_t *lengths;
	size_t have;
	uint64_t at; // ms: when the first came
	struct joining *next;
} joining;

typedef struct {
	int kind; // ERM_STORE_COMMIT or ERM_STORE_FRAGMENT
	uint8_t tree[32], id[32];
	uint8_t *bytes;
	size_t length;
} job;

struct transport {
	ErmSd *sd;
	ErmStore inner, store;
	bool lazy; // the store only listed at the start
	uint8_t (*unloaded)[32]; // lazy: the listed trees not taken in yet
	size_t unloaded_count;
	doc *docs;
	job *jobs;
	size_t job_count, job_room, job_next;
	transport_out *out;
	size_t out_count, out_room, out_next;
	size_t connected;
	uint64_t want; // the erm_sd_commits call awaited
	uint8_t (*found)[32];
	size_t found_count;
	bool answered;
	joining *joins;
	uint64_t join; // ms the parts of a payload may wait for the rest
	uint8_t key[32]; // this device's: who its ephemeral blops must be signed by
	// blops taken in to a history, told to the listeners once what took them in is done
	struct {
		doc *d;
		bool ephemeral;
		entry *e;
		Json *blop; // held till told
	} *arrivals;
	size_t arrival_count, arrival_room, arrival_next;
	bool announcing;
	struct {
		void (*fn)(void *context, const transport_arrival *arrival);
		void *context;
	} *listeners;
	size_t listener_count, listener_room;
	// document fetches out: the call, the tree, and whether it is the second (see fetch)
	struct {
		uint64_t call;
		uint8_t tree[32];
		bool second;
	} *fetches;
	size_t fetch_count, fetch_room;
};

// -- layers

static Json *again(void *context, const uint8_t name[32]);

static void layer_start(doc *d, layer *L, bool ephemeral) {
	memset(L, 0, sizeof *L);
	L->histories = history_create(d->id, apply_check, NULL);
	history_release(L->histories, apply_release);
	history_loader(L->histories, again, d);
	L->stored.by_stored = true;
	L->ephemeral = ephemeral;
}

static void unref(pending *p);

static void layer_free(layer *L) {
	history_free(L->histories);
	free(L->names.slots);
	free(L->stored.slots);
	free(L->taken);
	for (size_t i = 0; i < L->by_name.size; i++) {
		if (!L->by_name.slots[i].used) continue;
		bucket *b = L->by_name.slots[i].val;
		for (size_t k = 0; k < b->count; k++) unref(b->list[k]);
		free(b->list);
		free(b);
	}
	free(L->by_name.slots);
	free(L->by_id.slots);
	for (size_t i = 0; i < L->fresh_count; i++) unref(L->fresh[i]);
	free(L->fresh);
	free(L->moved);
	for (size_t i = 0; i < L->waiting_count; i++) unref(L->waiting[i]);
	free(L->waiting);
	free(L->refused);
}

static void unref(pending *p) {
	if (--p->refs > 0) return;
	free(p->given);
	free(p);
}

static mapslot *map_find(const bytemap *m, const uint8_t key[32]) {
	if (m->size == 0) return NULL;
	size_t h;
	memcpy(&h, key, sizeof h);
	for (size_t i = h & (m->size - 1); m->slots[i].used; i = (i + 1) & (m->size - 1))
		if (memcmp(m->slots[i].key, key, 32) == 0) return &m->slots[i];
	return NULL;
}

// the slot of a key, made when new
static mapslot *map_at(bytemap *m, const uint8_t key[32]) {
	mapslot *found = map_find(m, key);
	if (found) return found;
	if ((m->count + 1) * 2 > m->size) {
		bytemap old = *m;
		m->size = old.size ? old.size * 2 : 64;
		m->slots = calloc(m->size, sizeof *m->slots);
		if (m->slots == NULL) abort();
		for (size_t i = 0; i < old.size; i++) {
			if (!old.slots[i].used) continue;
			size_t h;
			memcpy(&h, old.slots[i].key, sizeof h);
			size_t at = h & (m->size - 1);
			while (m->slots[at].used) at = (at + 1) & (m->size - 1);
			m->slots[at] = old.slots[i];
		}
		free(old.slots);
	}
	size_t h;
	memcpy(&h, key, sizeof h);
	size_t at = h & (m->size - 1);
	while (m->slots[at].used) at = (at + 1) & (m->size - 1);
	memcpy(m->slots[at].key, key, 32);
	m->slots[at].used = true;
	m->slots[at].val = NULL;
	m->count++;
	return &m->slots[at];
}

static bucket *bucket_find(const layer *L, const uint8_t name[32]) {
	mapslot *s = map_find(&L->by_name, name);
	return s ? s->val : NULL;
}

static bucket *bucket_at(layer *L, const uint8_t name[32]) {
	mapslot *s = map_at(&L->by_name, name);
	if (!s->val) {
		s->val = calloc(1, sizeof(bucket));
		if (s->val == NULL) abort();
	}
	return s->val;
}

// a name moved: the seals waiting on it are looked at again (only seals held now care)
static void moved(layer *L, const uint8_t name[32]) {
	if (L->waiting_count == 0) return;
	L->moved = more(L->moved, L->moved_count, &L->moved_room, 32);
	memcpy(L->moved[L->moved_count++], name, 32);
}

// refused here, or the name of a stuck seal
static bool is_gone(const layer *L, const uint8_t name[32]) {
	const bucket *b = bucket_find(L, name);
	return b && (b->refused || b->stuck > 0);
}

// refused: listed by id, a refusal of the same id replaced; name, when its seal had one, is kept so a
// child of it is stuck
static void refuse(layer *L, const uint8_t id[32], bool fragment, transport_refusal code, const uint8_t *name) {
	size_t i = 0;
	while (i < L->refused_count && !(L->refused[i].fragment == fragment && memcmp(L->refused[i].id, id, 32) == 0)) i++;
	if (i == L->refused_count) {
		L->refused = more(L->refused, L->refused_count, &L->refused_room, sizeof *L->refused);
		L->refused_count++;
	}
	memcpy(L->refused[i].id, id, 32);
	L->refused[i].fragment = fragment;
	L->refused[i].code = code;
	if (name) {
		bucket_at(L, name)->refused = true;
		moved(L, name);
	}
}

static void unrefuse(layer *L, const uint8_t id[32]) {
	for (size_t i = 0; i < L->refused_count; i++) {
		if (L->refused[i].fragment || memcmp(L->refused[i].id, id, 32) != 0) continue;
		memmove(&L->refused[i], &L->refused[i + 1], (L->refused_count - i - 1) * sizeof *L->refused);
		L->refused_count--;
		return;
	}
}

// an entry's blop, held (jsonFree it): its own while held back, else decoded again from its bytes,
// checked when it came
static Json *decoded(const entry *e) {
	if (e->blop) return jsonRef(e->blop);
	Json *blop = NULL;
	if (e->heard) {
		blop_error error = blop_decode(e->sealed, e->length, &blop);
		free(error.field);
		return blop;
	}
	Json *x = cborDecode(e->sealed, e->length, NULL, NULL);
	const Json *change = jsonGet(x, "change");
	if (change && change->type == JSON_BYTES) {
		blop_error error = blop_decode(change->bytes.data, change->bytes.length, &blop);
		free(error.field);
	}
	jsonFree(x);
	return blop;
}

// a seal taken in to the layer: its tables, and its histories
// true if the histories took it in, not passed over
static bool admit(layer *L, entry *e) {
	table_put(&L->names, e);
	moved(L, e->name);
	table_put(&L->stored, e);
	L->taken = more(L->taken, L->taken_count, &L->taken_room, sizeof *L->taken);
	L->taken[L->taken_count++] = e;
	Json *blop = decoded(e);
	history_row r = history_add(L->histories, blop, e->name);
	jsonFree(blop);
	bool taken = r.kind == HISTORY_TAKEN;
	history_row_free(&r);
	return taken;
}

// -- documents

static void entry_free(entry *e) {
	jsonFree(e->blop);
	free(e->sealed);
	free(e->parents);
	free(e);
}

static void doc_free(doc *d) {
	layer_free(&d->stored);
	if (d->has_ephemeral) layer_free(&d->ephemeral);
	for (size_t i = 0; i < d->all_count; i++) entry_free(d->all[i]);
	free(d->all);
	for (size_t i = 0; i < d->direct_count; i++) free(d->direct[i].bytes);
	free(d->direct);
	for (size_t i = 0; i < d->fragment_count; i++) fragment_free(&d->fragments[i]);
	free(d->fragments);
	free(d);
}

static doc *doc_of(transport *t, const uint8_t tree[32]) {
	for (doc *d = t->docs; d; d = d->next)
		if (memcmp(d->tree, tree, 32) == 0) return d;
	doc *d = calloc(1, sizeof *d);
	if (d == NULL) abort();
	memcpy(d->tree, tree, 32);
	d->t = t;
	memcpy(d->id, "ermine://", 9);
	for (int i = 0; i < 32; i++) snprintf(d->id + 9 + 2 * i, 3, "%02x", tree[i]);
	layer_start(d, &d->stored, false);
	d->next = t->docs;
	t->docs = d;
	return d;
}

// a direct one's blop, held (jsonFree it)
static Json *direct_blop(const doc *d, size_t i) {
	if (d->direct[i].e) return decoded(d->direct[i].e);
	Json *blop = NULL;
	blop_error error = blop_decode(d->direct[i].bytes, d->direct[i].length, &blop);
	free(error.field);
	return blop;
}

// the histories' loader: a blop of the document's taken in, by its name, decoded again
static Json *again(void *context, const uint8_t name[32]) {
	doc *d = context;
	entry *e = table_get(&d->stored.names, name);
	if (!e && d->has_ephemeral) e = table_get(&d->ephemeral.names, name);
	if (e) return decoded(e);
	for (size_t i = d->direct_count; i-- > 0;)
		if (memcmp(d->direct[i].name, name, 32) == 0) return direct_blop(d, i);
	return NULL;
}

static doc *doc_named(transport *t, const char *id) {
	uint8_t tree[32];
	if (id_bytes(id, tree) != ID_OK) return NULL;
	return doc_of(t, tree);
}

// the ephemeral layer, made at first: every stored seal taken in so far goes into it (a stored blop
// is held by it too, the ephemeral ones on top)
static layer *ephemeral(doc *d) {
	layer *L = &d->ephemeral;
	if (d->has_ephemeral) return L;
	layer_start(d, L, true);
	d->has_ephemeral = true;
	for (size_t i = 0; i < d->stored.taken_count; i++) admit(L, d->stored.taken[i]);
	// and what was put straight into the stored histories
	for (size_t i = 0; i < d->direct_count; i++) {
		if (!d->direct[i].stored) continue;
		Json *blop = direct_blop(d, i);
		history_row r = history_add(L->histories, blop, d->direct[i].name);
		jsonFree(blop);
		history_row_free(&r);
	}
	return L;
}

// -- taking in

enum { TAKEN, REFUSED, WAITING, STUCK };

// a blop the histories took in from elsewhere, queued to be told (listeners are not called in the
// middle of taking in: they may make changes of their own)
static void arrive(doc *d, layer *L, entry *e) {
	transport *t = d->t;
	if (t->listener_count == 0) return;
	t->arrivals = more(t->arrivals, t->arrival_count, &t->arrival_room, sizeof *t->arrivals);
	t->arrivals[t->arrival_count].d = d;
	t->arrivals[t->arrival_count].ephemeral = L->ephemeral;
	t->arrivals[t->arrival_count].blop = jsonRef((Json *)history_get(L->histories, e->name));
	t->arrivals[t->arrival_count++].e = e;
}

// the arrivals queued, told in order; each may make more
static void announce(transport *t) {
	if (t->announcing) return;
	t->announcing = true;
	while (t->arrival_next < t->arrival_count) {
		size_t i = t->arrival_next++;
		transport_arrival a = {t->arrivals[i].d->id, t->arrivals[i].ephemeral ? TRANSPORT_EPHEMERAL : TRANSPORT_STORED,
			t->arrivals[i].blop, {0}, t->arrivals[i].e->heard};
		memcpy(a.name, t->arrivals[i].e->name, 32);
		for (size_t k = 0; k < t->listener_count; k++) t->listeners[k].fn(t->listeners[k].context, &a);
		jsonFree(t->arrivals[i].blop);
	}
	t->arrival_count = t->arrival_next = 0;
	t->announcing = false;
}

static void settle(doc *d, layer *L);

// the entries of a name: several when a signer signed twice; *out malloc'd
static size_t named_all(const table *t, const uint8_t name[32], entry ***out) {
	size_t n = 0;
	*out = grab(t->count * sizeof **out);
	if (t->size == 0) return 0;
	for (size_t i = start(name) & (t->size - 1); t->slots[i]; i = (i + 1) & (t->size - 1))
		if (memcmp(key(t, t->slots[i]), name, 32) == 0) (*out)[n++] = t->slots[i];
	return n;
}

static bool among(entry **list, size_t n, const uint8_t stored[32]) {
	for (size_t i = 0; i < n; i++)
		if (memcmp(list[i]->stored, stored, 32) == 0) return true;
	return false;
}

// step 5: the seal's parents here? waiting while one is not, stuck when one is refused or stuck here; the
// commit's parents each a stored id of one of its blop's parents, and each parent one of them; else step 6,
// the histories
static int attempt(doc *d, layer *L, pending *p) {
	entry *e = p->e;
	const Json *list = jsonGet(e->blop, "parents");
	size_t n = (size_t)list->array.count, missing = 0;
	bool gone = false, match = true;
	entry ***seen = grab(n * sizeof *seen);
	size_t *counts = grab(n * sizeof *counts);
	for (size_t i = 0; i < n; i++) {
		const uint8_t *name = list->array.items[i]->bytes.data;
		counts[i] = named_all(&L->names, name, &seen[i]);
		if (counts[i] == 0) missing++, gone = gone || is_gone(L, name);
	}
	if (!missing && p->commit) {
		for (size_t g = 0; g < p->given_count; g++) {
			bool found = false;
			for (size_t i = 0; i < n; i++) found = found || among(seen[i], counts[i], p->given[g]);
			match = match && found;
		}
		for (size_t i = 0; i < n; i++) {
			bool found = false;
			for (size_t g = 0; g < p->given_count; g++) found = found || among(seen[i], counts[i], p->given[g]);
			match = match && found;
		}
	}
	// the stored ids of its parents: the commit's own where it has them, else every one of each name
	size_t total = 0;
	uint8_t(*want)[32] = grab((missing ? 0 : p->commit ? p->given_count : 0) * 32 + 1);
	if (!missing) {
		if (p->commit) {
			memcpy(want, p->given, p->given_count * 32);
			total = p->given_count;
		} else {
			size_t all = 0;
			for (size_t i = 0; i < n; i++) all += counts[i];
			free(want);
			want = grab(all * 32 + 1);
			for (size_t i = 0; i < n; i++)
				for (size_t k = 0; k < counts[i]; k++) memcpy(want[total++], seen[i][k]->stored, 32);
		}
	}
	for (size_t i = 0; i < n; i++) free(seen[i]);
	free(seen);
	free(counts);
	if (missing) {
		free(want);
		return gone ? STUCK : WAITING;
	}
	if (!match) {
		free(want);
		refuse(L, p->id, false, TRANSPORT_PARENT_IDS, e->name);
		return REFUSED;
	}
	free(e->parents);
	e->parents = want;
	e->parent_count = total;
	for (size_t i = 0; i < total; i++) {
		entry *q = table_get(&L->stored, want[i]);
		if (q) q->child = true;
	}
	unrefuse(L, p->id);
	unrefuse(L, e->stored);
	if (admit(L, e)) arrive(d, L, e);
	if (!L->ephemeral) {
		d->dirty = true;
		// held by the ephemeral layer too
		if (d->has_ephemeral) {
			if (admit(&d->ephemeral, e)) arrive(d, &d->ephemeral, e);
			settle(d, &d->ephemeral);
		}
	}
	return TAKEN;
}

// a pending seal no longer held
static void kill(layer *L, pending *p) {
	if (p->stuck) {
		bucket_at(L, p->e->name)->stuck--;
		moved(L, p->e->name);
		p->stuck = false;
	}
	p->dead = true;
	L->waiting[p->slot] = L->waiting[--L->waiting_count];
	L->waiting[p->slot]->slot = p->slot;
	mapslot *s = map_find(&L->by_id, p->id);
	if (s && s->val == p) s->val = NULL;
	unref(p);
}

static int by_seq(const void *x, const void *y) {
	uint64_t a = (*(pending *const *)x)->seq, b = (*(pending *const *)y)->seq;
	return a < b ? -1 : a > b;
}

// the seals held back that something moved for, or new ones, are tried again, round after round,
// until none is left
static void settle(doc *d, layer *L) {
	while (L->fresh_count || L->moved_count) {
		pending **fresh = L->fresh;
		size_t fresh_count = L->fresh_count;
		uint8_t(*names)[32] = L->moved;
		size_t name_count = L->moved_count;
		L->fresh = NULL, L->fresh_count = L->fresh_room = 0;
		L->moved = NULL, L->moved_count = L->moved_room = 0;
		uint64_t stamp = ++L->round;
		pending **picks = NULL;
		size_t pick_count = 0, pick_room = 0;
		for (size_t i = 0; i < fresh_count; i++) {
			pending *p = fresh[i];
			if (!p->dead && p->mark != stamp) {
				p->mark = stamp, p->refs++;
				picks = more(picks, pick_count, &pick_room, sizeof *picks);
				picks[pick_count++] = p;
			}
			unref(p);
		}
		free(fresh);
		for (size_t i = 0; i < name_count; i++) {
			bucket *b = bucket_find(L, names[i]);
			if (!b) continue;
			size_t kept = 0;
			for (size_t k = 0; k < b->count; k++) {
				pending *p = b->list[k];
				if (p->dead) {
					unref(p);
					continue;
				}
				b->list[kept++] = p;
				if (p->mark != stamp) {
					p->mark = stamp, p->refs++;
					picks = more(picks, pick_count, &pick_room, sizeof *picks);
					picks[pick_count++] = p;
				}
			}
			b->count = kept;
		}
		free(names);
		qsort(picks, pick_count, sizeof *picks, by_seq);
		for (size_t i = 0; i < pick_count; i++) {
			pending *p = picks[i];
			if (!p->dead) {
				int result = attempt(d, L, p);
				if (result == TAKEN || result == REFUSED) {
					jsonFree(p->e->blop), p->e->blop = NULL;
					kill(L, p);
				} else if ((result == STUCK) != p->stuck) {
					p->stuck = result == STUCK;
					bucket *b = bucket_at(L, p->e->name);
					if (p->stuck) b->stuck++;
					else b->stuck--;
					moved(L, p->e->name);
				}
			}
			unref(p);
		}
		free(picks);
	}
}

static entry *entry_new(doc *d, const seal_unsealed *u, const uint8_t *bytes, size_t length) {
	entry *e = calloc(1, sizeof *e);
	if (e == NULL) abort();
	memcpy(e->name, u->name, 32);
	memcpy(e->stored, u->stored, 32);
	e->blop = u->blop;
	// a blop this device put straight into the histories (transport_take), sealed and added since: its
	// bytes give way to the seal's. Looked for among the last few taken
	for (size_t i = d->direct_count, looked = 0; i-- > 0 && looked < 64; looked++)
		if (memcmp(d->direct[i].name, u->name, 32) == 0) {
			if (!d->direct[i].e) free(d->direct[i].bytes), d->direct[i].bytes = NULL, d->direct[i].e = e;
			break;
		}
	e->sealed = grab(length);
	memcpy(e->sealed, bytes, length);
	e->length = length;
	e->lamport = (int64_t)jsonGet(e->blop, "lamport")->number;
	d->all = more(d->all, d->all_count, &d->all_room, sizeof *d->all);
	d->all[d->all_count++] = e;
	return e;
}

static void hold(doc *d, layer *L, bool commit, const uint8_t id[32], const uint8_t (*given)[32], size_t given_count, entry *e);

// Taking in a loose commit (commit: head its head, given its parents), or a seal alone (a fragment's
// member, an ephemeral blop), in TRANSPORT.tex's order. Refused ones are listed, held back ones kept
static void take(doc *d, layer *L, bool commit, const uint8_t head[32], const uint8_t (*given)[32], size_t given_count, const uint8_t *bytes, size_t length) {
	uint8_t id[32];
	if (commit) memcpy(id, head, 32);
	else seal_stored(bytes, length, id);
	// a stored id taken in is passed over
	if (table_get(&L->stored, id)) return;
	// the lock's open: unlocked gives back what it is given
	seal_unsealed u;
	seal_code code = seal_unseal(bytes, length, &u);
	if (code != SEAL_OK) {
		refuse(L, id, false, code == SEAL_SHAPE ? TRANSPORT_SHAPE : TRANSPORT_SIGNATURE, NULL);
		settle(d, L);
		return;
	}
	entry *e = entry_new(d, &u, bytes, length);
	if (commit && memcmp(u.stored, head, 32) != 0) {
		jsonFree(e->blop), e->blop = NULL;
		refuse(L, id, false, TRANSPORT_STORED_ID, e->name);
		settle(d, L);
		return;
	}
	if (strcmp(jsonText(jsonGet(e->blop, "node")), d->id) != 0) {
		jsonFree(e->blop), e->blop = NULL;
		refuse(L, id, false, TRANSPORT_DOCUMENT, e->name);
		settle(d, L);
		return;
	}
	hold(d, L, commit, id, given, given_count, e);
}

// the seal's parents not yet looked at: held back, then settled
static void hold(doc *d, layer *L, bool commit, const uint8_t id[32], const uint8_t (*given)[32], size_t given_count, entry *e) {
	mapslot *at = map_at(&L->by_id, id);
	pending *old = at->val;
	pending *p = calloc(1, sizeof *p);
	if (p == NULL) abort();
	p->refs = 1;
	if (old) {
		p->seq = old->seq;
		if (old->e != e) jsonFree(old->e->blop), old->e->blop = NULL;
		kill(L, old);
	} else p->seq = L->seq++;
	memcpy(p->id, id, 32);
	p->commit = commit;
	p->given = grab(given_count * 32);
	if (given_count) memcpy(p->given, given, given_count * 32);
	p->given_count = given_count;
	p->e = e;
	at = map_at(&L->by_id, id);
	at->val = p;
	L->waiting = more(L->waiting, L->waiting_count, &L->waiting_room, sizeof *L->waiting);
	p->slot = L->waiting_count;
	L->waiting[L->waiting_count++] = p;
	const Json *parents = jsonGet(e->blop, "parents");
	for (int i = 0; i < parents->array.count; i++) {
		bucket *b = bucket_at(L, parents->array.items[i]->bytes.data);
		b->list = more(b->list, b->count, &b->room, sizeof *b->list);
		b->list[b->count++] = p;
		p->refs++;
	}
	L->fresh = more(L->fresh, L->fresh_count, &L->fresh_room, sizeof *L->fresh);
	L->fresh[L->fresh_count++] = p;
	p->refs++;
	settle(d, L);
}

// An ephemeral blop heard from the device with that key, or published here: never sealed, never
// stored, no commit steps. Its name is BLAKE3 of its bytes; shape, signature (its signer the
// sender's), document; then handed to the ephemeral layer. False: refused
static bool hear(doc *d, const uint8_t from[32], const uint8_t *bytes, size_t length) {
	layer *L = ephemeral(d);
	uint8_t name[32];
	blop_name(bytes, length, name);
	Json *blop;
	blop_error error = blop_decode(bytes, length, &blop);
	if (error.code != BLOP_OK) {
		free(error.field);
		refuse(L, name, false, TRANSPORT_SHAPE, NULL);
		return false;
	}
	if (memcmp(jsonGet(blop, "signer")->bytes.data, from, 32) != 0) {
		jsonFree(blop);
		refuse(L, name, false, TRANSPORT_SIGNATURE, NULL);
		return false;
	}
	if (strcmp(jsonText(jsonGet(blop, "node")), d->id) != 0) {
		jsonFree(blop);
		refuse(L, name, false, TRANSPORT_DOCUMENT, NULL);
		return false;
	}
	// a name taken in is passed over
	if (table_get(&L->names, name)) {
		jsonFree(blop);
		return true;
	}
	unrefuse(L, name);
	entry *e = calloc(1, sizeof *e);
	if (e == NULL) abort();
	memcpy(e->name, name, 32);
	memcpy(e->stored, name, 32); // no stored id: its name stands in for the layer's table
	e->blop = blop;
	e->sealed = grab(length);
	memcpy(e->sealed, bytes, length);
	e->length = length;
	e->heard = true;
	e->lamport = (int64_t)jsonGet(blop, "lamport")->number;
	d->all = more(d->all, d->all_count, &d->all_room, sizeof *d->all);
	d->all[d->all_count++] = e;
	hold(d, L, false, name, NULL, 0, e);
	return true;
}

// -- parts of an ephemeral payload over Subduction's limit

// Subduction drops an ephemeral payload over LIMIT; a closed blop over it is sent as parts of at most PART bytes
#define LIMIT 65536
#define PART 60000

static void joining_free(joining *j) {
	for (size_t i = 0; i < j->parts; i++) free(j->bytes[i]);
	free(j->bytes);
	free(j->lengths);
	free(j);
}

// the parts not joined by the setting's time dropped; all: whatever the time
static void expire(transport *t, bool all) {
	uint64_t now = erm_host_now();
	for (joining **at = &t->joins; *at;) {
		joining *j = *at;
		if (all || now - j->at >= t->join) {
			*at = j->next;
			joining_free(j);
		} else at = &j->next;
	}
}

static bool whole_number(const Json *x, double *out) {
	if (x == NULL || x->type != JSON_NUMBER || x->number < 0 || x->number != (double)(uint64_t)x->number) return false;
	*out = x->number;
	return true;
}

// a payload heard: a part (a map of exactly whole, part, parts and bytes) is kept with its whole's and, when
// all are here, joined, its hash checked and what it makes heard; a bad part or hash is dropped. False: not a
// part (a blop, or no map): the caller hears it as a payload
static bool gather(transport *t, doc *d, const uint8_t from[32], const uint8_t *payload, size_t length) {
	Json *x = cborDecode(payload, length, NULL, NULL);
	if (x == NULL) return false;
	if (x->type != JSON_OBJECT || x->object.count != 4 || !jsonGet(x, "whole") || !jsonGet(x, "part") || !jsonGet(x, "parts") || !jsonGet(x, "bytes")) {
		jsonFree(x);
		return false;
	}
	const Json *whole = jsonGet(x, "whole"), *bytes = jsonGet(x, "bytes");
	double part, parts;
	if (whole->type != JSON_BYTES || whole->bytes.length != 32 || bytes->type != JSON_BYTES || bytes->bytes.length > PART || !whole_number(jsonGet(x, "part"), &part) || !whole_number(jsonGet(x, "parts"), &parts) || part >= parts || parts > 1e6) {
		jsonFree(x);
		return true;
	}
	expire(t, false);
	joining *j = t->joins;
	while (j && !(j->d == d && memcmp(j->from, from, 32) == 0 && memcmp(j->whole, whole->bytes.data, 32) == 0)) j = j->next;
	if (j == NULL) {
		j = calloc(1, sizeof *j);
		if (j == NULL) abort();
		j->d = d;
		memcpy(j->from, from, 32);
		memcpy(j->whole, whole->bytes.data, 32);
		j->parts = (size_t)parts;
		j->bytes = calloc(j->parts, sizeof *j->bytes);
		j->lengths = calloc(j->parts, sizeof *j->lengths);
		if (j->bytes == NULL || j->lengths == NULL) abort();
		j->at = erm_host_now();
		j->next = t->joins;
		t->joins = j;
	}
	if (j->parts == (size_t)parts && j->bytes[(size_t)part] == NULL) {
		size_t n = bytes->bytes.length;
		j->bytes[(size_t)part] = grab(n ? n : 1);
		memcpy(j->bytes[(size_t)part], bytes->bytes.data, n);
		j->lengths[(size_t)part] = n;
		j->have++;
	}
	jsonFree(x);
	if (j->have < j->parts) return true;
	for (joining **at = &t->joins; *at; at = &(*at)->next) {
		if (*at == j) {
			*at = j->next;
			break;
		}
	}
	size_t total = 0;
	for (size_t i = 0; i < j->parts; i++) total += j->lengths[i];
	uint8_t *all = grab(total ? total : 1), hash[32];
	size_t at = 0;
	for (size_t i = 0; i < j->parts; i++) {
		memcpy(all + at, j->bytes[i], j->lengths[i]);
		at += j->lengths[i];
	}
	blake3_hasher h;
	blake3_hasher_init(&h);
	blake3_hasher_update(&h, all, total);
	blake3_hasher_finalize(&h, hash, 32);
	if (memcmp(hash, j->whole, 32) == 0) hear(d, from, all, total);
	free(all);
	joining_free(j);
	return true;
}

// a closed blop sent: whole if Subduction takes it, else as parts
static void send(transport *t, doc *d, const uint8_t *bytes, size_t length) {
	if (length <= LIMIT) {
		erm_sd_publish(t->sd, d->tree, bytes, length);
		return;
	}
	uint8_t hash[32];
	blake3_hasher h;
	blake3_hasher_init(&h);
	blake3_hasher_update(&h, bytes, length);
	blake3_hasher_finalize(&h, hash, 32);
	size_t parts = (length + PART - 1) / PART;
	for (size_t i = 0; i < parts; i++) {
		size_t n = length - i * PART < PART ? length - i * PART : PART;
		Json *m = jsonObject();
		jsonAdd(m, "whole", jsonBytes(hash, 32));
		jsonAdd(m, "part", jsonNumber((double)i));
		jsonAdd(m, "parts", jsonNumber((double)parts));
		jsonAdd(m, "bytes", jsonBytes(bytes + i * PART, n));
		size_t size;
		const char *why;
		cborEncode(m, NULL, 0, &size, &why);
		uint8_t *out = grab(size);
		cborEncode(m, out, size, &size, &why);
		jsonFree(m);
		erm_sd_publish(t->sd, d->tree, out, size);
		free(out);
	}
}

// -- fragments

static const fragment *known(void *context, const uint8_t head[32]) {
	doc *d = context;
	for (size_t i = 0; i < d->fragment_count; i++)
		if (memcmp(d->fragments[i].head, head, 32) == 0) return &d->fragments[i];
	return NULL;
}

static bool lookup(void *context, const uint8_t id[32], const uint8_t (**parents)[32], size_t *count) {
	doc *d = context;
	entry *e = table_get(&d->stored.stored, id);
	if (e == NULL) return false;
	*parents = (const uint8_t(*)[32])e->parents;
	*count = e->parent_count;
	return true;
}

static int by_lamport(const void *x, const void *y) {
	const entry *a = *(entry *const *)x, *b = *(entry *const *)y;
	if (a->lamport != b->lamport) return a->lamport < b->lamport ? -1 : 1;
	return memcmp(a->name, b->name, 32);
}

// a fragment here: its members' seals, in ascending lamport and then name, as one list in the canonical
// encoding, closed as one (the lock unlocked gives it back); added
static void add_fragment(transport *t, doc *d, const fragment *f) {
	entry **members = grab(f->members.count * sizeof *members);
	for (size_t i = 0; i < f->members.count; i++) {
		members[i] = table_get(&d->stored.stored, f->members.ids[i]);
		if (members[i] == NULL) {
			free(members);
			return;
		}
	}
	qsort(members, f->members.count, sizeof *members, by_lamport);
	Json *list = jsonArray();
	for (size_t i = 0; i < f->members.count; i++) jsonPush(list, jsonBytes(members[i]->sealed, members[i]->length));
	free(members);
	size_t n = 0;
	const char *why;
	cborEncode(list, NULL, 0, &n, &why);
	uint8_t *blob = grab(n);
	cborEncode(list, blob, n, &n, &why);
	jsonFree(list);
	erm_sd_add_fragment(t->sd, d->tree, f->head, f->boundary.count ? (const uint8_t *)f->boundary.ids : NULL, f->boundary.count,
		f->checkpoints.count ? (const uint8_t *)f->checkpoints.ids : NULL, f->checkpoints.count, blob, n);
	free(blob);
}

static fragment *remember(doc *d, fragment f) {
	d->fragments = more(d->fragments, d->fragment_count, &d->fragment_room, sizeof *d->fragments);
	d->fragments[d->fragment_count] = f;
	return &d->fragments[d->fragment_count++];
}

// FRAGMENT.tex, Building: the new fragments of the document's heads, each added
static void build(transport *t, doc *d) {
	d->dirty = false;
	layer *L = &d->stored;
	uint8_t(*heads)[32] = grab(L->taken_count * 32);
	size_t n = 0;
	for (size_t i = 0; i < L->taken_count; i++)
		if (!L->taken[i]->child) memcpy(heads[n++], L->taken[i]->stored, 32);
	fragment *made;
	size_t count;
	fragment_build((const uint8_t(*)[32])heads, n, lookup, known, d, &made, &count);
	free(heads);
	// each is here before it is added, so its own save is passed over
	size_t first = d->fragment_count;
	for (size_t i = 0; i < count; i++) remember(d, made[i]);
	free(made);
	for (size_t i = first; i < d->fragment_count; i++) {
		fragment f = d->fragments[i];
		add_fragment(t, d, &f);
	}
}

static void take_fragment(doc *d, const uint8_t head[32], const uint8_t (*boundary)[32], size_t boundary_count, const uint8_t *blob, size_t length) {
	layer *L = &d->stored;
	// its head taken in by the histories already: passed over, but here
	entry *have = table_get(&L->stored, head);
	bool passed = have != NULL && history_slot(L->histories, have->name) != NULL;
	if (passed && known(d, head)) return;
	// the lock's open: unlocked gives back what it is given
	Json *list = cborDecode(blob, length, NULL, NULL);
	bool shape = list != NULL && list->type == JSON_ARRAY;
	for (int i = 0; shape && i < list->array.count; i++) shape = list->array.items[i]->type == JSON_BYTES;
	if (!shape) {
		jsonFree(list);
		if (!passed) refuse(L, head, true, TRANSPORT_SHAPE, NULL);
		return;
	}
	fragment f = {0};
	memcpy(f.head, head, 32);
	for (int i = 0; i < list->array.count; i++) {
		uint8_t s[32];
		seal_stored(list->array.items[i]->bytes.data, list->array.items[i]->bytes.length, s);
		fragment_push(&f.members, s);
	}
	for (size_t i = 0; i < boundary_count; i++) fragment_push(&f.boundary, boundary[i]);
	fragment_settle(&f.members);
	fragment_settle(&f.boundary);
	if (!passed) {
		bool has = false;
		for (size_t i = 0; i < f.members.count; i++) has = has || memcmp(f.members.ids[i], head, 32) == 0;
		if (!has) {
			fragment_free(&f);
			jsonFree(list);
			refuse(L, head, true, TRANSPORT_STORED_ID, NULL);
			return;
		}
		// each member in order, as a loose commit but for its commit; one refused leaves the others
		for (int i = 0; i < list->array.count; i++)
			take(d, L, false, NULL, NULL, 0, list->array.items[i]->bytes.data, list->array.items[i]->bytes.length);
	}
	jsonFree(list);
	// one here under that head (a fake, whose head is not taken in) gives way
	fragment *old = (fragment *)known(d, head);
	if (old) {
		fragment_free(old);
		*old = f;
	} else remember(d, f);
	d->dirty = true;
}

// -- the store: what Subduction saves is taken in

static int saved(void *self, int kind, const uint8_t *tree, const uint8_t id[32], const uint8_t *bytes, size_t length) {
	transport *t = self;
	int r = t->inner.put(t->inner.self, kind, tree, id, bytes, length);
	if (r != 0 || (kind != ERM_STORE_COMMIT && kind != ERM_STORE_FRAGMENT)) return r;
	t->jobs = more(t->jobs, t->job_count, &t->job_room, sizeof *t->jobs);
	job *j = &t->jobs[t->job_count++];
	j->kind = kind;
	memcpy(j->tree, tree, 32);
	memcpy(j->id, id, 32);
	j->bytes = grab(length);
	memcpy(j->bytes, bytes, length);
	j->length = length;
	return 0;
}

static int store_get(void *self, int kind, const uint8_t *tree, const uint8_t id[32], uint8_t **bytes, size_t *length) {
	transport *t = self;
	return t->inner.get(t->inner.self, kind, tree, id, bytes, length);
}

static int store_list(void *self, int kind, const uint8_t *tree, void (*each)(void *context, const uint8_t id[32]), void *context) {
	transport *t = self;
	return t->inner.list(t->inner.self, kind, tree, each, context);
}

static int store_remove(void *self, int kind, const uint8_t *tree, const uint8_t *id) {
	transport *t = self;
	return t->inner.remove(t->inner.self, kind, tree, id);
}

// one save taken in: the record, and its blob, which Subduction put first
static void process(transport *t, const job *j) {
	ErmSdRecord rec;
	if (!erm_sd_decode(j->kind, j->bytes, j->length, &rec)) return;
	uint8_t *blob = NULL;
	size_t length = 0;
	if (t->inner.get(t->inner.self, ERM_STORE_BLOB, NULL, rec.digest, &blob, &length) == 1) {
		doc *d = doc_of(t, j->tree);
		static const uint8_t none[1] = {0};
		const uint8_t *bytes = blob ? blob : none;
		const uint8_t(*parents)[32] = (const uint8_t(*)[32])rec.parents;
		if (j->kind == ERM_STORE_COMMIT) take(d, &d->stored, true, rec.id, parents, rec.parentCount, bytes, length);
		else take_fragment(d, rec.id, parents, rec.parentCount, bytes, length);
		erm_host_free(blob);
	}
	erm_sd_free_record(&rec);
}

// the saves so far, taken in; then fragments built where seals were taken in
static bool work(transport *t) {
	bool busy = t->job_next < t->job_count;
	while (t->job_next < t->job_count) {
		job *j = &t->jobs[t->job_next++];
		process(t, j);
		free(j->bytes);
	}
	t->job_count = t->job_next = 0;
	for (doc *d = t->docs; d; d = d->next) {
		if (!d->dirty) continue;
		build(t, d);
		busy = true;
	}
	return busy;
}

// -- starting: what the store already holds, taken in as a save is (TRANSPORT.tex, A device)

typedef struct {
	uint8_t (*ids)[32];
	size_t count, room;
} idlist;

static void collect(void *context, const uint8_t id[32]) {
	idlist *l = context;
	l->ids = more(l->ids, l->count, &l->room, sizeof *l->ids);
	memcpy(l->ids[l->count++], id, 32);
}

// every fragment and then every loose commit of every tree in the store, as saves; no order is
// needed: a commit whose parent is not yet in waits, as ever
// the stored contents of one tree (its fragments, then its loose commits) queued as jobs
static void queue_tree(transport *t, const uint8_t tree[32]) {
	for (int k = 0; k < 2; k++) {
		int kind = k == 0 ? ERM_STORE_FRAGMENT : ERM_STORE_COMMIT;
		idlist ids = {0};
		if (t->inner.list(t->inner.self, kind, tree, collect, &ids) == 0) {
			for (size_t n = 0; n < ids.count; n++) {
				uint8_t *bytes = NULL;
				size_t length = 0;
				if (t->inner.get(t->inner.self, kind, tree, ids.ids[n], &bytes, &length) != 1) continue;
				t->jobs = more(t->jobs, t->job_count, &t->job_room, sizeof *t->jobs);
				job *j = &t->jobs[t->job_count++];
				j->kind = kind;
				memcpy(j->tree, tree, 32);
				memcpy(j->id, ids.ids[n], 32);
				j->bytes = grab(length ? length : 1);
				if (length) memcpy(j->bytes, bytes, length);
				j->length = length;
				erm_host_free(bytes);
			}
		}
		free(ids.ids);
	}
}

// at the start: every stored tree taken in; lazy, only listed (taken in when followed)
static void load(transport *t) {
	idlist trees = {0};
	if (t->inner.list(t->inner.self, ERM_STORE_TREE, NULL, collect, &trees) != 0) {
		free(trees.ids);
		return;
	}
	if (t->lazy) {
		t->unloaded = trees.ids;
		t->unloaded_count = trees.count;
		return;
	}
	for (size_t i = 0; i < trees.count; i++) queue_tree(t, trees.ids[i]);
	free(trees.ids);
	work(t);
}

// lazy: the tree taken in if it is listed and not yet
static void load_tree(transport *t, const uint8_t tree[32]) {
	for (size_t i = 0; i < t->unloaded_count; i++) {
		if (memcmp(t->unloaded[i], tree, 32) != 0) continue;
		memmove(t->unloaded + i, t->unloaded + i + 1, (t->unloaded_count - i - 1) * 32);
		t->unloaded_count--;
		queue_tree(t, tree);
		work(t);
		return;
	}
}

// -- events

static void ask(transport *t, transport_out_kind kind, uint64_t conn, const uint8_t *bytes, size_t length) {
	t->out = more(t->out, t->out_count, &t->out_room, sizeof *t->out);
	transport_out *o = &t->out[t->out_count++];
	o->kind = kind;
	o->conn = conn;
	o->bytes = NULL;
	o->length = length;
	if (bytes) {
		o->bytes = grab(length);
		memcpy(o->bytes, bytes, length);
	}
}

// the tree fetched from every peer, subscribed. When it is done it is fetched once more: a commit
// added while the first was out (or before it was asked) is in neither its answer nor a push
static void fetch(transport *t, const uint8_t tree[32], bool second) {
	t->fetches = more(t->fetches, t->fetch_count, &t->fetch_room, sizeof *t->fetches);
	t->fetches[t->fetch_count].call = erm_sd_sync(t->sd, tree, 1, 0);
	memcpy(t->fetches[t->fetch_count].tree, tree, 32);
	t->fetches[t->fetch_count++].second = second;
}

static void fetched(transport *t, uint64_t call) {
	for (size_t i = 0; i < t->fetch_count; i++) {
		if (t->fetches[i].call != call) continue;
		uint8_t tree[32];
		memcpy(tree, t->fetches[i].tree, 32);
		bool second = t->fetches[i].second;
		t->fetches[i] = t->fetches[--t->fetch_count];
		if (!second) fetch(t, tree, true);
		return;
	}
}

static void sync_followed(transport *t) {
	for (doc *d = t->docs; d; d = d->next) {
		if (!d->followed) continue;
		erm_sd_subscribe(t->sd, d->tree);
		fetch(t, d->tree, false);
	}
}

static bool events(transport *t) {
	bool any = false;
	ErmSdEvent e;
	while (erm_sd_poll(t->sd, &e)) {
		any = true;
		if (e.kind == ERM_SD_SEND) ask(t, TRANSPORT_SEND, e.conn, e.bytes, e.length);
		else if (e.kind == ERM_SD_CLOSE) ask(t, TRANSPORT_CLOSE, e.conn, NULL, 0);
		else if (e.kind == ERM_SD_DONE) fetched(t, e.call);
		else if (e.kind == ERM_SD_CONNECTED && e.ok) {
			t->connected++;
			sync_followed(t);
		} else if (e.kind == ERM_SD_HEARD) {
			// an ephemeral blop of a followed document: the steps on the commit left out, never
			// stored; anything else on a topic is not heard
			for (doc *d = t->docs; d; d = d->next) {
				if (memcmp(d->tree, e.topic, 32) == 0 && d->followed && !gather(t, d, e.key, e.bytes, e.length)) hear(d, e.key, e.bytes, e.length);
			}
		} else if (e.kind == ERM_SD_COMMITS && e.call == t->want) {
			t->found = grab(e.count * 32);
			for (size_t i = 0; i < e.count; i++) memcpy(t->found[i], e.commits[i].id, 32);
			t->found_count = e.count;
			t->answered = true;
		}
		erm_sd_free_event(&e);
	}
	return any;
}

// -- the device

transport *transport_create(const uint8_t seed[32], const ErmStore *store) {
	return transport_create_told(seed, store, NULL, NULL);
}

transport *transport_create_told(const uint8_t seed[32], const ErmStore *store, void (*listener)(void *context, const transport_arrival *arrival), void *context) {
	return transport_create_lazy(seed, store, false, listener, context);
}

transport *transport_create_lazy(const uint8_t seed[32], const ErmStore *store, bool lazy, void (*listener)(void *context, const transport_arrival *arrival), void *context) {
	transport *t = calloc(1, sizeof *t);
	if (t == NULL) abort();
	t->lazy = lazy;
	t->inner = *store;
	t->store = (ErmStore){t, saved, store_get, store_list, store_remove};
	ermEd25519Public(seed, t->key);
	t->join = 30000;
	t->sd = erm_sd_new(seed, erm_host_now(), &t->store);
	if (t->sd == NULL) abort();
	if (listener) transport_arrived(t, listener, context);
	// everything the store holds is taken in before any connection
	load(t);
	return t;
}

void transport_free(transport *t) {
	if (t == NULL) return;
	erm_sd_free(t->sd);
	while (t->docs) {
		doc *d = t->docs;
		t->docs = d->next;
		doc_free(d);
	}
	for (size_t i = t->job_next; i < t->job_count; i++) free(t->jobs[i].bytes);
	free(t->jobs);
	for (size_t i = t->out_next; i < t->out_count; i++) free(t->out[i].bytes);
	free(t->out);
	free(t->found);
	free(t->unloaded);
	free(t->fetches);
	for (size_t i = t->arrival_next; i < t->arrival_count; i++) jsonFree(t->arrivals[i].blop);
	free(t->arrivals);
	free(t->listeners);
	expire(t, true);
	free(t);
}

uint64_t transport_connect(transport *t, const char *service) {
	return erm_sd_connect(t->sd, service);
}

void transport_service(const char *url, char *out, size_t size) {
	const char *at = strstr(url, "://");
	at = at ? at + 3 : url;
	size_t n = strcspn(at, "/?#");
	const char *login = memchr(at, '@', n);
	if (login) n -= (size_t)(login + 1 - at), at = login + 1;
	if (n >= size) n = size - 1;
	memcpy(out, at, n);
	out[n] = 0;
}

size_t transport_connected(const transport *t) {
	return t->connected;
}

void transport_received(transport *t, uint64_t conn, const uint8_t *bytes, size_t length) {
	erm_sd_received(t->sd, conn, bytes, length);
}

void transport_closed(transport *t, uint64_t conn) {
	erm_sd_closed(t->sd, conn);
}

int64_t transport_run(transport *t) {
	int64_t wait;
	bool busy;
	expire(t, false);
	do {
		wait = erm_sd_run(t->sd, erm_host_now());
		busy = events(t);
		busy = work(t) || busy;
		announce(t);
	} while (busy);
	// nothing given out is held now: the blops the histories no longer need go
	if (!t->announcing)
		for (doc *d = t->docs; d; d = d->next) {
			history_trim(d->stored.histories);
			if (d->has_ephemeral) history_trim(d->ephemeral.histories);
		}
	return wait;
}

bool transport_next(transport *t, transport_out *out) {
	if (t->out_next == t->out_count) {
		t->out_count = t->out_next = 0;
		return false;
	}
	*out = t->out[t->out_next++];
	return true;
}

void transport_out_free(transport_out *out) {
	free(out->bytes);
	out->bytes = NULL;
}

void transport_join(transport *t, uint64_t ms) {
	t->join = ms;
}

void transport_expire(transport *t) {
	expire(t, true);
}

transport_code transport_follow(transport *t, const char *id) {
	doc *d = doc_named(t, id);
	if (d == NULL) return TRANSPORT_DOC;
	if (t->lazy) load_tree(t, d->tree);
	d->followed = true;
	erm_sd_subscribe(t->sd, d->tree);
	fetch(t, d->tree, false);
	return TRANSPORT_OK;
}

histories *transport_histories(transport *t, const char *id, transport_layer which) {
	doc *d = doc_named(t, id);
	if (d == NULL) return NULL;
	return (which == TRANSPORT_STORED ? &d->stored : ephemeral(d))->histories;
}

void transport_arrived(transport *t, void (*listener)(void *context, const transport_arrival *arrival), void *context) {
	t->listeners = more(t->listeners, t->listener_count, &t->listener_room, sizeof *t->listeners);
	t->listeners[t->listener_count].fn = listener;
	t->listeners[t->listener_count++].context = context;
}

// a blop of this device's made here, put straight into the histories: the next change commits against it
// (a stored one goes into the ephemeral histories too, once there are any). Not announced; add and publish
// pass over it
transport_code transport_take(transport *t, const char *id, const uint8_t *bytes, size_t length, transport_layer which, const transport_made *made) {
	doc *d = doc_named(t, id);
	if (d == NULL) return TRANSPORT_DOC;
	Json *blop = made ? jsonRef((Json *)made->blop) : NULL;
	uint8_t name[32];
	if (made) memcpy(name, made->name, 32);
	else {
		blop_error error = blop_decode(bytes, length, &blop);
		if (error.code != BLOP_OK) {
			free(error.field);
			return TRANSPORT_BLOP;
		}
		blop_name(bytes, length, name);
	}
	d->direct = more(d->direct, d->direct_count, &d->direct_room, sizeof *d->direct);
	d->direct[d->direct_count].bytes = grab(length);
	memcpy(d->direct[d->direct_count].bytes, bytes, length);
	d->direct[d->direct_count].length = length;
	d->direct[d->direct_count].e = NULL;
	memcpy(d->direct[d->direct_count].name, name, 32);
	d->direct[d->direct_count++].stored = which == TRANSPORT_STORED;
	history_row r = history_add(which == TRANSPORT_STORED ? d->stored.histories : ephemeral(d)->histories, blop, name);
	history_row_free(&r);
	if (which == TRANSPORT_STORED && d->has_ephemeral) {
		r = history_add(d->ephemeral.histories, blop, name);
		history_row_free(&r);
	}
	// the histories hold what they need
	jsonFree(blop);
	return TRANSPORT_OK;
}

transport_code transport_add(transport *t, const char *id, const uint8_t *sealed, size_t length, const transport_made *made) {
	doc *d = doc_named(t, id);
	if (d == NULL) return TRANSPORT_DOC;
	seal_unsealed u;
	if (made) {
		u = (seal_unsealed){.blop = jsonRef((Json *)made->blop)};
		memcpy(u.name, made->name, 32);
		memcpy(u.stored, made->stored, 32);
		memcpy(u.signer, jsonGet(u.blop, "signer")->bytes.data, 32);
	} else if (seal_unseal(sealed, length, &u) != SEAL_OK) return TRANSPORT_SEAL;
	// the commit: the seal's stored id, and the stored ids of its parents' seals
	const Json *list = jsonGet(u.blop, "parents");
	size_t n = (size_t)list->array.count;
	uint8_t(*parents)[32] = grab(n * 32);
	for (size_t i = 0; i < n; i++) {
		entry *q = table_get(&d->stored.names, list->array.items[i]->bytes.data);
		if (q == NULL) {
			free(parents);
			seal_free(&u);
			return TRANSPORT_PARENTS;
		}
		memcpy(parents[i], q->stored, 32);
	}
	uint8_t head[32];
	memcpy(head, u.stored, 32);
	if (made) {
		// the histories have it before addCommit, so the save is passed over
		if (!table_get(&d->stored.stored, head))
			hold(d, &d->stored, true, head, (const uint8_t(*)[32])parents, n, entry_new(d, &u, sealed, length));
		else seal_free(&u);
	} else {
		seal_free(&u);
		take(d, &d->stored, true, head, (const uint8_t(*)[32])parents, n, sealed, length);
	}
	// the lock's close: unlocked gives back what it is given
	erm_sd_add_commit(t->sd, d->tree, head, n ? (const uint8_t *)parents : NULL, n, sealed, length);
	free(parents);
	if (d->dirty) build(t, d);
	announce(t);
	return TRANSPORT_OK;
}

// as given: checked as a receiver checks it, then published whether or not it was taken in
transport_code transport_publish(transport *t, const char *id, const uint8_t *blop_bytes, size_t length) {
	doc *d = doc_named(t, id);
	if (d == NULL) return TRANSPORT_DOC;
	hear(d, t->key, blop_bytes, length);
	send(t, d, blop_bytes, length);
	announce(t);
	return TRANSPORT_OK;
}

transport_code transport_put(transport *t, const char *id, const uint8_t head[32], const uint8_t (*parents)[32], size_t count, const uint8_t *blob, size_t length) {
	doc *d = doc_named(t, id);
	if (d == NULL) return TRANSPORT_DOC;
	erm_sd_add_commit(t->sd, d->tree, head, count ? (const uint8_t *)parents : NULL, count, blob, length);
	return TRANSPORT_OK;
}

transport_code transport_put_fragment(transport *t, const char *id, const uint8_t head[32], const uint8_t (*boundary)[32], size_t boundary_count, const uint8_t (*checkpoints)[32], size_t checkpoint_count, const uint8_t *blob, size_t length) {
	doc *d = doc_named(t, id);
	if (d == NULL) return TRANSPORT_DOC;
	erm_sd_add_fragment(t->sd, d->tree, head, boundary_count ? (const uint8_t *)boundary : NULL, boundary_count,
		checkpoint_count ? (const uint8_t *)checkpoints : NULL, checkpoint_count, blob, length);
	return TRANSPORT_OK;
}

// -- what is asked of it

static int by_id(const void *x, const void *y) {
	return memcmp(x, y, 32);
}

transport_taking transport_taking_of(transport *t, const char *id, transport_layer which) {
	transport_taking out = {0};
	doc *d = doc_named(t, id);
	if (d == NULL) return out;
	layer *L = which == TRANSPORT_STORED ? &d->stored : ephemeral(d);
	out.waiting = grab(L->waiting_count * sizeof *out.waiting);
	out.stuck = grab(L->waiting_count * sizeof *out.stuck);
	for (size_t i = 0; i < L->waiting_count; i++) {
		pending *p = L->waiting[i];
		const Json *parents = jsonGet(p->e->blop, "parents");
		if (p->stuck) {
			transport_waiting *w = &out.stuck[out.stuck_count++];
			memcpy(w->commit, p->id, 32);
			w->names = grab((size_t)parents->array.count * 32);
			w->count = 0;
			for (int k = 0; k < parents->array.count; k++) {
				const uint8_t *name = parents->array.items[k]->bytes.data;
				if (table_get(&L->names, name) == NULL && is_gone(L, name)) memcpy(w->names[w->count++], name, 32);
			}
			continue;
		}
		transport_waiting *w = &out.waiting[out.waiting_count++];
		memcpy(w->commit, p->id, 32);
		const Json *list = jsonGet(p->e->blop, "parents");
		w->names = grab((size_t)list->array.count * 32);
		w->count = 0;
		for (int k = 0; k < list->array.count; k++) {
			const uint8_t *name = list->array.items[k]->bytes.data;
			if (table_get(&L->names, name) == NULL) memcpy(w->names[w->count++], name, 32);
		}
	}
	qsort(out.waiting, out.waiting_count, sizeof *out.waiting, by_id);
	qsort(out.stuck, out.stuck_count, sizeof *out.stuck, by_id);
	out.refused = grab(L->refused_count * sizeof *out.refused);
	memcpy(out.refused, L->refused, L->refused_count * sizeof *out.refused);
	out.refused_count = L->refused_count;
	qsort(out.refused, out.refused_count, sizeof *out.refused, by_id);
	return out;
}

void transport_taking_free(transport_taking *taking) {
	for (size_t i = 0; i < taking->waiting_count; i++) free(taking->waiting[i].names);
	for (size_t i = 0; i < taking->stuck_count; i++) free(taking->stuck[i].names);
	free(taking->stuck);
	free(taking->waiting);
	free(taking->refused);
	memset(taking, 0, sizeof *taking);
}

const fragment *transport_fragments(transport *t, const char *id, size_t *count) {
	doc *d = doc_named(t, id);
	if (d == NULL) return *count = 0, NULL;
	qsort(d->fragments, d->fragment_count, sizeof *d->fragments, by_id);
	*count = d->fragment_count;
	return d->fragments;
}

size_t transport_stored(transport *t, const char *id, uint8_t (**out)[32]) {
	*out = NULL;
	doc *d = doc_named(t, id);
	if (d == NULL) return 0;
	free(t->found);
	t->found = NULL;
	t->found_count = 0;
	t->answered = false;
	t->want = erm_sd_commits(t->sd, d->tree);
	for (int round = 0; round < 1000 && !t->answered; round++) transport_run(t);
	*out = t->found;
	t->found = NULL;
	return t->found_count;
}
