// The mailroom (mailroom.h), in C: what a device keeps of its documents' commits, laid out as mailroom.ts is. Per
// document two histories, the seals taken in and those waiting on a parent's seal, what is refused,
// the snapshot hints; and this device's own takes, queued for the stack. A stack (subduction.c is one)
// talks to it through the functions in mailroom.h, which are what any stack would use.
#include "mailroom.h"

#include "snapshot.h"

#include "../../../ermine/encoding/c/json.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

const char *mr_layer_name(mr_layer layer) {
	return layer == MR_EPHEMERAL ? "ephemeral" : "stored";
}

const char *mr_code_name(mr_code code) {
	switch (code) {
	case MR_LOCK: return "lock";
	case MR_SHAPE: return "shape";
	case MR_SIGNATURE: return "signature";
	case MR_STORED_ID: return "stored";
	case MR_PARENTS: return "parents";
	case MR_BOUNDARY: return "boundary";
	case MR_ID: return "id";
	}
	return "";
}

void *mr_copy(const void *bytes, size_t length) {
	void *out = malloc(length ? length : 1);
	if (out == NULL) abort();
	if (length) memcpy(out, bytes, length);
	return out;
}

static int by_id(const void *a, const void *b) {
	return memcmp(a, b, 32);
}

// ---- what is kept of a seal

void mr_sealed_free(mr_sealed_t *s) {
	free(s->bytes);
	free(s->parents);
	*s = (mr_sealed_t){0};
}

// the unsealed's, taking its bytes; the unsealed is let go of
void mr_sealed_of(mr_sealed_t *s, sl_unsealed *u) {
	memcpy(s->name, u->name, CM_NAME);
	memcpy(s->stored, u->stored, 32);
	s->bytes = u->bytes;
	s->length = u->length;
	u->bytes = NULL;
	s->lamport = u->commit.lamport;
	s->parents_length = u->commit.parents_length;
	s->parents = mr_copy(u->commit.parents, u->commit.parents_length * CM_NAME);
	sl_free(u);
}

static void pending_free(mr_pending_t *p) {
	mr_sealed_free(&p->it);
	free(p->sealed);
	free(p->given);
	free(p->waiting);
	free(p->stuck);
	free(p);
}

void mr_blob_free(void *b) {
	if (b == NULL) return;
	free(((mr_blob_t *)b)->bytes);
	free(b);
}

void mr_order_free(mr_order_t *o) {
	im_free(&o->at);
	free(o->keys);
	*o = (mr_order_t){0};
}

// whether the order's entry k is the key's place in the map now
static bool current(const im_map *m, const mr_order_t *o, size_t k) {
	return im_has(m, o->keys[k].key) && (uintptr_t)im_get(&o->at, o->keys[k].key) == o->keys[k].serial;
}

// the key into the map, under value. New to it: past most, the oldest let go of first (drop: what is
// done with its value, or NULL)
void mr_note(im_map *m, mr_order_t *o, const uint8_t *key, void *value, size_t most, void (*drop)(void *value)) {
	if (!im_has(m, key)) {
		o->at.width = m->width;
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
		memcpy(o->keys[o->count].key, key, im_width(m));
		o->keys[o->count++].serial = ++o->serial;
		im_set(&o->at, key, (void *)o->serial);
	}
	im_set(m, key, value);
}

static void refusal_free(void *x) {
	mr_refusal *r = x;
	if (r == NULL) return;
	free(r->why);
	free(r);
}

void mr_refusal_note(im_map *m, mr_order_t *o, const uint8_t *key, mr_code code, const char *why, size_t most) {
	mr_refusal *r = calloc(1, sizeof *r);
	if (r == NULL) abort();
	r->code = code;
	r->why = why != NULL ? copyString(why) : NULL;
	// one before under the key: replaced where it is in the order
	refusal_free(im_get(m, key));
	mr_note(m, o, key, r, most, refusal_free);
}

void mr_refusal_del(im_map *m, const uint8_t *key) {
	refusal_free(im_del(m, key));
}

void mr_refusals_free(im_map *m) {
	for (size_t i = 0; i < m->slots; i++)
		if (m->used[i]) refusal_free(m->values[i]);
	im_free(m);
}

// ---- the mailroom

static void doc_free(mr_doc *d);
static void judge(mr_doc *d, const uint8_t name[CM_NAME]);

typedef struct {
	mr_doc *d;
	mr_layer layer;
	const hy_kept *kept;
	bool heard;
} told_t;

struct mr_mailroom {
	sl_seeded signer;
	mr_check_fn check;
	void *context;
	const rp_merges *merges;
	mr_limits limits;
	mr_stack stack;
	void *kcontext;

	im_map docs;
	mr_doc *first, *last;

	struct {
		mr_arrived_fn fn;
		void *context;
	} *listeners;
	size_t listener_count, listener_room;
	struct {
		mr_hearing_fn fn;
		void *context;
	} *hearers;
	size_t hearer_count, hearer_room;
	struct {
		mr_stopped_fn fn;
		void *context;
	} *stoppers;
	size_t stopper_count, stopper_room;
	struct {
		mr_moved_fn fn;
		void *context;
	} *movers;
	size_t mover_count, mover_room;
	// arrivals the histories' taken listeners told, told on after the add that let them in; own takes
	// that waited, let in, sent after them
	told_t *told;
	size_t told_count, told_next, told_room;
	told_t *released;
	size_t released_count, released_next, released_room;
	// heads with a snapshot hint, taken in by an add: checked by tell, after it (kept: the name)
	struct {
		mr_doc *d;
		uint8_t name[CM_NAME];
	} *judging;
	size_t judging_count, judging_room;
	// the check changed: what waited on it is judged again at the next run
	bool changed;

	// this device's own takes going out, in the order made
	mr_item *items, *items_last;
};

mr_mailroom *mr_create(const mr_options *o) {
	mr_mailroom *k = calloc(1, sizeof *k);
	if (k == NULL) abort();
	sl_seeded_init(&k->signer, o->seed);
	k->check = o->check;
	k->context = o->context;
	k->merges = o->merges;
	mr_limits l = o->limits;
	k->limits = (mr_limits){l.pending ? l.pending : 65536, l.refused ? l.refused : 4096, l.waiting ? l.waiting : 1024};
	return k;
}

void mr_attach(mr_mailroom *k, const mr_stack *stack, void *context) {
	k->stack = *stack;
	k->kcontext = context;
}

void mr_free(mr_mailroom *k) {
	if (k == NULL) return;
	for (mr_doc *d = k->first; d;) {
		mr_doc *n = d->next;
		doc_free(d);
		d = n;
	}
	im_free(&k->docs);
	free(k->listeners);
	free(k->hearers);
	free(k->movers);
	free(k->stoppers);
	free(k->told);
	free(k->released);
	free(k->judging);
	for (mr_item *it = k->items; it;) {
		mr_item *n = it->next;
		free(it->stop);
		free(it);
		it = n;
	}
	free(k);
}

const uint8_t *mr_key(const mr_mailroom *k) {
	return k->signer.signer.key;
}

const mr_limits *mr_limits_of(const mr_mailroom *k) {
	return &k->limits;
}

mr_doc *mr_find(const mr_mailroom *k, const uint8_t key[32]) {
	return im_get(&k->docs, key);
}

mr_doc *mr_first(const mr_mailroom *k) {
	return k->first;
}

// a peer's key (Subduction's, Ed25519) as the multikey the commits carry it as
void mr_peer(const uint8_t from[32], uint8_t key[SL_KEY]) {
	cm_key_join(0xed, from, 32, key);
}

void mr_hex(const uint8_t *bytes, size_t n, char *out) {
	for (size_t i = 0; i < n; i++) snprintf(out + 2 * i, 3, "%02x", bytes[i]);
}

void mr_changed(mr_mailroom *k) {
	k->changed = true;
}

mr_item *mr_front(mr_mailroom *k) {
	return k->items;
}

// the first item let go of
void mr_pop(mr_mailroom *k) {
	mr_item *it = k->items;
	k->items = it->next;
	if (k->items == NULL) k->items_last = NULL;
	free(it->stop);
	free(it);
}

bool mr_idle(const mr_mailroom *k) {
	return k->items == NULL;
}

bool mr_id(const char *doc, uint8_t key[32]) {
	uint8_t bytes[ID_MAX];
	if (doc == NULL || id_parse(doc, strlen(doc), bytes) == 0) return false;
	cm_digest((const uint8_t *)doc, strlen(doc), key);
	return true;
}

static void enqueue(mr_mailroom *k, mr_doc *d, mr_layer layer, const hy_kept *kept) {
	mr_item *it = calloc(1, sizeof *it);
	if (it == NULL) abort();
	it->d = d;
	it->layer = layer;
	it->kept = kept;
	if (k->items_last) k->items_last->next = it;
	else k->items = it;
	k->items_last = it;
}

// ---- taking in

static void tell(mr_mailroom *k) {
	while (k->told_next < k->told_count) {
		told_t a = k->told[k->told_next++];
		mr_arrival arrival = {a.d->id, a.layer, a.kept, a.heard};
		for (size_t i = 0; i < k->listener_count; i++) k->listeners[i].fn(k->listeners[i].context, &arrival);
	}
	k->told_count = k->told_next = 0;
	while (k->released_next < k->released_count) {
		told_t r = k->released[k->released_next++];
		enqueue(k, r.d, r.layer, r.kept);
	}
	k->released_count = k->released_next = 0;
	for (size_t i = 0; i < k->judging_count; i++) judge(k->judging[i].d, k->judging[i].name);
	k->judging_count = 0;
}

// own takes and the check: everything from elsewhere is marked in elsewhere before its history's add,
// and stays marked until taken in. The check asks the integration's only for a marked commit; one not
// marked is this device's own take (or a seal of it), which applied here already
static hy_refusal checked(void *context, const hy_kept *kept, const cm_commit *commit) {
	mr_side *s = context;
	mr_doc *d = s->d;
	mr_mailroom *k = d->mailroom;
	if (!im_has(&d->elsewhere[s->layer], kept->name) || k->check == NULL) return 0;
	return k->check(k->context, d->id, kept, commit, s->layer);
}

static void taken(void *context, const hy_kept *kept) {
	mr_side *s = context;
	mr_doc *d = s->d;
	mr_mailroom *k = d->mailroom;
	if (s->layer == MR_STORED && im_has(&d->hints, kept->name)) {
		ROOM(k->judging, k->judging_count, k->judging_room);
		k->judging[k->judging_count].d = d;
		memcpy(k->judging[k->judging_count++].name, kept->name, CM_NAME);
	}
	void *mark = im_get(&d->elsewhere[s->layer], kept->name);
	if (mark == NULL) {
		if (im_del(&d->own[s->layer], kept->name) != NULL) {
			ROOM(k->released, k->released_count, k->released_room);
			k->released[k->released_count++] = (told_t){d, s->layer, kept, false};
		}
		return;
	}
	im_del(&d->elsewhere[s->layer], kept->name);
	ROOM(k->told, k->told_count, k->told_room);
	k->told[k->told_count++] = (told_t){d, s->layer, kept, (uintptr_t)mark == 2};
}

// a commit from elsewhere a history let go of (past its most): its marks go too
static void dropped(void *context, const uint8_t name[CM_NAME]) {
	mr_side *s = context;
	im_del(&s->d->elsewhere[s->layer], name);
	im_del(&s->d->own[s->layer], name);
}

mr_doc *mr_named(mr_mailroom *k, const char *id) {
	uint8_t key[32];
	if (!mr_id(id, key)) return NULL;
	mr_doc *d = im_get(&k->docs, key);
	if (d != NULL) return d;
	d = calloc(1, sizeof *d);
	if (d == NULL) abort();
	d->length = strlen(id);
	d->id = mr_copy(id, d->length + 1);
	memcpy(d->key, key, 32);
	// the maps keyed by names
	d->elsewhere[0].width = d->elsewhere[1].width = d->own[0].width = d->own[1].width = CM_NAME;
	d->names.width = d->snapshots.width = d->hints.width = d->judged.width = CM_NAME;
	d->heard.width = d->bad.width = CM_NAME;
	d->mailroom = k;
	for (int l = 0; l < 2; l++) {
		d->sides[l] = (mr_side){d, (mr_layer)l};
		d->histories[l] = hy_create(checked, &d->sides[l]);
		hy_limit(d->histories[l], l == MR_EPHEMERAL ? k->limits.waiting : k->limits.pending, dropped, &d->sides[l]);
		hy_on_taken(d->histories[l], taken, &d->sides[l]);
	}
	im_set(&k->docs, key, d);
	if (k->last) k->last->next = d;
	else k->first = d;
	k->last = d;
	if (k->stack.made != NULL) k->stack.made(k->kcontext, d);
	return d;
}

static void doc_free(mr_doc *d) {
	for (int l = 0; l < 2; l++) {
		hy_free(d->histories[l]);
		im_free(&d->elsewhere[l]);
		im_free(&d->own[l]);
	}
	for (size_t i = 0; i < d->names.slots; i++) {
		if (!d->names.used[i]) continue;
		mr_idlist_t *l = d->names.values[i];
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
	for (int k = 0; k < 2; k++) {
		im_map *m = k == 0 ? &d->snapshots : &d->hints;
		for (size_t i = 0; i < m->slots; i++)
			if (m->used[i]) mr_blob_free(m->values[i]);
		im_free(m);
	}
	im_free(&d->judged);
	mr_order_t *orders[] = {&d->pending_order, &d->refused_order, &d->heard_order, &d->bad_order,
		&d->hints_order};
	for (size_t i = 0; i < sizeof orders / sizeof *orders; i++) mr_order_free(orders[i]);
	for (size_t i = 0; i < d->pending.slots; i++)
		if (d->pending.used[i]) pending_free(d->pending.values[i]);
	im_free(&d->pending);
	mr_refusals_free(&d->refused);
	mr_refusals_free(&d->heard);
	free(d->forgets);
	im_free(&d->bad);
	free(d->id);
	free(d);
}

// a commit from elsewhere, added to the layer's history, marked until taken in
static void admit(mr_doc *d, mr_layer layer, const uint8_t *bytes, size_t length, const uint8_t name[CM_NAME], bool heard) {
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
static void hand(mr_doc *d, const mr_sealed_t *it, const uint8_t *sealed, size_t sealed_length, const uint8_t (*ids)[32],
	size_t count, bool own) {
	mr_idlist_t **slot = (mr_idlist_t **)im_slot(&d->names, it->name);
	if (*slot == NULL) {
		*slot = calloc(1, sizeof **slot);
		if (*slot == NULL) abort();
	}
	mr_idlist_t *l = *slot;
	ROOM(l->ids, l->length, l->room);
	memcpy(l->ids[l->length++], it->stored, 32);
	im_del(&d->bad, it->name);
	mr_refusal_del(&d->refused, it->stored);
	mr_seen_t *s = calloc(1, sizeof *s);
	if (s == NULL) abort();
	memcpy(s->stored, it->stored, 32);
	memcpy(s->name, it->name, CM_NAME);
	s->lamport = it->lamport;
	s->bytes = mr_copy(it->bytes, it->length);
	s->length = it->length;
	s->sealed = sealed != NULL ? mr_copy(sealed, sealed_length) : NULL;
	s->sealed_length = sealed_length;
	s->ids = mr_copy(ids, count * 32);
	s->ids_length = count;
	im_set(&d->seen, it->stored, s);
	ROOM(d->order, d->order_count, d->order_room);
	d->order[d->order_count++] = s;
	if (d->mailroom->stack.handed != NULL) d->mailroom->stack.handed(d->mailroom->kcontext, d, it->stored);
	if (own) return;
	admit(d, MR_STORED, it->bytes, it->length, it->name, false);
	// the ephemeral history holds every stored commit too
	admit(d, MR_EPHEMERAL, it->bytes, it->length, it->name, false);
	tell(d->mailroom);
}

void mr_refuse(mr_doc *d, const uint8_t key[32], mr_code code, const uint8_t *name, const char *why) {
	uint8_t k[32], n[CM_NAME];
	memcpy(k, key, 32);
	if (name != NULL) memcpy(n, name, CM_NAME);
	mr_pending_t *p = im_del(&d->pending, k);
	mr_refusal_note(&d->refused, &d->refused_order, k, code, why, d->mailroom->limits.refused);
	if (name != NULL) mr_note(&d->bad, &d->bad_order, n, SET, d->mailroom->limits.refused, NULL);
	if (p != NULL) pending_free(p);
}

static int by_key(const void *a, const void *b) {
	return memcmp((*(mr_pending_t *const *)a)->key, (*(mr_pending_t *const *)b)->key, 32);
}

static bool among(const mr_idlist_t *l, const uint8_t id[32]) {
	for (size_t i = 0; i < l->length; i++)
		if (memcmp(l->ids[i], id, 32) == 0) return true;
	return false;
}

// for each pending seal, until none moves: stuck while a parent is refused or stuck, waiting while a
// parent's seal is not here; else a commit's parents each one of its commit's parents' stored ids,
// and each of them one of the commit's (refused, parents), or handed to the histories
void mr_settle(mr_doc *d) {
	for (bool moved = true; moved;) {
		moved = false;
		im_map gone = {.width = CM_NAME};
		for (size_t i = 0; i < d->bad.slots; i++)
			if (d->bad.used[i]) im_set(&gone, im_key(&d->bad, i), SET);
		size_t n = 0;
		mr_pending_t **list = malloc((d->pending.count + 1) * sizeof *list);
		if (list == NULL) abort();
		for (size_t i = 0; i < d->pending.slots; i++) {
			if (!d->pending.used[i]) continue;
			mr_pending_t *p = d->pending.values[i];
			list[n++] = p;
			if (p->sticks) im_set(&gone, p->it.name, SET);
		}
		qsort(list, n, sizeof *list, by_key);
		for (size_t i = 0; i < n; i++) {
			mr_pending_t *p = list[i];
			size_t pn = p->it.parents_length, missing = 0, stuck = 0;
			uint8_t(*m)[CM_NAME] = malloc(pn * CM_NAME + 1), (*s)[CM_NAME] = malloc(pn * CM_NAME + 1);
			if (m == NULL || s == NULL) abort();
			for (size_t k = 0; k < pn; k++) {
				if (im_has(&d->names, p->it.parents[k])) continue;
				memcpy(m[missing++], p->it.parents[k], CM_NAME);
				if (im_has(&gone, p->it.parents[k])) memcpy(s[stuck++], p->it.parents[k], CM_NAME);
			}
			bool changed = p->sticks != (stuck > 0) ||
				(stuck > 0 && (p->stuck_length != stuck || memcmp(p->stuck, s, stuck * CM_NAME) != 0));
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
			const mr_idlist_t **of = malloc((pn + 1) * sizeof *of);
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
			if (!match) mr_refuse(d, p->key, MR_PARENTS, p->it.name, NULL);
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

// pending, the oldest let go of past the limit (heard again, it comes in again)
static void pending_drop(void *p) {
	pending_free(p);
}

void mr_pend(mr_doc *d, mr_pending_t *p) {
	mr_refusal_del(&d->refused, p->key);
	mr_pending_t *old = im_del(&d->pending, p->key);
	if (old != NULL) pending_free(old);
	mr_note(&d->pending, &d->pending_order, p->key, p, d->mailroom->limits.pending, pending_drop);
}

// a seal taken in as a fragment's member, unsealed: no commit around it. Takes the member's
void mr_member(mr_doc *d, mr_member_t *m) {
	if (im_has(&d->seen, m->it.stored)) return;
	mr_refusal_del(&d->refused, m->it.stored);
	mr_pending_t *p = calloc(1, sizeof *p);
	if (p == NULL) abort();
	memcpy(p->key, m->it.stored, 32);
	p->it = m->it;
	m->it = (mr_sealed_t){0};
	p->sealed = m->sealed;
	p->sealed_length = m->length;
	m->sealed = NULL;
	mr_pend(d, p);
}

// the tables at a commit, from a snapshot kept here
static bool snapshot_of(void *context, const uint8_t name[CM_NAME], rp_tables *out) {
	const mr_doc *d = context;
	const mr_blob_t *b = im_get(&d->snapshots, name);
	return b != NULL && sn_tables(b->bytes, b->length, out) == PK_OK;
}

// a hint checked, when its head is taken in (rp_matches)
static void judge(mr_doc *d, const uint8_t name[CM_NAME]) {
	mr_blob_t *b = im_get(&d->hints, name);
	if (b == NULL || hy_get(d->histories[MR_STORED], name) == NULL) return;
	im_del(&d->hints, name);
	im_set(&d->judged, name, SET);
	if (rp_matches(d->histories[MR_STORED], name, b->bytes, b->length, snapshot_of, d, d->mailroom->merges)) {
		mr_blob_free(im_del(&d->snapshots, name));
		im_set(&d->snapshots, name, b);
	} else mr_blob_free(b);
}

// a snapshot a fragment carried is a hint, checked once: once its head is taken in, the tables are
// replayed to it, and it is kept only if they are the same; one that is not is let go of, and so is
// any after it for that head. own: made here, kept as it is. Once there is auth: snapshots signed by
// the fragment's builder (Subduction's issuer), kept if the builder may edit
void mr_hint(mr_doc *d, const uint8_t name[CM_NAME], const uint8_t *bytes, size_t length, bool own) {
	if (bytes == NULL || im_has(&d->judged, name)) return;
	mr_blob_t *b = malloc(sizeof *b);
	if (b == NULL) abort();
	*b = (mr_blob_t){mr_copy(bytes, length), length};
	if (own) {
		im_set(&d->judged, name, SET);
		mr_blob_free(im_del(&d->snapshots, name));
		im_set(&d->snapshots, name, b);
		return;
	}
	if (im_has(&d->hints, name)) {
		mr_blob_free(b);
		return;
	}
	mr_note(&d->hints, &d->hints_order, name, b, d->mailroom->limits.refused, mr_blob_free);
	judge(d, name);
}

// an ephemeral commit heard from a device with that key, a multikey (never sealed), already opened by
// the stack's lock: decode (shape), its signer the sender's (signature); then handed to the ephemeral history
void mr_hear(mr_doc *d, const uint8_t *blob, size_t length, const uint8_t who[SL_KEY]) {
	uint8_t name[CM_NAME];
	cm_name(blob, length, name);
	cm_commit c;
	if (cm_decode(blob, length, &c, NULL) != CM_OK) {
		mr_refusal_note(&d->heard, &d->heard_order, name, MR_SHAPE, NULL, d->mailroom->limits.refused);
		return;
	}
	bool same = c.signer_length == SL_KEY && memcmp(c.signer, who, SL_KEY) == 0;
	cm_free(&c);
	if (!same) {
		mr_refusal_note(&d->heard, &d->heard_order, name, MR_SIGNATURE, NULL, d->mailroom->limits.refused);
		return;
	}
	mr_refusal_del(&d->heard, name);
	admit(d, MR_EPHEMERAL, blob, length, name, true);
	tell(d->mailroom);
	for (size_t i = 0; i < d->mailroom->hearer_count; i++) d->mailroom->hearers[i].fn(d->mailroom->hearers[i].context, d->id, who, name);
}

// an ephemeral commit refused before it could be opened, noted by its name
void mr_unheard(mr_doc *d, const uint8_t *blob, size_t length, mr_code code, const char *why) {
	uint8_t name[CM_NAME];
	cm_name(blob, length, name);
	mr_refusal_note(&d->heard, &d->heard_order, name, code, why, d->mailroom->limits.refused);
}

// ---- own takes, handed to the stack

// what is held back or refused at the document may have changed: told
void mr_tell_moved(mr_mailroom *k, mr_doc *d) {
	for (size_t i = 0; i < k->mover_count; i++) k->movers[i].fn(k->movers[i].context, d->id);
}

// a stop heard from a device (a multikey): told in its turn, by the stack
void mr_tell_stopped(mr_doc *d, const uint8_t from[SL_KEY], const char *table) {
	mr_mailroom *k = d->mailroom;
	for (size_t i = 0; i < k->stopper_count; i++) k->stoppers[i].fn(k->stoppers[i].context, d->id, from, table);
}

// a seal opened and checked, in its document: its commit in *u
sl_code mr_opened(mr_doc *d, const uint8_t *blob, size_t length, sl_unsealed *u) {
	return sl_unseal(blob, length, (const uint8_t *)d->id, d->length, u, NULL);
}

// whether a commit waits on a parent: a seal held here for its parents' seals, or a commit in the
// stored history
bool mr_waits(const mr_doc *d) {
	for (size_t i = 0; i < d->pending.slots; i++) {
		if (d->pending.used[i] && ((const mr_pending_t *)d->pending.values[i])->waits) return true;
	}
	hy_waiting_row *rows = NULL;
	size_t n = hy_waiting(d->histories[MR_STORED], &rows);
	hy_waiting_free(rows, n);
	return n > 0;
}

// a stored commit of this device's: sealed, and its stored id (this device's own, named already)
bool mr_sealed(mr_doc *d, const hy_kept *k, uint8_t **sealed, size_t *length, uint8_t stored[32]) {
	sl_made made = {.commit = NULL};
	memcpy(made.name, k->name, CM_NAME);
	if (sl_seal(k->bytes, k->length, &d->mailroom->signer.signer, (const uint8_t *)d->id, d->length, &made, sealed, length,
		    NULL, NULL) != SL_OK)
		return false;
	sl_stored(*sealed, *length, stored);
	return true;
}

// its seal handed over (taken in already), behind the parents' seals handed over before it: the
// parents' stored ids into *ids
bool mr_handed(mr_doc *d, const hy_kept *k, const uint8_t *sealed, size_t length, const uint8_t s[32],
	uint8_t (**ids)[32]) {
	*ids = malloc(k->parents_length * 32 + 1);
	if (*ids == NULL) abort();
	for (size_t i = 0; i < k->parents_length; i++) {
		const mr_idlist_t *of = im_get(&d->names, k->parents[i]);
		// a parent is not taken in
		if (of == NULL) {
			free(*ids);
			*ids = NULL;
			return false;
		}
		memcpy((*ids)[i], of->ids[0], 32);
	}
	if (!im_has(&d->seen, s)) {
		mr_sealed_t own = {.bytes = k->bytes, .length = k->length, .lamport = k->lamport,
			.parents = (uint8_t(*)[CM_NAME])k->parents, .parents_length = k->parents_length};
		memcpy(own.name, k->name, CM_NAME);
		memcpy(own.stored, s, 32);
		uint8_t(*sorted)[32] = mr_copy(*ids, k->parents_length * 32);
		qsort(sorted, k->parents_length, 32, by_id);
		hand(d, &own, sealed, length, (const uint8_t(*)[32])sorted, k->parents_length, true);
		free(sorted);
		// a seal from elsewhere may wait on this one
		mr_settle(d);
		mr_tell_moved(d->mailroom, d);
	}
	return true;
}

hy_added mr_take(mr_mailroom *k, const char *id, const uint8_t *bytes, size_t length, mr_layer layer, const hy_made *made) {
	mr_doc *d = mr_named(k, id);
	if (d == NULL) return (hy_added){.kind = HY_REFUSED, .refusal = HY_SHAPE};
	hy_added added = hy_add(d->histories[layer], bytes, length, made);
	if (layer == MR_STORED) {
		hy_added also = hy_add(d->histories[MR_EPHEMERAL], bytes, length, made);
		hy_added_free(&also);
	}
	// only what is taken goes out: one passed is here already, one refused would be refused by a
	// receiver too, one waiting on a parent goes once it is let in
	uint8_t name[CM_NAME];
	if (made != NULL) memcpy(name, made->name, CM_NAME);
	else cm_name(bytes, length, name);
	if (added.kind == HY_TAKEN) enqueue(k, d, layer, hy_get(d->histories[layer], name));
	else if (added.kind == HY_WAITING) im_set(&d->own[layer], name, SET);
	// an own take may let in what waited on it: from elsewhere, told; its own, sent after it
	tell(k);
	return added;
}

hy_history *mr_history(mr_mailroom *k, const char *id, mr_layer layer) {
	mr_doc *d = mr_named(k, id);
	return d == NULL ? NULL : d->histories[layer];
}

void mr_arrived(mr_mailroom *k, mr_arrived_fn fn, void *context) {
	ROOM(k->listeners, k->listener_count, k->listener_room);
	k->listeners[k->listener_count].fn = fn;
	k->listeners[k->listener_count++].context = context;
}

void mr_moved(mr_mailroom *k, mr_moved_fn fn, void *context) {
	ROOM(k->movers, k->mover_count, k->mover_room);
	k->movers[k->mover_count].fn = fn;
	k->movers[k->mover_count++].context = context;
}

void mr_hearing(mr_mailroom *k, mr_hearing_fn fn, void *context) {
	ROOM(k->hearers, k->hearer_count, k->hearer_room);
	k->hearers[k->hearer_count].fn = fn;
	k->hearers[k->hearer_count++].context = context;
}

void mr_stop(mr_mailroom *k, const char *id, const char *table) {
	mr_doc *d = mr_named(k, id);
	if (d == NULL || table == NULL) return;
	mr_item *it = calloc(1, sizeof *it);
	if (it == NULL) abort();
	it->d = d;
	it->layer = MR_EPHEMERAL;
	it->stop = copyString(table);
	if (k->items_last) k->items_last->next = it;
	else k->items = it;
	k->items_last = it;
}

void mr_stopped(mr_mailroom *k, mr_stopped_fn fn, void *context) {
	ROOM(k->stoppers, k->stopper_count, k->stopper_room);
	k->stoppers[k->stopper_count].fn = fn;
	k->stoppers[k->stopper_count++].context = context;
}

bool mr_again(mr_mailroom *k, const char *id, const uint8_t name[CM_NAME]) {
	mr_doc *d = mr_named(k, id);
	if (d == NULL) return false;
	const hy_kept *kept = hy_get(d->histories[MR_EPHEMERAL], name);
	if (kept == NULL || hy_get(d->histories[MR_STORED], name) != NULL) return false;
	enqueue(k, d, MR_EPHEMERAL, kept);
	return true;
}

bool mr_forget(mr_mailroom *k, const char *id, const uint8_t name[CM_NAME]) {
	mr_doc *d = mr_named(k, id);
	if (d == NULL || hy_get(d->histories[MR_EPHEMERAL], name) == NULL ||
		hy_get(d->histories[MR_STORED], name) != NULL)
		return false;
	ROOM(d->forgets, d->forgets_count, d->forgets_room);
	memcpy(d->forgets[d->forgets_count++], name, CM_NAME);
	return true;
}

// whether anything queued here holds the commit: an item going out, an arrival to tell
static bool held(const mr_mailroom *t, const hy_kept *k) {
	for (const mr_item *it = t->items; it != NULL; it = it->next)
		if (it->kept == k) return true;
	for (size_t i = t->told_next; i < t->told_count; i++)
		if (t->told[i].kept == k) return true;
	for (size_t i = t->released_next; i < t->released_count; i++)
		if (t->released[i].kept == k) return true;
	return false;
}

// the ephemeral commits forgotten that nothing holds now, let go of
void mr_forgotten(mr_mailroom *t) {
	for (mr_doc *d = t->first; d; d = d->next) {
		size_t mailroom = 0;
		for (size_t i = 0; i < d->forgets_count; i++) {
			const uint8_t *name = d->forgets[i];
			const hy_kept *k = hy_get(d->histories[MR_EPHEMERAL], name);
			if (k == NULL || hy_get(d->histories[MR_STORED], name) != NULL) continue;
			if (held(t, k)) {
				memmove(d->forgets[mailroom++], name, CM_NAME);
				continue;
			}
			hy_forget(d->histories[MR_EPHEMERAL], name);
			im_del(&d->elsewhere[MR_EPHEMERAL], name);
			im_del(&d->own[MR_EPHEMERAL], name);
			mr_refusal_del(&d->heard, name);
		}
		d->forgets_count = mailroom;
	}
}

bool mr_snapshot(mr_mailroom *k, const char *id, const uint8_t name[CM_NAME], rp_tables *out) {
	mr_doc *d = mr_named(k, id);
	if (d == NULL) return false;
	const mr_blob_t *b = im_get(&d->snapshots, name);
	return b != NULL && sn_tables(b->bytes, b->length, out) == PK_OK;
}

// the check changed: the commits waiting on it judged again, what that lets in told
bool mr_rejudge(mr_mailroom *k) {
	if (!k->changed) return false;
	k->changed = false;
	for (mr_doc *d = k->first; d; d = d->next)
		for (int l = 0; l < 2; l++) hy_again(d->histories[l]);
	tell(k);
	for (mr_doc *d = k->first; d; d = d->next) mr_tell_moved(k, d);
	return true;
}

static int by_waiting(const void *a, const void *b) {
	return memcmp(((const mr_waiting_row *)a)->commit, ((const mr_waiting_row *)b)->commit, 32);
}

static int by_refused(const void *a, const void *b) {
	return memcmp(((const mr_refused_row *)a)->id, ((const mr_refused_row *)b)->id, ((const mr_refused_row *)a)->id_length);
}

mr_taking mr_taking_of(mr_doc *d, mr_layer layer, const im_map *broken, const im_map *locked) {
	mr_taking out = {0};
	if (layer == MR_EPHEMERAL) {
		out.refused = calloc(d->heard.count + 1, sizeof *out.refused);
		if (out.refused == NULL) abort();
		for (size_t i = 0; i < d->heard.slots; i++) {
			if (!d->heard.used[i]) continue;
			mr_refused_row *r = &out.refused[out.refused_count++];
			memcpy(r->id, im_key(&d->heard, i), CM_NAME);
			r->id_length = CM_NAME;
			const mr_refusal *x = d->heard.values[i];
			r->code = x->code;
			r->why = x->why;
		}
		qsort(out.refused, out.refused_count, sizeof *out.refused, by_refused);
		return out;
	}
	out.waiting = calloc(d->pending.count + (locked != NULL ? locked->count : 0) + 1, sizeof *out.waiting);
	out.refused = calloc(d->pending.count + d->refused.count + (broken != NULL ? broken->count : 0) + 1, sizeof *out.refused);
	if (out.waiting == NULL || out.refused == NULL) abort();
	for (size_t i = 0; i < d->pending.slots; i++) {
		if (!d->pending.used[i]) continue;
		const mr_pending_t *p = d->pending.values[i];
		if (p->waits) {
			mr_waiting_row *w = &out.waiting[out.waiting_count++];
			memcpy(w->commit, p->key, 32);
			w->names = mr_copy(p->waiting, p->waiting_length * CM_NAME);
			w->count = p->waiting_length;
		} else if (p->sticks) {
			mr_refused_row *r = &out.refused[out.refused_count++];
			memcpy(r->id, p->key, 32);
			r->id_length = 32;
			r->stuck = true;
			r->names = mr_copy(p->stuck, p->stuck_length * CM_NAME);
			r->count = p->stuck_length;
		}
	}
	// waiting on the lock: no parent named
	for (size_t i = 0; locked != NULL && i < locked->slots; i++) {
		if (!locked->used[i]) continue;
		mr_waiting_row *w = &out.waiting[out.waiting_count++];
		memcpy(w->commit, im_key(locked, i), 32);
	}
	for (int k = 0; k < 2; k++) {
		const im_map *m = k == 0 ? &d->refused : broken;
		if (m == NULL) continue;
		for (size_t i = 0; i < m->slots; i++) {
			if (!m->used[i]) continue;
			mr_refused_row *r = &out.refused[out.refused_count++];
			memcpy(r->id, im_key(m, i), 32);
			r->id_length = 32;
			r->fragment = k == 1;
			const mr_refusal *x = m->values[i];
			r->code = x->code;
			r->why = x->why;
		}
	}
	qsort(out.waiting, out.waiting_count, sizeof *out.waiting, by_waiting);
	qsort(out.refused, out.refused_count, sizeof *out.refused, by_refused);
	return out;
}

void mr_taking_free(mr_taking *taking) {
	for (size_t i = 0; i < taking->waiting_count; i++) free(taking->waiting[i].names), free(taking->waiting[i].boundary);
	for (size_t i = 0; i < taking->refused_count; i++) free(taking->refused[i].names);
	free(taking->waiting);
	free(taking->refused);
	*taking = (mr_taking){0};
}

