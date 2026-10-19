// A node's history (history.h), in C. Every name it has been told of has a rec: a commit taken,
// waiting or refused, or one only waited on (state NONE). Recs are found by name in a hash, and
// never let go of until the history is, but a head forgotten (hy_forget)
#include "history.h"
#include "keyed.h"

#include <stdlib.h>
#include <string.h>

const char *hy_refusal_name(hy_refusal refusal) {
	switch (refusal) {
	case HY_SHAPE: return "shape";
	case HY_LAMPORT: return "lamport";
	case HY_PATCHES: return "patches";
	case HY_PARENT: return "parent";
	case HY_MERGE: return "merge";
	case HY_WAIT: break;
	}
	return "";
}

typedef enum { S_NONE, S_WAITING, S_TAKEN, S_REFUSED } state;
typedef struct rec rec;
struct rec {
	state state;
	hy_refusal refusal;
	// refused for a parent: the parent refused, its name
	bool has_cause;
	uint8_t cause[CM_NAME];
	hy_kept kept;
	// how many taken commits go on this one
	size_t children;
	// waiting: the parents not taken yet, in order; none, on the check
	rec **on;
	size_t on_length;
	// the commits waiting on this one, in the order they came
	rec **waiters;
	size_t waiters_length, waiters_capacity;
};

// a growing list of pointers
typedef struct {
	rec **p;
	size_t n, capacity;
} list;

static void push(list *l, rec *r) {
	if (l->n == l->capacity) {
		l->capacity = l->capacity ? l->capacity * 2 : 16;
		l->p = realloc(l->p, l->capacity * sizeof *l->p);
		if (l->p == NULL) abort();
	}
	l->p[l->n++] = r;
}

typedef struct {
	hy_taken f;
	void *context;
} listener;

struct hy_history {
	uint64_t serial;
	hy_check check;
	void *context;
	// open addressing on a keyed hash of a name (keyed.h): names are what others send
	rec **table;
	size_t slots, count;
	list taken, heads, waits, refusals;
	listener *listeners;
	size_t listeners_length;
	// hy_limit's; how many recs wait (on parents or on the check)
	size_t most, waiting;
	void (*dropped)(void *context, const uint8_t name[CM_NAME]);
	void *dropped_context;
};

hy_history *hy_create(hy_check check, void *context) {
	static uint64_t made;
	hy_history *h = allocate(sizeof *h);
	h->serial = ++made;
	h->check = check;
	h->context = context;
	h->slots = 64;
	h->table = allocate(h->slots * sizeof *h->table);
	h->most = SIZE_MAX;
	return h;
}

void hy_limit(hy_history *h, size_t most, void (*dropped)(void *context, const uint8_t name[CM_NAME]), void *context) {
	h->most = most;
	h->dropped = dropped;
	h->dropped_context = context;
}

static void free_rec(rec *r) {
	free(r->kept.bytes);
	free(r->kept.table);
	free((void *)r->kept.merge);
	free((void *)r->kept.parents);
	free(r->on);
	free(r->waiters);
	free(r);
}

void hy_free(hy_history *h) {
	for (size_t i = 0; i < h->slots; i++)
		if (h->table[i] != NULL) free_rec(h->table[i]);
	free(h->table);
	free(h->taken.p), free(h->heads.p), free(h->waits.p), free(h->refusals.p);
	free(h->listeners);
	free(h);
}

static size_t hash_of(const uint8_t name[CM_NAME]) {
	return ky_hash(name, CM_NAME);
}

static rec *find(const hy_history *h, const uint8_t name[CM_NAME]) {
	size_t mask = h->slots - 1;
	for (size_t s = hash_of(name) & mask; h->table[s] != NULL; s = (s + 1) & mask)
		if (memcmp(h->table[s]->kept.name, name, CM_NAME) == 0) return h->table[s];
	return NULL;
}

// the rec of a name, made when there is none
static rec *get(hy_history *h, const uint8_t name[CM_NAME]) {
	rec *r = find(h, name);
	if (r != NULL) return r;
	if (2 * (h->count + 1) > h->slots) {
		rec **old = h->table;
		size_t n = h->slots;
		h->slots *= 2;
		h->table = allocate(h->slots * sizeof *h->table);
		for (size_t i = 0; i < n; i++) {
			if (old[i] == NULL) continue;
			size_t s = hash_of(old[i]->kept.name) & (h->slots - 1);
			while (h->table[s] != NULL) s = (s + 1) & (h->slots - 1);
			h->table[s] = old[i];
		}
		free(old);
	}
	r = allocate(sizeof *r);
	memcpy(r->kept.name, name, CM_NAME);
	size_t s = hash_of(name) & (h->slots - 1);
	while (h->table[s] != NULL) s = (s + 1) & (h->slots - 1);
	h->table[s] = r;
	h->count++;
	return r;
}

// out of the hash and freed: what follows it in its run moved back where it may stand
static void unhash(hy_history *h, rec *r) {
	size_t mask = h->slots - 1, s = hash_of(r->kept.name) & mask;
	while (h->table[s] != r) s = (s + 1) & mask;
	h->table[s] = NULL;
	for (size_t j = (s + 1) & mask; h->table[j] != NULL; j = (j + 1) & mask) {
		size_t home = hash_of(h->table[j]->kept.name) & mask;
		// j's rec may stay unless the hole at s lies between its home and j
		bool stays = s <= j ? (home > s && home <= j) : (home > s || home <= j);
		if (stays) continue;
		h->table[s] = h->table[j];
		h->table[j] = NULL;
		s = j;
	}
	h->count--;
	free_rec(r);
}

// r out of the list, looked for from its end
static void unlist(list *l, const rec *r) {
	for (size_t k = l->n; k-- > 0;) {
		if (l->p[k] != r) continue;
		memmove(&l->p[k], &l->p[k + 1], (l->n - k - 1) * sizeof *l->p);
		l->n--;
		return;
	}
}

static void become(hy_history *h, rec *r, state s);

// the oldest commit waiting on a parent let go of, as if never told: out of its parents' waiters (a
// parent only waited on, with no waiter left, let go of too, but keep), back to only waited on if
// something waits on it, else let go of; dropped told
static void let_go(hy_history *h, const rec *keep) {
	rec *r = NULL;
	for (size_t i = 0; i < h->waits.n && r == NULL; i++)
		if (h->waits.p[i]->state == S_WAITING && h->waits.p[i]->on_length > 0) r = h->waits.p[i];
	if (r == NULL) return;
	unlist(&h->waits, r);
	for (size_t i = 0; i < r->on_length; i++) {
		rec *p = r->on[i];
		for (size_t k = 0; k < p->waiters_length; k++) {
			if (p->waiters[k] != r) continue;
			memmove(&p->waiters[k], &p->waiters[k + 1], (p->waiters_length - k - 1) * sizeof *p->waiters);
			p->waiters_length--;
			break;
		}
		if (p->state == S_NONE && p->waiters_length == 0 && p != keep) unhash(h, p);
	}
	uint8_t name[CM_NAME];
	memcpy(name, r->kept.name, CM_NAME);
	become(h, r, S_NONE);
	r->on_length = 0;
	if (r->waiters_length == 0) unhash(h, r);
	else {
		free(r->kept.bytes), free(r->kept.table), free((void *)r->kept.merge), free((void *)r->kept.parents);
		uint8_t keep[CM_NAME];
		memcpy(keep, r->kept.name, CM_NAME);
		r->kept = (hy_kept){0};
		memcpy(r->kept.name, keep, CM_NAME);
	}
	if (h->dropped != NULL) h->dropped(h->dropped_context, name);
}

// the oldest refusals past most let go of (once nothing goes on them), and the waits list kept to
// what still waits
static void trim(hy_history *h) {
	while (h->refusals.n > h->most) {
		rec *r = h->refusals.p[0];
		memmove(&h->refusals.p[0], &h->refusals.p[1], (h->refusals.n - 1) * sizeof *h->refusals.p);
		h->refusals.n--;
		unlist(&h->waits, r);
		if (r->waiters_length == 0) unhash(h, r);
		else become(h, r, S_NONE);
	}
	if (h->waits.n > 2 * h->waiting + 64) {
		size_t k = 0;
		for (size_t i = 0; i < h->waits.n; i++)
			if (h->waits.p[i]->state == S_WAITING) h->waits.p[k++] = h->waits.p[i];
		h->waits.n = k;
	}
}

// a rec's state, the count of those waiting kept
static void become(hy_history *h, rec *r, state s) {
	if (r->state == S_WAITING) h->waiting--;
	if (s == S_WAITING) h->waiting++;
	r->state = s;
}

// --- refusing ---

static void mark(hy_history *h, rec *r, hy_refusal why, const uint8_t *cause) {
	become(h, r, S_REFUSED);
	r->refusal = why;
	r->has_cause = cause != NULL;
	if (cause != NULL) memcpy(r->cause, cause, CM_NAME);
	push(&h->refusals, r);
}

typedef struct {
	rec *r;
	size_t at;
} frame;
typedef struct {
	frame *p;
	size_t n, capacity;
} frames;

static void frame_push(frames *s, rec *r) {
	if (s->n == s->capacity) {
		s->capacity = s->capacity ? s->capacity * 2 : 16;
		s->p = realloc(s->p, s->capacity * sizeof *s->p);
		if (s->p == NULL) abort();
	}
	s->p[s->n++] = (frame){r, 0};
}

// refused, and what waits on it never comes in: each in turn, and what waits on that, depth first
static void refuse(hy_history *h, rec *first, hy_refusal why, const uint8_t *cause) {
	frames s = {0};
	mark(h, first, why, cause);
	frame_push(&s, first);
	while (s.n > 0) {
		frame *f = &s.p[s.n - 1];
		if (f->at == f->r->waiters_length) {
			f->r->waiters_length = 0;
			s.n--;
			continue;
		}
		rec *w = f->r->waiters[f->at++];
		if (w->state != S_WAITING) continue;
		w->on_length = 0;
		mark(h, w, HY_PARENT, f->r->kept.name);
		frame_push(&s, w);
	}
	free(s.p);
}

// --- taking in ---

static bool is_taken(const hy_history *h, const uint8_t name[CM_NAME]) {
	rec *r = find(h, name);
	return r != NULL && r->state == S_TAKEN;
}

// on the check: waiting on nothing named, listed in the waits once
static void hold(hy_history *h, rec *r) {
	if (r->state != S_WAITING) push(&h->waits, r), become(h, r, S_WAITING);
	r->on_length = 0;
}

// the parents all taken: the lamport, then check; taken, waiting on the check, or refused (what
// waits on it released or refused by the caller)
static bool take(hy_history *h, rec *r, const cm_commit *commit) {
	int64_t top = 0;
	for (size_t i = 0; i < r->kept.parents_length; i++) {
		int64_t l = find(h, r->kept.parents[i])->kept.lamport;
		if (l > top) top = l;
	}
	if (r->kept.lamport != top + 1) return refuse(h, r, HY_LAMPORT, NULL), false;
	hy_refusal why = h->check != NULL ? h->check(h->context, &r->kept, commit) : 0;
	if (why == HY_WAIT) return hold(h, r), false;
	if (why != 0) return refuse(h, r, why, NULL), false;
	become(h, r, S_TAKEN);
	push(&h->taken, r);
	for (size_t i = 0; i < r->kept.parents_length; i++) {
		rec *p = find(h, r->kept.parents[i]);
		p->children++;
		for (size_t k = 0; k < h->heads.n; k++) {
			if (h->heads.p[k] == p) {
				memmove(&h->heads.p[k], &h->heads.p[k + 1], (h->heads.n - k - 1) * sizeof *h->heads.p);
				h->heads.n--;
				break;
			}
		}
	}
	push(&h->heads, r);
	for (size_t i = 0; i < h->listeners_length; i++) h->listeners[i].f(h->listeners[i].context, &r->kept);
	return true;
}

// what waited on a commit just taken: each whose parents are now all taken is taken in turn, and
// what waited on it, depth first
static void release(hy_history *h, rec *first) {
	frames s = {0};
	frame_push(&s, first);
	while (s.n > 0) {
		frame *f = &s.p[s.n - 1];
		rec *r = f->r;
		if (f->at == r->waiters_length) {
			r->waiters_length = 0;
			s.n--;
			continue;
		}
		rec *w = r->waiters[f->at++];
		if (w->state != S_WAITING) continue;
		for (size_t k = 0; k < w->on_length; k++) {
			if (w->on[k] == r) {
				memmove(&w->on[k], &w->on[k + 1], (w->on_length - k - 1) * sizeof *w->on);
				w->on_length--;
				break;
			}
		}
		if (w->on_length > 0) continue;
		cm_commit c;
		if (cm_decode(w->kept.bytes, w->kept.length, &c, NULL) != CM_OK) {
			mark(h, w, HY_SHAPE, NULL);
			continue;
		}
		bool ok = take(h, w, &c);
		cm_free(&c);
		// frame f may have moved: take does not touch the stack, but a listener could add
		if (ok) frame_push(&s, w);
	}
	free(s.p);
}

hy_added hy_add(hy_history *h, const uint8_t *bytes, size_t length, const hy_made *made) {
	hy_added a = {0};
	uint8_t name[CM_NAME];
	if (made != NULL) memcpy(name, made->name, CM_NAME);
	else cm_name(bytes, length, name);
	rec *r = get(h, name);
	if (r->state == S_TAKEN || r->state == S_WAITING) return a.kind = HY_PASSED, a;
	if (r->state == S_REFUSED) return a.kind = HY_REFUSED, a.refusal = r->refusal, a;
	cm_commit own = {0};
	const cm_commit *c;
	if (made != NULL) c = made->commit;
	else {
		if (cm_decode(bytes, length, &own, NULL) != CM_OK) {
			mark(h, r, HY_SHAPE, NULL);
			trim(h);
			return a.kind = HY_REFUSED, a.refusal = HY_SHAPE, a;
		}
		c = &own;
	}
	for (size_t i = 0; i < c->parents_length; i++) {
		rec *p = find(h, c->parents[i]);
		if (p != NULL && p->state == S_REFUSED) {
			refuse(h, r, HY_PARENT, p->kept.name);
			cm_free(&own);
			trim(h);
			return a.kind = HY_REFUSED, a.refusal = HY_PARENT, a;
		}
	}
	hy_kept *k = &r->kept;
	k->bytes = allocate(length + 1);
	memcpy(k->bytes, bytes, length);
	k->length = length;
	k->table = copyString(c->table);
	uint8_t(*parents)[CM_NAME] = allocate(c->parents_length * CM_NAME + 1);
	if (c->parents_length) memcpy(parents, c->parents, c->parents_length * CM_NAME);
	k->parents = (const uint8_t(*)[CM_NAME])parents;
	k->parents_length = c->parents_length;
	// several parents, no base, no merge: key patches only, on all of them
	if (c->merge != NULL) k->merge = copyString(c->merge);
	else if (c->has_base) k->has_base = 1, memcpy(k->base, c->base, CM_NAME);
	else if (c->parents_length == 1) k->has_base = 1, memcpy(k->base, c->parents[0], CM_NAME);
	for (size_t i = 0; c->replaces != NULL && i < c->patches_length; i++)
		if (c->replaces[i].has) k->replaces = true;
	k->lamport = c->lamport;
	size_t missing = 0;
	for (size_t i = 0; i < c->parents_length; i++) missing += !is_taken(h, c->parents[i]);
	// before its parents' recs are had: letting go may let go of one only waited on
	if (missing > 0 && h->waiting >= h->most) let_go(h, r);
	r->on = allocate((c->parents_length + 1) * sizeof *r->on);
	missing = 0;
	for (size_t i = 0; i < c->parents_length; i++) {
		if (is_taken(h, c->parents[i])) continue;
		r->on[missing++] = get(h, c->parents[i]);
	}
	if (missing > 0) {
		r->on_length = missing;
		become(h, r, S_WAITING);
		push(&h->waits, r);
		a.kind = HY_WAITING;
		a.waiting = allocate(missing * CM_NAME);
		a.waiting_length = missing;
		for (size_t i = 0; i < missing; i++) {
			rec *m = r->on[i];
			memcpy(a.waiting[i], m->kept.name, CM_NAME);
			if (m->waiters_length == m->waiters_capacity) {
				m->waiters_capacity = m->waiters_capacity ? m->waiters_capacity * 2 : 4;
				m->waiters = realloc(m->waiters, m->waiters_capacity * sizeof *m->waiters);
				if (m->waiters == NULL) abort();
			}
			m->waiters[m->waiters_length++] = r;
		}
	} else if (take(h, r, c)) {
		a.kind = HY_TAKEN;
		release(h, r);
	} else if (r->state == S_WAITING) a.kind = HY_WAITING;
	else {
		a.kind = HY_REFUSED;
		a.refusal = r->refusal;
	}
	cm_free(&own);
	trim(h);
	return a;
}

void hy_again(hy_history *h) {
	// what waits on the check now, in order: a take may add to the waits as it goes
	list held = {0};
	for (size_t i = 0; i < h->waits.n; i++) {
		rec *r = h->waits.p[i];
		if (r->state == S_WAITING && r->on_length == 0) push(&held, r);
	}
	for (size_t i = 0; i < held.n; i++) {
		rec *r = held.p[i];
		if (r->state != S_WAITING || r->on_length != 0) continue;
		cm_commit c;
		if (cm_decode(r->kept.bytes, r->kept.length, &c, NULL) != CM_OK) {
			mark(h, r, HY_SHAPE, NULL);
			continue;
		}
		bool ok = take(h, r, &c);
		cm_free(&c);
		if (ok) release(h, r);
	}
	free(held.p);
	trim(h);
}

void hy_added_free(hy_added *a) {
	free(a->waiting);
	*a = (hy_added){0};
}

// --- reading ---

int hy_agreed(const hy_kept *a, const hy_kept *b) {
	if (a->lamport != b->lamport) return a->lamport > b->lamport ? -1 : 1;
	return cm_compare(b->name, CM_NAME, a->name, CM_NAME);
}

static int agreed(const void *x, const void *y) {
	return hy_agreed(*(const hy_kept *const *)x, *(const hy_kept *const *)y);
}

static size_t kept_of(const list *l, const hy_kept ***out) {
	const hy_kept **v = allocate((l->n + 1) * sizeof *v);
	for (size_t i = 0; i < l->n; i++) v[i] = &l->p[i]->kept;
	*out = v;
	return l->n;
}

size_t hy_heads(const hy_history *h, const hy_kept ***out) {
	size_t n = kept_of(&h->heads, out);
	qsort(*out, n, sizeof **out, agreed);
	return n;
}

size_t hy_all(const hy_history *h, const hy_kept ***out) { return kept_of(&h->taken, out); }

bool hy_forget(hy_history *h, const uint8_t name[CM_NAME]) {
	rec *r = find(h, name);
	if (r == NULL || r->state != S_TAKEN || r->children > 0) return false;
	unlist(&h->heads, r);
	unlist(&h->taken, r);
	for (size_t i = 0; i < r->kept.parents_length; i++) {
		rec *p = find(h, r->kept.parents[i]);
		if (p == NULL || --p->children > 0 || p->state != S_TAKEN) continue;
		push(&h->heads, p);
	}
	unhash(h, r);
	return true;
}

const hy_kept *hy_get(const hy_history *h, const uint8_t name[CM_NAME]) {
	rec *r = find(h, name);
	return r != NULL && r->state == S_TAKEN ? &r->kept : NULL;
}

void hy_on_taken(hy_history *h, hy_taken f, void *context) {
	h->listeners = realloc(h->listeners, (h->listeners_length + 1) * sizeof *h->listeners);
	if (h->listeners == NULL) abort();
	h->listeners[h->listeners_length++] = (listener){f, context};
}

size_t hy_waiting(const hy_history *h, hy_waiting_row **out) {
	hy_waiting_row *rows = allocate((h->waits.n + 1) * sizeof *rows);
	size_t n = 0;
	for (size_t i = 0; i < h->waits.n; i++) {
		const rec *r = h->waits.p[i];
		if (r->state != S_WAITING) continue;
		memcpy(rows[n].name, r->kept.name, CM_NAME);
		rows[n].waiting = allocate(r->on_length * CM_NAME + 1);
		rows[n].waiting_length = r->on_length;
		for (size_t k = 0; k < r->on_length; k++) memcpy(rows[n].waiting[k], r->on[k]->kept.name, CM_NAME);
		n++;
	}
	*out = rows;
	return n;
}

void hy_waiting_free(hy_waiting_row *rows, size_t count) {
	for (size_t i = 0; i < count; i++) free(rows[i].waiting);
	free(rows);
}

size_t hy_refused(const hy_history *h, hy_refused_row **out) {
	hy_refused_row *rows = allocate((h->refusals.n + 1) * sizeof *rows);
	for (size_t i = 0; i < h->refusals.n; i++) {
		memcpy(rows[i].name, h->refusals.p[i]->kept.name, CM_NAME);
		rows[i].refusal = h->refusals.p[i]->refusal;
		rows[i].has_on = h->refusals.p[i]->has_cause;
		if (rows[i].has_on) memcpy(rows[i].on, h->refusals.p[i]->cause, CM_NAME);
	}
	*out = rows;
	return h->refusals.n;
}

uint64_t hy_serial(const hy_history *h) { return h->serial; }

// --- since ---

size_t hy_follows(const hy_kept *k, const uint8_t (**out)[CM_NAME]) {
	if (k->merge != NULL || !k->has_base) return *out = k->parents, k->parents_length;
	*out = (const uint8_t(*)[CM_NAME])k->base;
	return 1;
}

// a set of kept, by address: each its number
typedef struct {
	const hy_kept **keys;
	size_t *values;
	size_t slots, count;
} pset;

static size_t pslot(const pset *s, const hy_kept *k) {
	size_t x = (size_t)(uintptr_t)k;
	x ^= x >> 17;
	x *= (size_t)0x9e3779b97f4a7c15ull;
	return x & (s->slots - 1);
}
static bool pget(const pset *s, const hy_kept *k, size_t *value) {
	if (s->slots == 0) return false;
	for (size_t i = pslot(s, k); s->keys[i] != NULL; i = (i + 1) & (s->slots - 1))
		if (s->keys[i] == k) {
			if (value != NULL) *value = s->values[i];
			return true;
		}
	return false;
}
static void pset_set(pset *s, const hy_kept *k, size_t value) {
	if (2 * (s->count + 1) > s->slots) {
		pset old = *s;
		s->slots = old.slots ? old.slots * 2 : 32;
		s->keys = allocate(s->slots * sizeof *s->keys);
		s->values = allocate(s->slots * sizeof *s->values);
		s->count = 0;
		for (size_t i = 0; i < old.slots; i++)
			if (old.keys[i] != NULL) pset_set(s, old.keys[i], old.values[i]);
		free(old.keys), free(old.values);
	}
	size_t i = pslot(s, k);
	while (s->keys[i] != NULL && s->keys[i] != k) i = (i + 1) & (s->slots - 1);
	if (s->keys[i] == NULL) s->count++;
	s->keys[i] = k;
	s->values[i] = value;
}
static void pset_free(pset *s) {
	free(s->keys), free(s->values);
	*s = (pset){0};
}

// a growing list of kept
typedef struct {
	const hy_kept **p;
	size_t n, capacity;
} klist;
static void kpush(klist *l, const hy_kept *k) {
	if (l->n == l->capacity) {
		l->capacity = l->capacity ? l->capacity * 2 : 16;
		l->p = realloc(l->p, l->capacity * sizeof *l->p);
		if (l->p == NULL) abort();
	}
	l->p[l->n++] = k;
}

static int agreed_sort(const void *x, const void *y) {
	return hy_agreed(*(const hy_kept *const *)x, *(const hy_kept *const *)y);
}

// every commit walked follows from all of the frontier
static bool under(const hy_history *h, const hy_kept *const *walked, size_t wn, const hy_kept *const *frontier,
	size_t fn) {
	size_t words = (fn + 63) / 64;
	uint64_t *reach = allocate((wn * words + 1) * sizeof *reach);
	pset at = {0}, done = {0};
	for (size_t j = 0; j < fn; j++) pset_set(&at, frontier[j], j);
	bool ok = true;
	for (size_t i = wn; i-- > 0;) {
		uint64_t *got = reach + i * words;
		const uint8_t(*up)[CM_NAME];
		size_t n = hy_follows(walked[i], &up);
		for (size_t p = 0; p < n; p++) {
			const hy_kept *k = hy_get(h, up[p]);
			size_t j;
			if (k == NULL) continue;
			if (pget(&at, k, &j)) got[j / 64] |= (uint64_t)1 << (j % 64);
			else if (pget(&done, k, &j))
				for (size_t w = 0; w < words; w++) got[w] |= reach[j * words + w];
		}
		size_t count = 0;
		for (size_t w = 0; w < words; w++) count += (size_t)__builtin_popcountll(got[w]);
		if (count != fn) {
			ok = false;
			break;
		}
		pset_set(&done, walked[i], i);
	}
	pset_free(&at), pset_free(&done);
	free(reach);
	return ok;
}

void hy_since(const hy_history *h, const hy_kept *const *heads, size_t n, hy_known known, void *context,
	const hy_kept ***from, size_t *from_length, const hy_kept ***commits, size_t *commits_length) {
	klist frontier = {0}, walked = {0};
	pset seen = {0}, in = {0};
	for (size_t i = 0; i < n; i++) {
		if (pget(&in, heads[i], NULL)) continue;
		pset_set(&in, heads[i], 0);
		kpush(&frontier, heads[i]);
	}
	const hy_kept **sorted = NULL;
	size_t sorted_length = 0;
	bool root = false;
	for (;;) {
		if (frontier.n == 0) break;
		if (!root) {
			sorted = realloc(sorted, frontier.n * sizeof *sorted);
			if (sorted == NULL) abort();
			memcpy(sorted, frontier.p, frontier.n * sizeof *sorted);
			sorted_length = frontier.n;
			qsort(sorted, sorted_length, sizeof *sorted, agreed_sort);
			const hy_kept *const *f = sorted;
			if ((sorted_length == 1 || walked.n == 0) && (known == NULL || known(context, f, sorted_length))) goto found;
			if (sorted_length > 1 && walked.n > 0 && (known == NULL || known(context, f, sorted_length)) &&
				under(h, walked.p, walked.n, f, sorted_length))
				goto found;
		}
		size_t top = 0;
		const hy_kept *const *fr = frontier.p;
		for (size_t i = 1; i < frontier.n; i++)
			if (hy_agreed(fr[i], fr[top]) < 0) top = i;
		const hy_kept *k = fr[top];
		frontier.p[top] = frontier.p[--frontier.n];
		pset_set(&in, k, 1);
		pset_set(&seen, k, 0);
		kpush(&walked, k);
		const uint8_t(*up)[CM_NAME];
		size_t un = hy_follows(k, &up);
		if (un == 0) root = true;
		for (size_t p = 0; p < un; p++) {
			const hy_kept *q = hy_get(h, up[p]);
			if (q == NULL || pget(&seen, q, NULL)) continue;
			size_t v;
			if (pget(&in, q, &v) && v == 0) continue;
			pset_set(&in, q, 0);
			kpush(&frontier, q);
		}
	}
	sorted_length = 0;
found:
	*from = (const hy_kept **)(sorted != NULL ? sorted : allocate(sizeof *sorted));
	*from_length = sorted_length;
	const hy_kept **out = allocate((walked.n + 1) * sizeof *out);
	for (size_t i = 0; i < walked.n; i++) out[i] = walked.p[walked.n - 1 - i];
	*commits = out;
	*commits_length = walked.n;
	free(frontier.p), free(walked.p);
	pset_free(&seen), pset_free(&in);
}
