// The layout, in C: layout.ts function by function, iterating in the same order (a Map's insertion order is an Omap's;
// slots and paths are sorted by code point, as there).
#include "layout.h"

#include "../../../ermine/encoding/c/json.h"
#include "names.h"

#include <stdlib.h>
#include <string.h>

#define ERMINE ".ermine"
#define TMP ".ermine/tmp"
// the null value's hash
#define NULLHASH "61a9bf10f0ffedc7dc77589ae2ab4ca80b006c806e6636e41b60410cd8f0bbc4"
// between the parts of a key: no valid string holds it
#define SEP "\xff"

static char tags[3];
static void *const yes = &tags[0];
// a verdict held in a map: unknown is NULL
static void *const no = &tags[1];
static void *const right = &tags[2];

// memory --------------------------------------------------------------------------------------------------------------

static void **pool;
static size_t poolcount, poolcapacity;

void *layout_grab(size_t size) {
	void *p = calloc(1, size ? size : 1);
	if (p == NULL) abort();
	if (poolcount == poolcapacity) {
		poolcapacity = poolcapacity ? poolcapacity * 2 : 1024;
		pool = realloc(pool, poolcapacity * sizeof *pool);
		if (pool == NULL) abort();
	}
	pool[poolcount++] = p;
	return p;
}

char *layout_own(char *text) {
	if (text == NULL) return NULL;
	if (poolcount == poolcapacity) {
		poolcapacity = poolcapacity ? poolcapacity * 2 : 1024;
		pool = realloc(pool, poolcapacity * sizeof *pool);
		if (pool == NULL) abort();
	}
	pool[poolcount++] = text;
	return text;
}

void layout_release(void) {
	for (size_t i = 0; i < poolcount; i++) free(pool[i]);
	poolcount = 0;
}

#define own layout_own
#define grab layout_grab
#define fmt(...) own(formatString(__VA_ARGS__))

// ordered maps and lists ------------------------------------------------------------------------------------------------

Omap *omap_new(void) {
	Omap *m = grab(sizeof *m);
	m->spread = 8;
	m->buckets = grab(8 * sizeof *m->buckets);
	for (int i = 0; i < 8; i++) m->buckets[i] = -1;
	return m;
}

static unsigned hash(const char *s) {
	unsigned h = 2166136261u;
	for (; *s; s++) h = (h ^ (unsigned char)*s) * 16777619u;
	return h;
}

static int find(const Omap *m, const char *key) {
	for (int i = m->buckets[hash(key) % m->spread]; i >= 0; i = m->entries[i].next)
		if (m->entries[i].live && strcmp(m->entries[i].key, key) == 0) return i;
	return -1;
}

void *omap_get(const Omap *m, const char *key) {
	int i = find(m, key);
	return i < 0 ? NULL : m->entries[i].value;
}

bool omap_has(const Omap *m, const char *key) {
	return find(m, key) >= 0;
}

void omap_set(Omap *m, const char *key, void *value) {
	int i = find(m, key);
	if (i >= 0) {
		m->entries[i].value = value;
		return;
	}
	if (m->count == m->capacity) {
		int capacity = m->capacity ? m->capacity * 2 : 8;
		OmapEntry *entries = grab(capacity * sizeof *entries);
		if (m->count) memcpy(entries, m->entries, m->count * sizeof *entries);
		m->entries = entries;
		m->capacity = capacity;
	}
	if (m->count >= m->spread) {
		m->spread *= 2;
		m->buckets = grab(m->spread * sizeof *m->buckets);
		for (int b = 0; b < m->spread; b++) m->buckets[b] = -1;
		for (int e = 0; e < m->count; e++) {
			if (!m->entries[e].live) continue;
			unsigned b = hash(m->entries[e].key) % m->spread;
			m->entries[e].next = m->buckets[b];
			m->buckets[b] = e;
		}
	}
	unsigned b = hash(key) % m->spread;
	m->entries[m->count] = (OmapEntry){key, value, m->buckets[b], true};
	m->buckets[b] = m->count++;
	m->size++;
}

bool omap_delete(Omap *m, const char *key) {
	int i = find(m, key);
	if (i < 0) return false;
	m->entries[i].live = false;
	m->size--;
	return true;
}

Omap *omap_copy(const Omap *m) {
	Omap *out = omap_new();
	for (int i = 0; i < m->count; i++)
		if (m->entries[i].live) omap_set(out, m->entries[i].key, m->entries[i].value);
	return out;
}

/** every live entry, in order */
#define EACH(m, e) for (const OmapEntry *e = (m)->entries; e < (m)->entries + (m)->count; e++) if (e->live)

Strs *strs_new(void) {
	return grab(sizeof(Strs));
}

void strs_push(Strs *list, const char *item) {
	if (list->count == list->capacity) {
		int capacity = list->capacity ? list->capacity * 2 : 4;
		const char **items = grab(capacity * sizeof *items);
		if (list->count) memcpy(items, list->items, list->count * sizeof *items);
		list->items = items;
		list->capacity = capacity;
	}
	list->items[list->count++] = item;
}

static bool includes(const Strs *list, const char *item) {
	for (int i = 0; list && i < list->count; i++)
		if (strcmp(list->items[i], item) == 0) return true;
	return false;
}

static int indexof(const Strs *list, const char *item) {
	for (int i = 0; list && i < list->count; i++)
		if (strcmp(list->items[i], item) == 0) return i;
	return -1;
}

static int bycp(const void *a, const void *b) {
	return names_bycodepoint(*(const char *const *)a, *(const char *const *)b);
}

/** an Omap's keys in code point order */
static Strs *sorted(const Omap *m) {
	Strs *keys = strs_new();
	EACH(m, e) strs_push(keys, e->key);
	if (keys->count) qsort(keys->items, keys->count, sizeof *keys->items, bycp);
	return keys;
}

// paths -----------------------------------------------------------------------------------------------------------------

static const char *join(const char *dir, const char *name) {
	return *dir == 0 ? name : fmt("%s/%s", dir, name);
}

static const char *parent(const char *path) {
	const char *s = strrchr(path, '/');
	return s ? own(copyStringOfLength(path, (size_t)(s - path))) : "";
}

static const char *base(const char *path) {
	const char *s = strrchr(path, '/');
	return s ? s + 1 : path;
}

/** a name less its extension and dot */
static const char *stem(const char *name, const char *ext) {
	return own(copyStringOfLength(name, strlen(name) - strlen(ext) - 1));
}

static const char *key(const char *name) {
	return own(names_key(name));
}

static const char *extension(const char *name) {
	return own(names_extension(name));
}

static Strs *splitting(const char *path) {
	Strs *out = strs_new();
	if (*path == 0) return out;
	const char *from = path;
	for (const char *c = path;; c++) {
		if (*c == '/' || *c == 0) {
			strs_push(out, own(copyStringOfLength(from, (size_t)(c - from))));
			from = c + 1;
			if (*c == 0) break;
		}
	}
	return out;
}

const char *layout_relative(const char *from, const char *to) {
	Strs *a = splitting(from), *b = splitting(to);
	int i = 0;
	while (i < a->count && i < b->count && strcmp(a->items[i], b->items[i]) == 0) i++;
	Strs *out = strs_new();
	for (int j = i; j < a->count; j++) strs_push(out, "..");
	for (int j = i; j < b->count; j++) strs_push(out, b->items[j]);
	if (!out->count) return ".";
	size_t n = 0;
	for (int j = 0; j < out->count; j++) n += strlen(out->items[j]) + 1;
	char *s = grab(n + 1);
	for (int j = 0; j < out->count; j++) {
		if (j) strcat(s, "/");
		strcat(s, out->items[j]);
	}
	return s;
}

// where nodes are -----------------------------------------------------------------------------------------------------

typedef const char *(*Up)(void *context, const char *id);

/** the folder a home's entries are in: its holder's folder, or the union's in it */
static const char *room(const Omap *layout, Home home, Up up, void *context) {
	const Layout *h = omap_get(layout, home.holder);
	const Entry *e = h && h->folder && h->entries ? omap_get(h->entries, home.name) : NULL;
	if (e == NULL) return NULL;
	const char *at = up(context, home.holder);
	if (at == NULL) return NULL;
	if (e->stems == NULL) return at;
	return join(at, e->stems->count ? e->stems->items[0] : "undefined");
}

typedef struct {
	const Omap *layout;
	Omap *seen;
} Climb;

static const char *climb(void *context, const char *id) {
	Climb *c = context;
	const Layout *r = omap_get(c->layout, id);
	if (r == NULL || r->away) return NULL;
	if (r->home == NULL) return "";
	if (omap_has(c->seen, id)) return NULL;
	omap_set(c->seen, id, yes);
	const char *at = room(c->layout, *r->home, climb, c);
	if (at == NULL) return NULL;
	const Layout *h = omap_get(c->layout, r->home->holder);
	const Entry *e = omap_get(h->entries, r->home->name);
	const char *s = NULL;
	if (e->stems == NULL) s = e->stem;
	else if (r->home->position + 1 < e->stems->count) s = e->stems->items[r->home->position + 1];
	return s == NULL ? NULL : join(at, s);
}

const char *layout_dir(const Omap *layout, const char *id) {
	Climb c = {layout, omap_new()};
	return climb(&c, id);
}

typedef struct {
	const Omap *layout;
	Omap *dirs; // id -> folder, NULL when it has none
} Cached;

static const char *cached(void *context, const char *id) {
	Cached *c = context;
	if (!omap_has(c->dirs, id)) omap_set(c->dirs, id, (void *)layout_dir(c->layout, id));
	return omap_get(c->dirs, id);
}

static const char *roomof(const Omap *layout, Home home) {
	Cached c = {layout, omap_new()};
	return room(layout, home, cached, &c);
}

/** whether a record shows its node at home in that slot */
static bool athome(const Layout *r, const char *holder, const char *name) {
	return r && !r->away && r->home && strcmp(r->home->holder, holder) == 0 && strcmp(r->home->name, name) == 0;
}

static Home *homeof(const char *holder, const char *name, int position) {
	Home *h = grab(sizeof *h);
	*h = (Home){holder, name, position};
	return h;
}

static Strs *slot(const Graph *graph, const char *holder, const char *name) {
	const Node *n = omap_get(graph->nodes, holder);
	return n ? omap_get(n->directory, name) : NULL;
}

// what is on disk -----------------------------------------------------------------------------------------------------

typedef struct {
	const char *const *v;
	int n;
} Pass;

static names_split_result split(Pass pass, const char *name, const char *form, const Node *x) {
	names_split_result r = names_split(name, form, x && x->head ? x->head : (const uint8_t *)"", x ? x->length : 0, pass.v, (size_t)pass.n);
	own(r.stem), own(r.ext);
	return r;
}

/** an id as a path segment; an id with a lone surrogate, which has none, as itself */
static const char *percent(const char *id) {
	const char *p = own(names_percent(id));
	return p ? p : id;
}

static Laid *laid(LaidKind kind) {
	Laid *l = grab(sizeof *l);
	l->kind = kind;
	return l;
}

/** every entry the layout puts on disk, left ones included */
static Omap *walk(const Graph *graph, const Omap *layout, Pass pass) {
	Omap *out = omap_new();
	const char *root = graph->root;
	Cached c = {layout, omap_new()};
	const Layout *rr = omap_get(layout, root);
	const Node *rn = omap_get(graph->nodes, root);
	if (rr && rr->file && rn) {
		Laid *l = laid(LAID_FILE);
		l->id = root, l->form = rn->form, l->hash = rr->laid ? rr->laid : rn->hash, l->info = rn->info;
		omap_set(out, fmt("%s/%s", ERMINE, rr->file), l);
	}
	// each node at its home: its file and its folder
	EACH(layout, e) {
		const char *id = e->key;
		const Layout *r = e->value;
		if (strcmp(id, root) == 0 || r->away || !r->home) continue;
		const Node *n = omap_get(graph->nodes, id);
		const char *where = n ? room(layout, *r->home, cached, &c) : NULL;
		if (!n || where == NULL) continue;
		Home *h = homeof(r->home->holder, r->home->name, r->home->position);
		if (r->file) {
			Laid *l = laid(LAID_FILE);
			l->id = id, l->home = h, l->form = n->form, l->hash = r->laid ? r->laid : n->hash, l->info = n->info;
			omap_set(out, join(where, r->file), l);
			// its sides, beside it
			for (int i = 0; r->sides && i < r->sides->count; i++) {
				if (i >= n->nsides) continue;
				Laid *s = laid(LAID_SIDE);
				s->id = id, s->home = h, s->side = i + 1, s->form = n->sides[i].form, s->hash = n->sides[i].hash;
				omap_set(out, join(where, r->sides->items[i]), s);
			}
		}
		const char *d = r->folder ? cached(&c, id) : NULL;
		if (d) {
			Laid *l = laid(LAID_FOLDER);
			l->id = id, l->home = h, l->info = n->info;
			omap_set(out, d, l);
		}
	}
	// in each shown folder: unions' folders and links
	EACH(layout, e) {
		const char *h = e->key;
		const Layout *r = e->value;
		if (r->away || !r->folder || !r->entries || (strcmp(h, root) != 0 && !r->home)) continue;
		const char *d = cached(&c, h);
		const Node *n = omap_get(graph->nodes, h);
		if (d == NULL || !n) continue;
		EACH(r->entries, en) {
			const char *name = en->key;
			const Entry *ent = en->value;
			const Strs *ids = omap_get(n->directory, name);
			int count = ids ? ids->count : 0;
			bool onion = ent->stems != NULL;
			if (onion) {
				Laid *l = laid(LAID_UNION);
				l->holder = h, l->name = name;
				omap_set(out, join(d, ent->stems->count ? ent->stems->items[0] : "undefined"), l);
			}
			if (!count || (count > 1) != onion) continue;
			const char *folder = onion ? join(d, ent->stems->count ? ent->stems->items[0] : "undefined") : d;
			for (int i = 0; i < count; i++) {
				const char *id = ids->items[i];
				const char *st = NULL;
				if (!onion) st = ent->stem;
				else if (i + 1 < ent->stems->count) st = ent->stems->items[i + 1];
				const Layout *x = omap_get(layout, id);
				if (st == NULL || (strcmp(id, root) != 0 && athome(x, h, name))) continue;
				Home *slotted = homeof(h, name, i);
				const Node *node = omap_get(graph->nodes, id);
				if (!node) {
					Laid *l = laid(LAID_LINK);
					l->id = id, l->home = slotted, l->half = "pending";
					l->target = layout_relative(folder, fmt("%s/id/%s", ERMINE, percent(id)));
					omap_set(out, join(folder, st), l);
					continue;
				}
				const char *file = NULL, *fold = NULL;
				if (strcmp(id, root) == 0) {
					if (x && x->file) file = fmt("%s/%s", ERMINE, x->file);
					fold = "";
				} else if (x && !x->away && x->home) {
					const char *w = room(layout, *x->home, cached, &c);
					if (w && x->file) file = join(w, x->file);
					if (x->folder) fold = cached(&c, id);
				}
				if (file) {
					names_split_result s = split(pass, name, node->form, node);
					const char *ext = s.ext;
					if (s.added) {
						const char *own_ext = extension(base(file));
						if (own_ext) ext = own_ext;
					}
					Laid *l = laid(LAID_LINK);
					l->id = id, l->home = slotted, l->half = "file", l->target = layout_relative(folder, file);
					omap_set(out, join(folder, fmt("%s.%s", st, ext)), l);
				}
				if (fold) {
					Laid *l = laid(LAID_LINK);
					l->id = id, l->home = slotted, l->half = "folder", l->target = layout_relative(folder, fold);
					omap_set(out, join(folder, st), l);
				}
			}
		}
	}
	return out;
}

/** whether a path, or a folder it is in, is in the set */
static bool under(const char *path, const Omap *set) {
	for (const char *p = path;; p = parent(p)) {
		if (omap_has(set, p)) return true;
		if (*p == 0) return false;
	}
}

/** every path in some record's left */
static Omap *lefts(const Omap *layout) {
	Omap *out = omap_new();
	EACH(layout, e) {
		const Layout *r = e->value;
		for (int i = 0; r->left && i < r->left->count; i++) omap_set(out, r->left->items[i], yes);
	}
	return out;
}

/** what a walk gives, less what is left and what is in it; the walk's own if nothing is left */
static Omap *without(Omap *all, const Omap *left) {
	if (!left->size) return all;
	Omap *out = omap_copy(all);
	EACH(all, e) if (under(e->key, left)) omap_delete(out, e->key);
	return out;
}

Omap *layout_disk(const Graph *graph, const Omap *layout, const char *const *pass, int count) {
	return without(walk(graph, layout, (Pass){pass, count}), lefts(layout));
}

// the records that fit --------------------------------------------------------------------------------------------------

typedef struct {
	const Graph *graph;
	const Omap *layout;
	Omap *fits; // id -> 1 no, 2 yes
} Fit;

static bool fit(Fit *f, const char *id) {
	void *known = omap_get(f->fits, id);
	if (known) return known == right;
	omap_set(f->fits, id, no);
	const char *root = f->graph->root;
	const Layout *r = omap_get(f->layout, id);
	bool ok = r && (strcmp(id, root) == 0 || omap_has(f->graph->nodes, id));
	if (ok && strcmp(id, root) == 0) ok = !r->home && !r->away;
	else if (ok && !r->away) {
		const char *h = r->home ? r->home->holder : "", *name = r->home ? r->home->name : "";
		int pos = r->home ? r->home->position : 0;
		const Strs *ids = slot(f->graph, h, name);
		int count = ids ? ids->count : 0;
		const Layout *hl = omap_get(f->layout, h);
		const Entry *e = hl && hl->entries ? omap_get(hl->entries, name) : NULL;
		ok = r->home && includes(ids, id) && fit(f, h) && !hl->away && hl->folder && e != NULL &&
			(e->stems == NULL ? count == 1 : e->stems->count == count + 1 && pos < count);
	}
	omap_set(f->fits, id, (ok ? right : no));
	return ok;
}

Omap *layout_prune(const Graph *graph, const Omap *layout) {
	Fit f = {graph, layout, omap_new()};
	Omap *out = omap_new();
	EACH(layout, e) if (fit(&f, e->key)) omap_set(out, e->key, e->value);
	return out;
}

// homes ---------------------------------------------------------------------------------------------------------------

typedef struct {
	const Graph *graph;
	const Omap *old;
	Omap *kept; // id -> 1 no, 2 yes
} Keeps;

static bool keeps(Keeps *k, const char *id) {
	if (strcmp(id, k->graph->root) == 0) return true;
	void *known = omap_get(k->kept, id);
	if (known) return known == right;
	omap_set(k->kept, id, no);
	const Layout *r = omap_get(k->old, id);
	bool ok = false;
	if (r && !r->away && r->home && omap_has(k->graph->nodes, id))
		ok = includes(slot(k->graph, r->home->holder, r->home->name), id) && keeps(k, r->home->holder);
	omap_set(k->kept, id, (ok ? right : no));
	return ok;
}

/** each shown node's home, and every shown node in the order homes were settled, the root first */
static void settle(const Graph *graph, const Omap *old, Omap **homes, Strs **order) {
	const char *root = graph->root;
	Keeps k = {graph, old, omap_new()};
	*homes = omap_new();
	*order = strs_new();
	strs_push(*order, root);
	Omap *shown = omap_new();
	omap_set(shown, root, yes);
	for (int i = 0; i < (*order)->count; i++) {
		const char *h = (*order)->items[i];
		const Node *n = omap_get(graph->nodes, h);
		Strs *slots = sorted(n->directory);
		for (int s = 0; s < slots->count; s++) {
			const char *name = slots->items[s];
			const Strs *ids = omap_get(n->directory, name);
			for (int pos = 0; pos < ids->count; pos++) {
				const char *id = ids->items[pos];
				if (omap_has(shown, id) || !omap_has(graph->nodes, id)) continue;
				if (keeps(&k, id)) {
					const Home *o = ((Layout *)omap_get(old, id))->home;
					if (strcmp(o->holder, h) != 0 || strcmp(o->name, name) != 0) continue;
				}
				omap_set(*homes, id, homeof(h, name, pos));
				omap_set(shown, id, yes);
				strs_push(*order, id);
			}
		}
	}
}

// the layout ------------------------------------------------------------------------------------------------------------

typedef struct {
	const Graph *graph;
	Graph view;
	const Omap *old;
	Pass pass;
	Probe probe;
	void *context;
	Owned owned;
	void *owncontext;
	Omap *all, *was, *relay, *ours, *taken, *layout;
} Lay;

static Entry *entry(const char *s, Strs *stems) {
	Entry *e = grab(sizeof *e);
	e->stem = s, e->stems = stems;
	return e;
}

static const char *extof(Lay *l, const char *name, const char *id) {
	const Node *x = omap_get(l->graph->nodes, id);
	return x ? split(l->pass, name, x->form, x).ext : NULL;
}

static const char *stemwas(Lay *l, const char *id) {
	const Layout *r = omap_get(l->old, id);
	if (!r || !r->home) return NULL;
	const Layout *h = omap_get(l->old, r->home->holder);
	const Entry *e = h && h->entries ? omap_get(h->entries, r->home->name) : NULL;
	if (!e) return NULL;
	if (!e->stems) return e->stem;
	return r->home->position + 1 < e->stems->count ? e->stems->items[r->home->position + 1] : NULL;
}

/** a node's position in a slot by the old layout: at home, its home's; else the old graph's; -1 for none */
static int poswas(Lay *l, const char *h, const char *name, const char *id) {
	const Layout *r = omap_get(l->old, id);
	if (athome(r, h, name)) return r->home->position;
	return indexof(slot(&l->view, h, name), id);
}

typedef void (*Into)(void *context, const char *name);

/** the old layout's sides' names of the nodes at home in a holder's slot */
static void sidesof(Lay *l, const char *h, const char *s, const Strs *ids, Into into, void *context) {
	for (int i = 0; i < ids->count; i++) {
		const Layout *r = omap_get(l->old, ids->items[i]);
		if (athome(r, h, s)) {
			for (int j = 0; r->sides && j < r->sides->count; j++) into(context, r->sides->items[j]);
		}
	}
}

/** a name's key, and its stem's as a file, into a set */
static void mark(void *set, const char *name) {
	omap_set(set, key(name), yes);
	const char *e = extension(name);
	if (e) omap_set(set, key(stem(name, e)), yes);
}

typedef struct {
	Lay *l;
	Omap *used, *foreign;
} Ent;

static void foreignto(void *context, const char *name) {
	Ent *e = context;
	mark(e->used, name);
	omap_set(e->foreign, key(name), yes);
}

/** the names the probe gives in a folder that the old layout did not put there are others' */
static void others(Lay *l, const char *folder, Into into, void *context) {
	if (folder == NULL) return;
	const Omap *mine = omap_get(l->ours, folder);
	const Strs *names = l->probe(l->context, folder);
	for (int i = 0; names && i < names->count; i++)
		if (!(mine && omap_has(mine, names->items[i])) && !(l->owned && l->owned(l->owncontext, join(folder, names->items[i])))) into(context, names->items[i]);
}

typedef struct {
	Omap *a, *b;
	const char *ext;
} Free;

/** whether a stem, or as a file with the extension, is in either set */
static bool taken(const char *c, void *context) {
	const Free *f = context;
	const char *k = key(c);
	if (omap_has(f->a, k) || (f->b && omap_has(f->b, k))) return true;
	if (f->ext == NULL) return false;
	k = key(fmt("%s.%s", c, f->ext));
	return omap_has(f->a, k) || (f->b && omap_has(f->b, k));
}

/** whether a kept stem's entries, as the node it shows now needs them, would land on another's */
static bool clash(Ent *en, const char *s, const char *st, const char *id) {
	Lay *l = en->l;
	const Node *x = omap_get(l->graph->nodes, id);
	if (!x) return omap_has(en->foreign, key(st));
	const Layout *r = omap_get(l->old, id);
	bool folder = false;
	EACH(x->directory, d) if (((Strs *)d->value)->count > 0) folder = true;
	if (!folder) folder = r && r->folder && !r->away;
	bool file = !(strcmp(x->hash, NULLHASH) == 0 && folder);
	return (folder && omap_has(en->foreign, key(st))) ||
		(file && omap_has(en->foreign, key(fmt("%s.%s", st, extof(l, s, id)))));
}

/** the number's words, less trailing .FINALs */
static const char *words(const char *member) {
	double n;
	char *w;
	if (!names_number(member, &n, &w)) return "";
	own(w);
	size_t length = strlen(w);
	while (length >= 6 && memcmp(w + length - 6, ".FINAL", 6) == 0) length -= 6;
	return own(copyStringOfLength(w, length));
}

/** the stems of a shown holder's slots */
static Omap *entries(Lay *l, const char *h) {
	const Graph *g = l->graph;
	const char *root = g->root;
	const Node *n = omap_get(g->nodes, h);
	const Layout *r = omap_get(l->old, h);
	Omap *prior = r ? r->entries : NULL;
	const char *now = strcmp(h, root) == 0 ? "" : r && !r->away && r->folder ? layout_dir(l->old, h) : NULL;
	Ent en = {l, omap_new(), omap_new()};
	Omap *used = en.used;
	if (strcmp(h, root) == 0) mark(used, ERMINE);
	// others' entries here, by the key their whole names compare by
	others(l, now, foreignto, &en);
	Strs *all = sorted(n->directory), *slots = strs_new();
	for (int i = 0; i < all->count; i++)
		if (((Strs *)omap_get(n->directory, all->items[i]))->count) strs_push(slots, all->items[i]);
	// the sides laid here: a new stem does not take one, though a side may move for a stem kept
	Omap *sided = omap_new();
	for (int i = 0; i < slots->count; i++) {
		const Strs *ids = omap_get(n->directory, slots->items[i]);
		if (ids->count == 1) sidesof(l, h, slots->items[i], ids, mark, sided);
	}
	Omap *out = omap_new();
	Strs *fresh = strs_new();
	for (int i = 0; i < slots->count; i++) {
		const char *s = slots->items[i];
		const Strs *ids = omap_get(n->directory, s);
		const Entry *e = prior ? omap_get(prior, s) : NULL;
		bool onion = ids->count > 1;
		const Strs *held = slot(&l->view, h, s);
		bool arrived = !onion && held && held->count == 1 && strcmp(held->items[0], ids->items[0]) == 0 &&
			!omap_has(l->view.nodes, ids->items[0]) && omap_has(g->nodes, ids->items[0]);
		if (e == NULL || (e->stems != NULL) != onion || arrived || omap_has(l->relay, fmt("%s" SEP "%s", h, s)) ||
			(!onion && clash(&en, s, e->stem, ids->items[0]))) {
			strs_push(fresh, s);
			continue;
		}
		const char *st = e->stems ? (e->stems->count ? e->stems->items[0] : "") : e->stem;
		omap_set(out, s, entry(st, NULL));
		omap_set(used, key(st), yes);
		const char *ext = onion ? NULL : extof(l, s, ids->items[0]);
		if (ext && *ext) mark(used, fmt("%s.%s", st, ext));
		const Layout *o = omap_get(l->old, ids->items[0]);
		const char *f = athome(o, h, s) ? o->file : NULL;
		if (!onion && f) mark(used, f);
	}
	Free fr = {used, sided, NULL};
	for (int i = 0; i < fresh->count; i++) {
		const char *s = fresh->items[i];
		const Strs *ids = omap_get(n->directory, s);
		const char *st = s, *ext = NULL;
		if (ids->count > 1) {
			const char *e = extension(s);
			if (e && !names_passes(s, l->pass.v, (size_t)l->pass.n)) st = stem(s, e);
		} else if (omap_has(g->nodes, ids->items[0])) {
			const Node *x = omap_get(g->nodes, ids->items[0]);
			names_split_result sp = split(l->pass, s, x->form, x);
			st = sp.stem, ext = sp.ext;
		}
		st = own(names_write(st, l->pass.v, (size_t)l->pass.n));
		st = own(names_cut(st, ext ? ext : ""));
		fr.ext = ext;
		st = own(names_free(st, taken, &fr));
		omap_set(used, key(st), yes);
		if (ext && *ext) mark(used, fmt("%s.%s", st, ext));
		omap_set(out, s, entry(st, NULL));
	}
	omap_set(l->taken, h, used);
	// a union's members: their numbers in slot order, with a person's words
	for (int i = 0; i < slots->count; i++) {
		const char *s = slots->items[i];
		const Strs *ids = omap_get(n->directory, s);
		if (ids->count < 2) continue;
		const Entry *e = prior ? omap_get(prior, s) : NULL;
		const char *folder = ((Entry *)omap_get(out, s))->stem;
		Omap *inner = omap_new(), *msided = omap_new();
		if (now != NULL && e && e->stems) others(l, join(now, e->stems->count ? e->stems->items[0] : "undefined"), mark, inner);
		sidesof(l, h, s, ids, mark, msided);
		Strs *stems = strs_new();
		strs_push(stems, folder);
		Free mf = {inner, msided, NULL};
		for (int j = 0; j < ids->count; j++) {
			const char *w = "";
			if (e && e->stems) {
				int p = poswas(l, h, s, ids->items[j]);
				if (p >= 0 && p + 1 < e->stems->count) w = words(e->stems->items[p + 1]);
			}
			const char *ext = extof(l, s, ids->items[j]);
			const char *m = own(names_member(j + 1, w));
			m = own(names_cut(m, ext ? ext : ""));
			mf.ext = ext;
			m = own(names_free(m, taken, &mf));
			mark(inner, m);
			if (ext && *ext) mark(inner, fmt("%s.%s", m, ext));
			strs_push(stems, m);
		}
		omap_set(out, s, entry(NULL, stems));
		omap_set(l->taken, fmt("%s" SEP "%s", h, s), inner);
	}
	return out;
}

/** a node's sides' names, beside its file: its file's stem with one more .FINAL each, clear of the folder's names, each with the extension its slot's name gives it, or its own */
static Strs *sides(Lay *l, const Node *x, const char *file, const Home *h) {
	const char *k;
	if (h == NULL) k = ERMINE;
	else {
		const Layout *holder = omap_get(l->layout, h->holder);
		k = ((Entry *)omap_get(holder->entries, h->name))->stems == NULL ? h->holder : fmt("%s" SEP "%s", h->holder, h->name);
	}
	Omap *used = omap_get(l->taken, k);
	if (!used) {
		used = omap_new();
		omap_set(used, key(file), yes);
		omap_set(l->taken, k, used);
	}
	const char *ext = extension(file);
	const char *st = ext == NULL ? file : stem(file, ext);
	Strs *out = strs_new();
	for (int i = 0; i < x->nsides; i++) {
		const Side *sd = &x->sides[i];
		const char *e;
		if (h == NULL) e = names_suffix(sd->form, sd->head ? sd->head : (const uint8_t *)"", sd->length);
		else {
			Node probe = {.form = sd->form, .head = sd->head, .length = sd->length};
			e = split(l->pass, h->name, sd->form, &probe).ext;
		}
		Free fr = {used, NULL, e};
		st = own(names_free(fmt("%s.FINAL", st), taken, &fr));
		omap_set(used, key(st), yes);
		omap_set(used, key(fmt("%s.%s", st, e)), yes);
		strs_push(out, fmt("%s.%s", st, e));
	}
	return out;
}

static const char *fileof(const char *id, const Omap *layout) {
	const Layout *r = omap_get(layout, id);
	if (!r || !r->file || r->away) return "";
	if (!r->home) return fmt("%s/%s", ERMINE, r->file);
	const char *at = roomof(layout, *r->home);
	return at == NULL ? "" : join(at, r->file);
}

static bool listed(const Strs *x, const Strs *y) {
	if (x == y) return true;
	if (!x || !y || x->count != y->count) return false;
	for (int i = 0; i < x->count; i++)
		if (strcmp(x->items[i], y->items[i]) != 0) return false;
	return true;
}

static bool same(const char *a, const char *b) {
	return a == b || (a && b && strcmp(a, b) == 0);
}

/** whether two records say the same */
static bool alike(const Layout *a, const Layout *b) {
	static const Strs none;
	if (!same(a->file, b->file) || !same(a->laid, b->laid) || !same(a->was, b->was) || a->folder != b->folder ||
		a->away != b->away || !!a->home != !!b->home || !listed(a->left, b->left) ||
		!listed(a->sides ? a->sides : &none, b->sides ? b->sides : &none))
		return false;
	if (a->home && (strcmp(a->home->holder, b->home->holder) != 0 || strcmp(a->home->name, b->home->name) != 0 ||
		a->home->position != b->home->position))
		return false;
	int x = a->entries ? a->entries->size : 0, y = b->entries ? b->entries->size : 0;
	if (x != y) return false;
	if (!x) return true;
	EACH(a->entries, e) {
		const Entry *v = e->value, *w = omap_get(b->entries, e->key);
		if (w == NULL) return false;
		if (v->stems == NULL ? w->stems != NULL || strcmp(v->stem, w->stem) != 0 : w->stems == NULL || !listed(v->stems, w->stems))
			return false;
	}
	return true;
}

// the plan --------------------------------------------------------------------------------------------------------------

bool layout_sameinfo(Info a, Info b) {
	if (a.count != b.count) return false;
	for (int i = 0; i < a.count; i++)
		if (strcmp(a.items[i].name, b.items[i].name) != 0 || strcmp(a.items[i].hash, b.items[i].hash) != 0 ||
			strcmp(a.items[i].form, b.items[i].form) != 0)
			return false;
	return true;
}

/** what an entry is, wherever it is */
static const char *which(const Laid *l) {
	switch (l->kind) {
	case LAID_FILE: return fmt("f" SEP "%s", l->id);
	case LAID_SIDE: return fmt("s" SEP "%s" SEP "%d", l->id, l->side);
	case LAID_FOLDER: return fmt("d" SEP "%s", l->id);
	case LAID_UNION: return fmt("u" SEP "%s" SEP "%s", l->holder, l->name);
	default: return fmt("l" SEP "%s" SEP "%s" SEP "%s" SEP "%s", l->home->holder, l->home->name, l->id, l->half);
	}
}

/** what a step names besides: a node's id, a union's holder and slot, a file's form, a side's number */
static void named(const Laid *l, Step *s) {
	switch (l->kind) {
	case LAID_FILE: s->id = l->id, s->form = l->form; break;
	case LAID_SIDE: s->id = l->id, s->form = l->form, s->side = l->side; break;
	case LAID_UNION: s->slot = true, s->holder = l->holder, s->name = l->name; break;
	default: s->id = l->id;
	}
}

typedef struct {
	const char *path;
	Laid *laid;
} Held;
/** where an entry is: the folder it is in, an entry's key or "#" and a fixed path, and its name */
typedef struct {
	const char *up, *name;
} At;
typedef struct {
	const char *k, *path;
} Pair;

typedef struct {
	Omap *was, *now, *at, *kids, *gone, *make, *moved;
	Step *steps;
	int count, capacity;
	const char *time;
	Ino ino;
	void *context;
} Diff;

static Omap *placed(Omap *all) {
	Omap *byPath = omap_new(), *out = omap_new();
	EACH(all, e) omap_set(byPath, ((Held *)e->value)->path, (void *)e->key);
	EACH(all, e) {
		const char *path = ((Held *)e->value)->path, *p = parent(path);
		const char *up = omap_get(byPath, p);
		At *a = grab(sizeof *a);
		a->up = up ? up : fmt("#%s", p), a->name = base(path);
		omap_set(out, e->key, a);
	}
	return out;
}

static const char *pathof(Diff *d, const char *up) {
	if (up[0] == '#') return up + 1;
	const At *a = omap_get(d->at, up);
	return join(pathof(d, a->up), a->name);
}

static const char *pathat(Diff *d, const char *k) {
	const At *a = omap_get(d->at, k);
	return join(pathof(d, a->up), a->name);
}

static void put(Diff *d, const char *k) {
	const At *a = omap_get(d->at, k);
	Omap *m = omap_get(d->kids, a->up);
	if (!m) omap_set(d->kids, a->up, m = omap_new());
	omap_set(m, key(a->name), (void *)k);
}

static void out(Diff *d, const char *k) {
	const At *a = omap_get(d->at, k);
	Omap *m = omap_get(d->kids, a->up);
	const char *n = key(a->name);
	if (m && omap_get(m, n) && strcmp(omap_get(m, n), k) == 0) omap_delete(m, n);
}

static Found foundof(FoundKind kind, const char *text) {
	Found f = {kind, text, false, 0};
	return f;
}

static Found found(Diff *d, const char *k) {
	const Held *h = omap_get(d->was, k);
	if (h->laid->kind == LAID_FILE || h->laid->kind == LAID_SIDE) return foundof(FOUND_FILE, h->laid->hash);
	if (h->laid->kind == LAID_LINK) return foundof(FOUND_LINK, h->laid->target);
	Found f = foundof(FOUND_FOLDER, NULL);
	if (d->ino) f.known = d->ino(d->context, h->path, &f.ino);
	return f;
}

static Found made(const Laid *l) {
	if (l->kind == LAID_FILE || l->kind == LAID_SIDE) return foundof(FOUND_FILE, l->hash);
	if (l->kind == LAID_LINK) return foundof(FOUND_LINK, l->target);
	return foundof(FOUND_FOLDER, NULL);
}

static int step(Diff *d, Step s) {
	if (d->count == d->capacity) {
		int capacity = d->capacity ? d->capacity * 2 : 16;
		Step *steps = grab(capacity * sizeof *steps);
		if (d->count) memcpy(steps, d->steps, d->count * sizeof *steps);
		d->steps = steps;
		d->capacity = capacity;
	}
	s.number = d->count + 1;
	d->steps[d->count++] = s;
	return s.number;
}

/** renames an entry into .ermine/tmp/ to wait there */
static void away(Diff *d, const char *k) {
	Found f = found(d, k);
	int n = d->count + 1;
	Step s = {.what = "rename", .from = pathat(d, k), .to = fmt("%s/%s.%d", TMP, d->time, n), .before = f, .after = f};
	named(((Held *)omap_get(d->was, k))->laid, &s);
	step(d, s);
	out(d, k);
	At *a = grab(sizeof *a);
	a->up = "#" TMP, a->name = fmt("%s.%d", d->time, n);
	omap_set(d->at, k, a);
}

static bool doomed(Diff *d, const char *k) {
	for (const char *up = ((At *)omap_get(d->at, k))->up; up[0] != '#'; up = ((At *)omap_get(d->at, up))->up)
		if (omap_has(d->gone, up)) return true;
	return false;
}

static int depth(const char *p) {
	if (*p == 0) return 0;
	int n = 1;
	for (; *p; p++) n += *p == '/';
	return n;
}

static int deepest(const void *a, const void *b) {
	const Pair *x = a, *y = b;
	return depth(y->path) - depth(x->path) ? depth(y->path) - depth(x->path) : names_bycodepoint(x->path, y->path);
}

static int shallowest(const void *a, const void *b) {
	const Pair *x = a, *y = b;
	return depth(x->path) - depth(y->path) ? depth(x->path) - depth(y->path) : names_bycodepoint(x->path, y->path);
}

static bool isfile(const Laid *l) {
	return l->kind == LAID_FILE || l->kind == LAID_SIDE;
}

/** the steps that take the disk from one layout's entries to another's */
static Step *diff(Omap *from, Omap *to, double time, Ino ino, void *context, int *count) {
	char text[32];
	jsonNumberText(time, text);
	Diff d = {.time = own(copyString(text)), .ino = ino, .context = context};
	d.was = omap_new(), d.now = omap_new(), d.kids = omap_new();
	d.gone = omap_new(), d.make = omap_new(), d.moved = omap_new();
	EACH(from, e) {
		Held *h = grab(sizeof *h);
		h->path = e->key, h->laid = e->value;
		omap_set(d.was, which(h->laid), h);
	}
	EACH(to, e) {
		Held *h = grab(sizeof *h);
		h->path = e->key, h->laid = e->value;
		omap_set(d.now, which(h->laid), h);
	}
	d.at = placed(d.was);
	Omap *want = placed(d.now);
	EACH(d.was, e) put(&d, e->key);

	EACH(d.was, e) {
		const char *k = e->key;
		const Held *o = e->value, *w = omap_get(d.now, k);
		if (!w) {
			omap_set(d.gone, k, yes);
			continue;
		}
		const At *a = omap_get(d.at, k), *b = omap_get(want, k);
		bool moves = strcmp(a->up, b->up) != 0 || strcmp(a->name, b->name) != 0;
		bool reform = isfile(o->laid) && isfile(w->laid) && strcmp(o->laid->form, w->laid->form) != 0;
		if (reform || (o->laid->kind == LAID_LINK && moves)) {
			omap_set(d.gone, k, yes);
			omap_set(d.make, k, yes);
		} else if (moves) omap_set(d.moved, k, yes);
	}
	EACH(d.now, e) if (!omap_has(d.was, e->key)) omap_set(d.make, e->key, yes);

	// first, what goes, and what moves out of a folder that goes, deepest first
	Pair *first = grab((d.was->count + 1) * sizeof *first);
	int nfirst = 0;
	EACH(d.was, e) {
		if (omap_has(d.gone, e->key) || (omap_has(d.moved, e->key) && doomed(&d, e->key)))
			first[nfirst++] = (Pair){e->key, pathat(&d, e->key)};
	}
	if (nfirst) qsort(first, nfirst, sizeof *first, deepest);
	for (int i = 0; i < nfirst; i++) {
		const char *k = first[i].k;
		if (!omap_has(d.gone, k)) {
			away(&d, k);
			continue;
		}
		Step s = {.what = "remove", .from = pathat(&d, k), .before = found(&d, k)};
		named(((Held *)omap_get(d.was, k))->laid, &s);
		int n = step(&d, s);
		out(&d, k);
		At *a = grab(sizeof *a);
		a->up = "#" TMP, a->name = fmt("%s.%d", d.time, n);
		omap_set(d.at, k, a);
	}

	// then each entry of the new layout, shallowest first
	Pair *then = grab((d.now->count + 1) * sizeof *then);
	int nthen = 0;
	EACH(d.now, e) then[nthen++] = (Pair){e->key, ((Held *)e->value)->path};
	if (nthen) qsort(then, nthen, sizeof *then, shallowest);
	for (int i = 0; i < nthen; i++) {
		const char *k = then[i].k;
		const Laid *l = ((Held *)omap_get(d.now, k))->laid;
		At *b = omap_get(want, k);
		if (omap_has(d.make, k) || omap_has(d.moved, k)) {
			Omap *m = omap_get(d.kids, b->up);
			const char *occupant = m ? omap_get(m, key(b->name)) : NULL;
			if (occupant && strcmp(occupant, k) != 0 && omap_has(d.moved, occupant)) away(&d, occupant);
			const char *to = join(pathof(&d, b->up), b->name);
			if (omap_has(d.make, k)) {
				Step s = {.what = l->kind == LAID_UNION ? "folder" : l->kind == LAID_SIDE ? "file" : l->kind == LAID_FILE ? "file" : l->kind == LAID_FOLDER ? "folder" : "link",
					.to = to, .after = made(l)};
				named(l, &s);
				if (l->kind == LAID_FILE || l->kind == LAID_FOLDER) s.hasinfo = true, s.info = l->info;
				step(&d, s);
			} else {
				Found f = found(&d, k);
				Step s = {.what = "rename", .from = pathat(&d, k), .to = to, .before = f, .after = f};
				named(l, &s);
				step(&d, s);
				out(&d, k);
			}
			omap_set(d.at, k, b);
			put(&d, k);
		}
		const Held *oh = omap_get(d.was, k);
		if (!oh || omap_has(d.make, k)) continue;
		const Laid *o = oh->laid;
		if (o->kind == LAID_FILE && l->kind == LAID_FILE && strcmp(o->hash, l->hash) != 0) {
			Step s = {.what = "file", .to = pathat(&d, k), .before = foundof(FOUND_FILE, o->hash), .after = foundof(FOUND_FILE, l->hash),
				.id = l->id, .form = l->form, .hasinfo = true, .info = l->info};
			step(&d, s);
		} else if (o->kind == LAID_SIDE && l->kind == LAID_SIDE && strcmp(o->hash, l->hash) != 0) {
			Step s = {.what = "file", .to = pathat(&d, k), .before = foundof(FOUND_FILE, o->hash), .after = foundof(FOUND_FILE, l->hash)};
			named(l, &s);
			step(&d, s);
		} else if (((o->kind == LAID_FILE && l->kind == LAID_FILE) || (o->kind == LAID_FOLDER && l->kind == LAID_FOLDER)) &&
			!layout_sameinfo(o->info, l->info)) {
			Found f = l->kind == LAID_FILE ? foundof(FOUND_FILE, l->hash) : found(&d, k);
			Step s = {.what = "info", .to = pathat(&d, k), .before = f, .after = f, .id = l->id, .hasinfo = true, .info = l->info};
			step(&d, s);
		} else if (o->kind == LAID_LINK && l->kind == LAID_LINK && strcmp(o->target, l->target) != 0) {
			Step s = {.what = "link", .to = pathat(&d, k), .before = foundof(FOUND_LINK, o->target), .after = foundof(FOUND_LINK, l->target), .id = l->id};
			step(&d, s);
		}
	}
	*count = d.count;
	return d.steps;
}

// laying out ------------------------------------------------------------------------------------------------------------

Laying layout_lay(const Graph *graph, const Omap *old, Probe probe, void *context, double time, const char *const *pass, int count, const Graph *before, Ino ino, void *inocontext) {
	return layout_lay_owned(graph, old, probe, context, time, pass, count, before, ino, inocontext, NULL, NULL);
}

Laying layout_lay_owned(const Graph *graph, const Omap *old, Probe probe, void *context, double time, const char *const *pass, int count, const Graph *before, Ino ino, void *inocontext, Owned owned, void *owncontext) {
	const char *root = graph->root;
	if (!omap_has(graph->nodes, root)) return (Laying){omap_copy(old), omap_new(), NULL, 0};
	if (before == NULL) before = graph;
	Pass p = {pass, count};
	// what the old layout was laid out from: the old graph, and the nodes the files program made
	// since, which it has records for
	Lay l = {.graph = graph, .old = old, .pass = p, .probe = probe, .context = context, .owned = owned, .owncontext = owncontext};
	l.view.root = before->root;
	l.view.nodes = omap_copy(before->nodes);
	EACH(graph->nodes, e) if (!omap_has(l.view.nodes, e->key) && omap_has(old, e->key)) omap_set(l.view.nodes, e->key, e->value);
	l.all = walk(&l.view, old, p);
	Omap *left = lefts(old);
	l.was = without(l.all, left);
	// the slots with an entry in left, to lay again under a new name
	l.relay = omap_new();
	EACH(left, e) {
		const Laid *x = omap_get(l.all, e->key);
		if (x && x->kind == LAID_UNION) omap_set(l.relay, fmt("%s" SEP "%s", x->holder, x->name), yes);
		else if (x && x->home) omap_set(l.relay, fmt("%s" SEP "%s", x->home->holder, x->home->name), yes);
	}
	// the old layout's names in each folder; the rest the probe gives are others'
	l.ours = omap_new();
	EACH(l.was, e) {
		const char *dir = parent(e->key);
		Omap *s = omap_get(l.ours, dir);
		if (!s) omap_set(l.ours, dir, s = omap_new());
		omap_set(s, base(e->key), yes);
	}
	l.taken = omap_new();
	l.layout = omap_new();

	Omap *homes;
	Strs *order;
	settle(graph, old, &homes, &order);

	for (int i = 0; i < order->count; i++) {
		const char *id = order->items[i];
		const Node *x = omap_get(graph->nodes, id);
		const Layout *r = omap_get(old, id);
		const Layout *back = r && !r->away ? r : NULL;
		Layout *rec = grab(sizeof *rec);
		const Home *h = omap_get(homes, id);
		if (h) rec->home = homeof(h->holder, h->name, h->position);
		bool folder = strcmp(id, root) == 0 || (back && back->folder);
		EACH(x->directory, e) if (((Strs *)e->value)->count > 0) folder = true;
		if (folder) {
			rec->folder = true;
			Omap *e = entries(&l, id);
			if (e->size) rec->entries = e;
		}
		omap_set(l.layout, id, rec);
		if (!(strcmp(x->hash, NULLHASH) == 0 && folder)) {
			if (strcmp(id, root) == 0) rec->file = fmt("root.%s", names_suffix(x->form, x->head ? x->head : (const uint8_t *)"", x->length));
			else {
				const Layout *holder = omap_get(l.layout, h->holder);
				const Entry *e = omap_get(holder->entries, h->name);
				const char *st = e->stems ? e->stems->items[h->position + 1] : e->stem;
				const Node *was = omap_get(l.view.nodes, id);
				bool unchanged = back && back->file && athome(back, h->holder, h->name) && same(stemwas(&l, id), st) &&
					strcmp(was ? was->form : x->form, x->form) == 0;
				rec->file = unchanged ? back->file : fmt("%s.%s", st, split(p, h->name, x->form, x).ext);
			}
			rec->laid = x->hash;
			const char *w = back ? back->laid : NULL;
			if (w && strcmp(w, x->hash) != 0) {
				const Laid *wl = omap_get(l.was, fileof(id, old));
				if (wl && wl->kind == LAID_FILE) rec->was = w;
			}
			if (x->nsides) rec->sides = sides(&l, x, rec->file, rec->home);
		}
	}
	// a record whose node is no longer shown is kept, away
	EACH(old, e) {
		if (omap_has(l.layout, e->key)) continue;
		Layout *r = grab(sizeof *r);
		*r = *(const Layout *)e->value;
		r->was = NULL, r->left = NULL, r->away = true;
		omap_set(l.layout, e->key, r);
	}

	Omap *changed = omap_new();
	EACH(l.layout, e) {
		const Layout *o = omap_get(old, e->key);
		if (!o || !alike(o, e->value)) omap_set(changed, e->key, e->value);
	}
	Laying out = {l.layout, changed, NULL, 0};
	out.plan = diff(l.was, layout_disk(graph, l.layout, pass, count), time, ino, inocontext, &out.count);
	return out;
}
