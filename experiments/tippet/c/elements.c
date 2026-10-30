// Elements (see elements.h). A sequence is a list of runs in order: elements one after another of
// one device, counters one on, all gone or none, held as one (typing is one run). With them how many
// are not gone, a cursor (j, and live: how many before runs[j] are not gone) that typing and edits
// near the last move from, and by device the counter past its newest here (an insert never uses a
// counter twice, so an element is found near the cursor, else from the first).
#include "elements.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { MADE, SPLICE, PUT };

// a run's most elements
#define MOST ((1u << 30) - 1)

// made: counters c on; born (there since the list's step): places c on
typedef struct {
	uint64_t c;
	uint32_t device;
	uint32_t len : 30, gone : 1, born : 1;
} run;

typedef struct {
	uint32_t device;
	uint64_t top;
} top;

struct el_list {
	uint8_t *key;
	size_t keyn;
	run *runs;
	size_t n, room;
	el_ref by; // the step its born ones are since
	size_t count, j, live;
	top *tops;
	size_t ntops, roomtops;
};

static void list_free(const tp_mem *mem, el_list *l) {
	tp_free(mem, l->runs, l->room * sizeof *l->runs);
	tp_free(mem, l->tops, l->roomtops * sizeof *l->tops);
	tp_free(mem, l->key, l->keyn);
	tp_free(mem, l, sizeof *l);
}

// room for 4 runs more: a change adds 2 at most, and undoing it 2 more
static int grow(const tp_mem *mem, el_list *l) {
	if (l->n + 4 <= l->room) return 0;
	size_t room = l->room ? l->room : 4;
	while (room < l->n + 4) room *= 2;
	run *r = tp_grow(mem, l->runs, l->room * sizeof *r, room * sizeof *r);
	if (!r) return -1;
	l->runs = r, l->room = room;
	return 0;
}

static el_id id_at(const el_list *l, const run *r, uint64_t o) {
	return r->born ? (el_id){r->device, 1, l->by.lamport, r->c + o} : (el_id){r->device, 0, r->c + o, 0};
}
static el_id plus(el_id i, uint64_t x) {
	if (i.born) i.k += x;
	else i.c += x;
	return i;
}
static int same(const el_id *a, const el_id *b) {
	return a->device == b->device && a->born == b->born && a->c == b->c && a->k == b->k;
}
// where id is in r, or -1
static long place(const el_list *l, const run *r, const el_id *id) {
	if (r->device != id->device || r->born != id->born || (id->born && id->c != l->by.lamport)) return -1;
	uint64_t x = id->born ? id->k : id->c;
	return x >= r->c && x - r->c < r->len ? (long)(x - r->c) : -1;
}
// an element's run and place in it: near the cursor first
static int find(const el_list *l, const el_id *id, size_t *j, uint64_t *o) {
	for (size_t d = 0; d < 4; d++) {
		size_t at[2] = {l->j - 1 - d, l->j + d};
		for (int i = 0; i < 2; i++) {
			long x = at[i] < l->n ? place(l, &l->runs[at[i]], id) : -1;
			if (x >= 0) return *j = at[i], *o = (uint64_t)x, 1;
		}
	}
	for (size_t i = 0; i < l->n; i++) {
		long x = place(l, &l->runs[i], id);
		if (x >= 0) return *j = i, *o = (uint64_t)x, 1;
	}
	return 0;
}
static int there(const el_list *l, const el_gone *g) {
	size_t j;
	uint64_t o;
	for (uint64_t x = 0; x < g->count; x += l->runs[j].len - o) {
		el_id id = plus(g->id, x);
		if (!find(l, &id, &j, &o)) return 0;
	}
	return 1;
}

static size_t live_of(const run *r) { return r->gone ? 0 : r->len; }
// how many before runs[j] are not gone, the cursor moved there
static size_t live_before(el_list *l, size_t j) {
	while (l->j < j) l->live += live_of(&l->runs[l->j++]);
	while (l->j > j) l->live -= live_of(&l->runs[--l->j]);
	return l->live;
}
// the a-th element not gone, its run (n: past the last) and place *o, the cursor there
static size_t live_at(el_list *l, size_t a, uint64_t *o) {
	while (l->j > 0 && l->live > a) l->live -= live_of(&l->runs[--l->j]);
	for (; l->j < l->n; l->live += live_of(&l->runs[l->j++])) {
		const run *r = &l->runs[l->j];
		if (!r->gone && l->live + r->len > a) return *o = a - l->live, l->j;
	}
	return *o = 0, l->j;
}
// runs [j, j + del) for ins (room made before), the cursor at j
static void edit(el_list *l, size_t j, size_t del, const run *ins, size_t nins) {
	live_before(l, j);
	memmove(l->runs + j + nins, l->runs + j + del, (l->n - j - del) * sizeof *l->runs);
	if (nins) memcpy(l->runs + j, ins, nins * sizeof *ins);
	l->n = l->n + nins - del;
}
// runs[j - 1] and runs[j] as one, if they go on from each other
static void join(el_list *l, size_t j) {
	if (j == 0 || j >= l->n) return;
	run a = l->runs[j - 1], b = l->runs[j];
	if (a.device != b.device || a.born != b.born || a.gone != b.gone || a.c + a.len != b.c ||
		(uint64_t)a.len + b.len > MOST)
		return;
	a.len += b.len;
	edit(l, j - 1, 2, &a, 1);
}
// run j's elements [o, o + n) a run of their own: its index
static size_t cut(el_list *l, size_t j, uint64_t o, uint64_t n) {
	run r = l->runs[j], parts[3];
	size_t k = 0;
	if (o) parts[k] = r, parts[k++].len = (uint32_t)o;
	parts[k] = r, parts[k].c = r.c + o, parts[k++].len = (uint32_t)n;
	if (o + n < r.len) parts[k] = r, parts[k].c = r.c + o + n, parts[k++].len = (uint32_t)(r.len - o - n);
	edit(l, j, 1, parts, k);
	return j + (o ? 1 : 0);
}
static void mark(el_list *l, size_t j, uint64_t o, uint64_t n, int gone) {
	size_t i = cut(l, j, o, n);
	l->runs[i].gone = (uint32_t)gone;
	l->count = gone ? l->count - n : l->count + n;
	join(l, i + 1), join(l, i);
}

static top *top_of(el_list *l, uint32_t device) {
	for (size_t i = 0; i < l->ntops; i++) {
		if (l->tops[i].device == device) return &l->tops[i];
	}
	return NULL;
}

// paths are cbor arrays, canonical: one is a prefix of another when its items are the other's first
// items, byte for byte. the prefix's length in items, or -1
static long prefix_of(tp_span a, tp_span b) {
	tp_in x = {a.p, a.p + a.n}, y = {b.p, b.p + b.n};
	uint64_t m, k;
	if (tp_array(&x, &m) || tp_array(&y, &k) || m > k) return -1;
	size_t bytes = (size_t)(x.end - x.p);
	if ((size_t)(y.end - y.p) < bytes || memcmp(x.p, y.p, bytes)) return -1;
	return (long)m;
}
static int under(tp_span prefix, const uint8_t *key, size_t keyn) {
	return prefix_of(prefix, (tp_span){key, keyn}) >= 0;
}

// a sequence's length, or -1
static long units(const op_value *v) {
	if (!v) return -1;
	if (v->type == OP_LIST) return (long)v->count;
	if (v->type != OP_STR) return -1;
	long n = 0;
	for (size_t i = 0; i < v->bytes; i++) n += (((unsigned char)v->str[i]) & 0xc0) != 0x80;
	return n;
}

// what is at the target's path, NULL if nothing
static const op_value *at_path(const op_value *v, const op_target *t) {
	for (size_t i = 0; i < t->length; i++) {
		const op_key *k = &t->path[i];
		if (!v) return NULL;
		if (v->type == OP_LIST) {
			if (k->type != OP_NUM_KEY || k->n < 0 || (size_t)k->n >= v->count) return NULL;
			v = v->items[k->n];
		} else if (v->type == OP_MAP) {
			char digits[32];
			const char *name = k->s;
			if (k->type == OP_NUM_KEY) snprintf(digits, sizeof digits, "%ld", k->n), name = digits;
			v = op_get(v, name);
		} else return NULL;
	}
	return v;
}

static tp_span move_path(tp_span move) {
	tp_in in = {move.p, move.p + move.n};
	uint64_t k;
	tp_span key, v = {NULL, 0};
	tp_map(&in, &k);
	for (uint64_t i = 0; i < k; i++) {
		tp_text(&in, &key), tp_skip(&in, &v);
		if (tp_is(key, "path")) return v;
	}
	return v;
}



typedef struct {
	const el_ctx *c;
	el_state *st;
	el_back *back;
	el_ref ref;
} work;

static int devcmp(const el_ctx *c, uint32_t x, uint32_t y) {
	if (x == y) return 0;
	if (x == EL_NONE) return -1;
	if (y == EL_NONE) return 1;
	return memcmp(c->bytes(c->self, x), c->bytes(c->self, y), 32);
}
// the element at runs[j], place o, sorts after one of this step's at counter c
static int sorts_after(const work *w, const el_list *l, size_t j, uint64_t o, uint64_t c) {
	const run *r = &l->runs[j];
	uint64_t at = r->born ? l->by.lamport : r->c + o;
	if (at != c) return at > c;
	return devcmp(w->c, r->born ? l->by.device : r->device, w->ref.device) > 0;
}

static int rec_room(work *w) {
	el_back *b = w->back;
	if (b->n < b->room) return 0;
	size_t room = b->room ? 2 * b->room : 1;
	el_rec *p = tp_grow(w->c->mem, b->p, b->room * sizeof *p, room * sizeof *p);
	if (!p) return -1;
	b->p = p, b->room = room;
	return 0;
}

static el_list *list_at(const el_state *st, tp_span path) {
	for (size_t i = 0; i < st->n; i++) {
		el_list *l = st->lists[i];
		if (l->keyn == path.n && !memcmp(l->key, path.p, path.n)) return l;
	}
	return NULL;
}

// room for one more list in the state
static int lists_room(const tp_mem *mem, el_state *st) {
	if (st->n < st->room) return 0;
	size_t room = st->room ? 2 * st->room : 4;
	el_list **p = tp_grow(mem, st->lists, st->room * sizeof *p, room * sizeof *p);
	if (!p) return -1;
	st->lists = p, st->room = room;
	return 0;
}

// the sequence at the patch's path, its elements made now: those there since the step that made it
// new
static int elements(work *w, const op_value *cur, const op_patch *p, tp_span path, el_list **out) {
	const tp_mem *mem = w->c->mem;
	el_state *st = w->st;
	if ((*out = list_at(st, path))) return 0;
	long most = -1;
	el_ref by = {0, 0, EL_NONE};
	for (size_t i = 0; i < st->nborn; i++) {
		long m = prefix_of((tp_span){st->born[i].key, st->born[i].keyn}, path);
		if (m > most) most = m, by = st->born[i].r;
	}
	size_t count = (size_t)units(at_path(cur, &p->place)), runs = (count + MOST - 1) / MOST;
	el_list *l = tp_alloc(mem, sizeof *l);
	if (!l) return TP_NOMEM;
	memset(l, 0, sizeof *l);
	l->key = tp_alloc(mem, path.n), l->keyn = path.n;
	l->room = runs + 4, l->runs = tp_alloc(mem, l->room * sizeof *l->runs);
	if (!l->key || !l->runs || rec_room(w) || lists_room(mem, st)) {
		if (!l->runs) l->room = 0;
		list_free(mem, l);
		return TP_NOMEM;
	}
	memcpy(l->key, path.p, path.n);
	for (size_t k = 0; k < count; k += MOST) {
		uint32_t len = (uint32_t)(count - k < MOST ? count - k : MOST);
		l->runs[l->n++] = (run){k, by.device, len, 0, 1};
	}
	l->by = by, l->count = count;
	st->lists[st->n++] = l;
	w->back->p[w->back->n++] = (el_rec){.kind = MADE, .splice = {.list = l}};
	*out = l;
	return 0;
}

// the sequences at the path and under it made new by this step (a put, a removal, a move there);
// self 0: under it only (a splice into an array: a position under it now names another element)
static int renew(work *w, tp_span prefix, int self) {
	const tp_mem *mem = w->c->mem;
	el_state *st = w->st;
	size_t nl = 0, nb = 0;
#define SELF(l) (!self && (l)->keyn == prefix.n && !memcmp((l)->key, prefix.p, prefix.n))
	for (size_t i = 0; i < st->n; i++) nl += under(prefix, st->lists[i]->key, st->lists[i]->keyn) && !SELF(st->lists[i]);
	for (size_t i = 0; i < st->nborn; i++) nb += under(prefix, st->born[i].key, st->born[i].keyn);
	el_list **rl = nl ? tp_alloc(mem, nl * sizeof *rl) : NULL;
	el_born *rb = nb ? tp_alloc(mem, nb * sizeof *rb) : NULL;
	uint8_t *key = tp_alloc(mem, prefix.n);
	int bad = (nl && !rl) || (nb && !rb) || !key || rec_room(w);
	if (!bad && st->nborn - nb + 1 > st->roomborn) {
		size_t room = st->roomborn ? 2 * st->roomborn : 4;
		el_born *born = tp_grow(mem, st->born, st->roomborn * sizeof *born, room * sizeof *born);
		if (born) st->born = born, st->roomborn = room;
		else bad = 1;
	}
	if (bad) {
		tp_free(mem, rl, nl * sizeof *rl), tp_free(mem, rb, nb * sizeof *rb);
		tp_free(mem, key, prefix.n);
		return TP_NOMEM;
	}
	size_t k = 0;
	for (size_t i = 0; i < st->n; i++) {
		if (under(prefix, st->lists[i]->key, st->lists[i]->keyn) && !SELF(st->lists[i])) rl[k++] = st->lists[i];
		else st->lists[i - k] = st->lists[i];
	}
#undef SELF
	st->n -= nl, k = 0;
	for (size_t i = 0; i < st->nborn; i++) {
		if (under(prefix, st->born[i].key, st->born[i].keyn)) rb[k++] = st->born[i];
		else st->born[i - k] = st->born[i];
	}
	st->nborn -= nb;
	memcpy(key, prefix.p, prefix.n);
	st->born[st->nborn++] = (el_born){key, prefix.n, w->ref};
	w->back->p[w->back->n++] = (el_rec){.kind = PUT, .put = {rb, nb, rl, nl, key}};
	return 0;
}

// a put, a removal or a move
static int other(work *w, const op_patch *p, const tp_patch *tp) {
	int code = renew(w, tp->path, 1);
	if (!code && p->has_move) code = renew(w, move_path(tp->move), 1);
	return code;
}


// room for one more in a growing array of size each
static int more(const tp_mem *mem, void **p, size_t n, size_t *room, size_t each) {
	if (n < *room) return 0;
	size_t r = *room ? 2 * *room : 4;
	void *q = tp_grow(mem, *p, *room * each, r * each);
	if (!q) return -1;
	*p = q, *room = r;
	return 0;
}

// a splice, its inserted ones counted from c, by its ids (anchor) or its range, as the patches to
// apply by position (*qs, *nq)
static int splice(work *w, const op_value *cur, const op_patch *p, const tp_patch *tp, uint64_t c,
	const el_anchor *anchor, int name, op_patch **qs, size_t *nq, size_t *qcap, el_anchor *named) {
	const tp_mem *mem = w->c->mem;
	// an insert of another kind than the sequence (a list into a text): doesn't apply, as apply refuses
	const op_value *into = at_path(cur, &p->place);
	if (p->has_value && (!p->value || p->value->type != into->type)) return OP_WRONG_KIND;
	el_list *l;
	int code = elements(w, cur, p, tp->path, &l);
	if (code) return code;
	uint64_t a = (uint64_t)p->place.from, b = (uint64_t)p->place.to, o;
	long m = p->has_value ? units(p->value) : 0;
	// its counters past those its device made here: an element is never named twice
	const top *used = top_of(l, w->ref.device);
	if (m > 0 && used && c < used->top) return OP_RANGE;
	size_t j, ngone = 0, roomgone = 0, nout = 0, qroom = 0;
	el_gone *gone = NULL;
	const el_gone *names;
	size_t nnames;
	op_patch *out = NULL;
	el_id first = {0};
	int has_first = 0;
	// what it names: the element it goes after, and those it takes away, as runs
	if (anchor) {
		has_first = anchor->has_after, first = anchor->after;
		if (has_first && !find(l, &first, &j, &o)) return OP_RANGE;
		for (size_t r = 0; r < anchor->ngone; r++) {
			if (!there(l, &anchor->gone[r])) return OP_RANGE;
		}
		names = anchor->gone, nnames = anchor->ngone;
	} else {
		if (a > b || b > l->count) return OP_RANGE;
		if (a) j = live_at(l, (size_t)a - 1, &o), first = id_at(l, &l->runs[j], o), has_first = 1;
		for (uint64_t x = a; x < b;) {
			j = live_at(l, (size_t)x, &o);
			const run *r = &l->runs[j];
			uint64_t n = r->len - o < b - x ? r->len - o : b - x;
			el_id i = id_at(l, r, o), next = ngone ? plus(gone[ngone - 1].id, gone[ngone - 1].count) : i;
			if (ngone && same(&next, &i)) gone[ngone - 1].count += n;
			else if (more(mem, (void **)&gone, ngone, &roomgone, sizeof *gone)) {
				code = TP_NOMEM;
				goto done;
			} else gone[ngone++] = (el_gone){i, n};
			x += n;
		}
		names = gone, nnames = ngone;
	}
	// its record first, so a failure from here is undone with the rest
	if (rec_room(w)) {
		code = TP_NOMEM;
		goto done;
	}
	size_t ri = w->back->n++;
	w->back->p[ri] = (el_rec){.kind = SPLICE, .splice = {.list = l}};
#define REC (w->back->p[ri].splice)
	// the gone ones still there taken away, each once however often named, by position
	for (size_t r = 0; r < nnames; r++) {
		for (uint64_t x = 0; x < names[r].count;) {
			el_id id = plus(names[r].id, x);
			find(l, &id, &j, &o);
			uint64_t m = l->runs[j].len - o < names[r].count - x ? l->runs[j].len - o : names[r].count - x;
			x += m;
			if (l->runs[j].gone) continue;
			if (grow(mem, l) || more(mem, (void **)&REC.taken, REC.ntaken, &REC.roomtaken, sizeof *REC.taken) ||
				more(mem, (void **)&out, nout + 1, &qroom, sizeof *out)) {
				code = TP_NOMEM;
				goto done;
			}
			size_t from = live_before(l, j) + (size_t)o;
			mark(l, j, o, m, 1);
			REC.taken[REC.ntaken++] = (el_gone){id, m};
			op_patch *last = nout ? &out[nout - 1] : NULL;
			if (last && (size_t)last->place.from == from) last->place.to += (int64_t)m;
			else if (last && from + m == (size_t)last->place.from) last->place.from = (int64_t)from;
			else {
				out[nout] = (op_patch){0}, out[nout].place = p->place;
				out[nout].place.from = (int64_t)from, out[nout++].place.to = (int64_t)(from + m);
			}
		}
	}
	// where the inserted go: after its element, past those that sort after it (by ids)
	j = 0, o = 0;
	if (has_first) {
		find(l, &first, &j, &o);
		if (++o == l->runs[j].len) j++, o = 0;
	}
	if (anchor) {
		while (j < l->n && sorts_after(w, l, j, o, c)) j++, o = 0;
	}
	size_t to = live_before(l, j) + (j < l->n && !l->runs[j].gone ? (size_t)o : 0);
	if (more(mem, (void **)&out, nout + 1, &qroom, sizeof *out)) {
		code = TP_NOMEM;
		goto done;
	}
	if (m > 0) {
		top *t = top_of(l, w->ref.device);
		if ((uint64_t)m > MOST || grow(mem, l) ||
			(!t && more(mem, (void **)&l->tops, l->ntops, &l->roomtops, sizeof *l->tops))) {
			code = (uint64_t)m > MOST ? OP_RANGE : TP_NOMEM;
			goto done;
		}
		if (o) j = cut(l, j, o, l->runs[j].len - o);
		run made = {c, w->ref.device, (uint32_t)m, 0, 0};
		edit(l, j, 0, &made, 1);
		l->count += (size_t)m;
		join(l, j + 1), join(l, j);
		REC.device = w->ref.device, REC.c = c, REC.m = (uint64_t)m;
		REC.had = t != NULL, REC.top = t ? t->top : 0;
		if (!t) t = &l->tops[l->ntops++], t->device = w->ref.device;
		t->top = c + (uint64_t)m;
	}
	if (m > 0 || !nout) {
		out[nout] = (op_patch){0};
		out[nout].place = p->place;
		out[nout].place.from = out[nout].place.to = (int64_t)to;
		if (m > 0) out[nout].has_value = 1, out[nout].value = p->value;
		nout++;
	}
#undef REC
	if (name && named) {
		// not named: one of them made by no step (no put made its sequence), so it goes by its range
		int none = has_first && first.device == EL_NONE;
		for (size_t r = 0; r < ngone; r++) none |= gone[r].id.device == EL_NONE;
		el_gone *g = ngone ? tp_grow(mem, gone, roomgone * sizeof *g, ngone * sizeof *g) : NULL;
		if (ngone && !g) {
			code = TP_NOMEM;
			goto done;
		}
		if (ngone) gone = g, roomgone = ngone;
		if (!none) {
			*named = (el_anchor){1, has_first, first, gone, ngone};
			gone = NULL, roomgone = 0;
		}
	}
	*qs = out, *nq = nout, *qcap = qroom, out = NULL;
	// into an array: what is under it now is made new (a position names another element)
	const op_value *seq = at_path(cur, &p->place);
	if (seq && seq->type == OP_LIST) code = renew(w, tp->path, 0);
done:
	tp_free(mem, gone, roomgone * sizeof *gone), tp_free(mem, out, qroom * sizeof *out);
	return code;
}

// undoes one record
static void undo_rec(const tp_mem *mem, el_state *st, el_rec *r) {
	if (r->kind == MADE) {
		for (size_t i = 0; i < st->n; i++) {
			if (st->lists[i] != r->splice.list) continue;
			memmove(st->lists + i, st->lists + i + 1, (st->n - i - 1) * sizeof *st->lists);
			st->n--;
			list_free(mem, r->splice.list);
			break;
		}
	} else if (r->kind == SPLICE) {
		el_list *l = r->splice.list;
		size_t j;
		uint64_t o;
		el_id id = {r->splice.device, 0, r->splice.c, 0};
		for (uint64_t x = 0, m = r->splice.m; x < m;) {
			el_id at = plus(id, x);
			find(l, &at, &j, &o);
			uint64_t n = l->runs[j].len - o < m - x ? l->runs[j].len - o : m - x;
			size_t i = cut(l, j, o, n);
			edit(l, i, 1, NULL, 0);
			l->count -= (size_t)n, x += n;
			join(l, i);
		}
		if (r->splice.m) {
			top *t = top_of(l, r->splice.device);
			if (r->splice.had) t->top = r->splice.top;
			else *t = l->tops[--l->ntops];
		}
		for (size_t g = r->splice.ntaken; g-- > 0;) {
			const el_gone *taken = &r->splice.taken[g];
			for (uint64_t x = 0; x < taken->count;) {
				el_id at = plus(taken->id, x);
				find(l, &at, &j, &o);
				uint64_t n = l->runs[j].len - o < taken->count - x ? l->runs[j].len - o : taken->count - x;
				mark(l, j, o, n, 0), x += n;
			}
		}
		tp_free(mem, r->splice.taken, r->splice.roomtaken * sizeof *r->splice.taken);
	} else {
		for (size_t i = 0; i < st->nborn; i++) {
			if (st->born[i].key != r->put.pushed) continue;
			tp_free(mem, st->born[i].key, st->born[i].keyn);
			memmove(st->born + i, st->born + i + 1, (st->nborn - i - 1) * sizeof *st->born);
			st->nborn--;
			break;
		}
		for (size_t i = 0; i < r->put.nborn; i++) st->born[st->nborn++] = r->put.born[i];
		for (size_t i = 0; i < r->put.nlists; i++) st->lists[st->n++] = r->put.lists[i];
		tp_free(mem, r->put.born, r->put.nborn * sizeof *r->put.born);
		tp_free(mem, r->put.lists, r->put.nlists * sizeof *r->put.lists);
	}
}

static void drop_rec(const tp_mem *mem, el_rec *r) {
	if (r->kind == SPLICE) tp_free(mem, r->splice.taken, r->splice.roomtaken * sizeof *r->splice.taken);
	if (r->kind != PUT) return;
	for (size_t i = 0; i < r->put.nborn; i++) tp_free(mem, r->put.born[i].key, r->put.born[i].keyn);
	for (size_t i = 0; i < r->put.nlists; i++) list_free(mem, r->put.lists[i]);
	tp_free(mem, r->put.born, r->put.nborn * sizeof *r->put.born);
	tp_free(mem, r->put.lists, r->put.nlists * sizeof *r->put.lists);
}

void el_back_undo(const tp_mem *mem, el_state *st, el_back *back) {
	while (back->n) undo_rec(mem, st, &back->p[--back->n]);
	tp_free(mem, back->p, back->room * sizeof *back->p);
	*back = (el_back){0};
}

void el_back_free(const tp_mem *mem, el_back *back) {
	for (size_t i = 0; i < back->n; i++) drop_rec(mem, &back->p[i]);
	tp_free(mem, back->p, back->room * sizeof *back->p);
	*back = (el_back){0};
}

void el_state_free(const tp_mem *mem, el_state *st) {
	for (size_t i = 0; i < st->n; i++) list_free(mem, st->lists[i]);
	for (size_t i = 0; i < st->nborn; i++) tp_free(mem, st->born[i].key, st->born[i].keyn);
	tp_free(mem, st->lists, st->room * sizeof *st->lists);
	tp_free(mem, st->born, st->roomborn * sizeof *st->born);
	*st = (el_state){0};
}

// undoes the records past marks (a step that failed)
static void rollback(work *w, size_t marks) {
	el_back *b = w->back;
	while (b->n > marks) undo_rec(w->c->mem, w->st, &b->p[--b->n]);
}

int el_step(const el_ctx *c, el_state *st, op_value **value, const el_ref *ref, tp_span patches,
	const op_patch *ps, size_t n, const uint8_t *keep, const el_anchor *ids, int name,
	op_undo *undo, el_back *back, op_patch **applied, size_t *napplied, el_anchor **named) {
	work w = {c, st, back, *ref};
	size_t marks = back->n, at = 0, nout = 0, roomout = 0, nus = 0, roomus = 0;
	op_value *cur = *value;
	int owned = 0, code = 0;
	op_patch *out = NULL, *cat = NULL;
	op_undo *us = NULL;
	el_anchor *nm = NULL;
	size_t total = 0;
	uint64_t made = 0; // the step's elements so far: the next is counter lamport + made
	if (name && named && n && !(nm = tp_alloc(c->mem, n * sizeof *nm))) return TP_NOMEM;
	if (nm) memset(nm, 0, n * sizeof *nm);
	tp_patch tp;
	for (size_t i = 0; i < n && !code; i++) {
		if (tp_patch_next(patches, &at, &tp)) {
			code = OP_NOT_A_PATCH;
			break;
		}
		uint64_t counter = ref->lamport + made;
		made += tp_patch_made(&tp);
		if (keep && !keep[i]) continue;
		const op_patch *p = &ps[i];
		op_patch *qs = (op_patch *)p, *made_qs = NULL;
		size_t nq = 1, qcap = 0;
		const el_anchor *anchor = !name && ids && ids[i].named ? &ids[i] : NULL;
		if (p->place.has_range && units(at_path(cur, &p->place)) >= 0) {
			code = splice(&w, cur, p, &tp, counter, anchor, name, &made_qs, &nq, &qcap, nm ? &nm[i] : NULL);
			if (!code) qs = made_qs;
		} else code = other(&w, p, &tp);
		for (size_t q = 0; q < nq && !code; q++) {
			op_value *next = NULL;
			size_t failed;
			op_undo u = {NULL, 0, 0};
			op_apply_options ao = {.undo = &u};
			if ((code = op_apply(cur, &qs[q], 1, undo ? &ao : NULL, &next, &failed))) break;
			if (owned) op_free(cur);
			cur = next, owned = 1;
			if (nout == roomout) {
				size_t room = roomout ? 2 * roomout : 8;
				op_patch *o = realloc(out, room * sizeof *o);
				if (!o) {
					op_undo_free(&u);
					code = TP_NOMEM;
					break;
				}
				out = o, roomout = room;
			}
			if (undo && nus == roomus) {
				size_t room = roomus ? 2 * roomus : 8;
				op_undo *t = tp_grow(c->mem, us, roomus * sizeof *t, room * sizeof *t);
				if (!t) {
					op_undo_free(&u);
					code = TP_NOMEM;
					break;
				}
				us = t, roomus = room;
			}
			out[nout++] = qs[q];
			if (undo) us[nus++] = u;
		}
		tp_free(c->mem, made_qs, qcap * sizeof *made_qs);
	}
	if (!code && undo) {
		for (size_t i = 0; i < nus; i++) total += us[i].n;
		if (total && !(cat = malloc(total * sizeof *cat))) code = TP_NOMEM;
	}
	if (code) {
		for (size_t i = 0; i < nus; i++) op_undo_free(&us[i]);
		tp_free(c->mem, us, roomus * sizeof *us);
		free(out);
		if (nm) el_anchors_free(c->mem, nm, n);
		if (owned) op_free(cur);
		rollback(&w, marks);
		return code;
	}
	if (undo) {
		size_t k = 0;
		for (size_t i = nus; i-- > 0;) {
			if (us[i].n) memcpy(cat + k, us[i].patches, us[i].n * sizeof *cat);
			k += us[i].n;
			free(us[i].patches);
		}
		*undo = (op_undo){cat, total, total};
	}
	tp_free(c->mem, us, roomus * sizeof *us);
	if (owned) op_free(*value), *value = cur;
	if (applied) *applied = out, *napplied = nout;
	else free(out);
	if (named) *named = nm;
	return 0;
}

void el_anchors_free(const tp_mem *mem, el_anchor *a, size_t n) {
	if (!a) return;
	for (size_t i = 0; i < n; i++) tp_free(mem, a[i].gone, a[i].ngone * sizeof *a[i].gone);
	tp_free(mem, a, n * sizeof *a);
}

int el_named(const el_anchor *a, size_t n) {
	for (size_t i = 0; a && i < n; i++) {
		if (a[i].named) return 1;
	}
	return 0;
}

// an element id as written: this device's x (counter lamport - x) or [x, k], another's [device, c]
// or [device, lamport, k]
static int read_id(const el_ctx *c, tp_in *in, const tp_step *s, uint32_t me, el_id *id) {
	uint64_t k, a, b = 0;
	int64_t x;
	tp_span key;
	if (in->p < in->end && *in->p >> 5 <= 1) {
		if (tp_int(in, &x)) return -1;
		*id = (el_id){me, 0, x >= 0 ? s->lamport - (uint64_t)x : s->lamport + (uint64_t)-x, 0};
		return 0;
	}
	if (tp_array(in, &k)) return -1;
	if (in->p < in->end && *in->p >> 5 == 0) {
		if (tp_whole(in, &a) || tp_whole(in, &b)) return -1;
		*id = (el_id){me, 1, s->lamport - a, b};
		return 0;
	}
	if (tp_bytes(in, 32, &key) || tp_whole(in, &a) || (k == 3 && tp_whole(in, &b))) return -1;
	// a device not known has no elements: nothing is named by it, and it is not made known
	long d = c->find(c->self, key.p);
	*id = (el_id){d < 0 ? EL_UNKNOWN : (uint32_t)d, k == 3, a, b};
	return 0;
}

int el_read(const el_ctx *c, const tp_step *s, el_anchor **out) {
	*out = NULL;
	if (!s->ids.p) return 0;
	tp_in in = {s->ids.p, s->ids.p + s->ids.n};
	uint64_t k;
	long me = c->index(c->self, s->device);
	if (me < 0) return TP_NOMEM;
	if (tp_array(&in, &k)) return TP_NOTSTEP;
	el_anchor *a = k ? tp_alloc(c->mem, (size_t)k * sizeof *a) : NULL;
	if (k && !a) return TP_NOMEM;
	if (k) memset(a, 0, (size_t)k * sizeof *a);
	int code = 0;
	for (uint64_t i = 0; i < k && !code; i++) {
		uint64_t two, g = 0;
		if (tp_null(&in)) continue;
		if (tp_array(&in, &two)) code = TP_NOTSTEP;
		else if (!tp_null(&in)) code = read_id(c, &in, s, (uint32_t)me, &a[i].after), a[i].has_after = 1;
		if (!code && tp_array(&in, &g)) code = TP_NOTSTEP;
		if (!code && g && !(a[i].gone = tp_alloc(c->mem, (size_t)g * sizeof *a[i].gone))) code = TP_NOMEM;
		if (!code) a[i].ngone = (size_t)g;
		for (uint64_t j = 0; j < g && !code; j++) {
			uint64_t pair;
			if (tp_array(&in, &pair) || read_id(c, &in, s, (uint32_t)me, &a[i].gone[j].id) ||
				tp_whole(&in, &a[i].gone[j].count))
				code = TP_NOTSTEP;
		}
		a[i].named = !code;
	}
	if (code) return el_anchors_free(c->mem, a, (size_t)k), code;
	*out = a;
	return 0;
}

static void write_id(tp_buf *b, const el_ctx *c, const el_id *id, uint32_t me, uint64_t lamport) {
	if (id->device == me) {
		if (id->born) tp_put_head(b, 4, 2);
		if (id->c <= lamport) tp_put_head(b, 0, lamport - id->c);
		else tp_put_head(b, 1, id->c - lamport - 1);
	} else {
		tp_put_head(b, 4, id->born ? 3 : 2), tp_put_head(b, 2, 32), tp_put(b, c->bytes(c->self, id->device), 32);
		tp_put_head(b, 0, id->c);
	}
	if (id->born) tp_put_head(b, 0, id->k);
}

void el_write(tp_buf *b, const el_ctx *c, const el_anchor *a, size_t n, uint32_t me, uint64_t lamport) {
	tp_put_head(b, 4, n);
	for (size_t i = 0; i < n; i++) {
		if (!a[i].named) {
			tp_put(b, "\xf6", 1);
			continue;
		}
		tp_put_head(b, 4, 2);
		if (a[i].has_after) write_id(b, c, &a[i].after, me, lamport);
		else tp_put(b, "\xf6", 1);
		tp_put_head(b, 4, a[i].ngone);
		for (size_t j = 0; j < a[i].ngone; j++) {
			tp_put_head(b, 4, 2), write_id(b, c, &a[i].gone[j].id, me, lamport);
			tp_put_head(b, 0, a[i].gone[j].count);
		}
	}
}

