// Commits over Subduction (transport.h), in C. Laid out as transport.ts is: documents and their
// histories, taking in (the seal, its stored id, its parents, then the histories), fragments,
// ephemeral commits and their parts, building, sending what take queued, and Subduction.
//
// transport.ts's two promise chains are two queues here: jobs (its run: taking in what the store
// saved, building, what was heard, in the order asked, one at a time) and items (its outgoing: this
// device's own takes, sealed and stored or published, in the order made). A job or an item that waits
// on Subduction (an addCommit, an addFragment, a publish) holds its queue until the call is answered,
// as an await there does. tp_run runs both, and Subduction, until nothing more can go on
#include "transport.h"

#include "ids.h"
#include "run.h"
#include "seal.h"
#include "snapshot.h"

#include "../../../ermine/encoding/c/cbor.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// Subduction drops an ephemeral payload over LIMIT; one over it is sent as parts of at most PART
#define LIMIT 65536
#define PART 60000

// a followed document still empty is asked for again after each of these, in ms
static const uint64_t backoff[] = {250, 500, 1000, 2000, 4000, 8000, 16000};
#define BACKOFF (sizeof backoff / sizeof *backoff)

// room for one more in an array
#define ROOM(array, count, room) \
	do { \
		if ((count) == (room)) { \
			(room) = (room) ? (room) * 2 : 8; \
			(array) = realloc((array), (room) * sizeof *(array)); \
			if ((array) == NULL) abort(); \
		} \
	} while (0)

#define CODE(c) ((void *)(uintptr_t)(c))
#define SET ((void *)1)

const char *tp_layer_name(tp_layer layer) {
	return layer == TP_EPHEMERAL ? "ephemeral" : "stored";
}

const char *tp_code_name(tp_code code) {
	switch (code) {
	case TP_LOCK: return "lock";
	case TP_SHAPE: return "shape";
	case TP_SIGNATURE: return "signature";
	case TP_STORED_ID: return "stored";
	case TP_PARENTS: return "parents";
	case TP_BOUNDARY: return "boundary";
	}
	return "";
}

static void *copy(const void *bytes, size_t length) {
	void *out = malloc(length ? length : 1);
	if (out == NULL) abort();
	if (length) memcpy(out, bytes, length);
	return out;
}

static int by_id(const void *a, const void *b) {
	return memcmp(a, b, 32);
}

static size_t depth(const uint8_t id[32]) {
	return fragment_depth(id);
}

// ---- what is kept of a seal

// a seal's commit, as the transport reads it: its name, bytes, the seal's stored id, lamport, parents
typedef struct {
	uint8_t name[32], stored[32];
	uint8_t *bytes;
	size_t length;
	int64_t lamport;
	uint8_t (*parents)[32];
	size_t parents_length;
} sealed_t;

static void sealed_free(sealed_t *s) {
	free(s->bytes);
	free(s->parents);
	*s = (sealed_t){0};
}

// the unsealed's, taking its bytes; the unsealed is let go of
static void sealed_of(sealed_t *s, sl_unsealed *u) {
	memcpy(s->name, u->name, 32);
	memcpy(s->stored, u->stored, 32);
	s->bytes = u->bytes;
	s->length = u->length;
	u->bytes = NULL;
	s->lamport = u->commit.lamport;
	s->parents_length = u->commit.parents_length;
	s->parents = copy(u->commit.parents, u->commit.parents_length * 32);
	sl_free(u);
}

// a seal taken in: its commit's name and lamport, its commit's bytes, its sealed bytes (NULL: a
// commit a run's next vouched for, held without a seal), and the stored ids of the seals it was taken
// in over (its commit's parents; or, for a seal alone, every seal of each)
typedef struct {
	uint8_t stored[32], name[32];
	int64_t lamport;
	uint8_t *bytes;
	size_t length;
	uint8_t *sealed;
	size_t sealed_length;
	uint8_t (*ids)[32];
	size_t ids_length;
} seen_t;

// a loose commit, or a seal alone (a fragment's member), not yet handed to the histories: its parents
// not all here, or one refused. given: the commit's parents' stored ids, sorted. waiting, stuck: what
// settle last found
typedef struct {
	uint8_t key[32];
	bool commit;
	sealed_t it;
	uint8_t *sealed;
	size_t sealed_length;
	uint8_t (*given)[32];
	size_t given_length;
	bool waits, sticks;
	uint8_t (*waiting)[32];
	size_t waiting_length;
	uint8_t (*stuck)[32];
	size_t stuck_length;
} pending_t;

static void pending_free(pending_t *p) {
	sealed_free(&p->it);
	free(p->sealed);
	free(p->given);
	free(p->waiting);
	free(p->stuck);
	free(p);
}

// a name's stored ids: a signer may have signed it twice
typedef struct {
	uint8_t (*ids)[32];
	size_t length, room;
} idlist_t;

typedef struct {
	uint8_t *bytes;
	size_t length;
} blob_t;

static void blob_free(void *b) {
	if (b == NULL) return;
	free(((blob_t *)b)->bytes);
	free(b);
}

// the keys of a map in the order they came, so its oldest can be let go of past a most (transport.ts's
// note, a Map's order): each with the serial it came with, which at keeps, so one that went and came
// again is where it came last
typedef struct {
	im_map at;
	struct {
		uint8_t key[32];
		uintptr_t serial;
	} *keys;
	size_t first, count, room;
	uintptr_t serial;
} order_t;

static void order_free(order_t *o) {
	im_free(&o->at);
	free(o->keys);
	*o = (order_t){0};
}

// whether the order's entry k is the key's place in the map now
static bool current(const im_map *m, const order_t *o, size_t k) {
	return im_has(m, o->keys[k].key) && (uintptr_t)im_get(&o->at, o->keys[k].key) == o->keys[k].serial;
}

// the key into the map, under value. New to it: past most, the oldest let go of first (drop: what is
// done with its value, or NULL)
static void note(im_map *m, order_t *o, const uint8_t key[32], void *value, size_t most, void (*drop)(void *value)) {
	if (!im_has(m, key)) {
		while (m->count >= most && o->first < o->count) {
			size_t k = o->first++;
			if (!current(m, o, k)) continue;
			im_del(&o->at, o->keys[k].key);
			void *v = im_del(m, o->keys[k].key);
			if (drop != NULL) drop(v);
		}
		// the entries that are no key's place now let go of, once they are most of them
		if (o->count - o->first > 2 * m->count + 64) {
			size_t n = 0;
			for (size_t k = o->first; k < o->count; k++)
				if (current(m, o, k)) o->keys[n++] = o->keys[k];
			o->first = 0, o->count = n;
		}
		ROOM(o->keys, o->count, o->room);
		memcpy(o->keys[o->count].key, key, 32);
		o->keys[o->count++].serial = ++o->serial;
		im_set(&o->at, key, (void *)o->serial);
	}
	im_set(m, key, value);
}

// ---- documents

typedef struct doc doc;
typedef struct {
	doc *d;
	tp_layer layer;
} side_t;

struct doc {
	char id[9 + 64 + 1];
	uint8_t bytes[32];
	tp_device *t;
	side_t sides[2];
	hy_history *histories[2];
	// what each history was given from elsewhere and has not taken in yet, by name: 1 + heard
	im_map elsewhere[2];
	// this device's own takes waiting on a parent, by name: sent once let in
	im_map own[2];
	// a taken-in seal's name to its stored ids (idlist_t)
	im_map names;
	// by stored id (seen_t), and in the order taken in
	im_map seen;
	seen_t **order;
	size_t order_count, order_room;
	// by head (fragment *)
	im_map fragments;
	// the snapshots fragments carried, packed, by their head's name (blob_t), each checked (hint); the
	// snapshots not checked yet (blob_t), and the heads checked
	im_map snapshots, hints, judged;
	// by a commit's head or a seal's stored id (pending_t)
	im_map pending;
	// codes: by head or stored id; fragments refused whole, by head; refused ephemeral commits, by name
	im_map refused, broken, heard;
	// names of seals refused here
	im_map bad;
	// the order each capped map's keys came in (note)
	order_t pending_order, refused_order, broken_order, heard_order, bad_order, hints_order;
	// how many taken-in seals have a depth, so a build with none is passed over
	size_t deep;
	// ephemeral commits to let go of once nothing queued holds them (tp_forget)
	uint8_t (*forgets)[32];
	size_t forgets_count, forgets_room;
	bool followed, follow_later;
	// asked for again at due, the ask'th time
	bool asking;
	size_t ask;
	uint64_t due;
	doc *next;
};

// ---- the queues

typedef struct job job;
typedef struct item item;

typedef enum {
	J_LOAD,     // what the store holds, taken in
	J_LOADED,   // the end of it
	J_TAKE,     // a record the store held when starting: commit or fragment, nothing more
	J_SAVE,     // a record Subduction saved (or a conformance hook put gave): taken in, then compacted and built
	J_HEAR,     // an ephemeral commit heard
	J_GATHER,   // a part of an ephemeral payload
	J_COMPACT,  // the loose commits a fragment covers let go of
	J_BUILD,    // the fragments not built yet
	J_SUBSCRIBE // a channel's topic subscribed
} job_kind;

struct job {
	job_kind kind;
	doc *d;
	// J_TAKE, J_SAVE: the record's kind and tree, its bytes (or given: its head, parents or boundary,
	// checkpoints (12 bytes each) and blob as the hook put had them)
	int record;
	uint8_t tree[32];
	bool given;
	uint8_t *checks;
	size_t checks_count;
	uint8_t head[32];
	// parents, boundary; J_BUILD's heads (none: every head). J_COMPACT: the fragment's head
	uint8_t (*list)[32];
	size_t count;
	bool all;
	// the record, the blob, the payload, the part's bytes
	uint8_t *bytes;
	size_t length;
	// J_HEAR, J_GATHER: the sender; J_GATHER, J_SUBSCRIBE: the topic (topic set: a channel's)
	uint8_t from[32], topic[32];
	bool channel;
	uint8_t whole[32];
	size_t part, parts;
	// a build, as it goes: the fragments made, the one being added
	fragment **fresh;
	size_t fresh_count, at;
	bool started, waiting, done;
	// an item waits for it to be done
	item *waiter;
	job *next;
};

// one of this device's own takes, going out: sealed and stored, or published
struct item {
	doc *d;
	tp_layer layer;
	const hy_kept *kept;
	// 0: not started; 1: waiting on its call; 2: waiting on its build; 3: done
	int state;
	uint8_t stored[32];
	job *build;
	item *next;
};

typedef enum { C_STORE, C_PUBLISH, C_FRAGMENT, C_SUBSCRIBE, C_FETCH, C_PUT, C_PUT_FRAGMENT } call_kind;

typedef enum { F_FOLLOW, F_CONNECT, F_ASK } fetch_kind;
// a document synced with every peer, twice: what was added while the first was out is in neither its
// answer nor a push
typedef struct {
	doc *d;
	fetch_kind kind;
	int round;
	size_t ask;
} fetch_t;

// a conformance hook's put, until Subduction answers: saw, whether its save came
typedef struct {
	doc *d;
	uint8_t head[32];
	uint8_t (*list)[32];
	size_t count;
	uint8_t *blob;
	size_t length;
	// a fragment's checkpoints, 12 bytes each
	uint8_t *checks;
	size_t checks_count;
	bool saw;
} put_t;

typedef struct {
	uint64_t call;
	call_kind kind;
	void *what;
} call_t;

typedef struct {
	uint64_t id;
	bool up, fresh;
	uint8_t key[32];
} conn_t;

struct tp_listener {
	tp_heard_fn fn;
	void *context;
	bool gone;
	tp_listener *next;
};

// a channel's topic: who is told
typedef struct {
	tp_listener *first;
} channel_t;

// the parts of one ephemeral payload from one sender, by where (a document or a channel's topic)
typedef struct join {
	uint8_t where[32], from[32], whole[32];
	bool channel;
	size_t parts;
	struct {
		size_t index;
		uint8_t *bytes;
		size_t length;
	} *got;
	size_t got_count, got_room;
	uint64_t at;
	struct join *next;
} join_t;

typedef struct {
	doc *d;
	tp_layer layer;
	const hy_kept *kept;
	bool heard;
} told_t;

struct tp_device {
	sl_seeded signer;
	ErmStore inner, store;
	ErmSd *sd;
	char *service;
	uint64_t join;
	tp_clock_fn now;
	void *clock;
	tp_check_fn check;
	tp_snapshot_fn snapshot;
	void *context;
	const rp_merges *merges;
	tp_limits limits;

	im_map docs;
	doc *first, *last;
	doc **followed;
	size_t followed_count, followed_room;

	struct {
		tp_arrived_fn fn;
		void *context;
	} *listeners;
	size_t listener_count, listener_room;
	struct {
		tp_hearing_fn fn;
		void *context;
	} *hearers;
	size_t hearer_count, hearer_room;
	// arrivals the histories' taken listeners told, told on after the add that let them in; own takes
	// that waited, let in, sent after them
	told_t *told;
	size_t told_count, told_next, told_room;
	told_t *released;
	size_t released_count, released_next, released_room;
	// heads with a snapshot hint, taken in by an add: checked by tell, after it (kept: the name)
	struct {
		doc *d;
		uint8_t name[32];
	} *judging;
	size_t judging_count, judging_room;
	// the check changed: what waited on it is judged again at the next run
	bool changed;

	job *jobs, *jobs_last, *cursor;
	item *items, *items_last;

	tp_out *outs;
	size_t out_count, out_next, out_room;
	call_t *calls;
	size_t call_count, call_room;
	conn_t *conns;
	size_t conn_count, conn_room;

	// every topic subscribed to, again on each connection made after
	im_map wanted;
	uint8_t (*wanted_order)[32];
	size_t wanted_count, wanted_room;
	// channels' topics (channel_t)
	im_map channels;
	join_t *joins;

	size_t fetching, putting;
	bool loaded;
	// tp_stored's call, and its answer
	uint64_t want;
	bool answered;
	uint8_t (*found)[32];
	size_t found_count;
};

static uint64_t now_of(const tp_device *t) {
	return t->now ? t->now(t->clock) : erm_host_now();
}

// a peer's key (Subduction's, Ed25519) as the multikey the commits carry it as
static void peer_key(const uint8_t from[32], uint8_t key[SL_KEY]) {
	cm_key_join(0xed, from, 32, key);
}

static void hex_of(const uint8_t *bytes, size_t n, char *out) {
	for (size_t i = 0; i < n; i++) snprintf(out + 2 * i, 3, "%02x", bytes[i]);
}

bool tp_doc(const char *doc, uint8_t bytes[32]) {
	if (doc == NULL || strncmp(doc, "ermine://", 9) != 0 || strlen(doc) != 9 + 64) return false;
	for (size_t i = 0; i < 32; i++) {
		unsigned v = 0;
		for (int k = 0; k < 2; k++) {
			char c = doc[9 + 2 * i + k];
			if (c >= '0' && c <= '9') v = v * 16 + (unsigned)(c - '0');
			else if (c >= 'a' && c <= 'f') v = v * 16 + (unsigned)(c - 'a' + 10);
			else return false;
		}
		bytes[i] = (uint8_t)v;
	}
	return true;
}

// ---- calls Subduction answers later

static void call(tp_device *t, uint64_t number, call_kind kind, void *what) {
	ROOM(t->calls, t->call_count, t->call_room);
	t->calls[t->call_count++] = (call_t){number, kind, what};
}

// ---- jobs and items

static job *job_new(job_kind kind, doc *d) {
	job *j = calloc(1, sizeof *j);
	if (j == NULL) abort();
	j->kind = kind;
	j->d = d;
	return j;
}

// the fragments a build made are the document's: only the list of them is the job's
static void job_free(job *j) {
	free(j->list);
	free(j->checks);
	free(j->bytes);
	free(j->fresh);
	free(j);
}

// at the end of the queue
static void later(tp_device *t, job *j) {
	j->next = NULL;
	if (t->jobs_last) t->jobs_last->next = j;
	else t->jobs = j;
	t->jobs_last = j;
}

// next: after the job running (and what it put next before), else first
static void next(tp_device *t, job *j) {
	if (t->cursor == NULL) {
		j->next = t->jobs;
		t->jobs = j;
		if (t->jobs_last == NULL) t->jobs_last = j;
		return;
	}
	j->next = t->cursor->next;
	t->cursor->next = j;
	if (t->jobs_last == t->cursor) t->jobs_last = j;
	t->cursor = j;
}

static job *build_job(doc *d, const uint8_t (*heads)[32], size_t count) {
	job *j = job_new(J_BUILD, d);
	j->all = heads == NULL;
	if (heads != NULL) {
		j->list = copy(heads, count * 32);
		j->count = count;
	}
	return j;
}

static void enqueue(tp_device *t, doc *d, tp_layer layer, const hy_kept *kept) {
	item *it = calloc(1, sizeof *it);
	if (it == NULL) abort();
	it->d = d;
	it->layer = layer;
	it->kept = kept;
	if (t->items_last) t->items_last->next = it;
	else t->items = it;
	t->items_last = it;
}

// ---- taking in

static void judge(doc *d, const uint8_t name[32]);

static void tell(tp_device *t) {
	while (t->told_next < t->told_count) {
		told_t a = t->told[t->told_next++];
		tp_arrival arrival = {a.d->id, a.layer, a.kept, a.heard};
		for (size_t i = 0; i < t->listener_count; i++) t->listeners[i].fn(t->listeners[i].context, &arrival);
	}
	t->told_count = t->told_next = 0;
	while (t->released_next < t->released_count) {
		told_t r = t->released[t->released_next++];
		enqueue(t, r.d, r.layer, r.kept);
	}
	t->released_count = t->released_next = 0;
	for (size_t i = 0; i < t->judging_count; i++) judge(t->judging[i].d, t->judging[i].name);
	t->judging_count = 0;
}

// own takes and the check: everything from elsewhere is marked in elsewhere before its history's add,
// and stays marked until taken in. The check asks the integration's only for a marked commit; one not
// marked is this device's own take (or a seal of it), which applied here already
static hy_refusal checked(void *context, const hy_kept *kept, const cm_commit *commit) {
	side_t *s = context;
	doc *d = s->d;
	tp_device *t = d->t;
	if (!im_has(&d->elsewhere[s->layer], kept->name) || t->check == NULL) return 0;
	return t->check(t->context, d->id, kept, commit, s->layer);
}

static void taken(void *context, const hy_kept *kept) {
	side_t *s = context;
	doc *d = s->d;
	tp_device *t = d->t;
	if (s->layer == TP_STORED && im_has(&d->hints, kept->name)) {
		ROOM(t->judging, t->judging_count, t->judging_room);
		t->judging[t->judging_count].d = d;
		memcpy(t->judging[t->judging_count++].name, kept->name, 32);
	}
	void *mark = im_get(&d->elsewhere[s->layer], kept->name);
	if (mark == NULL) {
		if (im_del(&d->own[s->layer], kept->name) != NULL) {
			ROOM(t->released, t->released_count, t->released_room);
			t->released[t->released_count++] = (told_t){d, s->layer, kept, false};
		}
		return;
	}
	im_del(&d->elsewhere[s->layer], kept->name);
	ROOM(t->told, t->told_count, t->told_room);
	t->told[t->told_count++] = (told_t){d, s->layer, kept, (uintptr_t)mark == 2};
}

// a commit from elsewhere a history let go of (past its most): its marks go too
static void dropped(void *context, const uint8_t name[32]) {
	side_t *s = context;
	im_del(&s->d->elsewhere[s->layer], name);
	im_del(&s->d->own[s->layer], name);
}

static doc *document(tp_device *t, const uint8_t tree[32]) {
	doc *d = im_get(&t->docs, tree);
	if (d != NULL) return d;
	d = calloc(1, sizeof *d);
	if (d == NULL) abort();
	memcpy(d->bytes, tree, 32);
	memcpy(d->id, "ermine://", 9);
	hex_of(tree, 32, d->id + 9);
	d->t = t;
	for (int l = 0; l < 2; l++) {
		d->sides[l] = (side_t){d, (tp_layer)l};
		d->histories[l] = hy_create(checked, &d->sides[l]);
		hy_limit(d->histories[l], l == TP_EPHEMERAL ? t->limits.waiting : t->limits.pending, dropped, &d->sides[l]);
		hy_on_taken(d->histories[l], taken, &d->sides[l]);
	}
	im_set(&t->docs, tree, d);
	if (t->last) t->last->next = d;
	else t->first = d;
	t->last = d;
	return d;
}

static doc *named(tp_device *t, const char *id) {
	uint8_t tree[32];
	if (!tp_doc(id, tree)) return NULL;
	return document(t, tree);
}

static void doc_free(doc *d) {
	for (int l = 0; l < 2; l++) {
		hy_free(d->histories[l]);
		im_free(&d->elsewhere[l]);
		im_free(&d->own[l]);
	}
	for (size_t i = 0; i < d->names.slots; i++) {
		if (!d->names.used[i]) continue;
		idlist_t *l = d->names.values[i];
		free(l->ids);
		free(l);
	}
	im_free(&d->names);
	for (size_t i = 0; i < d->order_count; i++) {
		free(d->order[i]->sealed);
		free(d->order[i]->bytes);
		free(d->order[i]->ids);
		free(d->order[i]);
	}
	free(d->order);
	im_free(&d->seen);
	for (size_t i = 0; i < d->fragments.slots; i++) {
		if (!d->fragments.used[i]) continue;
		fragment_free(d->fragments.values[i]);
		free(d->fragments.values[i]);
	}
	im_free(&d->fragments);
	for (int k = 0; k < 2; k++) {
		im_map *m = k == 0 ? &d->snapshots : &d->hints;
		for (size_t i = 0; i < m->slots; i++)
			if (m->used[i]) blob_free(m->values[i]);
		im_free(m);
	}
	im_free(&d->judged);
	order_t *orders[] = {&d->pending_order, &d->refused_order, &d->broken_order, &d->heard_order, &d->bad_order,
		&d->hints_order};
	for (size_t i = 0; i < sizeof orders / sizeof *orders; i++) order_free(orders[i]);
	for (size_t i = 0; i < d->pending.slots; i++)
		if (d->pending.used[i]) pending_free(d->pending.values[i]);
	im_free(&d->pending);
	im_free(&d->refused);
	im_free(&d->broken);
	im_free(&d->heard);
	free(d->forgets);
	im_free(&d->bad);
	free(d);
}

// a commit from elsewhere, added to the layer's history, marked until taken in
static void admit(doc *d, tp_layer layer, const uint8_t *bytes, size_t length, const uint8_t name[32], bool heard) {
	im_map *from = &d->elsewhere[layer];
	bool was = im_has(from, name);
	if (!was) im_set(from, name, CODE(1 + heard));
	hy_added a = hy_add(d->histories[layer], bytes, length, NULL);
	// refused, or here already (not waiting from before): nothing comes of the mark
	if (a.kind == HY_REFUSED || (a.kind == HY_PASSED && !was)) im_del(from, name);
	hy_added_free(&a);
}

// handed to the histories: its seal is taken in here. own: a seal of this device's own take, which
// its histories hold already
static void hand(doc *d, const sealed_t *it, const uint8_t *sealed, size_t sealed_length, const uint8_t (*ids)[32],
	size_t count, bool own) {
	idlist_t **slot = (idlist_t **)im_slot(&d->names, it->name);
	if (*slot == NULL) {
		*slot = calloc(1, sizeof **slot);
		if (*slot == NULL) abort();
	}
	idlist_t *l = *slot;
	ROOM(l->ids, l->length, l->room);
	memcpy(l->ids[l->length++], it->stored, 32);
	im_del(&d->bad, it->name);
	im_del(&d->refused, it->stored);
	seen_t *s = calloc(1, sizeof *s);
	if (s == NULL) abort();
	memcpy(s->stored, it->stored, 32);
	memcpy(s->name, it->name, 32);
	s->lamport = it->lamport;
	s->bytes = copy(it->bytes, it->length);
	s->length = it->length;
	s->sealed = sealed != NULL ? copy(sealed, sealed_length) : NULL;
	s->sealed_length = sealed_length;
	s->ids = copy(ids, count * 32);
	s->ids_length = count;
	im_set(&d->seen, it->stored, s);
	ROOM(d->order, d->order_count, d->order_room);
	d->order[d->order_count++] = s;
	if (depth(it->stored) > 0) d->deep++;
	if (own) return;
	admit(d, TP_STORED, it->bytes, it->length, it->name, false);
	// the ephemeral history holds every stored commit too
	admit(d, TP_EPHEMERAL, it->bytes, it->length, it->name, false);
	tell(d->t);
}

static void refuse(doc *d, const uint8_t key[32], tp_code code, const uint8_t *name) {
	uint8_t k[32], n[32];
	memcpy(k, key, 32);
	if (name != NULL) memcpy(n, name, 32);
	pending_t *p = im_del(&d->pending, k);
	note(&d->refused, &d->refused_order, k, CODE(code), d->t->limits.refused, NULL);
	if (name != NULL) note(&d->bad, &d->bad_order, n, SET, d->t->limits.refused, NULL);
	if (p != NULL) pending_free(p);
}

static int by_key(const void *a, const void *b) {
	return memcmp((*(pending_t *const *)a)->key, (*(pending_t *const *)b)->key, 32);
}

static bool among(const idlist_t *l, const uint8_t id[32]) {
	for (size_t i = 0; i < l->length; i++)
		if (memcmp(l->ids[i], id, 32) == 0) return true;
	return false;
}

// for each pending seal, until none moves: stuck while a parent is refused or stuck, waiting while a
// parent's seal is not here; else a commit's parents each one of its commit's parents' stored ids,
// and each of them one of the commit's (refused, parents), or handed to the histories
static void settle(doc *d) {
	for (bool moved = true; moved;) {
		moved = false;
		im_map gone = {0};
		for (size_t i = 0; i < d->bad.slots; i++)
			if (d->bad.used[i]) im_set(&gone, d->bad.keys[i], SET);
		size_t n = 0;
		pending_t **list = malloc((d->pending.count + 1) * sizeof *list);
		if (list == NULL) abort();
		for (size_t i = 0; i < d->pending.slots; i++) {
			if (!d->pending.used[i]) continue;
			pending_t *p = d->pending.values[i];
			list[n++] = p;
			if (p->sticks) im_set(&gone, p->it.name, SET);
		}
		qsort(list, n, sizeof *list, by_key);
		for (size_t i = 0; i < n; i++) {
			pending_t *p = list[i];
			size_t pn = p->it.parents_length, missing = 0, stuck = 0;
			uint8_t(*m)[32] = malloc(pn * 32 + 1), (*s)[32] = malloc(pn * 32 + 1);
			if (m == NULL || s == NULL) abort();
			for (size_t k = 0; k < pn; k++) {
				if (im_has(&d->names, p->it.parents[k])) continue;
				memcpy(m[missing++], p->it.parents[k], 32);
				if (im_has(&gone, p->it.parents[k])) memcpy(s[stuck++], p->it.parents[k], 32);
			}
			bool changed = p->sticks != (stuck > 0) ||
				(stuck > 0 && (p->stuck_length != stuck || memcmp(p->stuck, s, stuck * 32) != 0));
			free(p->stuck);
			free(p->waiting);
			p->sticks = stuck > 0;
			p->stuck = stuck ? s : NULL;
			p->stuck_length = stuck;
			if (!stuck) free(s);
			p->waits = !stuck && missing;
			p->waiting = p->waits ? m : NULL;
			p->waiting_length = p->waits ? missing : 0;
			if (!p->waits) free(m);
			if (changed) moved = true;
			if (missing) continue;
			const idlist_t **of = malloc((pn + 1) * sizeof *of);
			if (of == NULL) abort();
			size_t all = 0;
			for (size_t k = 0; k < pn; k++) {
				of[k] = im_get(&d->names, p->it.parents[k]);
				all += of[k]->length;
			}
			bool match = true;
			if (p->commit) {
				for (size_t g = 0; g < p->given_length && match; g++) {
					bool found = false;
					for (size_t k = 0; k < pn && !found; k++) found = among(of[k], p->given[g]);
					match = found;
				}
				for (size_t k = 0; k < pn && match; k++) {
					bool found = false;
					for (size_t g = 0; g < p->given_length && !found; g++) found = among(of[k], p->given[g]);
					match = found;
				}
			}
			if (!match) refuse(d, p->key, TP_PARENTS, p->it.name);
			else {
				im_del(&d->pending, p->key);
				if (p->commit) hand(d, &p->it, p->sealed, p->sealed_length, (const uint8_t(*)[32])p->given, p->given_length, false);
				else {
					uint8_t(*ids)[32] = malloc(all * 32 + 1);
					if (ids == NULL) abort();
					size_t at = 0;
					for (size_t k = 0; k < pn; k++) {
						memcpy(ids[at], of[k]->ids, of[k]->length * 32);
						at += of[k]->length;
					}
					hand(d, &p->it, p->sealed, p->sealed_length, (const uint8_t(*)[32])ids, all, false);
					free(ids);
				}
				pending_free(p);
			}
			free(of);
			moved = true;
		}
		free(list);
		im_free(&gone);
	}
}

static tp_code code_of(sl_code code) {
	return code == SL_SIGNATURE ? TP_SIGNATURE : TP_SHAPE;
}

// pending, the oldest let go of past the limit (heard again, it comes in again)
static void pending_drop(void *p) {
	pending_free(p);
}
static void pend(doc *d, pending_t *p) {
	pending_t *old = im_del(&d->pending, p->key);
	if (old != NULL) pending_free(old);
	note(&d->pending, &d->pending_order, p->key, p, d->t->limits.pending, pending_drop);
}

// a loose commit's first steps, the lock (unlocked), the seal, its stored id: its commit in *it;
// false: refused, noted
static bool opening(doc *d, const uint8_t head[32], const uint8_t *blob, size_t length, sl_unsealed *it) {
	sl_code code = sl_unseal(blob, length, d->bytes, it, NULL);
	if (code != SL_OK) {
		refuse(d, head, code_of(code), NULL);
		return false;
	}
	if (memcmp(it->stored, head, 32) != 0) {
		uint8_t name[32];
		memcpy(name, it->name, 32);
		sl_free(it);
		refuse(d, head, TP_STORED_ID, name);
		settle(d);
		return false;
	}
	return true;
}

// the steps of a loose commit, in order: the lock (unlocked), the seal, its stored id, then pending
static void take_commit(doc *d, const uint8_t head[32], const uint8_t (*parents)[32], size_t count, const uint8_t *blob,
	size_t length) {
	if (im_has(&d->seen, head)) return;
	sl_unsealed u;
	if (!opening(d, head, blob, length, &u)) return;
	im_del(&d->refused, head);
	pending_t *p = calloc(1, sizeof *p);
	if (p == NULL) abort();
	memcpy(p->key, head, 32);
	p->commit = true;
	sealed_of(&p->it, &u);
	p->sealed = copy(blob, length);
	p->sealed_length = length;
	p->given = copy(parents, count * 32);
	p->given_length = count;
	qsort(p->given, count, 32, by_id);
	pend(d, p);
	settle(d);
}

// what Subduction may store of a loose commit (its admission): one that unseals under its stored id
// (the lock, unlocked, opens all). What is refused is noted, as taking it in notes it
static bool allows(doc *d, const uint8_t head[32], const uint8_t *blob, size_t length) {
	if (im_has(&d->seen, head)) return true;
	sl_unsealed u;
	if (!opening(d, head, blob, length, &u)) return false;
	sl_free(&u);
	return true;
}

// a fragment's member: its sealed bytes (NULL: vouched for by the next in its run), and its commit as
// the transport reads it
typedef struct {
	uint8_t *sealed;
	size_t length;
	sealed_t it;
} member_t;

// a seal taken in as a fragment's member, unsealed: no commit around it. Takes the member's
static void member(doc *d, member_t *m) {
	if (im_has(&d->seen, m->it.stored)) return;
	im_del(&d->refused, m->it.stored);
	pending_t *p = calloc(1, sizeof *p);
	if (p == NULL) abort();
	memcpy(p->key, m->it.stored, 32);
	p->it = m->it;
	m->it = (sealed_t){0};
	p->sealed = m->sealed;
	p->sealed_length = m->length;
	m->sealed = NULL;
	pend(d, p);
}

// a fragment's blob opened: {run: its members as columns (run.h), snapshot?: packed tables}, or
// {members: [sealed...], snapshot?} as it was first written. Each member unsealed as it is read, in
// order: the first that is not good ends it, and the fragment is refused whole with its code (a run
// that is not one, or comes to too much: shape). The snapshot dropped when it does not read back
typedef struct {
	member_t *members;
	size_t count, room;
	uint8_t *snapshot;
	size_t snapshot_length;
	// while reading: the first member refused
	tp_code code;
} contents_t;

static void contents_free(contents_t *c) {
	for (size_t i = 0; i < c->count; i++) {
		free(c->members[i].sealed);
		sealed_free(&c->members[i].it);
	}
	free(c->members);
	free(c->snapshot);
	*c = (contents_t){0};
}

// what a reading keeps: the contents, the document its seals are for, and the members vouched for
// by one not read yet
typedef struct {
	contents_t *c;
	const uint8_t *doc;
	member_t *vouched;
	size_t vouched_count, vouched_room;
} reading_t;

// a member kept
static member_t *push_member(contents_t *c) {
	ROOM(c->members, c->count, c->room);
	member_t *m = &c->members[c->count++];
	*m = (member_t){0};
	return m;
}

// one member read: a seal unsealed and kept, with the ones it vouches for before it; one vouched for,
// held until then. The first that is not good ends the reading
static bool read_member(void *context, const rn_member *r) {
	reading_t *g = context;
	contents_t *c = g->c;
	if (r->sealed == NULL) {
		cm_commit commit;
		if (cm_decode(r->commit, r->commit_length, &commit, NULL) != CM_OK) return c->code = TP_SHAPE, false;
		ROOM(g->vouched, g->vouched_count, g->vouched_room);
		member_t *m = &g->vouched[g->vouched_count++];
		*m = (member_t){0};
		memcpy(m->it.name, r->name, 32);
		memcpy(m->it.stored, r->stored, 32);
		m->it.bytes = copy(r->commit, r->commit_length);
		m->it.length = r->commit_length;
		m->it.lamport = commit.lamport;
		m->it.parents_length = commit.parents_length;
		m->it.parents = copy(commit.parents, commit.parents_length * 32);
		cm_free(&commit);
		return true;
	}
	sl_unsealed u;
	sl_code code = sl_unseal(r->sealed, r->sealed_length, g->doc, &u, NULL);
	if (code != SL_OK) {
		c->code = code_of(code);
		return false;
	}
	for (size_t i = 0; i < g->vouched_count; i++) *push_member(c) = g->vouched[i];
	g->vouched_count = 0;
	member_t *m = push_member(c);
	m->sealed = copy(r->sealed, r->sealed_length);
	m->length = r->sealed_length;
	sealed_of(&m->it, &u);
	return true;
}

// a {members} list's one seal read
static bool read_seal(reading_t *g, const uint8_t *sealed, size_t length) {
	rn_member r = {.sealed = sealed, .sealed_length = length};
	return read_member(g, &r);
}

// 0, or the code the fragment is refused with (out is left empty)
static tp_code contents(const uint8_t doc[32], const uint8_t *open, size_t length, contents_t *out) {
	*out = (contents_t){0};
	reading_t g = {out, doc, NULL, 0, 0};
	Json *x = cborDecode(open, length, NULL, NULL);
	if (x == NULL || x->type != JSON_OBJECT || x->object.count < 1 || x->object.count > 2) return jsonFree(x), TP_SHAPE;
	const Json *run = jsonGet(x, "run"), *members = jsonGet(x, "members"), *snapshot = jsonGet(x, "snapshot");
	if ((run == NULL) == (members == NULL) || (size_t)x->object.count != 1 + (snapshot != NULL)) return jsonFree(x), TP_SHAPE;
	tp_code code = 0;
	if (run != NULL) {
		if (run->type != JSON_BYTES) code = TP_SHAPE;
		else {
			rn_code c = rn_each(run->bytes.data, run->bytes.length, read_member, &g, NULL);
			if (c == RN_STOPPED) code = out->code;
			else if (c != RN_OK) code = TP_SHAPE;
		}
	} else if (members->type != JSON_ARRAY) code = TP_SHAPE;
	else {
		for (int i = 0; i < members->array.count && code == 0; i++) {
			const Json *m = members->array.items[i];
			if (m->type != JSON_BYTES) code = TP_SHAPE;
			else if (!read_seal(&g, m->bytes.data, m->bytes.length)) code = out->code;
		}
	}
	for (size_t i = 0; i < g.vouched_count; i++) sealed_free(&g.vouched[i].it);
	free(g.vouched);
	if (code == 0 && snapshot != NULL) {
		if (snapshot->type != JSON_BYTES) code = TP_SHAPE;
		else {
			rp_tables tables;
			rp_init(&tables);
			if (sn_tables(snapshot->bytes.data, snapshot->bytes.length, &tables) == PK_OK) {
				out->snapshot = copy(snapshot->bytes.data, snapshot->bytes.length);
				out->snapshot_length = snapshot->bytes.length;
			}
			rp_free(&tables);
		}
	}
	jsonFree(x);
	if (code != 0) contents_free(out);
	return code;
}

static bool lookup(void *context, const uint8_t id[32], const uint8_t (**parents)[32], size_t *count);
static const fragment *known(void *context, const uint8_t head[32]);

// the stored ids of the members reached from the head, along each one's parents (by name) among the
// members, into reached (empty)
static void reach(const uint8_t head[32], const contents_t *c, im_map *reached) {
	const member_t **todo = malloc((c->count + 1) * sizeof *todo);
	if (todo == NULL) abort();
	size_t n = 0;
	for (size_t i = 0; i < c->count; i++)
		if (memcmp(c->members[i].it.stored, head, 32) == 0) todo[n++] = &c->members[i];
	while (n > 0) {
		const member_t *m = todo[--n];
		if (im_has(reached, m->it.stored)) continue;
		im_set(reached, m->it.stored, SET);
		for (size_t p = 0; p < m->it.parents_length; p++) {
			for (size_t i = 0; i < c->count; i++) {
				if (memcmp(c->members[i].it.name, m->it.parents[p], 32) != 0) continue;
				todo = realloc(todo, (n + 2) * sizeof *todo);
				if (todo == NULL) abort();
				todo[n++] = &c->members[i];
			}
		}
	}
	free(todo);
}

// whether two lists of ids hold the same ids
static bool same_ids(const uint8_t (*a)[32], size_t an, const uint8_t (*b)[32], size_t bn) {
	im_map x = {0}, y = {0};
	for (size_t i = 0; i < an; i++) im_set(&x, a[i], SET);
	for (size_t i = 0; i < bn; i++) im_set(&y, b[i], SET);
	bool same = x.count == y.count;
	for (size_t i = 0; i < an && same; i++) same = im_has(&y, a[i]);
	im_free(&x), im_free(&y);
	return same;
}

// a fragment's contents (into got), checked against what Subduction says of it, as transport.ts's
// checked: its head one of its members; its head of depth 1 or more, every other member of less depth,
// and reached from the head along parents among the members; its boundary of the head's depth or more
// and none of its members; its checkpoints (their first 12 bytes; NULL: none said) each member but the
// head with a depth; a member's stored id seen here under its own name. A head here whose walk can be
// made here: its members and boundary that walk's.
// 0, or the code it is refused with (got left empty)
static tp_code vetted(doc *d, const uint8_t head[32], const uint8_t (*boundary)[32], size_t count,
	const uint8_t *checkpoints, size_t checks, const uint8_t *open, size_t length, contents_t *got) {
	tp_code code = contents(d->bytes, open, length, got);
	if (code != 0) return code;
	size_t top = depth(head);
	bool has = false;
	im_map ids = {0}, reached = {0};
	for (size_t i = 0; i < got->count; i++) {
		has = has || memcmp(got->members[i].it.stored, head, 32) == 0;
		im_set(&ids, got->members[i].it.stored, SET);
	}
	// a stored id here already is under the name it has here (a vouched one's is only said)
	for (size_t i = 0; i < got->count && has; i++) {
		const seen_t *was = im_get(&d->seen, got->members[i].it.stored);
		if (was != NULL && memcmp(was->name, got->members[i].it.name, 32) != 0) has = false;
	}
	if (!has) code = TP_STORED_ID;
	else {
		reach(head, got, &reached);
		if (top == 0 || reached.count != ids.count) code = TP_BOUNDARY;
		for (size_t i = 0; i < got->count && code == 0; i++) {
			const uint8_t *id = got->members[i].it.stored;
			if (memcmp(id, head, 32) != 0 && depth(id) >= top) code = TP_BOUNDARY;
		}
		for (size_t i = 0; i < count && code == 0; i++)
			if (depth(boundary[i]) < top || im_has(&ids, boundary[i])) code = TP_BOUNDARY;
		if (code == 0 && checkpoints != NULL) {
			im_map want = {0}, given = {0};
			uint8_t k[32] = {0};
			for (size_t i = 0; i < ids.slots; i++) {
				if (!ids.used[i] || memcmp(ids.keys[i], head, 32) == 0 || depth(ids.keys[i]) == 0) continue;
				memcpy(k, ids.keys[i], 12);
				im_set(&want, k, SET);
			}
			for (size_t i = 0; i < checks; i++) memcpy(k, checkpoints + 12 * i, 12), im_set(&given, k, SET);
			bool same = want.count == given.count;
			for (size_t i = 0; i < want.slots && same; i++) same = !want.used[i] || im_has(&given, want.keys[i]);
			if (!same) code = TP_BOUNDARY;
			im_free(&want), im_free(&given);
		}
		if (code == 0 && im_has(&d->seen, head)) {
			fragment w = {0};
			if (fragment_walk(head, lookup, known, d, &w) == FRAGMENT_OK) {
				uint8_t(*mine)[32] = malloc(got->count * 32 + 1);
				if (mine == NULL) abort();
				for (size_t i = 0; i < got->count; i++) memcpy(mine[i], got->members[i].it.stored, 32);
				bool same = same_ids((const uint8_t(*)[32])w.members.ids, w.members.count, (const uint8_t(*)[32])mine,
						    got->count) &&
					same_ids((const uint8_t(*)[32])w.boundary.ids, w.boundary.count, boundary, count);
				free(mine);
				if (!same) code = TP_BOUNDARY;
			}
			fragment_free(&w);
		}
	}
	im_free(&ids), im_free(&reached);
	if (code != 0) contents_free(got);
	return code;
}

// a fragment refused whole, by head
static void broke(doc *d, const uint8_t head[32], tp_code code) {
	note(&d->broken, &d->broken_order, head, CODE(code), d->t->limits.refused, NULL);
}

// what Subduction may store of a fragment (its admission): one that is checked (vetted; the lock,
// unlocked, opens all). One whose head is not here yet is noted refused whole
static bool allows_fragment(doc *d, const uint8_t head[32], const uint8_t (*boundary)[32], size_t count,
	const uint8_t *checkpoints, size_t checks, const uint8_t *blob, size_t length) {
	contents_t got;
	tp_code code = vetted(d, head, boundary, count, checkpoints, checks, blob, length, &got);
	if (code == 0) return contents_free(&got), true;
	if (!im_has(&d->seen, head)) broke(d, head, code);
	return false;
}

// the tables at a commit, from a snapshot kept here
static bool snapshot_of(void *context, const uint8_t name[32], rp_tables *out) {
	const doc *d = context;
	const blob_t *b = im_get(&d->snapshots, name);
	return b != NULL && sn_tables(b->bytes, b->length, out) == PK_OK;
}

// a hint checked, when its head is taken in (rp_matches)
static void judge(doc *d, const uint8_t name[32]) {
	blob_t *b = im_get(&d->hints, name);
	if (b == NULL || hy_get(d->histories[TP_STORED], name) == NULL) return;
	im_del(&d->hints, name);
	im_set(&d->judged, name, SET);
	if (rp_matches(d->histories[TP_STORED], name, b->bytes, b->length, snapshot_of, d, d->t->merges)) {
		blob_free(im_del(&d->snapshots, name));
		im_set(&d->snapshots, name, b);
	} else blob_free(b);
}

// a snapshot a fragment carried is a hint, checked once: once its head is taken in, the tables are
// replayed to it, and it is kept only if they are the same; one that is not is let go of, and so is
// any after it for that head. own: made here, kept as it is. Once there is auth: snapshots signed by
// the fragment's builder (Subduction's issuer), kept if the builder may edit
static void hint(doc *d, const uint8_t name[32], const uint8_t *bytes, size_t length, bool own) {
	if (bytes == NULL || im_has(&d->judged, name)) return;
	blob_t *b = malloc(sizeof *b);
	if (b == NULL) abort();
	*b = (blob_t){copy(bytes, length), length};
	if (own) {
		im_set(&d->judged, name, SET);
		blob_free(im_del(&d->snapshots, name));
		im_set(&d->snapshots, name, b);
		return;
	}
	if (im_has(&d->hints, name)) {
		blob_free(b);
		return;
	}
	note(&d->hints, &d->hints_order, name, b, d->t->limits.refused, blob_free);
	judge(d, name);
}

// a fragment taken in: its members as its blob has them (sorted, a seal there twice kept twice, as
// transport.ts keeps the list), its boundary as Subduction gave it
static fragment *fragment_of(const uint8_t head[32], const contents_t *c, const uint8_t (*boundary)[32],
	size_t boundary_count) {
	fragment *f = calloc(1, sizeof *f);
	if (f == NULL) abort();
	memcpy(f->head, head, 32);
	for (size_t i = 0; i < c->count; i++) fragment_push(&f->members, c->members[i].it.stored);
	for (size_t i = 0; i < boundary_count; i++) fragment_push(&f->boundary, boundary[i]);
	if (f->members.count) qsort(f->members.ids, f->members.count, 32, by_id);
	fragment_settle(&f->boundary);
	return f;
}

static void put_fragment(doc *d, fragment *f) {
	fragment *old = im_del(&d->fragments, f->head);
	if (old != NULL) fragment_free(old), free(old);
	im_set(&d->fragments, f->head, f);
}

// a fragment taken in: its members (each checked) as seals alone, its snapshot a hint. One whose head
// is here already has its members checked too, and is only noted
static void take_fragment(doc *d, const uint8_t head[32], const uint8_t (*boundary)[32], size_t count,
	const uint8_t *checkpoints, size_t checks, const uint8_t *blob, size_t length) {
	const seen_t *here = im_get(&d->seen, head);
	if (here != NULL && im_has(&d->fragments, head) && im_has(&d->judged, here->name)) return;
	contents_t got;
	tp_code code = vetted(d, head, boundary, count, checkpoints, checks, blob, length, &got);
	if (code != 0) {
		if (here == NULL) broke(d, head, code);
		return;
	}
	im_del(&d->broken, head);
	uint8_t top[32];
	for (size_t i = 0; i < got.count; i++)
		if (memcmp(got.members[i].it.stored, head, 32) == 0) memcpy(top, got.members[i].it.name, 32);
	if (!im_has(&d->fragments, head)) put_fragment(d, fragment_of(head, &got, boundary, count));
	for (size_t i = 0; i < got.count; i++) member(d, &got.members[i]);
	if (got.snapshot != NULL) hint(d, top, got.snapshot, got.snapshot_length, false);
	contents_free(&got);
	settle(d);
}

// an ephemeral commit heard from a device with that key (never sealed): the lock's open (unlocked),
// decode (shape), its signer the sender's (signature); then handed to the ephemeral history
static void hear(doc *d, const uint8_t *blob, size_t length, const uint8_t from[32]) {
	uint8_t name[32];
	cm_name(blob, length, name);
	cm_commit c;
	if (cm_decode(blob, length, &c, NULL) != CM_OK) {
		note(&d->heard, &d->heard_order, name, CODE(TP_SHAPE), d->t->limits.refused, NULL);
		return;
	}
	uint8_t who[SL_KEY];
	peer_key(from, who);
	bool same = c.signer_length == SL_KEY && memcmp(c.signer, who, SL_KEY) == 0;
	cm_free(&c);
	if (!same) {
		note(&d->heard, &d->heard_order, name, CODE(TP_SIGNATURE), d->t->limits.refused, NULL);
		return;
	}
	im_del(&d->heard, name);
	admit(d, TP_EPHEMERAL, blob, length, name, true);
	tell(d->t);
	for (size_t i = 0; i < d->t->hearer_count; i++) d->t->hearers[i].fn(d->t->hearers[i].context, d->id, who, name);
}

// ---- parts of an ephemeral payload over Subduction's limit

typedef enum { NOT_A_PART, NO_PART, A_PART } part_kind;
typedef struct {
	uint8_t whole[32];
	size_t part, parts;
	const uint8_t *bytes;
	size_t length;
	Json *own;
} part_t;

// a payload that is a part: a map of exactly whole, part, parts and bytes. NOT_A_PART: not one (a
// commit, or no map); NO_PART: one, but its values are not, or it has more than most parts (dropped)
static part_kind part_of(const uint8_t *payload, size_t length, size_t most, part_t *out) {
	*out = (part_t){0};
	Json *x = cborDecode(payload, length, NULL, NULL);
	if (x == NULL) return NOT_A_PART;
	const Json *whole = jsonGet(x, "whole"), *part = jsonGet(x, "part"), *parts = jsonGet(x, "parts"),
		   *bytes = jsonGet(x, "bytes");
	if (x->type != JSON_OBJECT || x->object.count != 4 || !whole || !part || !parts || !bytes) {
		jsonFree(x);
		return NOT_A_PART;
	}
	int64_t p, n;
	if (whole->type != JSON_BYTES || whole->bytes.length != 32 || bytes->type != JSON_BYTES ||
		bytes->bytes.length > PART || !jsonIsWhole(part, &p) || !jsonIsWhole(parts, &n) || p < 0 || p >= n ||
		(uint64_t)n > most) {
		jsonFree(x);
		return NO_PART;
	}
	memcpy(out->whole, whole->bytes.data, 32);
	out->part = (size_t)p;
	out->parts = (size_t)n;
	out->bytes = bytes->bytes.data;
	out->length = bytes->bytes.length;
	out->own = x;
	return A_PART;
}

static void join_free(join_t *j) {
	for (size_t i = 0; i < j->got_count; i++) free(j->got[i].bytes);
	free(j->got);
	free(j);
}

// the parts not joined by the setting's time dropped; all: whatever the time
static void expire(tp_device *t, bool all) {
	uint64_t now = now_of(t);
	for (join_t **at = &t->joins; *at;) {
		join_t *j = *at;
		if (all || now - j->at >= t->join) {
			*at = j->next;
			join_free(j);
		} else at = &j->next;
	}
}

// one part from a sender: kept with its whole's; when all are here, joined, the hash checked: what
// they make (malloc'd), or NULL
static uint8_t *gather(tp_device *t, const job *p, size_t *length) {
	expire(t, false);
	join_t *j = t->joins;
	while (j && !(j->channel == p->channel && memcmp(j->where, p->channel ? p->topic : p->d->bytes, 32) == 0 &&
			     memcmp(j->from, p->from, 32) == 0 && memcmp(j->whole, p->whole, 32) == 0))
		j = j->next;
	if (j == NULL) {
		// past the limit, the oldest let go of: the last in the list
		size_t n = 0;
		for (join_t *k = t->joins; k != NULL; k = k->next) n++;
		if (n >= t->limits.joins) {
			join_t **at = &t->joins;
			while ((*at)->next != NULL) at = &(*at)->next;
			join_free(*at);
			*at = NULL;
		}
		j = calloc(1, sizeof *j);
		if (j == NULL) abort();
		memcpy(j->where, p->channel ? p->topic : p->d->bytes, 32);
		j->channel = p->channel;
		memcpy(j->from, p->from, 32);
		memcpy(j->whole, p->whole, 32);
		j->parts = p->parts;
		j->at = now_of(t);
		j->next = t->joins;
		t->joins = j;
	}
	if (j->parts != p->parts) return NULL;
	bool has = false;
	for (size_t i = 0; i < j->got_count && !has; i++) has = j->got[i].index == p->part;
	if (!has) {
		ROOM(j->got, j->got_count, j->got_room);
		j->got[j->got_count].index = p->part;
		j->got[j->got_count].bytes = copy(p->bytes, p->length);
		j->got[j->got_count++].length = p->length;
	}
	if (j->got_count < j->parts) return NULL;
	for (join_t **at = &t->joins; *at; at = &(*at)->next) {
		if (*at == j) {
			*at = j->next;
			break;
		}
	}
	size_t total = 0;
	for (size_t i = 0; i < j->got_count; i++) total += j->got[i].length;
	uint8_t *all = malloc(total + 1), hash[32];
	if (all == NULL) abort();
	size_t at = 0;
	for (size_t i = 0; i < j->parts; i++) {
		for (size_t k = 0; k < j->got_count; k++) {
			if (j->got[k].index != i) continue;
			memcpy(all + at, j->got[k].bytes, j->got[k].length);
			at += j->got[k].length;
			break;
		}
	}
	cm_name(all, total, hash);
	bool good = memcmp(hash, j->whole, 32) == 0;
	join_free(j);
	if (!good) return free(all), NULL;
	*length = total;
	return all;
}

// a payload published on a topic: whole when it is no more than LIMIT (and parts is false), else as
// parts of at most PART. The last call
static uint64_t publish(tp_device *t, const uint8_t topic[32], const uint8_t *bytes, size_t length, bool parts) {
	if (length <= LIMIT && !parts) return erm_sd_publish(t->sd, topic, bytes, length);
	uint8_t whole[32];
	cm_name(bytes, length, whole);
	size_t n = (length + PART - 1) / PART;
	if (n == 0) n = 1;
	uint64_t last = 0;
	for (size_t i = 0; i < n; i++) {
		size_t k = length - i * PART < PART ? length - i * PART : PART;
		Json *m = jsonObject();
		jsonAdd(m, "whole", jsonBytes(whole, 32));
		jsonAdd(m, "part", jsonNumber((double)i));
		jsonAdd(m, "parts", jsonNumber((double)n));
		jsonAdd(m, "bytes", jsonBytes(bytes + i * PART, k));
		size_t size = 0;
		cborEncode(m, NULL, 0, &size, NULL);
		uint8_t *out = malloc(size + 1);
		if (out == NULL) abort();
		cborEncode(m, out, size, &size, NULL);
		jsonFree(m);
		last = erm_sd_publish(t->sd, topic, out, size);
		free(out);
	}
	return last;
}

// a channel's topic: BLAKE3 of "ermine/v0/topic" then the topic's CBOR, so never a document's
static channel_t *channel(tp_device *t, const char *name, uint8_t id[32]) {
	Json *s = jsonString(name);
	size_t n = 0;
	cborEncode(s, NULL, 0, &n, NULL);
	uint8_t *bytes = malloc(15 + n + 1);
	if (bytes == NULL) abort();
	memcpy(bytes, "ermine/v0/topic", 15);
	cborEncode(s, bytes + 15, n, &n, NULL);
	jsonFree(s);
	cm_name(bytes, 15 + n, id);
	free(bytes);
	channel_t **slot = (channel_t **)im_slot(&t->channels, id);
	if (*slot == NULL) {
		*slot = calloc(1, sizeof **slot);
		if (*slot == NULL) abort();
	}
	return *slot;
}

static void tell_channel(channel_t *c, const uint8_t from[32], const uint8_t *bytes, size_t length) {
	char who[2 * SL_KEY + 1];
	uint8_t key[SL_KEY];
	peer_key(from, key);
	hex_of(key, SL_KEY, who);
	for (tp_listener *l = c->first; l; l = l->next)
		if (!l->gone) l->fn(l->context, who, bytes, length);
}

// every ephemeral topic this device has subscribed to: again on each connection made after
static uint64_t subscribe(tp_device *t, const uint8_t topic[32]) {
	if (im_has(&t->wanted, topic)) return 0;
	im_set(&t->wanted, topic, SET);
	ROOM(t->wanted_order, t->wanted_count, t->wanted_room);
	memcpy(t->wanted_order[t->wanted_count++], topic, 32);
	return erm_sd_subscribe(t->sd, topic);
}

// ---- building

static bool lookup(void *context, const uint8_t id[32], const uint8_t (**parents)[32], size_t *count) {
	const seen_t *s = im_get(&((doc *)context)->seen, id);
	if (s == NULL) return false;
	*parents = (const uint8_t(*)[32])s->ids;
	*count = s->ids_length;
	return true;
}

static const fragment *known(void *context, const uint8_t head[32]) {
	return im_get(&((doc *)context)->fragments, head);
}

static int by_lamport(const void *x, const void *y) {
	const seen_t *a = *(const seen_t *const *)x, *b = *(const seen_t *const *)y;
	if (a->lamport != b->lamport) return a->lamport < b->lamport ? -1 : 1;
	return memcmp(a->name, b->name, 32);
}

// the fragments not built yet, walked from the job's heads (all: from every head): false when there
// are none
static bool build_start(doc *d, job *j) {
	if (d->deep == 0) return false;
	uint8_t(*heads)[32] = j->list;
	size_t count = j->count;
	if (j->all) {
		im_map covered = {0};
		for (size_t i = 0; i < d->order_count; i++)
			for (size_t k = 0; k < d->order[i]->ids_length; k++) im_set(&covered, d->order[i]->ids[k], SET);
		heads = malloc(d->order_count * 32 + 1);
		if (heads == NULL) abort();
		count = 0;
		for (size_t i = 0; i < d->order_count; i++)
			if (!im_has(&covered, d->order[i]->stored)) memcpy(heads[count++], d->order[i]->stored, 32);
		im_free(&covered);
	}
	fragment *made;
	size_t n;
	fragment_build((const uint8_t(*)[32])heads, count, lookup, known, d, &made, &n);
	if (heads != j->list) free(heads);
	j->fresh = malloc((n + 1) * sizeof *j->fresh);
	if (j->fresh == NULL) abort();
	for (size_t i = 0; i < n; i++) {
		fragment *f = malloc(sizeof *f);
		if (f == NULL) abort();
		*f = made[i];
		put_fragment(d, f);
		j->fresh[i] = f;
	}
	free(made);
	j->fresh_count = n;
	j->at = 0;
	return n > 0;
}

// one fresh fragment's blob, {run, snapshot?}: its members' seals in lamport order, and the tables at
// its head, packed, when the integration gives them; added
static uint64_t build_add(tp_device *t, doc *d, const fragment *f) {
	const seen_t **ms = malloc((f->members.count + 1) * sizeof *ms);
	rn_item *items = malloc((f->members.count + 1) * sizeof *items);
	if (ms == NULL || items == NULL) abort();
	for (size_t i = 0; i < f->members.count; i++) ms[i] = im_get(&d->seen, f->members.ids[i]);
	qsort(ms, f->members.count, sizeof *ms, by_lamport);
	for (size_t i = 0; i < f->members.count; i++)
		items[i] = ms[i]->sealed != NULL ? (rn_item){ms[i]->sealed, ms[i]->sealed_length, NULL}
						  : (rn_item){ms[i]->bytes, ms[i]->length, ms[i]->stored};
	uint8_t *run = NULL;
	size_t run_length = 0;
	rn_pack(items, f->members.count, &run, &run_length);
	free(ms);
	free(items);
	Json *blob = jsonObject();
	jsonAdd(blob, "run", jsonBytes(run, run_length));
	free(run);
	const seen_t *top = im_get(&d->seen, f->head);
	const hy_kept *kept = hy_get(d->histories[TP_STORED], top->name);
	uint8_t *snapshot = NULL;
	size_t snapshot_length = 0;
	if (kept != NULL && t->snapshot != NULL && t->snapshot(t->context, d->id, kept, &snapshot, &snapshot_length)) {
		jsonAdd(blob, "snapshot", jsonBytes(snapshot, snapshot_length));
		hint(d, top->name, snapshot, snapshot_length, true);
		free(snapshot);
	}
	size_t n = 0;
	cborEncode(blob, NULL, 0, &n, NULL);
	uint8_t *bytes = malloc(n + 1);
	if (bytes == NULL) abort();
	cborEncode(blob, bytes, n, &n, NULL);
	jsonFree(blob);
	uint64_t c = erm_sd_add_fragment(t->sd, d->bytes, f->head, f->boundary.count ? (const uint8_t *)f->boundary.ids : NULL,
		f->boundary.count, f->checkpoints.count ? (const uint8_t *)f->checkpoints.ids : NULL, f->checkpoints.count, bytes, n);
	free(bytes);
	return c;
}


// ---- the jobs

// a record from the store: its id, its parents or boundary, its blob. false: it does not decode, or
// its blob is not there
typedef struct {
	ErmSdRecord rec;
	uint8_t *blob;
	size_t length;
} record_t;

static bool record(tp_device *t, int kind, const uint8_t *bytes, size_t length, record_t *out) {
	*out = (record_t){0};
	if (!erm_sd_decode(kind, bytes, length, &out->rec)) return false;
	if (t->inner.get(t->inner.self, ERM_STORE_BLOB, NULL, out->rec.digest, &out->blob, &out->length) != 1) {
		erm_sd_free_record(&out->rec);
		return false;
	}
	return true;
}

static void record_free(record_t *r) {
	erm_sd_free_record(&r->rec);
	erm_host_free(r->blob);
}

static const uint8_t none[1];

// a fragment stored: the loose commits it stands for let go from storage (sedimentree's minimal
// form). Only the members of the fragment the store holds for that head (Subduction keeps one a
// head), checked, and reached from its head: whatever is let go of comes back from it
static void compact(tp_device *t, doc *d, const uint8_t head[32]) {
	uint8_t *bytes = NULL;
	size_t length = 0;
	if (t->inner.get(t->inner.self, ERM_STORE_FRAGMENT, d->bytes, head, &bytes, &length) != 1) return;
	record_t r;
	bool ok = record(t, ERM_STORE_FRAGMENT, bytes != NULL ? bytes : none, length, &r);
	erm_host_free(bytes);
	if (!ok) return;
	contents_t got;
	if (contents(d->bytes, r.blob != NULL ? r.blob : none, r.length, &got) == 0) {
		im_map reached = {0};
		reach(head, &got, &reached);
		for (size_t i = 0; i < reached.slots; i++)
			if (reached.used[i]) t->inner.remove(t->inner.self, ERM_STORE_COMMIT, d->bytes, reached.keys[i]);
		im_free(&reached);
		contents_free(&got);
	}
	record_free(&r);
}

// what the store held, or Subduction saved, taken in; save: then compacted and built as a save is
static void take(tp_device *t, job *j, bool save) {
	const uint8_t *head, *blob, *checks;
	const uint8_t(*list)[32];
	size_t count, length, checks_count;
	record_t r;
	if (j->given) {
		head = j->head, list = (const uint8_t(*)[32])j->list, count = j->count, blob = j->bytes, length = j->length;
		checks = j->checks != NULL ? j->checks : none, checks_count = j->checks_count;
	} else {
		if (!record(t, j->record, j->bytes, j->length, &r)) return;
		head = r.rec.id, list = (const uint8_t(*)[32])r.rec.parents, count = r.rec.parentCount;
		blob = r.blob ? r.blob : none, length = r.length;
		checks = r.rec.checkpoints != NULL ? r.rec.checkpoints : none, checks_count = r.rec.checkpointCount;
	}
	doc *d = document(t, j->tree);
	size_t deep = d->deep;
	if (j->record == ERM_STORE_COMMIT) take_commit(d, head, list, count, blob, length);
	else take_fragment(d, head, list, count, checks, checks_count, blob, length);
	if (save) {
		if (j->record == ERM_STORE_FRAGMENT) {
			const fragment *got = im_get(&d->fragments, head);
			if (got != NULL && got->members.count) {
				job *c = job_new(J_COMPACT, d);
				memcpy(c->head, head, 32);
				later(t, c);
			}
		}
		// only a commit taken in that can head a fragment, or a fragment, makes one to build: walking
		// every commit after each would make n commits cost n squared
		if (j->record == ERM_STORE_FRAGMENT || d->deep != deep) next(t, build_job(d, NULL, 0));
	}
	if (!j->given) record_free(&r);
}

typedef struct {
	uint8_t (*ids)[32];
	size_t count, room;
} collected_t;

static void collect(void *context, const uint8_t id[32]) {
	collected_t *c = context;
	ROOM(c->ids, c->count, c->room);
	memcpy(c->ids[c->count++], id, 32);
}

// starting: what the store holds, taken in before anything else: each tree's fragments, then its
// loose commits, then its fragments built. Read from the store itself, so nothing is saved again
static void load(tp_device *t) {
	collected_t trees = {0};
	t->inner.list(t->inner.self, ERM_STORE_TREE, NULL, collect, &trees);
	for (size_t i = 0; i < trees.count; i++) {
		doc *d = document(t, trees.ids[i]);
		for (int k = 0; k < 2; k++) {
			int kind = k == 0 ? ERM_STORE_FRAGMENT : ERM_STORE_COMMIT;
			collected_t ids = {0};
			t->inner.list(t->inner.self, kind, trees.ids[i], collect, &ids);
			for (size_t n = 0; n < ids.count; n++) {
				uint8_t *bytes = NULL;
				size_t length = 0;
				if (t->inner.get(t->inner.self, kind, trees.ids[i], ids.ids[n], &bytes, &length) != 1) continue;
				job *j = job_new(J_TAKE, d);
				j->record = kind;
				memcpy(j->tree, trees.ids[i], 32);
				j->bytes = copy(bytes ? bytes : none, length);
				j->length = length;
				erm_host_free(bytes);
				next(t, j);
			}
			free(ids.ids);
		}
		next(t, build_job(d, NULL, 0));
	}
	free(trees.ids);
	next(t, job_new(J_LOADED, NULL));
}

static void fetch(tp_device *t, doc *d, fetch_kind kind, size_t ask);
static void post_connect(tp_device *t);

static void follow_now(tp_device *t, doc *d) {
	if (!d->followed) {
		d->followed = true;
		ROOM(t->followed, t->followed_count, t->followed_room);
		t->followed[t->followed_count++] = d;
	}
	subscribe(t, d->bytes);
	fetch(t, d, F_FOLLOW, 0);
}

typedef enum { STEP_DONE, STEP_WAIT } step_t;

static step_t step(tp_device *t, job *j) {
	switch (j->kind) {
	case J_LOAD: load(t); return STEP_DONE;
	case J_LOADED:
		t->loaded = true;
		for (doc *d = t->first; d; d = d->next)
			if (d->follow_later) d->follow_later = false, follow_now(t, d);
		post_connect(t);
		return STEP_DONE;
	case J_TAKE: take(t, j, false); return STEP_DONE;
	case J_SAVE: take(t, j, true); return STEP_DONE;
	case J_HEAR: hear(j->d, j->bytes, j->length, j->from); return STEP_DONE;
	case J_GATHER: {
		size_t length;
		uint8_t *all = gather(t, j, &length);
		if (all == NULL) return STEP_DONE;
		if (!j->channel) hear(j->d, all, length, j->from);
		else {
			channel_t *c = im_get(&t->channels, j->topic);
			if (c != NULL) tell_channel(c, j->from, all, length);
		}
		free(all);
		return STEP_DONE;
	}
	case J_COMPACT: compact(t, j->d, j->head); return STEP_DONE;
	case J_SUBSCRIBE: {
		if (j->started) return STEP_DONE;
		j->started = true;
		uint64_t c = subscribe(t, j->topic);
		if (c == 0) return STEP_DONE;
		call(t, c, C_SUBSCRIBE, j);
		return STEP_WAIT;
	}
	case J_BUILD: {
		doc *d = j->d;
		if (!j->started) {
			j->started = true;
			if (!build_start(d, j)) return STEP_DONE;
		} else {
			const fragment *f = j->fresh[j->at++];
			compact(t, d, f->head);
			if (j->at == j->fresh_count) return STEP_DONE;
		}
		uint64_t c = build_add(t, d, j->fresh[j->at]);
		if (c == 0) return STEP_DONE;
		call(t, c, C_FRAGMENT, j);
		return STEP_WAIT;
	}
	}
	return STEP_DONE;
}

// the jobs, one at a time, in order, as far as they go
static bool jobs(tp_device *t) {
	bool moved = false;
	while (t->jobs != NULL && !t->jobs->waiting) {
		job *j = t->jobs;
		t->cursor = j;
		step_t s = step(t, j);
		t->cursor = NULL;
		moved = true;
		if (s == STEP_WAIT) {
			j->waiting = true;
			break;
		}
		t->jobs = j->next;
		if (t->jobs == NULL) t->jobs_last = NULL;
		if (j->waiter != NULL) j->done = true;
		else job_free(j);
	}
	return moved;
}

// ---- sending what take queued

// a stored commit of this device's: sealed, its seal handed over (taken in already), added as a
// loose commit; one that can head a fragment builds it
static void store(tp_device *t, item *it) {
	doc *d = it->d;
	const hy_kept *k = it->kept;
	sl_made made = {.commit = NULL};
	memcpy(made.name, k->name, 32);
	uint8_t *sealed;
	size_t length;
	if (sl_seal(k->bytes, k->length, &t->signer.signer, d->bytes, &made, &sealed, &length, NULL, NULL) != SL_OK) {
		it->state = 3;
		return;
	}
	uint8_t s[32];
	sl_stored(sealed, length, s);
	uint8_t(*ids)[32] = malloc(k->parents_length * 32 + 1);
	if (ids == NULL) abort();
	for (size_t i = 0; i < k->parents_length; i++) {
		const idlist_t *of = im_get(&d->names, k->parents[i]);
		// a parent is not taken in
		if (of == NULL) {
			free(ids);
			free(sealed);
			it->state = 3;
			return;
		}
		memcpy(ids[i], of->ids[0], 32);
	}
	if (!im_has(&d->seen, s)) {
		sealed_t own = {.bytes = k->bytes, .length = k->length, .lamport = k->lamport,
			.parents = (uint8_t(*)[32])k->parents, .parents_length = k->parents_length};
		memcpy(own.name, k->name, 32);
		memcpy(own.stored, s, 32);
		uint8_t(*sorted)[32] = copy(ids, k->parents_length * 32);
		qsort(sorted, k->parents_length, 32, by_id);
		hand(d, &own, sealed, length, (const uint8_t(*)[32])sorted, k->parents_length, true);
		free(sorted);
		// a seal from elsewhere may wait on this one
		settle(d);
	}
	memcpy(it->stored, s, 32);
	uint64_t c = erm_sd_add_commit(t->sd, d->bytes, s, k->parents_length ? (const uint8_t *)ids : NULL, k->parents_length,
		sealed, length);
	free(ids);
	free(sealed);
	if (c == 0) {
		it->state = 3;
		return;
	}
	call(t, c, C_STORE, it);
	it->state = 1;
}

static bool outgoing(tp_device *t) {
	bool moved = false;
	while (t->items != NULL) {
		item *it = t->items;
		if (it->state == 2 && it->build->done) {
			job_free(it->build);
			it->build = NULL;
			it->state = 3;
		}
		if (it->state == 1 || it->state == 2) break;
		if (it->state == 0) {
			// what is sealed and stored is handed over behind what the store held
			if (!t->loaded) break;
			moved = true;
			if (it->layer == TP_STORED) store(t, it);
			else {
				// an ephemeral commit of this device's: closed (unlocked), published, as parts when over
				uint64_t c = publish(t, it->d->bytes, it->kept->bytes, it->kept->length, false);
				if (c == 0) it->state = 3;
				else call(t, c, C_PUBLISH, it), it->state = 1;
			}
			continue;
		}
		t->items = it->next;
		if (t->items == NULL) t->items_last = NULL;
		free(it);
		moved = true;
	}
	return moved;
}

// ---- fetching

static void fetch(tp_device *t, doc *d, fetch_kind kind, size_t ask) {
	uint64_t c = erm_sd_sync(t->sd, d->bytes, 1, 0);
	if (c == 0) return;
	fetch_t *f = malloc(sizeof *f);
	if (f == NULL) abort();
	*f = (fetch_t){d, kind, 1, ask};
	call(t, c, C_FETCH, f);
	t->fetching++;
}

static size_t taken_count(doc *d) {
	const hy_kept **all;
	size_t n = hy_all(d->histories[TP_STORED], &all);
	free(all);
	return n;
}

// whether a commit waits on a parent: a seal held here for its parents' seals, or a commit in the
// stored history
static bool waits(doc *d) {
	for (size_t i = 0; i < d->pending.slots; i++) {
		if (d->pending.used[i] && ((const pending_t *)d->pending.values[i])->waits) return true;
	}
	hy_waiting_row *rows = NULL;
	size_t n = hy_waiting(d->histories[TP_STORED], &rows);
	hy_waiting_free(rows, n);
	return n > 0;
}

// a followed document asked for again, a while later each time: the server pushes a commit to its
// subscribers before it stores it, so an ask that lands between is answered without it and hears no
// push. Asked twice more whatever it holds, then on while it holds nothing or a commit waits on a
// parent; after the last step, every last step while a commit waits
static bool worth(doc *d, size_t i) {
	return i < 2 || (i < BACKOFF && taken_count(d) == 0) || waits(d);
}
static void asking(tp_device *t, doc *d, size_t i) {
	d->asking = false;
	if (!worth(d, i)) return;
	d->asking = true;
	d->ask = i;
	d->due = now_of(t) + backoff[i < BACKOFF ? i : BACKOFF - 1];
}

static bool timers(tp_device *t, uint64_t now) {
	bool moved = false;
	for (doc *d = t->first; d; d = d->next) {
		if (!d->asking || now < d->due) continue;
		d->asking = false;
		moved = true;
		if (!worth(d, d->ask)) continue;
		fetch(t, d, F_ASK, d->ask);
	}
	return moved;
}

// connections whose handshake is done, once what the store held is in: the topics subscribed again
// (a subscription reaches only the connections there when it is made), the followed documents fetched
static void post_connect(tp_device *t) {
	if (!t->loaded) return;
	for (size_t i = 0; i < t->conn_count; i++) {
		if (!t->conns[i].up || !t->conns[i].fresh) continue;
		t->conns[i].fresh = false;
		for (size_t k = 0; k < t->wanted_count; k++) erm_sd_subscribe(t->sd, t->wanted_order[k]);
		for (size_t k = 0; k < t->followed_count; k++) fetch(t, t->followed[k], F_CONNECT, 0);
	}
}

// ---- Subduction's events

static void ask(tp_device *t, tp_out_kind kind, uint64_t conn, const uint8_t *bytes, size_t length) {
	ROOM(t->outs, t->out_count, t->out_room);
	t->outs[t->out_count++] = (tp_out){kind, conn, bytes ? copy(bytes, length) : NULL, length};
}

static void forget_conn(tp_device *t, uint64_t conn) {
	for (size_t i = 0; i < t->conn_count; i++) {
		if (t->conns[i].id != conn) continue;
		t->conns[i] = t->conns[--t->conn_count];
		return;
	}
}

static void given_save(tp_device *t, put_t *p, int kind) {
	job *j = job_new(J_SAVE, p->d);
	j->record = kind;
	j->given = true;
	memcpy(j->tree, p->d->bytes, 32);
	memcpy(j->head, p->head, 32);
	j->list = p->list, j->count = p->count, p->list = NULL;
	j->bytes = p->blob, j->length = p->length, p->blob = NULL;
	j->checks = p->checks, j->checks_count = p->checks_count, p->checks = NULL;
	later(t, j);
}

static void put_free(put_t *p) {
	free(p->list);
	free(p->blob);
	free(p->checks);
	free(p);
}

static void done(tp_device *t, uint64_t number, bool ok) {
	size_t i = 0;
	while (i < t->call_count && t->calls[i].call != number) i++;
	if (i == t->call_count) return;
	call_t c = t->calls[i];
	t->calls[i] = t->calls[--t->call_count];
	switch (c.kind) {
	case C_STORE: {
		item *it = c.what;
		it->state = 3;
		if (ok && depth(it->stored) > 0) {
			// Subduction asks for a fragment (FragmentRequested): built in the queue, and waited for
			it->build = build_job(it->d, (const uint8_t(*)[32])it->stored, 1);
			it->build->waiter = it;
			later(t, it->build);
			it->state = 2;
		}
		break;
	}
	case C_PUBLISH: ((item *)c.what)->state = 3; break;
	case C_FRAGMENT:
	case C_SUBSCRIBE: ((job *)c.what)->waiting = false; break;
	case C_FETCH: {
		fetch_t *f = c.what;
		if (f->round == 1) {
			uint64_t again = erm_sd_sync(t->sd, f->d->bytes, 1, 0);
			if (again != 0) {
				f->round = 2;
				call(t, again, C_FETCH, f);
				break;
			}
		}
		t->fetching--;
		if (f->kind == F_FOLLOW) asking(t, f->d, 0);
		else if (f->kind == F_ASK) asking(t, f->d, f->ask + 1);
		free(f);
		break;
	}
	case C_PUT:
	case C_PUT_FRAGMENT: {
		put_t *p = c.what;
		t->putting--;
		int kind = c.kind == C_PUT ? ERM_STORE_COMMIT : ERM_STORE_FRAGMENT;
		if (ok) {
			// a save Subduction passed over (one it holds under that id with a lower digest) is taken in
			// as given, as the save hook would have it
			if (!p->saw) given_save(t, p, kind);
			if (kind == ERM_STORE_FRAGMENT || depth(p->head) > 0) later(t, build_job(p->d, NULL, 0));
		}
		put_free(p);
		break;
	}
	}
}

// an ephemeral message: a document's (followed), or a channel's
static void heard(tp_device *t, const uint8_t topic[32], const uint8_t from[32], const uint8_t *payload, size_t length) {
	doc *d = im_get(&t->docs, topic);
	part_t p;
	part_kind kind = part_of(payload, length, t->limits.parts, &p);
	channel_t *c = im_get(&t->channels, topic);
	job *j = NULL;
	if (c != NULL && d == NULL) {
		if (kind == NOT_A_PART) tell_channel(c, from, payload, length);
		else if (kind == A_PART) {
			j = job_new(J_GATHER, NULL);
			j->channel = true;
			memcpy(j->topic, topic, 32);
		}
	} else if (d != NULL && d->followed) {
		if (kind == NOT_A_PART) {
			j = job_new(J_HEAR, d);
			j->bytes = copy(payload, length);
			j->length = length;
		} else if (kind == A_PART) j = job_new(J_GATHER, d);
	}
	if (j != NULL) {
		memcpy(j->from, from, 32);
		if (j->kind == J_GATHER) {
			memcpy(j->whole, p.whole, 32);
			j->part = p.part;
			j->parts = p.parts;
			j->bytes = copy(p.bytes, p.length);
			j->length = p.length;
		}
		later(t, j);
	}
	jsonFree(p.own);
}

static bool events(tp_device *t) {
	bool any = false;
	ErmSdEvent e;
	while (erm_sd_poll(t->sd, &e)) {
		any = true;
		switch (e.kind) {
		case ERM_SD_SEND: ask(t, TP_SEND, e.conn, e.bytes, e.length); break;
		case ERM_SD_CLOSE:
			ask(t, TP_CLOSE, e.conn, NULL, 0);
			forget_conn(t, e.conn);
			break;
		case ERM_SD_DONE: done(t, e.call, e.ok); break;
		case ERM_SD_CONNECTED:
			for (size_t i = 0; i < t->conn_count; i++) {
				if (t->conns[i].id != e.conn) continue;
				if (e.ok) {
					t->conns[i].up = t->conns[i].fresh = true;
					memcpy(t->conns[i].key, e.key, 32);
				} else forget_conn(t, e.conn);
				break;
			}
			post_connect(t);
			break;
		case ERM_SD_COMMITS:
			if (e.call != t->want) break;
			free(t->found);
			t->found = malloc(e.count * 32 + 1);
			if (t->found == NULL) abort();
			for (size_t i = 0; i < e.count; i++) memcpy(t->found[i], e.commits[i].id, 32);
			t->found_count = e.count;
			t->answered = true;
			break;
		case ERM_SD_HEARD: heard(t, e.topic, e.key, e.bytes, e.length); break;
		default: break;
		}
		erm_sd_free_event(&e);
	}
	return any;
}

// ---- Subduction's store, wrapped: what it saves is taken in

// what Subduction may store (its admission: allows, allows_fragment), the record decoded and its blob,
// put just before it, read. One not admitted is refused (the save fails), its blob let go of too
static bool admits(tp_device *t, int kind, const uint8_t tree[32], const uint8_t *bytes, size_t length) {
	record_t r;
	if (!record(t, kind, bytes, length, &r)) return false;
	doc *d = document(t, tree);
	const uint8_t *blob = r.blob != NULL ? r.blob : none;
	bool ok = kind == ERM_STORE_COMMIT
		? allows(d, r.rec.id, blob, r.length)
		: allows_fragment(d, r.rec.id, (const uint8_t(*)[32])r.rec.parents, r.rec.parentCount,
			  r.rec.checkpoints != NULL ? r.rec.checkpoints : none, r.rec.checkpointCount, blob, r.length);
	if (!ok) t->inner.remove(t->inner.self, ERM_STORE_BLOB, NULL, r.rec.digest);
	record_free(&r);
	return ok;
}

static int saved(void *self, int kind, const uint8_t *tree, const uint8_t id[32], const uint8_t *bytes, size_t length) {
	tp_device *t = self;
	if ((kind == ERM_STORE_COMMIT || kind == ERM_STORE_FRAGMENT) && !admits(t, kind, tree, bytes, length)) return -1;
	int r = t->inner.put(t->inner.self, kind, tree, id, bytes, length);
	if (r != 0 || (kind != ERM_STORE_COMMIT && kind != ERM_STORE_FRAGMENT)) return r;
	call_kind waits = kind == ERM_STORE_COMMIT ? C_PUT : C_PUT_FRAGMENT;
	for (size_t i = 0; i < t->call_count; i++) {
		if (t->calls[i].kind != waits) continue;
		put_t *p = t->calls[i].what;
		if (memcmp(p->d->bytes, tree, 32) == 0 && memcmp(p->head, id, 32) == 0) p->saw = true;
	}
	job *j = job_new(J_SAVE, NULL);
	j->record = kind;
	memcpy(j->tree, tree, 32);
	j->bytes = copy(bytes, length);
	j->length = length;
	later(t, j);
	return 0;
}

static int store_get(void *self, int kind, const uint8_t *tree, const uint8_t id[32], uint8_t **bytes, size_t *length) {
	tp_device *t = self;
	return t->inner.get(t->inner.self, kind, tree, id, bytes, length);
}

static int store_list(void *self, int kind, const uint8_t *tree, void (*each)(void *context, const uint8_t id[32]),
	void *context) {
	tp_device *t = self;
	return t->inner.list(t->inner.self, kind, tree, each, context);
}

static int store_remove(void *self, int kind, const uint8_t *tree, const uint8_t *id) {
	tp_device *t = self;
	return t->inner.remove(t->inner.self, kind, tree, id);
}

// ---- the device

tp_device *tp_create(const tp_options *o) {
	tp_device *t = calloc(1, sizeof *t);
	if (t == NULL) abort();
	sl_seeded_init(&t->signer, o->seed);
	t->inner = *o->store;
	t->store = (ErmStore){t, saved, store_get, store_list, store_remove};
	t->service = copyString(o->service ? o->service : "ermine");
	t->join = o->join ? o->join : 30000;
	t->now = o->now;
	t->clock = o->clock;
	t->check = o->check;
	t->snapshot = o->snapshot;
	t->context = o->context;
	t->merges = o->merges;
	tp_limits l = o->limits;
	t->limits = (tp_limits){l.pending ? l.pending : 65536, l.refused ? l.refused : 4096, l.waiting ? l.waiting : 1024,
		l.joins ? l.joins : 64, l.parts ? l.parts : 1024};
	t->sd = erm_sd_new(o->seed, now_of(t), &t->store);
	if (t->sd == NULL) {
		free(t->service);
		free(t);
		return NULL;
	}
	later(t, job_new(J_LOAD, NULL));
	return t;
}

void tp_free(tp_device *t) {
	if (t == NULL) return;
	erm_sd_free(t->sd);
	for (doc *d = t->first; d;) {
		doc *n = d->next;
		doc_free(d);
		d = n;
	}
	im_free(&t->docs);
	free(t->followed);
	free(t->listeners);
	free(t->hearers);
	free(t->told);
	free(t->released);
	free(t->judging);
	for (job *j = t->jobs; j;) {
		job *n = j->next;
		if (j->waiter == NULL) job_free(j);
		j = n;
	}
	for (item *it = t->items; it;) {
		item *n = it->next;
		if (it->build != NULL) job_free(it->build);
		free(it);
		it = n;
	}
	for (size_t i = t->out_next; i < t->out_count; i++) free(t->outs[i].bytes);
	free(t->outs);
	for (size_t i = 0; i < t->call_count; i++) {
		if (t->calls[i].kind == C_FETCH) free(t->calls[i].what);
		if (t->calls[i].kind == C_PUT || t->calls[i].kind == C_PUT_FRAGMENT) put_free(t->calls[i].what);
	}
	free(t->calls);
	free(t->conns);
	im_free(&t->wanted);
	free(t->wanted_order);
	for (size_t i = 0; i < t->channels.slots; i++) {
		if (!t->channels.used[i]) continue;
		channel_t *c = t->channels.values[i];
		for (tp_listener *l = c->first; l;) {
			tp_listener *n = l->next;
			free(l);
			l = n;
		}
		free(c);
	}
	im_free(&t->channels);
	expire(t, true);
	free(t->found);
	free(t->service);
	free(t);
}

const uint8_t *tp_key(const tp_device *t) {
	return t->signer.signer.key;
}

// listeners let go of since they were last told
static void sweep(tp_device *t) {
	for (size_t i = 0; i < t->channels.slots; i++) {
		if (!t->channels.used[i]) continue;
		channel_t *c = t->channels.values[i];
		for (tp_listener **at = &c->first; *at;) {
			tp_listener *l = *at;
			if (l->gone) *at = l->next, free(l);
			else at = &l->next;
		}
	}
}

static void forget_due(tp_device *t);
static bool rejudge(tp_device *t);

int64_t tp_run(tp_device *t) {
	for (;;) {
		uint64_t now = now_of(t);
		int64_t wait = erm_sd_run(t->sd, now);
		bool moved = events(t);
		moved = rejudge(t) || moved;
		moved = jobs(t) || moved;
		moved = outgoing(t) || moved;
		moved = timers(t, now) || moved;
		if (moved || wait == 0) continue;
		sweep(t);
		forget_due(t);
		int64_t timer = -1;
		for (doc *d = t->first; d; d = d->next) {
			if (!d->asking) continue;
			int64_t in = d->due > now ? (int64_t)(d->due - now) : 0;
			if (timer < 0 || in < timer) timer = in;
		}
		if (wait < 0) return timer;
		return timer < 0 || wait < timer ? wait : timer;
	}
}

bool tp_idle(const tp_device *t) {
	return t->jobs == NULL && t->items == NULL;
}

bool tp_ready(const tp_device *t) {
	return t->loaded;
}

size_t tp_fetching(const tp_device *t) {
	return t->fetching;
}

uint64_t tp_connect(tp_device *t, const char *service) {
	uint64_t c = erm_sd_connect(t->sd, service != NULL ? service : t->service);
	if (c == 0) return 0;
	ROOM(t->conns, t->conn_count, t->conn_room);
	t->conns[t->conn_count++] = (conn_t){.id = c};
	return c;
}

void tp_received(tp_device *t, uint64_t conn, const uint8_t *bytes, size_t length) {
	erm_sd_received(t->sd, conn, bytes, length);
}

void tp_closed(tp_device *t, uint64_t conn) {
	erm_sd_closed(t->sd, conn);
	forget_conn(t, conn);
}

bool tp_connected(const tp_device *t, uint64_t conn, uint8_t key[SL_KEY]) {
	for (size_t i = 0; i < t->conn_count; i++) {
		if (t->conns[i].id != conn || !t->conns[i].up) continue;
		if (key != NULL) peer_key(t->conns[i].key, key);
		return true;
	}
	return false;
}

void tp_disconnect(tp_device *t, const uint8_t key[SL_KEY]) {
	// the peer by its Ed25519 key: the multikey's
	if (key[0] != 0xed || key[1] != 0x01) return;
	for (size_t i = 0; i < t->conn_count;) {
		if (!t->conns[i].up || memcmp(t->conns[i].key, key + 2, 32) != 0) {
			i++;
			continue;
		}
		uint64_t conn = t->conns[i].id;
		erm_sd_closed(t->sd, conn);
		ask(t, TP_CLOSE, conn, NULL, 0);
		t->conns[i] = t->conns[--t->conn_count];
	}
}

void tp_service(const char *url, char *out, size_t size) {
	const char *at = strstr(url, "://");
	at = at ? at + 3 : url;
	size_t n = strcspn(at, "/?#");
	const char *login = memchr(at, '@', n);
	if (login) n -= (size_t)(login + 1 - at), at = login + 1;
	if (n >= size) n = size - 1;
	memcpy(out, at, n);
	out[n] = 0;
}

bool tp_next(tp_device *t, tp_out *out) {
	if (t->out_next == t->out_count) {
		t->out_count = t->out_next = 0;
		return false;
	}
	*out = t->outs[t->out_next++];
	return true;
}

void tp_out_free(tp_out *out) {
	free(out->bytes);
	out->bytes = NULL;
}

bool tp_follow(tp_device *t, const char *id) {
	doc *d = named(t, id);
	if (d == NULL) return false;
	if (!t->loaded) d->follow_later = true;
	else follow_now(t, d);
	return true;
}

hy_history *tp_history(tp_device *t, const char *id, tp_layer layer) {
	doc *d = named(t, id);
	return d == NULL ? NULL : d->histories[layer];
}

hy_added tp_take(tp_device *t, const char *id, const uint8_t *bytes, size_t length, tp_layer layer, const hy_made *made) {
	doc *d = named(t, id);
	if (d == NULL) return (hy_added){.kind = HY_REFUSED, .refusal = HY_SHAPE};
	hy_added added = hy_add(d->histories[layer], bytes, length, made);
	if (layer == TP_STORED) {
		hy_added also = hy_add(d->histories[TP_EPHEMERAL], bytes, length, made);
		hy_added_free(&also);
	}
	// only what is taken goes out: one passed is here already, one refused would be refused by a
	// receiver too, one waiting on a parent goes once it is let in
	uint8_t name[32];
	if (made != NULL) memcpy(name, made->name, 32);
	else cm_name(bytes, length, name);
	if (added.kind == HY_TAKEN) enqueue(t, d, layer, hy_get(d->histories[layer], name));
	else if (added.kind == HY_WAITING) im_set(&d->own[layer], name, SET);
	// an own take may let in what waited on it: from elsewhere, told; its own, sent after it
	tell(t);
	return added;
}

void tp_arrived(tp_device *t, tp_arrived_fn fn, void *context) {
	ROOM(t->listeners, t->listener_count, t->listener_room);
	t->listeners[t->listener_count].fn = fn;
	t->listeners[t->listener_count++].context = context;
}

void tp_hearing(tp_device *t, tp_hearing_fn fn, void *context) {
	ROOM(t->hearers, t->hearer_count, t->hearer_room);
	t->hearers[t->hearer_count].fn = fn;
	t->hearers[t->hearer_count++].context = context;
}

bool tp_again(tp_device *t, const char *id, const uint8_t name[32]) {
	doc *d = named(t, id);
	if (d == NULL) return false;
	const hy_kept *kept = hy_get(d->histories[TP_EPHEMERAL], name);
	if (kept == NULL || hy_get(d->histories[TP_STORED], name) != NULL) return false;
	enqueue(t, d, TP_EPHEMERAL, kept);
	return true;
}

bool tp_forget(tp_device *t, const char *id, const uint8_t name[32]) {
	doc *d = named(t, id);
	if (d == NULL || hy_get(d->histories[TP_EPHEMERAL], name) == NULL ||
		hy_get(d->histories[TP_STORED], name) != NULL)
		return false;
	ROOM(d->forgets, d->forgets_count, d->forgets_room);
	memcpy(d->forgets[d->forgets_count++], name, 32);
	return true;
}

// whether anything queued here holds the commit: an item going out, an arrival to tell
static bool held(const tp_device *t, const hy_kept *k) {
	for (const item *it = t->items; it != NULL; it = it->next)
		if (it->kept == k) return true;
	for (size_t i = t->told_next; i < t->told_count; i++)
		if (t->told[i].kept == k) return true;
	for (size_t i = t->released_next; i < t->released_count; i++)
		if (t->released[i].kept == k) return true;
	return false;
}

// the ephemeral commits forgotten that nothing holds now, let go of
static void forget_due(tp_device *t) {
	for (doc *d = t->first; d; d = d->next) {
		size_t keep = 0;
		for (size_t i = 0; i < d->forgets_count; i++) {
			const uint8_t *name = d->forgets[i];
			const hy_kept *k = hy_get(d->histories[TP_EPHEMERAL], name);
			if (k == NULL || hy_get(d->histories[TP_STORED], name) != NULL) continue;
			if (held(t, k)) {
				memmove(d->forgets[keep++], name, 32);
				continue;
			}
			hy_forget(d->histories[TP_EPHEMERAL], name);
			im_del(&d->elsewhere[TP_EPHEMERAL], name);
			im_del(&d->own[TP_EPHEMERAL], name);
			im_del(&d->heard, name);
		}
		d->forgets_count = keep;
	}
}

bool tp_snapshot(tp_device *t, const char *id, const uint8_t name[32], rp_tables *out) {
	doc *d = named(t, id);
	if (d == NULL) return false;
	const blob_t *b = im_get(&d->snapshots, name);
	return b != NULL && sn_tables(b->bytes, b->length, out) == PK_OK;
}

size_t tp_stored(tp_device *t, const char *id, uint8_t (**out)[32]) {
	*out = NULL;
	doc *d = named(t, id);
	if (d == NULL) return 0;
	free(t->found);
	t->found = NULL;
	t->found_count = 0;
	t->answered = false;
	t->want = erm_sd_commits(t->sd, d->bytes);
	for (int round = 0; round < 10000 && !t->answered; round++) tp_run(t);
	*out = t->found;
	t->found = NULL;
	size_t n = t->found_count;
	t->found_count = 0;
	return n;
}

size_t tp_fragments(tp_device *t, const char *id, const fragment ***out) {
	*out = NULL;
	doc *d = named(t, id);
	if (d == NULL) return 0;
	const fragment **list = malloc((d->fragments.count + 1) * sizeof *list);
	if (list == NULL) abort();
	size_t n = 0;
	for (size_t i = 0; i < d->fragments.slots; i++)
		if (d->fragments.used[i]) list[n++] = d->fragments.values[i];
	*out = list;
	return n;
}

void tp_send(tp_device *t, const char *topic, const uint8_t *bytes, size_t length) {
	uint8_t id[32];
	channel(t, topic, id);
	// a server relays a publish only from a subscriber of its topic
	subscribe(t, id);
	part_t p;
	part_kind kind = part_of(bytes, length, t->limits.parts, &p);
	jsonFree(p.own);
	// a payload that looks like a part is sent as parts too, so it arrives as it was sent
	publish(t, id, bytes, length, kind != NOT_A_PART);
}

tp_listener *tp_listen(tp_device *t, const char *topic, tp_heard_fn fn, void *context) {
	uint8_t id[32];
	channel_t *c = channel(t, topic, id);
	tp_listener *l = calloc(1, sizeof *l);
	if (l == NULL) abort();
	l->fn = fn;
	l->context = context;
	tp_listener **at = &c->first;
	while (*at) at = &(*at)->next;
	*at = l;
	job *j = job_new(J_SUBSCRIBE, NULL);
	memcpy(j->topic, id, 32);
	later(t, j);
	return l;
}

void tp_unlisten(tp_device *t, tp_listener *l) {
	(void)t;
	l->gone = true;
}

void tp_changed(tp_device *t) {
	t->changed = true;
}

// the check changed: the commits waiting on it judged again, what that lets in told
static bool rejudge(tp_device *t) {
	if (!t->changed) return false;
	t->changed = false;
	for (doc *d = t->first; d; d = d->next)
		for (int l = 0; l < 2; l++) hy_again(d->histories[l]);
	tell(t);
	return true;
}

// the harnesses' hooks (transport_conformance_hook.h), only in their builds
#ifdef CONFORMANCE_HOOK
#include "transport_conformance_hook.c"
#endif
