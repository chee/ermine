// Places (places.h), in C. Items are reference counted and hold their strings and their up. Opened
// places are a trie (trie.h) of the opened addresses, a step per entry; a step keeps its items as a
// list of its own, what it read (the up item and the value it found, held), and how many opened
// places share it. A write is built in a block of its own (patches, keys, values) that the node's
// change refers to, kept until that node's next write.
#include "places.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "trie.h"

const char pl_root_mark = 0;

static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) {
		fputs("places: out of memory\n", stderr);
		abort();
	}
	return p;
}
static void *xgrow(void *p, size_t n) {
	p = realloc(p, n ? n : 1);
	if (p == NULL) {
		fputs("places: out of memory\n", stderr);
		abort();
	}
	return p;
}
static char *xdup(const char *s) { return strcpy(xalloc(strlen(s) + 1), s); }

// --- keys and items ---

static int keq(tb_key a, tb_key b) {
	if (a.symbol != NULL || b.symbol != NULL) return a.symbol == b.symbol;
	return strcmp(a.string, b.string) == 0;
}
static size_t klen(tb_key k) { return k.symbol != NULL ? 0 : strlen(k.string) + 1; }
static tb_key kput(tb_key k, char **at) {
	if (k.symbol != NULL) return k;
	size_t n = klen(k);
	memcpy(*at, k.string, n);
	tb_key out = tb_string(*at);
	*at += n;
	return out;
}

// takes a hold of up
static pl_item *item_new(tb_key source, tb_key id, const pl_item *up, const char *name, size_t at) {
	size_t nname = name != NULL ? strlen(name) + 1 : 0;
	pl_item *i = xalloc(sizeof *i + klen(source) + klen(id) + nname);
	char *room = (char *)(i + 1);
	i->source = kput(source, &room);
	i->id = kput(id, &room);
	if (name != NULL) {
		memcpy(room, name, nname);
		i->name = room;
	}
	i->up = up != NULL ? pl_item_ref((pl_item *)up) : NULL;
	i->at = at;
	i->refs = 1;
	return i;
}

pl_item *pl_item_ref(pl_item *item) {
	if (item != NULL) item->refs++;
	return item;
}
void pl_item_free(pl_item *i) {
	while (i != NULL && --i->refs == 0) {
		pl_item *up = (pl_item *)i->up;
		free(i);
		i = up;
	}
}

size_t pl_path(const pl_item *item, const char **names, size_t cap) {
	size_t n = 0;
	for (const pl_item *i = item; i != NULL && i->up != NULL; i = i->up) n++;
	size_t k = n;
	for (const pl_item *i = item; i != NULL && i->up != NULL; i = i->up) {
		k--;
		if (k < cap) names[k] = i->name;
	}
	return n;
}

// --- lists ---

typedef struct {
	pl_item **v;
	size_t n, cap;
} vec;
static void push(vec *a, pl_item *i) {
	if (a->n == a->cap) {
		a->cap = a->cap ? a->cap * 2 : 4;
		a->v = xgrow(a->v, a->cap * sizeof *a->v);
	}
	a->v[a->n++] = i;
}
// lets go of the items; the room stays
static void clear(vec *a) {
	for (size_t i = 0; i < a->n; i++) pl_item_free(a->v[i]);
	a->n = 0;
}
static void vec_free(vec *a) {
	clear(a);
	free(a->v);
	*a = (vec){0};
}

struct pl;
static pl_list *list_make(struct pl *p, vec *a);

void pl_list_free(pl_list *l) {
	if (l == NULL) return;
	for (size_t i = 0; i < l->n; i++) pl_item_free(l->items[i]);
	free((void *)l->items);
	free(l);
}

// --- the places ---

struct pl {
	pl_setup s;
	pl_item *top;
	pl_list *starts; // one start list for every open: [top]
	uint64_t serial;
	tr *held;
	// the blocks of patches kept, by the node written, and in a list
	tb_table *kept;
	struct blk *blocks;
};

static pl_list *list_make(pl *p, vec *a) {
	pl_list *l = xalloc(sizeof *l);
	l->n = a->n;
	l->items = a->v;
	l->serial = ++p->serial;
	*a = (vec){0};
	return l;
}

pl *pl_new(const pl_setup *s) {
	pl *p = xalloc(sizeof *p);
	p->s = *s;
	p->top = item_new(s->root_source, s->root_id, NULL, NULL, 0);
	vec a = {0};
	push(&a, pl_item_ref(p->top));
	p->starts = list_make(p, &a);
	p->held = tr_new();
	p->kept = tb_new();
	return p;
}

// a write's patches and what they refer to
typedef struct blk {
	struct blk *next, *prev;
	void **mem;
	size_t nmem, cmem;
	op_value **vals;
	size_t nvals, cvals;
} blk;

static void blk_free(pl *p, blk *b) {
	if (b == NULL) return;
	if (b->prev != NULL) b->prev->next = b->next;
	else p->blocks = b->next;
	if (b->next != NULL) b->next->prev = b->prev;
	for (size_t i = 0; i < b->nvals; i++) op_free(b->vals[i]);
	for (size_t i = 0; i < b->nmem; i++) free(b->mem[i]);
	free(b->vals);
	free(b->mem);
	free(b);
}

void pl_free(pl *p) {
	if (p == NULL) return;
	while (p->blocks != NULL) blk_free(p, p->blocks);
	tb_free(p->kept);
	tr_free(p->held);
	pl_list_free(p->starts);
	pl_item_free(p->top);
	free(p);
}

const char *pl_code_name(int code) {
	switch (code) {
	case PL_NOT_A_NAME: return "not-a-name";
	case PL_NOTHING_THERE: return "nothing-there";
	case PL_ALREADY_THERE: return "already-there";
	case PL_RANGE: return "range";
	case PL_OP: return "op";
	}
	return "ok";
}

// --- reading values ---

static const op_value *map_of(const nd_node *n) {
	return n != NULL && n->value != NULL && n->value->type == OP_MAP ? n->value : NULL;
}
// the list under name in a children node; none, or not a list: NULL
static const op_value *array(const nd_node *n, const char *name) {
	const op_value *m = map_of(n);
	const op_value *l = m != NULL ? op_get(m, name) : NULL;
	return l != NULL && l->type == OP_LIST ? l : NULL;
}
// a name holding something that is not a list: taken, never written over
static int taken(const nd_node *n, const char *name) {
	const op_value *m = map_of(n);
	const op_value *v = m != NULL ? op_get(m, name) : NULL;
	return v != NULL && v->type != OP_LIST;
}

static int key_of(const pl *p, const op_value *v, tb_key *k) {
	if (v->type == OP_STR) {
		*k = tb_string(v->str);
		return 1;
	}
	const void *token;
	if (p->s.symbol != NULL && p->s.symbol(p->s.ctx, v, &token)) {
		*k = tb_symbol(token);
		return 1;
	}
	return 0;
}
// an entry, or 0 for anything else in a list: it keeps its position, and is no item
static int entry(const pl *p, const op_value *e, tb_key *source, tb_key *id) {
	return e->type == OP_LIST && e->count == 2 && key_of(p, e->items[0], source) &&
		key_of(p, e->items[1], id);
}

static const pl_item *begin_ref(pl *p, const pl_at *from) {
	if (from == NULL) return pl_item_ref(p->top);
	if (from->item != NULL) return pl_item_ref((pl_item *)from->item);
	return item_new(from->source, from->id, NULL, NULL, 0);
}

static void tell(pl *p, const pl_sink *to, const pl_item *at, const char *name, int keys) {
	if (to != NULL) to->read(to->ctx, at->source, at->id, name, keys);
	else if (p->s.read != NULL) p->s.read(p->s.ctx, at->source, at->id, name, keys);
}

// what a step read: the item, and the value found there (held; NULL: none)
typedef struct {
	pl_item *up;
	op_value *value;
} seen;
typedef struct {
	seen *v;
	size_t n, cap;
} seens;
static void seens_free(seens *s) {
	for (size_t i = 0; i < s->n; i++) {
		pl_item_free(s->v[i].up);
		op_free(s->v[i].value);
	}
	free(s->v);
	*s = (seens){0};
}

// one name down from each item: every entry under the name in its children, in order
static void step(pl *p, pl_item *const *items, size_t n, const char *name, const pl_sink *to, vec *out,
		seens *sn) {
	for (size_t k = 0; k < n; k++) {
		pl_item *up = items[k];
		nd_node *node = p->s.children(p->s.ctx, up->source, up->id);
		tell(p, to, up, name, 0);
		if (sn != NULL) {
			if (sn->n == sn->cap) {
				sn->cap = sn->cap ? sn->cap * 2 : 4;
				sn->v = xgrow(sn->v, sn->cap * sizeof *sn->v);
			}
			sn->v[sn->n++] = (seen){pl_item_ref(up), node != NULL ? op_ref(node->value) : NULL};
		}
		const op_value *list = array(node, name);
		for (size_t i = 0; list != NULL && i < list->count; i++) {
			tb_key source, id;
			if (entry(p, list->items[i], &source, &id)) push(out, item_new(source, id, up, name, i));
		}
	}
}

static int bad(const char *name) {
	return name[0] == '\0' || strcmp(name, ".") == 0 || strcmp(name, "..") == 0 || strcmp(name, "/") == 0;
}
static int names_only(const char *const *address, size_t n) {
	for (size_t i = 0; i < n; i++) if (bad(address[i])) return 0;
	return 1;
}

// the item the names are walked from, and the names. ".." takes back a name, else goes up the way
// the start was reached; above it: 0. An address of names only is the names already, given back as
// it is; else *names is the caller's to free, pointing into address
static int plan(pl *p, const char *const *address, size_t n, const pl_at *from, const pl_item **at,
	const char *const **names, size_t *nnames) {
	const pl_item *cur = begin_ref(p, from);
	if (names_only(address, n)) {
		*at = cur;
		*names = address;
		*nnames = n;
		return 1;
	}
	const char **ns = xalloc((n ? n : 1) * sizeof *ns);
	size_t k = 0;
	for (size_t i = 0; i < n; i++) {
		const char *s = address[i];
		if (strcmp(s, ".") == 0) continue;
		if (strcmp(s, "/") == 0) {
			pl_item_free((pl_item *)cur);
			cur = pl_item_ref(p->top);
			k = 0;
		} else if (strcmp(s, "..") != 0) ns[k++] = s;
		else if (k) k--;
		else {
			const pl_item *up = cur != NULL ? pl_item_ref((pl_item *)cur->up) : NULL;
			pl_item_free((pl_item *)cur);
			cur = up;
		}
	}
	if (cur == NULL) {
		free(ns);
		return 0;
	}
	*at = cur;
	*names = ns;
	*nnames = k;
	return 1;
}

// what is at the address, front first, as a vec the caller frees. Two lists swapped: the items a
// step reads from, and what it finds
static vec get(pl *p, const char *const *address, size_t n, const pl_at *from, const pl_sink *to) {
	vec items = {0}, next = {0};
	const pl_item *at;
	const char *const *names;
	size_t nn;
	if (!plan(p, address, n, from, &at, &names, &nn)) return items;
	push(&items, (pl_item *)at);
	for (size_t i = 0; i < nn && items.n; i++) {
		step(p, items.v, items.n, names[i], to, &next, NULL);
		clear(&items);
		vec was = items;
		items = next;
		next = was;
	}
	if (names != address) free((void *)names);
	free(next.v);
	return items;
}

pl_list *pl_get(pl *p, const char *const *address, size_t n, const pl_at *from, const pl_sink *read) {
	vec out = get(p, address, n, from, read);
	return list_make(p, &out);
}

pl_list *pl_lookup(pl *p, const char *const *address, size_t n, const pl_at *from, int all,
	const pl_sink *read) {
	vec out = {0};
	const pl_item *at = begin_ref(p, from);
	while (at != NULL) {
		pl_at here = pl_at_item(at);
		vec found = get(p, address, n, &here, read);
		for (size_t i = 0; i < found.n; i++) push(&out, found.v[i]);
		free(found.v);
		if (found.n && !all) {
			pl_item_free((pl_item *)at);
			break;
		}
		const pl_item *up = pl_item_ref((pl_item *)at->up);
		pl_item_free((pl_item *)at);
		at = up;
	}
	return list_make(p, &out);
}

// --- names ---

// a whole number as an object holds it: no leading zero, below 2^32 - 1
static int index_key(const char *s, unsigned long *out) {
	size_t n = strlen(s);
	if (n == 0 || n > 10 || (n > 1 && s[0] == '0')) return 0;
	unsigned long v = 0;
	for (size_t i = 0; i < n; i++) {
		if (s[i] < '0' || s[i] > '9') return 0;
		v = v * 10 + (unsigned long)(s[i] - '0');
	}
	if (v >= 4294967295UL) return 0;
	*out = v;
	return 1;
}
static int by_index(const void *a, const void *b) {
	unsigned long x, y;
	index_key(*(char *const *)a, &x);
	index_key(*(char *const *)b, &y);
	return x < y ? -1 : x > y;
}

// the name copied in at `at`, listed; the spot after it
static char *name_in(pl_strings *out, char *at, const char *name) {
	out->names[out->n++] = strcpy(at, name);
	return at + strlen(name) + 1;
}

pl_strings pl_names(pl *p, pl_at at, const pl_sink *read) {
	const pl_item *item = begin_ref(p, &at);
	nd_node *node = p->s.children(p->s.ctx, item->source, item->id);
	tell(p, read, item, NULL, 1);
	pl_strings out = {0};
	const op_value *m = map_of(node);
	if (m != NULL) {
		// one allocation: the pointers, then the names
		size_t room = 0;
		for (size_t i = 0; i < m->count; i++) {
			if (m->items[i]->type == OP_LIST) room += strlen(m->keys[i]) + 1;
		}
		out.names = xalloc((m->count ? m->count : 1) * sizeof *out.names + room);
		char *next = (char *)(out.names + m->count);
		// an object lists its whole-number keys first, ascending, then the rest as made
		size_t nums = 0;
		unsigned long x;
		for (size_t i = 0; i < m->count; i++) {
			if (m->items[i]->type == OP_LIST && index_key(m->keys[i], &x)) next = name_in(&out, next, m->keys[i]), nums++;
		}
		qsort(out.names, nums, sizeof *out.names, by_index);
		for (size_t i = 0; i < m->count; i++) {
			if (m->items[i]->type == OP_LIST && !index_key(m->keys[i], &x)) next = name_in(&out, next, m->keys[i]);
		}
	}
	pl_item_free((pl_item *)item);
	return out;
}
void pl_strings_free(pl_strings s) { free(s.names); }

// --- members ---

// the indices of the list values in a map, in an object's name order: whole numbers first,
// ascending, then the rest as made. *n of them; the caller frees
typedef struct {
	unsigned long num;
	size_t at;
} numbered;
static int by_num(const void *a, const void *b) {
	unsigned long x = ((const numbered *)a)->num, y = ((const numbered *)b)->num;
	return x < y ? -1 : x > y;
}
static size_t *name_order(const op_value *m, size_t *n) {
	size_t *out = xalloc((m->count ? m->count : 1) * sizeof *out);
	numbered *nums = xalloc((m->count ? m->count : 1) * sizeof *nums);
	size_t k = 0, c = 0;
	for (size_t i = 0; i < m->count; i++) {
		unsigned long x;
		if (m->items[i]->type == OP_LIST && index_key(m->keys[i], &x)) nums[c++] = (numbered){x, i};
	}
	qsort(nums, c, sizeof *nums, by_num);
	for (size_t i = 0; i < c; i++) out[k++] = nums[i].at;
	free(nums);
	for (size_t i = 0; i < m->count; i++) {
		unsigned long x;
		if (m->items[i]->type == OP_LIST && !index_key(m->keys[i], &x)) out[k++] = i;
	}
	*n = k;
	return out;
}

// the entries of a list under name in up's children, as items, in order
static void entries(pl *p, pl_item *up, const char *name, const op_value *list, vec *out) {
	for (size_t i = 0; i < list->count; i++) {
		tb_key source, id;
		if (entry(p, list->items[i], &source, &id)) push(out, item_new(source, id, up, name, i));
	}
}

pl_list *pl_members_at(pl *p, pl_at at, const pl_sink *read) {
	pl_item *up = (pl_item *)begin_ref(p, &at);
	nd_node *node = p->s.children(p->s.ctx, up->source, up->id);
	tell(p, read, up, NULL, 1);
	vec out = {0};
	const op_value *m = map_of(node);
	if (m != NULL) {
		size_t n, *order = name_order(m, &n);
		for (size_t k = 0; k < n; k++) {
			tell(p, read, up, m->keys[order[k]], 0);
			entries(p, up, m->keys[order[k]], m->items[order[k]], &out);
		}
		free(order);
	}
	pl_item_free(up);
	return list_make(p, &out);
}

// --- opened places ---

typedef struct {
	uint64_t from; // the serial of the list it was walked from; 0: not yet
	pl_list *items;
	seens seen;
	size_t opened;
} held_step;

// the path: a trie entry per name, which holds the name (kept while this is open)
// what an opened place keeps of one item's members: per name, the list walked and the items it gave
typedef struct {
	char *name;
	op_value *list; // held; NULL: given away
	vec items;
} kept_name;
typedef struct {
	pl_item *up; // held
	kept_name *names;
	size_t n, cap;
} kept_level;

struct pl_held {
	pl *p;
	kept_level *levels;
	size_t nlevels;
	pl_list *members; // the last result, ours
	int valid;
	int dropped;
	const pl_sink *opened; // the open's sink, or NULL
	tr_entry **path;
	size_t n;
};

static const pl_list none = {0, NULL, 0};

static void step_free(held_step *s) {
	seens_free(&s->seen);
	pl_list_free(s->items);
	free(s);
}

pl_held *pl_open(pl *p, const char *const *address, size_t n, const pl_sink *read) {
	pl_held *h = xalloc(sizeof *h);
	h->p = p;
	h->opened = read;
	const pl_item *at;
	const char *const *names;
	size_t nn;
	h->valid = plan(p, address, n, NULL, &at, &names, &nn);
	if (!h->valid) return h;
	pl_item_free((pl_item *)at);
	h->n = nn;
	h->path = xalloc((nn ? nn : 1) * sizeof *h->path);
	tr_entry *prev = NULL;
	for (size_t i = 0; i < nn; i++) {
		tr_entry *e = tr_make(p->held, &names[i], 1, prev);
		if (e->value == NULL) {
			held_step *s = xalloc(sizeof *s);
			s->items = list_make(p, &(vec){0});
			e->value = s;
		}
		((held_step *)e->value)->opened++;
		h->path[i] = prev = e;
	}
	if (names != address) free((void *)names);
	return h;
}

// two walks gave the same items: the same entries, found in the same items, at the same places
static int alike(const vec *a, const pl_list *b) {
	if (a->n != b->n) return 0;
	for (size_t i = 0; i < a->n; i++) {
		const pl_item *x = a->v[i], *y = b->items[i];
		if (!keq(x->source, y->source) || !keq(x->id, y->id) || x->up != y->up ||
				strcmp(x->name, y->name) != 0 || x->at != y->at) return 0;
	}
	return 1;
}

// a step still good: every children node it read has the value it had. A node changed in place
// keeps its value: its step is never good
static int good(pl *p, const held_step *s) {
	for (size_t i = 0; i < s->seen.n; i++) {
		const seen *x = &s->seen.v[i];
		nd_node *node = p->s.children(p->s.ctx, x->up->source, x->up->id);
		if (node != NULL && node->in_place) return 0;
		if ((node != NULL ? node->value : NULL) != x->value) return 0;
	}
	return 1;
}

const pl_list *pl_items(pl_held *h, const pl_sink *read) {
	pl *p = h->p;
	if (read == NULL) read = h->opened;
	if (h->dropped || !h->valid) return &none;
	const pl_list *before = p->starts;
	for (size_t i = 0; i < h->n; i++) {
		held_step *s = h->path[i]->value;
		const char *name = h->path[i]->name;
		if (s->from != before->serial || !good(p, s)) {
			s->from = before->serial;
			seens_free(&s->seen);
			vec walked = {0};
			if (before->n) step(p, before->items, before->n, name, read, &walked, &s->seen);
			if (!alike(&walked, s->items)) {
				pl_list_free(s->items);
				s->items = list_make(p, &walked);
			} else vec_free(&walked);
		} else {
			for (size_t k = 0; k < s->seen.n; k++) tell(p, read, s->seen.v[k].up, name, 0);
		}
		before = s->items;
	}
	return before;
}

static void level_free(kept_level *l) {
	for (size_t i = 0; i < l->n; i++) {
		free(l->names[i].name);
		op_free(l->names[i].list);
		vec_free(&l->names[i].items);
	}
	free(l->names);
	pl_item_free(l->up);
}
static void levels_free(pl_held *h) {
	for (size_t i = 0; i < h->nlevels; i++) level_free(&h->levels[i]);
	free(h->levels);
	h->levels = NULL;
	h->nlevels = 0;
	pl_list_free(h->members);
	h->members = NULL;
}

const pl_list *pl_members(pl_held *h, const pl_sink *read) {
	pl *p = h->p;
	if (read == NULL) read = h->opened;
	if (h->dropped || !h->valid) return &none;
	const pl_list *its = pl_items(h, read);
	kept_level *next = xalloc((its->n ? its->n : 1) * sizeof *next);
	vec out = {0};
	// the old levels are looked up from a cursor: the items come in the same order mostly
	size_t from = 0;
	for (size_t k = 0; k < its->n; k++) {
		pl_item *up = its->items[k];
		nd_node *node = p->s.children(p->s.ctx, up->source, up->id);
		tell(p, read, up, NULL, 1);
		kept_level *was = NULL;
		for (size_t j = 0; j < h->nlevels && was == NULL; j++) {
			kept_level *c = &h->levels[(from + j) % h->nlevels];
			if (c->up == up) was = c, from = (from + j + 1) % h->nlevels;
		}
		kept_level *l = &next[k];
		l->up = pl_item_ref(up);
		const op_value *m = map_of(node);
		if (m == NULL) continue;
		size_t n, *order = name_order(m, &n);
		l->names = xalloc((n ? n : 1) * sizeof *l->names);
		size_t at = 0;
		for (size_t q = 0; q < n; q++) {
			const char *name = m->keys[order[q]];
			const op_value *list = m->items[order[q]];
			tell(p, read, up, name, 0);
			kept_name *e = &l->names[l->n++];
			kept_name *old = NULL;
			for (size_t j = 0; was != NULL && j < was->n && old == NULL; j++) {
				kept_name *c = &was->names[(at + j) % was->n];
				if (c->list != NULL && strcmp(c->name, name) == 0) old = c, at = (at + j + 1) % was->n;
			}
			if (old != NULL && old->list == list && !(node != NULL && node->in_place)) {
				*e = *old;
				old->list = NULL;
				old->name = NULL;
				old->items = (vec){0};
			} else {
				*e = (kept_name){.name = xdup(name), .list = op_ref((op_value *)list)};
				entries(p, up, name, list, &e->items);
			}
			for (size_t i = 0; i < e->items.n; i++) push(&out, pl_item_ref(e->items.v[i]));
		}
		free(order);
	}
	// the old levels and what is left in them go; the new are kept
	kept_level *old = h->levels;
	size_t nold = h->nlevels;
	h->levels = next;
	h->nlevels = its->n;
	for (size_t i = 0; i < nold; i++) level_free(&old[i]);
	free(old);
	pl_list_free(h->members);
	h->members = list_make(p, &out);
	return h->members;
}

void pl_drop(pl_held *h) {
	if (h->dropped) return;
	h->dropped = 1;
	levels_free(h);
	if (!h->valid) return;
	for (size_t i = 0; i < h->n; i++) {
		held_step *s = h->path[i]->value;
		if (--s->opened == 0) {
			step_free(s);
			h->path[i]->value = NULL;
		}
	}
	if (h->n) tr_prune(h->p->held, h->path[h->n - 1]);
}

void pl_close(pl_held *h) {
	if (h == NULL) return;
	pl_drop(h);
	free(h->path);
	free(h);
}

// --- writing ---

static void *bmem(blk *b, size_t n) {
	if (b->nmem == b->cmem) {
		b->cmem = b->cmem ? b->cmem * 2 : 8;
		b->mem = xgrow(b->mem, b->cmem * sizeof *b->mem);
	}
	return b->mem[b->nmem++] = xalloc(n);
}
static op_value *bval(blk *b, op_value *v) {
	if (b->nvals == b->cvals) {
		b->cvals = b->cvals ? b->cvals * 2 : 4;
		b->vals = xgrow(b->vals, b->cvals * sizeof *b->vals);
	}
	return b->vals[b->nvals++] = v;
}
static op_key *bkey(blk *b, const char *name) {
	op_key *k = bmem(b, sizeof *k);
	k->type = OP_STR_KEY;
	char *s = bmem(b, strlen(name) + 1);
	k->s = strcpy(s, name);
	return k;
}
static op_target target(blk *b, const char *name, int range, long from, long to) {
	return (op_target){.path = bkey(b, name), .length = 1, .has_range = range, .from = from, .to = to};
}

static op_value *key_value(pl *p, tb_key k) {
	if (k.symbol == NULL) return op_str(k.string);
	return p->s.symbol_value != NULL ? p->s.symbol_value(p->s.ctx, k.symbol) : op_null();
}
// [[source, id]]
static op_value *put_value(pl *p, blk *b, tb_key source, tb_key id) {
	op_value *put = bval(b, op_list()), *e = op_list();
	op_push(e, key_value(p, source));
	op_push(e, key_value(p, id));
	op_push(put, e);
	return put;
}

static const char kept_part;

// the patches, as one change on the parent's children node; the block is kept until the node's
// next write. done: the node added to changed
static int write(pl *p, tb_key source, tb_key id, nd_node *n, blk *b, op_patch *ps, size_t nps,
	ch_header header, pl_changed *changed) {
	size_t failed;
	if (nd_update(n, ps, nps, header, &failed) != OP_OK) {
		blk_free(p, b);
		return PL_OP;
	}
	tb_key part = tb_symbol(&kept_part), where = tb_symbol(n);
	blk_free(p, tb_get(p->kept, part, where));
	tb_sub(p->kept, part, where, b);
	if (changed != NULL) changed->nodes[changed->n++] = (pl_wrote){source, id, n};
	return PL_OK;
}

static blk *blk_new(pl *p) {
	blk *b = xalloc(sizeof *b);
	b->next = p->blocks;
	if (b->next != NULL) b->next->prev = b;
	p->blocks = b;
	return b;
}

static int within(long i, long lo, long hi) { return i >= lo && i <= hi; }
static int fail(int code, const char **err_at, const char *at) {
	if (err_at != NULL) *err_at = at;
	return code;
}
static void ids(const pl_at *at, tb_key *source, tb_key *id) {
	*source = at->item != NULL ? at->item->source : at->source;
	*id = at->item != NULL ? at->item->id : at->id;
}
static nd_node *node_of(pl *p, tb_key source, tb_key id) { return p->s.children(p->s.ctx, source, id); }
// the patches that make sure n's value is a map, first
static size_t base(blk *b, const nd_node *n, op_patch *ps) {
	if (map_of(n) != NULL) return 0;
	ps[0] = (op_patch){.place = {.path = NULL, .length = 0}, .has_value = 1, .value = bval(b, op_map())};
	return 1;
}

static int place_in(pl *p, tb_key ps_, tb_key pid, const char *name, tb_key source, tb_key id,
	ch_header header, long index, const char **err_at, pl_changed *changed) {
	if (bad(name)) return fail(PL_NOT_A_NAME, err_at, name);
	nd_node *n = node_of(p, ps_, pid);
	if (n == NULL) return fail(PL_NOTHING_THERE, err_at, NULL);
	if (taken(n, name)) return fail(PL_ALREADY_THERE, err_at, name);
	const op_value *list = array(n, name);
	long len = list != NULL ? (long)list->count : 0;
	long i = index == PL_END ? len : index;
	if (!within(i, 0, len)) return fail(PL_RANGE, err_at, name);
	blk *b = blk_new(p);
	op_patch *ps = bmem(b, 2 * sizeof *ps);
	size_t k = base(b, n, ps);
	op_value *put = put_value(p, b, source, id);
	ps[k] = (op_patch){.place = target(b, name, list != NULL, i, i), .has_value = 1, .value = put};
	return write(p, ps_, pid, n, b, ps, k + 1, header, changed);
}

static int unplace_in(pl *p, tb_key psrc, tb_key pid, const char *name, long index, ch_header header,
	const char **err_at, pl_changed *changed) {
	nd_node *n = node_of(p, psrc, pid);
	if (n == NULL) return fail(PL_NOTHING_THERE, err_at, NULL);
	const op_value *list = array(n, name);
	if (list == NULL || list->count == 0) return fail(PL_NOTHING_THERE, err_at, name);
	if (!within(index, 0, (long)list->count - 1)) return fail(PL_RANGE, err_at, name);
	blk *b = blk_new(p);
	op_patch *ps = bmem(b, sizeof *ps);
	if (list->count == 1) ps[0] = (op_patch){.place = target(b, name, 0, 0, 0)};
	else ps[0] = (op_patch){.place = target(b, name, 1, index, index + 1)};
	return write(p, psrc, pid, n, b, ps, 1, header, changed);
}

static int order_in(pl *p, tb_key psrc, tb_key pid, const char *name, long from, long to,
	ch_header header, const char **err_at, pl_changed *changed) {
	nd_node *n = node_of(p, psrc, pid);
	if (n == NULL) return fail(PL_NOTHING_THERE, err_at, NULL);
	const op_value *list = array(n, name);
	long len = list != NULL ? (long)list->count : 0;
	if (!within(from, 0, len - 1) || !within(to, 0, len - 1)) return fail(PL_RANGE, err_at, name);
	if (from == to) return PL_OK;
	blk *b = blk_new(p);
	op_patch *ps = bmem(b, sizeof *ps);
	ps[0] = (op_patch){.place = target(b, name, 1, to, to), .has_move = 1,
		.move = target(b, name, 1, from, from + 1)};
	return write(p, psrc, pid, n, b, ps, 1, header, changed);
}

int pl_place(pl *p, pl_at at, const char *name, tb_key source, tb_key id, ch_header header,
	long index, const char **err_at, pl_changed *changed) {
	if (changed != NULL) changed->n = 0;
	tb_key ps, pid;
	ids(&at, &ps, &pid);
	return place_in(p, ps, pid, name, source, id, header, index, err_at, changed);
}

int pl_unplace(pl *p, pl_at at, const char *name, long index, ch_header header, const char **err_at,
	pl_changed *changed) {
	if (changed != NULL) changed->n = 0;
	tb_key ps, pid;
	ids(&at, &ps, &pid);
	return unplace_in(p, ps, pid, name, index, header, err_at, changed);
}

int pl_order(pl *p, pl_at at, const char *name, long from, long to, ch_header header,
	const char **err_at, pl_changed *changed) {
	if (changed != NULL) changed->n = 0;
	tb_key ps, pid;
	ids(&at, &ps, &pid);
	return order_in(p, ps, pid, name, from, to, header, err_at, changed);
}

int pl_rename(pl *p, pl_at at, const char *name, const char *to, ch_header header,
	const char **err_at, pl_changed *changed) {
	if (changed != NULL) changed->n = 0;
	if (bad(to)) return fail(PL_NOT_A_NAME, err_at, to);
	tb_key ps, pid;
	ids(&at, &ps, &pid);
	nd_node *n = node_of(p, ps, pid);
	if (n == NULL) return fail(PL_NOTHING_THERE, err_at, NULL);
	const op_value *list = array(n, name);
	if (list == NULL || list->count == 0) return fail(PL_NOTHING_THERE, err_at, name);
	if (strcmp(to, name) == 0) return PL_OK;
	const op_value *m = map_of(n);
	if (m != NULL && op_get(m, to) != NULL) return fail(PL_ALREADY_THERE, err_at, to);
	blk *b = blk_new(p);
	op_patch *ps2 = bmem(b, sizeof *ps2);
	ps2[0] = (op_patch){.place = target(b, to, 0, 0, 0), .has_move = 1, .move = target(b, name, 0, 0, 0)};
	return write(p, ps, pid, n, b, ps2, 1, header, changed);
}

int pl_move(pl *p, pl_at at, const char *name, long index, pl_at toat, const char *toname,
	ch_header header, long toindex, const char **err_at, pl_changed *changed) {
	if (changed != NULL) changed->n = 0;
	if (bad(toname)) return fail(PL_NOT_A_NAME, err_at, toname);
	tb_key ps, pid, ts, tid;
	ids(&at, &ps, &pid);
	ids(&toat, &ts, &tid);
	nd_node *n = node_of(p, ps, pid);
	if (n == NULL) return fail(PL_NOTHING_THERE, err_at, NULL);
	const op_value *list = array(n, name);
	long len = list != NULL ? (long)list->count : 0;
	if (!within(index, 0, len - 1)) return fail(len ? PL_RANGE : PL_NOTHING_THERE, err_at, name);
	tb_key source, id;
	if (!entry(p, list->items[index], &source, &id)) return fail(PL_NOTHING_THERE, err_at, name);
	// the same node, not the same key: the table may hold one node under several keys
	int one = node_of(p, ts, tid) == n;
	if (one && strcmp(name, toname) == 0) {
		return order_in(p, ts, tid, name, index, toindex == PL_END ? len - 1 : toindex, header, err_at,
			changed);
	}
	if (one) {
		if (taken(n, toname)) return fail(PL_ALREADY_THERE, err_at, toname);
		const op_value *target_list = array(n, toname);
		long tlen = target_list != NULL ? (long)target_list->count : 0;
		long i = toindex == PL_END ? tlen : toindex;
		if (!within(i, 0, tlen)) return fail(PL_RANGE, err_at, toname);
		blk *b = blk_new(p);
		op_patch *patches = bmem(b, 3 * sizeof *patches);
		size_t k = 0;
		if (target_list == NULL) {
			patches[k++] = (op_patch){.place = target(b, toname, 0, 0, 0), .has_value = 1,
				.value = bval(b, op_list())};
		}
		patches[k++] = (op_patch){.place = target(b, toname, 1, i, i), .has_move = 1,
			.move = target(b, name, 1, index, index + 1)};
		if (len == 1) patches[k++] = (op_patch){.place = target(b, name, 0, 0, 0)};
		return write(p, ts, tid, n, b, patches, k, header, changed);
	}
	// two parents: copied out first, as the entry's strings live in a value a write may let go of
	char *s = source.symbol == NULL ? xdup(source.string) : NULL, *d = id.symbol == NULL ? xdup(id.string) : NULL;
	tb_key cs = s != NULL ? tb_string(s) : source, cid = d != NULL ? tb_string(d) : id;
	int code = place_in(p, ts, tid, toname, cs, cid, header, toindex, err_at, changed);
	free(s);
	free(d);
	if (code != PL_OK) return code;
	return unplace_in(p, ps, pid, name, index, header, err_at, changed);
}
