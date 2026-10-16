// program.c: the files program. See program.h; the rules, and the order of every step, are program.ts's.
//
// A failure is thrown as program.ts throws one: THROW leaves to the nearest unit, which lists the entry it was making
// and goes on; outside every unit it leaves edit, which then answers nothing. Memory is layout.h's arena (grab, own):
// what edit builds, and what it answers, lasts till st_release.
#ifdef __linux__
#define _GNU_SOURCE
#endif

#include "program.h"

#include "names.h"

#include <dirent.h>
#include <setjmp.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define own layout_own
#define grab layout_grab
#define fmt(...) own(formatString(__VA_ARGS__))

// ordered maps are Omaps: a Map's insertion order is theirs
#define EACH(m, e) for (const OmapEntry *e = (m)->entries; e < (m)->entries + (m)->count; e++) if (e->live)
#define YES ((void *)1)

// values ----------------------------------------------------------------------------------------------------------------

// the hash of a value as the graph has it; NULL for none
static const char *hash_of(const op_value *v) {
	if (!v) return NULL;
	Json *j = fg_json_of(v);
	char h[65];
	bool ok = mf_hash(j, h);
	jsonFree(j);
	return ok ? own(copyString(h)) : NULL;
}

static bool same_text(const char *a, const char *b) {
	return a == b || (a && b && strcmp(a, b) == 0);
}

// the state of one call of edit ---------------------------------------------------------------------------------------

typedef struct {
	void *items;
	size_t count, capacity;
} Vec;

static void *vpush(Vec *v, size_t size) {
	if (v->count == v->capacity) {
		size_t capacity = v->capacity ? v->capacity * 2 : 8;
		void *items = grab(capacity * size);
		if (v->count) memcpy(items, v->items, v->count * size);
		v->items = items, v->capacity = capacity;
	}
	return (char *)v->items + size * v->count++;
}

typedef struct Unit {
	jmp_buf jump;
	struct Unit *prev;
	const char *trash;
	const char *const *mend;
	size_t mends;
} Unit;

typedef struct {
	const char *id;
	long at;
} Slot;
typedef struct {
	Slot *items;
	size_t count;
} Slots;

// where a new entry goes: the node whose folder it is in, and for a union's folder its slot
typedef struct {
	const char *holder, *slot;
} Target;

typedef struct {
	const char *path;
	const Laid *was;
	const st_entry *now;
} Changed;

typedef struct {
	const char *id;
	bool has_file, has_folder;
	const char *file[2], *folder[2];
} Move;
typedef struct {
	const char *holder, *slot, *from, *to;
} UnionMove;
typedef struct {
	const char *id;
	const Laid *was;
	const char *from, *to;
	const st_entry *now;
} LinkMove;
typedef struct {
	const char *from, *to;
} SideMove;
typedef struct {
	const char *path;
	const Laid *laid;
} Taken;
typedef struct {
	const char *holder, *slot, *folder;
	Omap *moved;
} Reorder;

typedef struct {
	st_store *store;
	fg_api *api;
	const char *listing; // the node the program lists on
	Unit *unit;
	char error[512];
	const char *root;
	const Graph *graph;
	Omap *layout, *want, *kids;
	const char *folder;
	const char *const *pass;
	size_t passes;
	Omap *made, *madeby, *landed, *returned, *waiting, *took;
	Omap *gone, *gone_by;
	Vec marks, slots, unside, clear, trash, mend, listed;
} E;

static void throw_(E *e, const char *format, ...) __attribute__((noreturn, format(printf, 2, 3)));
static void throw_(E *e, const char *format, ...) {
	va_list ap;
	va_start(ap, format);
	vsnprintf(e->error, sizeof e->error, format, ap);
	va_end(ap);
	longjmp(e->unit->jump, 1);
}

static void api_(E *e, const char *error) {
	if (error) throw_(e, "%s", error);
}
#define API(e, call) api_(e, call)

static const char *dup_(const char *s) {
	return s ? own(copyString(s)) : NULL;
}

static void push_path(Vec *v, const char *path) {
	*(const char **)vpush(v, sizeof(const char *)) = path;
}
static void push_listed(Vec *v, const char *path, const char *why) {
	*(fp_listed *)vpush(v, sizeof(fp_listed)) = (fp_listed){path, why};
}
static void list(E *e, const char *path, const char *why) {
	push_listed(&e->listed, path, why);
}

// a failed unit: its entry listed with its error, sent to the Trash, the graph laid out again there
static void refused(E *e, const Unit *u, const char *error) {
	if (u->trash) push_listed(&e->trash, u->trash, fmt("refused: %s", error));
	for (size_t i = 0; i < u->mends; i++) push_path(&e->mend, u->mend[i]);
}

// one edit made into changes. UNIT_BEGIN(e, trash, mends, n) ... UNIT_END(e): the body leaves early with break
#define UNIT_BEGIN(e, TRASH, MENDS, N) \
	{ \
		Unit u_ = {.prev = (e)->unit, .trash = (TRASH), .mend = (MENDS), .mends = (N)}; \
		(e)->unit = &u_; \
		if (setjmp(u_.jump) == 0) { \
			do {
#define UNIT_END(e) \
	} \
	while (0) \
		; \
	} \
	else refused((e), &u_, (e)->error); \
	(e)->unit = u_.prev; \
	}

// paths -------------------------------------------------------------------------------------------------------------------

static const char *join(const char *dir, const char *name) {
	return dir[0] == 0 ? name : fmt("%s/%s", dir, name);
}
static const char *parent(const char *path) {
	const char *slash = strrchr(path, '/');
	return slash ? own(copyStringOfLength(path, (size_t)(slash - path))) : "";
}
static const char *base(const char *path) {
	const char *slash = strrchr(path, '/');
	return slash ? slash + 1 : path;
}
static int depth(const char *path) {
	if (!path[0]) return 0;
	int n = 1;
	for (; *path; path++) n += *path == '/';
	return n;
}
static bool under(const char *path, const char *folder) {
	size_t n = strlen(folder);
	return strncmp(path, folder, n) == 0 && path[n] == '/';
}
static const char *ext_of(const char *name) {
	return own(names_extension(name));
}
// an entry's stem: its name less its last extension, if it has one
static const char *stem_of(const char *name) {
	const char *x = ext_of(name);
	return x ? own(copyStringOfLength(name, strlen(name) - strlen(x) - 1)) : name;
}

// a link's target from the folder it is in, as a path from the store's folder; NULL if it leads out
static const char *resolve(const char *store, const char *folder, const char *target) {
	Strs *parts = strs_new();
	char *copy = copyString(target);
	own(copy);
	if (target[0] == '/') {
		if (strcmp(target, store) == 0) return "";
		if (!under(target, store)) return NULL;
		for (char *p = copy + strlen(store) + 1, *q; p; p = q) {
			q = strchr(p, '/');
			if (q) *q++ = 0;
			strs_push(parts, p);
		}
	} else {
		char *f = own(copyString(folder));
		if (f[0])
			for (char *p = f, *q; p; p = q) {
				q = strchr(p, '/');
				if (q) *q++ = 0;
				strs_push(parts, p);
			}
		for (char *p = copy, *q; p; p = q) {
			q = strchr(p, '/');
			if (q) *q++ = 0;
			strs_push(parts, p);
		}
	}
	Strs *out = strs_new();
	for (int i = 0; i < parts->count; i++) {
		const char *p = parts->items[i];
		if (p[0] == 0 || strcmp(p, ".") == 0) continue;
		if (strcmp(p, "..") == 0) {
			if (!out->count) return NULL;
			out->count--;
		} else strs_push(out, p);
	}
	char *joined = copyString("");
	for (int i = 0; i < out->count; i++) {
		char *next = formatString("%s%s%s", joined, i ? "/" : "", out->items[i]);
		free(joined);
		joined = next;
	}
	return own(joined);
}

// the graph ---------------------------------------------------------------------------------------------------------

// the node's value as the graph has it now: core keeps one version, so a side, a later one, is never there
static const op_value *value_of(E *e, const char *id) {
	if (!fg_loaded(fg_of(e->api), id)) throw_(e, "the node is not loaded");
	return fg_value(fg_of(e->api), id);
}

// the ids of a holder's slot, as the graph has them now, with each one's position in the list
static Slots slot_of(E *e, const char *holder, const char *slot) {
	Slots out = {0};
	const char **ids;
	size_t n = fg_ids(fg_of(e->api), holder, slot, &ids);
	out.items = grab((n + 1) * sizeof *out.items);
	for (size_t i = 0; i < n; i++) out.items[out.count++] = (Slot){dup_(ids[i]), (long)i};
	free((void *)ids);
	return out;
}
static long position_of(E *e, const char *holder, const char *slot, const char *id, int near) {
	Slots all = slot_of(e, holder, slot);
	if (near >= 0 && (size_t)near < all.count && strcmp(all.items[near].id, id) == 0) return all.items[near].at;
	for (size_t i = 0; i < all.count; i++)
		if (strcmp(all.items[i].id, id) == 0) return all.items[i].at;
	throw_(e, "the slot \"%s\" no longer holds the node", slot);
}

// the patches that make from into to: for two strings, or two typed arrays of one kind, one splice of the part between
// what is alike at the start and at the end; a snapshot for anything else. Bytes are a snapshot
static size_t scalar(const char *s) {
	unsigned char c = (unsigned char)*s;
	return c < 0x80 ? 1 : c < 0xE0 ? 2 : c < 0xF0 ? 3 : 4;
}
static op_patch patch_of(const op_value *from, const op_value *to) {
	op_patch p = {0};
	p.has_value = 1;
	p.value = to;
	// a null written whole takes the value away: the node has none
	if (to->type == OP_NULL) p.has_value = 0;
	if (from && from->type == OP_STR && to->type == OP_STR) {
		// code points of each, as offsets
		size_t na = 0, nb = 0;
		for (const char *c = from->str; *c; c += scalar(c)) na++;
		for (const char *c = to->str; *c; c += scalar(c)) nb++;
		const char **a = grab((na + 1) * sizeof *a), **b = grab((nb + 1) * sizeof *b);
		size_t i = 0;
		for (const char *c = from->str; *c; c += scalar(c)) a[i++] = c;
		a[na] = from->str + strlen(from->str);
		i = 0;
		for (const char *c = to->str; *c; c += scalar(c)) b[i++] = c;
		b[nb] = to->str + strlen(to->str);
		size_t pre = 0, suf = 0;
		while (pre < na && pre < nb && a[pre + 1] - a[pre] == b[pre + 1] - b[pre] && memcmp(a[pre], b[pre], (size_t)(a[pre + 1] - a[pre])) == 0) pre++;
		while (suf < na - pre && suf < nb - pre && a[na - suf] - a[na - suf - 1] == b[nb - suf] - b[nb - suf - 1] &&
			   memcmp(a[na - suf - 1], b[nb - suf - 1], (size_t)(a[na - suf] - a[na - suf - 1])) == 0)
			suf++;
		p.place.has_range = 1;
		p.place.from = (long)pre, p.place.to = (long)(na - suf);
		p.value = op_str_n(b[pre], (size_t)(b[nb - suf] - b[pre]));
		return p;
	}
	if (from && from->type == OP_TYPED && to->type == OP_TYPED && from->kind == to->kind) {
		size_t size = op_size(from->kind), na = op_length(from), nb = op_length(to);
		size_t pre = 0, suf = 0;
		while (pre < na && pre < nb && memcmp(from->data + pre * size, to->data + pre * size, size) == 0) pre++;
		while (suf < na - pre && suf < nb - pre && memcmp(from->data + (na - 1 - suf) * size, to->data + (nb - 1 - suf) * size, size) == 0) suf++;
		p.place.has_range = 1;
		p.place.from = (long)pre, p.place.to = (long)(na - suf);
		p.value = op_typed(to->kind, to->data + pre * size, nb - suf - pre);
	}
	return p;
}

// writes a value whole to a node, by patches from what it has; at: the version, from 0
// to is a new value, let go of once written (the graph keeps its own hold), with the one the patch made of it
static void write_nt(E *e, const char *id, op_value *to, size_t at) {
	const op_value *from = at == 0 ? value_of(e, id) : NULL;
	if (at != 0 && !fg_loaded(fg_of(e->api), id)) throw_(e, "the node is not loaded");
	op_patch patch = patch_of(from, to);
	const char *error = fg_write(e->api, id, &patch, 1, at);
	if (patch.value && patch.value != to) op_free((op_value *)patch.value);
	op_free(to);
	API(e, error);
}
static void write_json(E *e, const char *id, const Json *to, size_t at) {
	write_nt(e, id, fg_value_of(to), at);
}

// value is a new value, let go of once the node is made (the graph keeps its own hold)
static const char *create_(E *e, op_value *value) {
	char *id;
	const char *error = fg_create(e->api, value, false, &id);
	op_free(value);
	API(e, error);
	const char *mine = dup_(id);
	free(id);
	return mine;
}
static void insert_(E *e, const char *holder, const char *slot, const char *id, long at) {
	API(e, fg_insert(e->api, holder, slot, id, at, -1));
}
static void insert_over(E *e, const char *holder, const char *slot, const char *id, long from, long to) {
	API(e, fg_insert(e->api, holder, slot, id, from, to));
}
static void remove_(E *e, const char *holder, const char *slot, long from, long to) {
	API(e, fg_remove(e->api, holder, slot, from, to));
}
static void move_(E *e, const char *h, const char *s, long at, const char *toh, const char *tos, bool has_to, long to) {
	API(e, fg_move(e->api, h, s, at, toh, tos, has_to ? to : -1));
}

// the layout --------------------------------------------------------------------------------------------------------

static Layout *layout_get(E *e, const char *id) {
	return omap_get(e->layout, id);
}
static Layout *rec(E *e, const char *id) {
	Layout *r = omap_get(e->layout, id);
	if (!r) {
		r = grab(sizeof *r);
		omap_set(e->layout, dup_(id), r);
	}
	return r;
}
static Home *new_home(const char *holder, const char *name, int position) {
	Home *h = grab(sizeof *h);
	*h = (Home){dup_(holder), dup_(name), position};
	return h;
}
static bool shown(E *e, const char *id) {
	Layout *r = layout_get(e, id);
	return r && !r->away && (strcmp(id, e->root) == 0 || r->home);
}
static Entry *entry_of(Layout *r, const char *slot) {
	return r && r->entries ? omap_get(r->entries, slot) : NULL;
}
static const char *member_stem(const Entry *e, int at) {
	return e->stems && at + 1 < e->stems->count ? e->stems->items[at + 1] : NULL;
}
// a node's stem at its home, which its file and folder share
static const char *stem_at(E *e, const char *id) {
	Layout *r = layout_get(e, id);
	if (!r || !r->home) return NULL;
	Entry *en = entry_of(layout_get(e, r->home->holder), r->home->name);
	if (!en) return NULL;
	return en->stems ? member_stem(en, r->home->position) : en->stem;
}
// the folder a node's file is in
static const char *room_of(E *e, const char *id) {
	if (strcmp(id, e->root) == 0) return ".ermine";
	Layout *r = layout_get(e, id);
	if (!r || !r->home) return NULL;
	Entry *en = entry_of(layout_get(e, r->home->holder), r->home->name);
	const char *at = layout_dir(e->layout, r->home->holder);
	if (!en || !at) return NULL;
	return en->stems ? join(at, en->stems->items[0]) : at;
}
static Omap *entries_of(E *e, const char *holder) {
	Layout *r = rec(e, holder);
	r->folder = true;
	if (!r->entries) r->entries = omap_new();
	return r->entries;
}
static Entry *entry_str(const char *stem) {
	Entry *en = grab(sizeof *en);
	en->stem = dup_(stem);
	return en;
}

// a union's members' stems again, from the graph's order: each at home keeps its own, one given takes its
static void restem(E *e, const char *holder, const char *slot, const char *give_id, const char *give_stem) {
	Entry *old = entry_of(layout_get(e, holder), slot);
	if (!old || !old->stems) return;
	Slots ids = slot_of(e, holder, slot);
	Strs *stems = strs_new();
	strs_push(stems, old->stems->items[0]);
	for (size_t i = 0; i < ids.count; i++) {
		Layout *r = layout_get(e, ids.items[i].id);
		const char *stem = give_id && strcmp(give_id, ids.items[i].id) == 0 ? give_stem : NULL;
		bool mine = r && r->home && !r->away && strcmp(r->home->holder, holder) == 0 && strcmp(r->home->name, slot) == 0;
		if (!stem && mine) stem = member_stem(old, r->home->position);
		if (!stem) stem = fmt("%zu", i + 1);
		strs_push(stems, stem);
		if (mine) r->home = new_home(holder, slot, (int)i);
	}
	Entry *en = grab(sizeof *en);
	en->stems = stems;
	omap_set(entries_of(e, holder), dup_(slot), en);
}

// failing: see throw_ and UNIT_BEGIN

// the new entries' place -------------------------------------------------------------------------------------------------

static void take(E *e, const fp_edit *m);

static bool target(E *e, const char *folder, Target *out) {
	if (!folder[0]) return *out = (Target){e->root, NULL}, true;
	const fp_edit *w = omap_get(e->waiting, folder);
	if (w && !omap_has(e->made, folder)) take(e, w);
	const char *m = omap_get(e->made, folder);
	if (m) return *out = (Target){m, NULL}, true;
	// a union's folder that a node back from the Trash held
	if (w && w->now->kind == ST_FOLDER && w->now->holder && omap_has(e->returned, w->now->holder))
		return *out = (Target){w->now->holder, w->now->name}, true;
	const Laid *l = omap_get(e->want, folder);
	if (l && l->kind == LAID_FOLDER) return *out = (Target){l->id, NULL}, true;
	if (l && l->kind == LAID_UNION) return *out = (Target){l->holder, l->name}, true;
	return false;
}
// an entry's slot and place in a target: a union's, at the position its number gives, or a slot of its own at the end
typedef struct {
	const char *slot;
	long at;
} Spot;
static Spot spot(E *e, Target t, const char *slot, const char *name) {
	Slots all = slot_of(e, t.holder, t.slot ? t.slot : slot);
	long end = all.count ? all.items[all.count - 1].at + 1 : 0;
	if (!t.slot) return (Spot){slot, end};
	double n;
	char *words;
	if (!names_number(stem_of(name), &n, &words)) return (Spot){t.slot, end};
	free(words);
	long i = (long)n - 1;
	if (i > (long)all.count) i = (long)all.count;
	if (i < 0) i = 0;
	return (Spot){t.slot, (size_t)i < all.count ? all.items[i].at : end};
}
// sets a new or returning node's entry in the layout: its home, its stem in its holder's entries
static void home(E *e, const char *id, Target t, const char *slot, const char *stem) {
	Slots all = slot_of(e, t.holder, slot);
	size_t i = 0;
	for (size_t k = 0; k < all.count; k++)
		if (strcmp(all.items[k].id, id) == 0) {
			i = k;
			break;
		}
	Layout *r = rec(e, id);
	r->home = new_home(t.holder, slot, (int)i);
	r->away = false;
	Omap *es = entries_of(e, t.holder);
	Entry *en = omap_get(es, slot);
	if (en && en->stems) restem(e, t.holder, slot, id, stem);
	else if (!en || all.count == 1) omap_set(es, dup_(slot), entry_str(stem));
}

// the graph's nodes' kept form -----------------------------------------------------------------------------------------

static const Node *kept_node(E *e, const char *id) {
	return omap_get(e->graph->nodes, id);
}
static const char *kept_form(const Node *n) {
	return n ? n->form : "cbor";
}
static names_split_result split_of(E *e, const char *slot, const Node *n) {
	return names_split(slot, kept_form(n), n ? n->head : NULL, n ? n->length : 0, e->pass, e->passes);
}
// a node's value file edited -------------------------------------------------------------------------------------------

typedef enum { M_SAME, M_WRITTEN, M_TRASHED, M_MET } Met;

// the three cases of an edit to a node's file whose value differs from its laid
static Met meet(E *e, const char *id, const char *laid, const char *path, const st_entry *now, bool via_link) {
	const char *graphs = hash_of(value_of(e, id));
	if (same_text(graphs, now->hash)) return M_SAME;
	if (graphs && laid && strcmp(graphs, laid) == 0) {
		write_json(e, id, now->value, 0);
		return M_WRITTEN;
	}
	if (strcmp(id, e->root) == 0) {
		push_listed(&e->trash, path, "an edit to the root's file met a change");
		push_path(&e->mend, path);
		return M_TRASHED;
	}
	// the two meet: a new node holding the edit, right after the one it met
	Layout *old = layout_get(e, id);
	if (!old || !old->home) throw_(e, "the node is not shown");
	const char *holder = old->home->holder, *slot = old->home->name;
	int near = old->home->position;
	long at = position_of(e, holder, slot, id, near);
	const char *nid = create_(e, fg_value_of(now->value));
	insert_(e, holder, slot, nid, at + 1);
	if (via_link) return M_MET;
	// the edited file is the new node's; the met node's is laid again
	const char *file = old->file;
	old->file = NULL, old->laid = NULL;
	Layout *n = grab(sizeof *n);
	n->home = new_home(holder, slot, near + 1);
	n->file = file;
	n->laid = dup_(now->hash);
	omap_set(e->layout, dup_(nid), n);
	// in a union, the edited file's stem is the new node's, so the store renames it to the new node's place and lays the
	// met node's where it was
	restem(e, holder, slot, file ? nid : NULL, file ? stem_of(file) : NULL);
	*(fp_mark *)vpush(&e->marks, sizeof(fp_mark)) = (fp_mark){path, dup_(nid)};
	return M_MET;
}

// links ---------------------------------------------------------------------------------------------------------------------

// the id a link leads to: a node's file or folder in the store, or .ermine/id/ and an id; NULL for anywhere else
static const char *linked(E *e, const char *folder, const char *to) {
	const char *p = resolve(e->folder, folder, to);
	if (!p) return NULL;
	if (strncmp(p, ".ermine/id/", 11) == 0) {
		const char *seg = p + 11;
		return seg[0] && !strchr(seg, '/') ? own(names_unpercent(seg)) : NULL;
	}
	if (!p[0]) return e->root;
	const char *l = omap_get(e->landed, p);
	if (l) return l;
	const Laid *w = omap_get(e->want, p);
	if (w && (w->kind == LAID_FILE || w->kind == LAID_FOLDER)) return w->id;
	const char *m = omap_get(e->made, p);
	return m;
}

// a new entry's node made, and its path kept by folder and name, for beside
static void made_(E *e, const char *path, void *id) {
	if (!omap_has(e->made, path)) {
		const char *key = fmt("%s\xff%s", parent(path), own(names_key(base(path))));
		Strs *same = omap_get(e->madeby, key);
		if (!same) omap_set(e->madeby, key, same = strs_new());
		strs_push(same, path);
	}
	omap_set(e->made, path, id);
}

// a shown node beside a new entry, whose other half it is: a folder for a file, a file for a folder
static const char *beside(E *e, const char *folder, const char *name, st_kind kind) {
	Omap *here = omap_get(e->kids, folder);
	const char *k = own(names_key(kind == ST_FILE ? stem_of(name) : name));
	if (kind == ST_FILE) {
		Strs *same = omap_get(e->madeby, fmt("%s\xff%s", folder, k));
		for (int i = 0; same && i < same->count; i++) {
			const char *id = omap_get(e->made, same->items[i]);
			Layout *r = layout_get(e, id);
			if (!r || !r->file) return id;
		}
	}
	if (!here) return NULL;
	EACH(here, c) {
		const Laid *l = c->value;
		if (kind == ST_FILE && l->kind == LAID_FOLDER && strcmp(own(names_key(c->key)), k) == 0) {
			Layout *r = layout_get(e, l->id);
			if (!r || !r->file) return l->id;
		}
		if (kind == ST_FOLDER && l->kind == LAID_FILE && l->home) {
			const char *stem = stem_at(e, l->id);
			Layout *r = layout_get(e, l->id);
			if (stem && strcmp(own(names_key(stem)), k) == 0 && !(r && r->folder)) return l->id;
		}
	}
	return NULL;
}

// whether a node is one the graph keeps that no shown node holds now
static bool away_(E *e, const char *id) {
	return strcmp(id, e->root) != 0 && omap_has(e->graph->nodes, id) && !shown(e, id);
}

// a node back in a folder: it, and what its kept layout shows under it, shown again
static void back(E *e, const char *id) {
	Omap *on = omap_new();
	omap_set(on, id, YES);
	for (bool grew = true; grew;) {
		grew = false;
		EACH(e->layout, c) {
			Layout *r = c->value;
			if (!r->away || !r->home || omap_has(on, c->key) || !omap_has(on, r->home->holder)) continue;
			const Node *h = kept_node(e, r->home->holder);
			Strs *ids = h ? omap_get(h->directory, r->home->name) : NULL;
			bool in = false;
			for (int i = 0; ids && i < ids->count; i++)
				if (strcmp(ids->items[i], c->key) == 0) in = true;
			if (!in) continue;
			r->away = false;
			omap_set(on, c->key, YES);
			omap_set(e->returned, c->key, YES);
			grew = true;
		}
	}
}

// taking a new entry in -----------------------------------------------------------------------------------------------------

static void take(E *e, const fp_edit *m) {
	const char *path = m->path;
	const st_entry *now = m->now;
	if (omap_has(e->took, path)) return;
	omap_set(e->took, path, YES);
	const char *folder = parent(path), *name = base(path);
	if (strcmp(folder, ".ermine") == 0) {
		// the root's file made
		if (now->kind != ST_FILE) return;
		const char *rt = e->root;
		UNIT_BEGIN(e, path, ((const char *[]){path}), 1)
			if (now->why) {
				list(e, path, "does not read: it does not read in its form");
				break;
			}
			write_json(e, rt, now->value, 0);
			Layout *r = rec(e, rt);
			r->file = dup_(name);
			r->laid = dup_(now->hash);
		UNIT_END(e)
		return;
	}
	Target t;
	if (!target(e, folder, &t)) return;
	if (now->kind == ST_LINK) {
		// a link a folder back from the Trash held: the store's, which it lays again
		if (omap_has(e->returned, t.holder)) return;
		UNIT_BEGIN(e, NULL, NULL, 0)
			const char *to = linked(e, folder, now->target);
			if (!to) {
				list(e, path, "a link that leads nowhere in the store");
				break;
			}
			names_take_result tk = names_take(name);
			Spot sp = spot(e, t, own(tk.slot), name);
			free(tk.form);
			insert_(e, t.holder, sp.slot, to, sp.at);
			push_path(&e->clear, path);
		UNIT_END(e)
		return;
	}
	if (now->kind == ST_FILE && now->why) {
		list(e, path, "does not read: it does not read in its form");
		return;
	}
	// a union's folder a folder back from the Trash held: its members are taken in as its slot's
	if (now->kind == ST_FOLDER && now->holder && omap_has(e->returned, now->holder)) return;
	Layout *own_ = now->id && omap_has(e->returned, now->id) ? layout_get(e, now->id) : NULL;
	if (own_ && own_->home && strcmp(own_->home->holder, t.holder) == 0 && (!t.slot || strcmp(own_->home->name, t.slot) == 0)) {
		// what a folder back from the Trash held, as the graph kept it: its value compared
		const char *id = now->id;
		UNIT_BEGIN(e, path, ((const char *[]){path}), 1)
			if (now->kind == ST_FOLDER) {
				own_->folder = true;
				made_(e, path, (void *)id);
			} else {
				if (!same_text(hash_of(value_of(e, id)), now->hash)) write_json(e, id, now->value, 0);
				own_->file = dup_(name);
				own_->laid = dup_(now->hash);
			}
			omap_set(e->landed, path, (void *)id);
		UNIT_END(e)
		return;
	}
	UNIT_BEGIN(e, path, NULL, 0)
		// the other half of a node beside it
		const char *half = beside(e, folder, name, now->kind);
		if (half) {
			if (now->kind == ST_FILE) {
				if (!same_text(hash_of(value_of(e, half)), now->hash)) write_json(e, half, now->value, 0);
				Layout *r = rec(e, half);
				r->file = dup_(name);
				r->laid = dup_(now->hash);
			} else {
				Layout *r = rec(e, half);
				r->folder = true;
				if (!r->entries) r->entries = omap_new();
				const Home *h = r->home;
				Entry *en = entry_of(layout_get(e, h->holder), h->name);
				if (en && !en->stems) omap_set(entries_of(e, h->holder), dup_(h->name), entry_str(name));
				made_(e, path, (void *)half);
			}
			*(fp_mark *)vpush(&e->marks, sizeof(fp_mark)) = (fp_mark){path, dup_(half)};
			omap_set(e->landed, path, (void *)half);
			break;
		}
		const char *slot_name;
		if (now->kind == ST_FILE) {
			names_take_result tk = names_take(name);
			slot_name = own(tk.slot);
			free(tk.form);
		} else slot_name = own(names_read(name));
		const char *stem = now->kind == ST_FILE ? stem_of(name) : name;
		// a node the graph keeps, back from the Trash
		if (now->id && away_(e, now->id)) {
			const char *id = now->id;
			// its name read back less the extension the store adds for its value
			const Node *node = kept_node(e, id);
			const char *ext = names_suffix(node->form, node->head, node->length);
			const char *have = ext_of(name);
			if (now->kind == ST_FILE && have && strcmp(have, ext) == 0) {
				const char *read = own(names_read(name));
				slot_name = own(copyStringOfLength(read, strlen(read) - strlen(ext) - 1));
			}
			Layout *was = layout_get(e, id);
			Spot sp = spot(e, t, slot_name, name);
			long at = sp.at;
			if (was && was->home && strcmp(was->home->holder, t.holder) == 0 && strcmp(was->home->name, sp.slot) == 0) {
				Slots all = slot_of(e, t.holder, sp.slot);
				at = (size_t)was->home->position < all.count ? all.items[was->home->position].at : at;
			}
			insert_(e, t.holder, sp.slot, id, at);
			if (now->kind == ST_FOLDER) {
				back(e, id);
				Layout *r = rec(e, id);
				r->file = NULL, r->laid = NULL;
				r->folder = true;
				made_(e, path, (void *)id);
			} else {
				Layout *r = rec(e, id);
				r->file = dup_(name);
				r->folder = false;
				r->entries = NULL;
			}
			home(e, id, t, sp.slot, stem);
			if (now->kind == ST_FILE) {
				if (!same_text(hash_of(value_of(e, id)), now->hash)) write_json(e, id, now->value, 0);
				rec(e, id)->laid = dup_(now->hash);
			}
			*(fp_mark *)vpush(&e->marks, sizeof(fp_mark)) = (fp_mark){path, dup_(id)};
			omap_set(e->landed, path, (void *)id);
			break;
		}
		// a new node, or a copy, which is new nodes
		Spot sp = spot(e, t, slot_name, name);
		const char *id = create_(e, now->kind == ST_FILE ? fg_value_of(now->value) : op_null());
		insert_(e, t.holder, sp.slot, id, sp.at);
		Layout *r = rec(e, id);
		if (now->kind == ST_FILE) {
			r->file = dup_(name);
			r->laid = dup_(now->hash);
		} else {
			r->folder = true;
			r->entries = omap_new();
			made_(e, path, (void *)dup_(id));
		}
		home(e, id, t, sp.slot, stem);
		*(fp_mark *)vpush(&e->marks, sizeof(fp_mark)) = (fp_mark){path, dup_(id)};
		omap_set(e->landed, path, (void *)dup_(id));
		if (now->kind == ST_FILE) push_path(&e->unside, path);
	UNIT_END(e)
}


// the edit ------------------------------------------------------------------------------------------------------------------

// a stable sort: JavaScript's is, and the order the layout is made in depends on it
static void stable(void *items, size_t count, size_t size, int (*cmp)(const void *, const void *)) {
	if (count < 2) return;
	char *a = items, *tmp = grab(count * size);
	for (size_t width = 1; width < count; width *= 2) {
		for (size_t i = 0; i < count; i += 2 * width) {
			size_t mid = i + width < count ? i + width : count, hi = i + 2 * width < count ? i + 2 * width : count;
			size_t l = i, r = mid, o = i;
			while (l < mid && r < hi) {
				if (cmp(a + l * size, a + r * size) <= 0) memcpy(tmp + o++ * size, a + l++ * size, size);
				else memcpy(tmp + o++ * size, a + r++ * size, size);
			}
			while (l < mid) memcpy(tmp + o++ * size, a + l++ * size, size);
			while (r < hi) memcpy(tmp + o++ * size, a + r++ * size, size);
		}
		memcpy(a, tmp, count * size);
	}
}

static int cmp_made(const void *x, const void *y) {
	const fp_edit *a = *(const fp_edit *const *)x, *b = *(const fp_edit *const *)y;
	int d = depth(a->path) - depth(b->path);
	if (d) return d;
	int ra = a->now->kind == ST_FOLDER ? 0 : a->now->kind == ST_FILE ? 1 : 2;
	int rb = b->now->kind == ST_FOLDER ? 0 : b->now->kind == ST_FILE ? 1 : 2;
	return ra - rb;
}
static int cmp_path_depth(const void *x, const void *y) {
	const OmapEntry *a = *(const OmapEntry *const *)x, *b = *(const OmapEntry *const *)y;
	return depth(a->key) - depth(b->key);
}
static int cmp_move(const void *x, const void *y) {
	const Move *a = *(const Move *const *)x, *b = *(const Move *const *)y;
	return depth((a->has_file ? a->file : a->folder)[1]) - depth((b->has_file ? b->file : b->folder)[1]);
}

static const char *key_of(const Laid *l) {
	switch (l->kind) {
	case LAID_FILE: return fmt("f\xff%s", l->id);
	case LAID_FOLDER: return fmt("d\xff%s", l->id);
	case LAID_UNION: return fmt("u\xff%s\xff%s", l->holder, l->name);
	case LAID_LINK: return fmt("l\xff%s", l->id);
	default: return fmt("s\xff%s\xff%s", l->id, l->hash);
	}
}

static Taken taken(E *e, const char *key) {
	const char *p = omap_get(e->gone_by, key);
	if (!p) return (Taken){NULL, NULL};
	omap_delete(e->gone_by, key);
	const Laid *l = omap_get(e->gone, p);
	omap_delete(e->gone, p);
	return (Taken){p, l};
}

// an entry moved on disk, with a free name beside another: renamed only if nothing is there
typedef struct {
	Omap *there;
	const char *ext;
} Ask;
static bool is_taken(const char *c, void *context) {
	const Ask *a = context;
	const char *name = a->ext ? fmt("%s.%s", c, a->ext) : c;
	return omap_has(a->there, own(names_key(name)));
}
static const char *follow(E *e, const char *from, const char *to) {
	const char *dir = parent(to);
	DIR *d = opendir(dir[0] ? fmt("%s/%s", e->folder, dir) : e->folder);
	if (!d) return NULL;
	Ask ask = {omap_new(), ext_of(base(to))};
	for (struct dirent *de; (de = readdir(d));) {
		if (strcmp(de->d_name, ".") == 0 || strcmp(de->d_name, "..") == 0) continue;
		omap_set(ask.there, own(names_key(de->d_name)), YES);
	}
	closedir(d);
	const char *stem = ask.ext ? stem_of(base(to)) : base(to);
	const char *free_stem = own(names_free(stem, is_taken, &ask));
	const char *at = join(dir, ask.ext ? fmt("%s.%s", free_stem, ask.ext) : free_stem);
	const char *a = from[0] ? fmt("%s/%s", e->folder, from) : e->folder, *b = fmt("%s/%s", e->folder, at);
	if (rename(a, b) != 0) return NULL;
	return at;
}

// the slot a renamed node's entry gives: a file's new name less the extension the store added, a folder's plus the one its slot's name had
static const char *renamed(E *e, const char *id, const char *name, bool folder) {
	Layout *r = layout_get(e, id);
	const char *slot = r->home->name;
	names_split_result s = split_of(e, slot, kept_node(e, id));
	own(s.stem), own(s.ext);
	if (folder) return own(names_renamed(name, s.added ? NULL : s.ext, true));
	const char *ext = r->file ? ext_of(r->file) : NULL;
	size_t sl = strlen(slot);
	bool added = ext && !(sl > strlen(ext) + 1 && strcmp(slot + sl - strlen(ext) - 1, fmt(".%s", ext)) == 0);
	return own(names_renamed(name, added ? ext : NULL, false));
}

// unions renamed or moved: each id moved to the slot its new name gives, the layout rekeyed
static void union_body(E *e, const UnionMove *u) {
	Target t;
	if (!target(e, parent(u->to), &t)) throw_(e, "moved into a folder that is no node's");
	const char *ext = ext_of(u->slot);
	bool keep = ext && !names_passes(u->slot, e->pass, e->passes);
	const char *slot = t.slot ? t.slot : own(names_renamed(base(u->to), keep ? ext : NULL, true));
	Slots ids = slot_of(e, u->holder, u->slot);
	Entry *was = entry_of(layout_get(e, u->holder), u->slot);
	bool into = t.slot || slot_of(e, t.holder, slot).count > 0;
	if (strcmp(t.holder, u->holder) != 0 || strcmp(slot, u->slot) != 0)
		for (size_t i = 0; i < ids.count; i++) move_(e, u->holder, u->slot, 0, t.holder, slot, false, 0);
	if (into || !was || !was->stems) return;
	*(fp_slot *)vpush(&e->slots, sizeof(fp_slot)) = (fp_slot){u->to, t.holder, dup_(slot)};
	omap_delete(layout_get(e, u->holder)->entries, u->slot);
	Strs *stems = strs_new();
	strs_push(stems, base(u->to));
	for (int i = 1; i < was->stems->count; i++) strs_push(stems, was->stems->items[i]);
	Entry *en = grab(sizeof *en);
	en->stems = stems;
	omap_set(entries_of(e, t.holder), dup_(slot), en);
	for (size_t i = 0; i < ids.count; i++) {
		Layout *r = layout_get(e, ids.items[i].id);
		if (r && r->home && strcmp(r->home->holder, u->holder) == 0 && strcmp(r->home->name, u->slot) == 0)
			r->home = new_home(t.holder, slot, (int)i);
	}
}

static void landed_(E *e, const char *path, const char *id) {
	omap_set(e->landed, dup_(path), (void *)dup_(id));
}

// an entry moved: its node placed where its new place says, the layout as the disk now is
static void move_body(E *e, const Move *mv, Omap *reorder) {
	const char *const *lead = mv->has_file ? mv->file : mv->folder;
	bool is_file = mv->has_file;
	Layout *r = layout_get(e, mv->id);
	if (!r || !r->home || r->away) throw_(e, "moved a node that is not shown");
	const char *h = r->home->holder, *s = r->home->name;
	int near = r->home->position;
	Target t;
	if (!target(e, parent(lead[1]), &t)) throw_(e, "moved into a folder that is no node's");
	const char *from = parent(lead[0]);
	bool stay = strcmp(from, parent(lead[1])) == 0;
	Entry *old = entry_of(layout_get(e, h), s);
	bool old_union = old && old->stems;
	if (stay && old_union && t.slot && strcmp(t.slot, s) == 0 && strcmp(t.holder, h) == 0) {
		// within a union's folder: its members placed again by number
		const char *key = fmt("%s\xff%s", h, s);
		Reorder *g = omap_get(reorder, key);
		if (!g) {
			g = grab(sizeof *g);
			*g = (Reorder){h, s, parent(lead[1]), omap_new()};
			omap_set(reorder, key, g);
		}
		omap_set(g->moved, dup_(mv->id), (void *)dup_(base(lead[1])));
		if (mv->has_file && mv->has_folder) omap_set(g->moved, dup_(mv->id), (void *)dup_(base(mv->file[1])));
		return;
	}
	const char *slot = t.slot ? t.slot : renamed(e, mv->id, base(lead[1]), !is_file);
	long at = 0;
	if (t.slot) at = spot(e, t, slot, base(lead[1])).at;
	if (strcmp(t.holder, h) != 0 || strcmp(slot, s) != 0)
		move_(e, h, s, position_of(e, h, s, mv->id, near), t.holder, slot, t.slot != NULL, at);
	if (stay && !old_union && !t.slot) {
		// within one folder: the entries where the person put them, the store renames the rest
		if (mv->has_file) r->file = dup_(base(mv->file[1]));
		bool folded = mv->has_folder && strcmp(parent(mv->folder[1]), from) == 0;
		if (strcmp(slot, s) == 0) {
			if (folded) omap_set(entries_of(e, h), dup_(s), entry_str(base(mv->folder[1])));
		} else {
			// its home is the slot it moved to, so a mount in a slot sorting first does not take it; the other half, and a
			// file whose name its slot's would not give, are renamed here to its stem, so the layout is as the disk now is
			const Node *node = kept_node(e, mv->id);
			names_split_result sp = split_of(e, slot, node);
			own(sp.stem), own(sp.ext);
			const char *ext = sp.ext;
			const char *room = room_of(e, mv->id);
			const char *where = folded ? mv->folder[1] : r->folder ? layout_dir(e->layout, mv->id) : NULL;
			const char *stem;
			if (folded) stem = base(mv->folder[1]);
			else {
				stem = stem_at(e, mv->id);
				if (!stem) stem = slot;
			}
			if (mv->has_file) {
				// the file decides
				const char *want = own(names_write(sp.stem, e->pass, e->passes));
				const char *wanted = fmt("%s.%s", want, ext);
				const char *put = r->file && strcmp(r->file, wanted) == 0 ? mv->file[1] : follow(e, mv->file[1], join(from, wanted));
				if (put) {
					r->file = dup_(base(put));
					landed_(e, put, mv->id);
					stem = stem_of(base(put));
				} else stem = stem_of(r->file);
				if (where && strcmp(base(where), stem) != 0) {
					const char *moved = follow(e, where, join(from, stem));
					if (moved) landed_(e, moved, mv->id);
					stem = moved ? base(moved) : base(where);
				}
			} else if (folded && r->file && room) {
				const char *wanted = fmt("%s.%s", stem, ext);
				const char *put = strcmp(r->file, wanted) == 0 ? join(room, r->file) : follow(e, join(room, r->file), join(from, wanted));
				if (put) {
					r->file = dup_(base(put));
					landed_(e, put, mv->id);
				}
			}
			Layout *hr = layout_get(e, h);
			if (hr && hr->entries && !slot_of(e, h, s).count) omap_delete(hr->entries, s);
			home(e, mv->id, t, slot, stem);
		}
		if (mv->has_file) landed_(e, mv->file[1], mv->id);
		if (mv->has_folder) landed_(e, mv->folder[1], mv->id);
		return;
	}
	// across folders: the other half brought beside the one that decides
	const char *to = parent(lead[1]);
	const char *stem = is_file ? stem_of(base(lead[1])) : base(lead[1]);
	if (is_file && r->folder) {
		const char *where = mv->has_folder ? mv->folder[1] : layout_dir(e->layout, mv->id);
		if (where) {
			const char *put = strcmp(parent(where), to) == 0 ? where : follow(e, where, join(to, stem));
			if (put) {
				stem = base(put);
				landed_(e, put, mv->id);
			}
		}
	} else if (!is_file && r->file) {
		const char *room = room_of(e, mv->id);
		const char *where = mv->has_file ? mv->file[1] : room ? join(room, r->file) : NULL;
		if (where) {
			const char *put = strcmp(parent(where), to) == 0 ? where : follow(e, where, join(to, base(where)));
			if (put) {
				r->file = dup_(base(put));
				landed_(e, put, mv->id);
			}
		}
	}
	if (is_file) r->file = dup_(base(lead[1]));
	landed_(e, lead[1], mv->id);
	Layout *hr = layout_get(e, h);
	Entry *he = entry_of(hr, s);
	if (hr && hr->entries && !slot_of(e, h, s).count) omap_delete(hr->entries, s);
	else if (he && he->stems) restem(e, h, s, NULL, NULL);
	home(e, mv->id, t, slot, stem);
}

// a union's members renamed in its folder: placed by their numbers, then names
static void reorder_body(E *e, const Reorder *g) {
	Slots all = slot_of(e, g->holder, g->slot);
	Entry *en = entry_of(layout_get(e, g->holder), g->slot);
	Omap *named = omap_new();
	for (size_t i = 0; i < all.count; i++) {
		Layout *r = layout_get(e, all.items[i].id);
		bool mine = r && r->home && strcmp(r->home->holder, g->holder) == 0 && strcmp(r->home->name, g->slot) == 0;
		const char *name = omap_get(g->moved, all.items[i].id);
		if (!name) {
			if (mine) {
				name = r->file;
				if (!name) name = member_stem(en, r->home->position);
			}
			if (!name) name = "";
		}
		omap_set(named, all.items[i].id, (void *)name);
	}
	size_t n = all.count;
	const char **order = grab((n + 1) * sizeof *order);
	for (size_t i = 0; i < n; i++) order[i] = all.items[i].id;
	// a stable insertion sort by number, then name
	for (size_t i = 1; i < n; i++) {
		const char *id = order[i];
		size_t j = i;
		for (; j > 0; j--) {
			const char *na = omap_get(named, order[j - 1]), *nb = omap_get(named, id);
			double x, y;
			char *wx = NULL, *wy = NULL;
			bool hx = names_number(stem_of(na), &x, &wx), hy = names_number(stem_of(nb), &y, &wy);
			free(wx), free(wy);
			int c;
			if (hx && hy && x != y) c = x < y ? -1 : 1;
			else if (hx != hy) c = hx ? -1 : 1;
			else c = names_bycodepoint(na, nb);
			if (c <= 0) break;
			order[j] = order[j - 1];
		}
		order[j] = id;
	}
	const char **now = grab((n + 1) * sizeof *now);
	for (size_t i = 0; i < n; i++) now[i] = all.items[i].id;
	for (size_t i = 0; i < n; i++) {
		size_t j = 0;
		while (strcmp(now[j], order[i]) != 0) j++;
		if (j == i) continue;
		move_(e, g->holder, g->slot, (long)j, g->holder, g->slot, true, (long)i);
		const char *x = now[j];
		if (j < i) memmove(now + j, now + j + 1, (i - j) * sizeof *now);
		else memmove(now + i + 1, now + i, (j - i) * sizeof *now);
		now[i] = x;
	}
	Strs *stems = strs_new();
	strs_push(stems, en->stems->items[0]);
	for (size_t i = 0; i < n; i++) {
		Layout *r = layout_get(e, order[i]);
		const char *name = omap_get(named, order[i]);
		bool moved = omap_has(g->moved, order[i]);
		if (r && r->home && strcmp(r->home->holder, g->holder) == 0 && strcmp(r->home->name, g->slot) == 0) {
			const char *old = member_stem(en, r->home->position);
			strs_push(stems, moved ? stem_of(name) : old ? old : "");
			if (moved && r->file) r->file = dup_(name);
			r->home = new_home(g->holder, g->slot, (int)i);
		} else strs_push(stems, fmt("%zu", i + 1));
	}
	Entry *ne = grab(sizeof *ne);
	ne->stems = stems;
	omap_set(entries_of(e, g->holder), dup_(g->slot), ne);
}

// a link moved: the id moved to the slot the link's new name gives; the store lays it again
static void link_body(E *e, const LinkMove *l) {
	Target t;
	if (!target(e, parent(l->to), &t)) throw_(e, "moved into a folder that is no node's");
	const char *h = l->was->home->holder, *s = l->was->home->name;
	int near = l->was->home->position;
	names_split_result sp = split_of(e, s, kept_node(e, l->id));
	own(sp.stem), own(sp.ext);
	const char *slot = t.slot;
	if (!slot) {
		if (l->was->half && strcmp(l->was->half, "folder") == 0) slot = own(names_renamed(base(l->to), sp.added ? NULL : sp.ext, true));
		else slot = own(names_renamed(base(l->to), sp.added ? sp.ext : NULL, false));
	}
	long at = t.slot ? spot(e, t, slot, base(l->to)).at : 0;
	if (strcmp(t.holder, h) != 0 || strcmp(slot, s) != 0)
		move_(e, h, s, position_of(e, h, s, l->id, near), t.holder, slot, t.slot != NULL, at);
	push_path(&e->clear, l->to);
}

// what the layout showed in a folder now gone is shown nowhere: a node still held elsewhere is laid again there
static void vanish(E *e, const char *folder) {
	EACH(e->want, c) {
		const char *p = c->key;
		const Laid *l = c->value;
		if (l->kind == LAID_LINK && !(l->half && strcmp(l->half, "pending") == 0)) {
			const char *to = resolve(e->folder, parent(p), l->target);
			if (to && (strcmp(to, folder) == 0 || under(to, folder))) push_path(&e->clear, p);
		}
		if (strcmp(p, folder) != 0 && !under(p, folder)) continue;
		Layout *r = l->kind == LAID_FILE || l->kind == LAID_FOLDER ? layout_get(e, l->id) : NULL;
		if (!r) continue;
		if (l->kind == LAID_FILE) r->file = NULL, r->laid = NULL;
		else r->folder = false;
	}
}

typedef struct {
	const char *file, *folder;
} Gone;

static void union_gone_body(E *e, const Laid *l, const char *path) {
	Slots n = slot_of(e, l->holder, l->name);
	if (n.count) remove_(e, l->holder, l->name, n.items[0].at, n.items[n.count - 1].at + 1);
	vanish(e, path);
}

static void node_gone_body(E *e, const char *id, const Gone *g) {
	Layout *r = layout_get(e, id);
	if (!r) throw_(e, "no layout for the node");
	if (strcmp(id, e->root) == 0) {
		// the root's file removed: its folder is the store's, always shown
		if (g->file) {
			write_nt(e, id, op_null(), 0);
			r->file = NULL, r->laid = NULL;
		}
		return;
	}
	bool folder_shown = r->folder;
	if (g->file && !g->folder && folder_shown) {
		write_nt(e, id, op_null(), 0);
		r->file = NULL, r->laid = NULL;
		return;
	}
	if (g->folder && !g->file && r->file) {
		Strs *names = strs_new();
		const char **slots;
		size_t nslots = fg_slots(fg_of(e->api), id, &slots);
		for (size_t i = 0; i < nslots; i++) strs_push(names, own(copyString(slots[i])));
		free((void *)slots);
		for (int i = 0; i < names->count; i++) {
			Slots sl = slot_of(e, id, names->items[i]);
			if (sl.count) remove_(e, id, names->items[i], sl.items[0].at, sl.items[sl.count - 1].at + 1);
		}
		vanish(e, g->folder);
		r->folder = false;
		r->entries = NULL;
		return;
	}
	if (!r->home) throw_(e, "the node is not shown");
	const char *h = r->home->holder, *s = r->home->name;
	long at = position_of(e, h, s, id, r->home->position);
	remove_(e, h, s, at, at + 1);
	// shown elsewhere still, it is laid again there
	if (g->file) vanish(e, g->file);
	if (g->folder) vanish(e, g->folder);
}

// what moved: an entry gone from one place and found at another, by its id or a union's slot
typedef struct {
	Omap *moves;
	Vec unions, links, sides;
} Matched;

// whether a new entry is one gone from elsewhere
static bool match(E *e, Matched *x, const fp_edit *m) {
	const st_entry *n = m->now;
	Taken tk;
	if (n->kind == ST_FOLDER && n->holder) {
		tk = taken(e, fmt("u\xff%s\xff%s", n->holder, n->name));
		if (tk.path) {
			*(UnionMove *)vpush(&x->unions, sizeof(UnionMove)) = (UnionMove){n->holder, n->name, tk.path, m->path};
			return true;
		}
	}
	if (!n->id) return false;
	const char *key = n->kind == ST_FILE ? fmt("f\xff%s", n->id) : n->kind == ST_FOLDER ? fmt("d\xff%s", n->id) : fmt("l\xff%s", n->id);
	tk = taken(e, key);
	if (!tk.path && n->kind == ST_FILE && n->hash) tk = taken(e, fmt("s\xff%s\xff%s", n->id, n->hash));
	if (!tk.path) return false;
	const Laid *l = tk.laid;
	if (l->kind == LAID_SIDE) *(SideMove *)vpush(&x->sides, sizeof(SideMove)) = (SideMove){tk.path, m->path};
	else if (l->kind == LAID_LINK) *(LinkMove *)vpush(&x->links, sizeof(LinkMove)) = (LinkMove){n->id, l, tk.path, m->path, n};
	else {
		Move *mv = omap_get(x->moves, n->id);
		if (!mv) {
			mv = grab(sizeof *mv);
			mv->id = n->id;
			omap_set(x->moves, n->id, mv);
		}
		if (l->kind == LAID_FILE) mv->has_file = true, mv->file[0] = tk.path, mv->file[1] = m->path;
		else mv->has_folder = true, mv->folder[0] = tk.path, mv->folder[1] = m->path;
	}
	return true;
}

// what is in a new folder, all the way down, may be an entry moved in from elsewhere in the store: a move into the new
// folder's node, not new
static void into(E *e, Matched *x, const fp_edit *list, size_t count, Omap *moved_in) {
	for (size_t i = 0; i < count; i++) {
		const fp_edit *m = &list[i];
		if (!m->now || m->was) continue;
		if (match(e, x, m)) omap_set(moved_in, m->path, YES);
		else into(e, x, m->inside, m->inside_length, moved_in);
	}
}

// the layout is set as the disk now is; what is left for the disk is Done's
static void edit_all(E *e, const fp_edit *differences, size_t count) {
	st_store *store = e->store;
	e->graph = st_graph(store);
	e->root = e->graph->root;
	e->layout = st_layout(store);
	e->folder = st_folder(store);
	e->pass = st_pass(store, &e->passes);
	if (!e->layout) throw_(e, "the layout is not there");
	e->want = layout_disk(e->graph, e->layout, e->pass, (int)e->passes);
	// each folder's laid entries, by name
	e->kids = omap_new();
	EACH(e->want, c) {
		const char *p = c->key;
		const char *dir = parent(p);
		Omap *m = omap_get(e->kids, dir);
		if (!m) omap_set(e->kids, dup_(dir), m = omap_new());
		omap_set(m, dup_(base(p)), c->value);
	}
	// new folders made in this pass: the node each is
	e->made = omap_new();
	e->madeby = omap_new();
	// where entries moved or were made in this pass: the node each is, for a link made to one
	e->landed = omap_new();
	// the nodes a folder back from the Trash shows again, as the graph kept them
	e->returned = omap_new();
	e->took = omap_new();

	// sorting the differences
	Vec changed = {0}, fresh = {0};
	e->gone = omap_new();
	for (size_t i = 0; i < count; i++) {
		const fp_edit *d = &differences[i];
		if (d->was && d->now) {
			const Laid *w = d->was;
			const st_entry *n = d->now;
			bool same = !n->id || (w->kind != LAID_UNION && w->id && strcmp(n->id, w->id) == 0);
			if (((w->kind == LAID_FILE || w->kind == LAID_SIDE) && n->kind == ST_FILE && same) ||
				(w->kind == LAID_LINK && n->kind == ST_LINK) ||
				(w->kind == LAID_LINK && w->half && strcmp(w->half, "file") == 0 && n->kind == ST_FILE && (!n->id || strcmp(n->id, w->id) == 0)) ||
				(w->kind == LAID_FILE && !w->home)) {
				*(Changed *)vpush(&changed, sizeof(Changed)) = (Changed){d->path, w, n};
				continue;
			}
			omap_set(e->gone, d->path, (void *)w);
			*(const fp_edit **)vpush(&fresh, sizeof(void *)) = d;
		} else if (d->was) omap_set(e->gone, d->path, (void *)d->was);
		else if (d->now) *(const fp_edit **)vpush(&fresh, sizeof(void *)) = d;
	}

	Matched x = {omap_new(), {0}, {0}, {0}};
	e->gone_by = omap_new();
	EACH(e->gone, c) {
		const char *key = key_of(c->value);
		if (!omap_has(e->gone_by, key)) omap_set(e->gone_by, key, (void *)c->key);
	}
	Vec rest = {0};
	for (size_t i = 0; i < fresh.count; i++) {
		const fp_edit *m = ((const fp_edit **)fresh.items)[i];
		if (!match(e, &x, m)) *(const fp_edit **)vpush(&rest, sizeof(void *)) = m;
	}
	Omap *moved_in = omap_new();
	for (size_t i = 0; i < rest.count; i++) {
		const fp_edit *m = ((const fp_edit **)rest.items)[i];
		into(e, &x, m->inside, m->inside_length, moved_in);
	}
	// a moved folder's own contents, found where it went, are its node's, not new
	Vec went = {0};
	EACH(x.moves, c) {
		const Move *mv = c->value;
		if (mv->has_folder) *(const char **)vpush(&went, sizeof(void *)) = mv->folder[1];
	}
	for (size_t i = 0; i < x.unions.count; i++) *(const char **)vpush(&went, sizeof(void *)) = ((UnionMove *)x.unions.items)[i].to;
	Vec news = {0};
	for (size_t i = 0; i < rest.count; i++) {
		const fp_edit *m = ((const fp_edit **)rest.items)[i];
		bool inside = false;
		for (size_t k = 0; k < went.count; k++)
			if (under(m->path, ((const char **)went.items)[k])) inside = true;
		if (!inside) *(const fp_edit **)vpush(&news, sizeof(void *)) = m;
	}

	// a node's value file edited
	for (size_t i = 0; i < changed.count; i++) {
		const Changed *c = &((Changed *)changed.items)[i];
		const char *path = c->path;
		const Laid *was = c->was;
		const st_entry *now = c->now;
		if (was->kind == LAID_LINK && now->kind == ST_LINK) {
			// a link pointed somewhere else: the id it led to unplaced, the one it leads to mounted
			UNIT_BEGIN(e, NULL, ((const char *[]){path}), 1)
				const char *to = linked(e, parent(path), now->target);
				if (!to) {
					list(e, path, "a link that leads nowhere in the store");
					break;
				}
				long at = position_of(e, was->home->holder, was->home->name, was->id, was->home->position);
				insert_over(e, was->home->holder, was->home->name, to, at, at + 1);
				push_path(&e->clear, path);
			UNIT_END(e)
		} else if (was->kind == LAID_LINK && now->kind == ST_FILE) {
			// a file saved through a link: a write to its node, as if made at its home
			UNIT_BEGIN(e, path, ((const char *[]){path}), 1)
				if (now->why) {
					list(e, path, "does not read: it does not read in its form");
					break;
				}
				Layout *lr = layout_get(e, was->id);
				const char *laid = lr && lr->laid ? lr->laid : NULL;
				if (!laid) {
					const Node *kn = kept_node(e, was->id);
					laid = kn ? kn->hash : NULL;
				}
				Met r = meet(e, was->id, laid ? laid : "", path, now, true);
				if (r != M_TRASHED) {
					push_path(&e->clear, path);
					push_path(&e->mend, path);
				}
			UNIT_END(e)
		} else if (was->kind == LAID_SIDE && now->kind == ST_FILE) {
			// sides are writable: an edit to a side's file writes that version
			UNIT_BEGIN(e, path, ((const char *[]){path}), 1)
				if (now->why) {
					list(e, path, "does not read: it does not read in its form");
					break;
				}
				const char *h = hash_of(was->side == 0 ? value_of(e, was->id) : NULL);
				if (same_text(h, now->hash)) break;
				if (!same_text(h, was->hash)) {
					push_listed(&e->trash, path, "an edit to a side whose version changed since it was laid");
					push_path(&e->mend, path);
					break;
				}
				write_json(e, was->id, now->value, (size_t)was->side);
			UNIT_END(e)
		} else if (was->kind == LAID_FILE && now->kind == ST_FILE) {
			UNIT_BEGIN(e, path, ((const char *[]){path}), 1)
				if (now->why) {
					list(e, path, "does not read: it does not read in its form");
					break;
				}
				Met r = meet(e, was->id, was->hash, path, now, false);
				if (r == M_SAME || r == M_WRITTEN) rec(e, was->id)->laid = dup_(now->hash);
				// a new form is a new file, which the store makes; the person's, taken in, goes
				if (r == M_WRITTEN && !same_text(now->form, was->form)) push_path(&e->clear, path);
				if (!now->id) *(fp_mark *)vpush(&e->marks, sizeof(fp_mark)) = (fp_mark){path, dup_(was->id)};
			UNIT_END(e)
		} else if (was->kind == LAID_FILE) {
			// the root's file replaced by something else
			omap_set(e->gone, path, (void *)was);
			fp_edit *made = grab(sizeof *made);
			*made = (fp_edit){path, NULL, now, false, NULL, 0};
			*(const fp_edit **)vpush(&news, sizeof(void *)) = made;
		}
	}

	// the new entries, a new folder's contents included but for what moved into it: shallowest first, so a new folder's
	// node is there for what is in it; in one folder, folders first, so a file beside one with its stem is its node's,
	// and links last, so what they lead to is there
	Vec all = {0}, queue = {0};
	for (size_t i = 0; i < news.count; i++) *(const fp_edit **)vpush(&queue, sizeof(void *)) = ((const fp_edit **)news.items)[i];
	for (size_t q = 0; q < queue.count; q++) {
		const fp_edit *m = ((const fp_edit **)queue.items)[q];
		*(const fp_edit **)vpush(&all, sizeof(void *)) = m;
		for (size_t k = 0; k < m->inside_length; k++) {
			const fp_edit *i = &m->inside[k];
			if (i->now && !i->was && !omap_has(moved_in, i->path)) *(const fp_edit **)vpush(&queue, sizeof(void *)) = i;
		}
	}
	stable(all.items, all.count, sizeof(void *), cmp_made);
	// new folders, which a move into one takes in first
	e->waiting = omap_new();
	for (size_t i = 0; i < all.count; i++) {
		const fp_edit *m = ((const fp_edit **)all.items)[i];
		if (m->now->kind == ST_FOLDER) omap_set(e->waiting, m->path, (void *)m);
	}

	// unions renamed or moved: each id moved to the slot its new name gives, the layout rekeyed
	for (size_t i = 0; i < x.unions.count; i++) {
		const UnionMove *u = &((UnionMove *)x.unions.items)[i];
		UNIT_BEGIN(e, u->to, ((const char *[]){u->from}), 1)
			union_body(e, u);
		UNIT_END(e)
	}

	// moves, shallowest first
	size_t nmoves = 0;
	const Move **mvs = grab((x.moves->size + 1) * sizeof *mvs);
	EACH(x.moves, c) mvs[nmoves++] = c->value;
	stable(mvs, nmoves, sizeof *mvs, cmp_move);
	Omap *reorder = omap_new();
	for (size_t i = 0; i < nmoves; i++) {
		const Move *mv = mvs[i];
		const char *const *lead = mv->has_file ? mv->file : mv->folder;
		UNIT_BEGIN(e, lead[1], ((const char *[]){lead[0]}), 1)
			move_body(e, mv, reorder);
		UNIT_END(e)
	}
	EACH(reorder, c) {
		const Reorder *g = c->value;
		UNIT_BEGIN(e, NULL, NULL, 0)
			reorder_body(e, g);
		UNIT_END(e)
	}

	// links moved: the id moved to the slot the link's new name gives; the store lays it again
	for (size_t i = 0; i < x.links.count; i++) {
		const LinkMove *l = &((LinkMove *)x.links.items)[i];
		UNIT_BEGIN(e, NULL, ((const char *[]){l->from}), 1)
			link_body(e, l);
		UNIT_END(e)
	}

	// a side renamed: laid again, and listed
	for (size_t i = 0; i < x.sides.count; i++) {
		const SideMove *sd = &((SideMove *)x.sides.items)[i];
		push_listed(&e->trash, sd->to, "a side renamed: the store lays it again");
		push_path(&e->mend, sd->from);
	}

	// new entries
	for (size_t i = 0; i < all.count; i++) take(e, ((const fp_edit **)all.items)[i]);

	// removals
	size_t ngone = 0;
	const OmapEntry **gs = grab((e->gone->size + 1) * sizeof *gs);
	EACH(e->gone, c) gs[ngone++] = c;
	stable(gs, ngone, sizeof *gs, cmp_path_depth);
	Omap *nodes = omap_new(), *seen = omap_new();
	for (size_t i = 0; i < ngone; i++) {
		const char *path = gs[i]->key;
		const Laid *l = gs[i]->value;
		if (l->kind == LAID_FILE || l->kind == LAID_FOLDER) {
			Gone *g = omap_get(nodes, l->id);
			if (!g) {
				g = grab(sizeof *g);
				omap_set(nodes, l->id, g);
			}
			if (l->kind == LAID_FILE) g->file = path;
			else g->folder = path;
		} else if (l->kind == LAID_UNION) {
			UNIT_BEGIN(e, NULL, ((const char *[]){path}), 1)
				union_gone_body(e, l, path);
			UNIT_END(e)
		} else if (l->kind == LAID_LINK) {
			const char *key = fmt("%s\xff%s\xff%s", l->home->holder, l->home->name, l->id);
			if (omap_has(seen, key)) continue;
			omap_set(seen, key, YES);
			UNIT_BEGIN(e, NULL, ((const char *[]){path}), 1)
				long at = position_of(e, l->home->holder, l->home->name, l->id, l->home->position);
				remove_(e, l->home->holder, l->home->name, at, at + 1);
			UNIT_END(e)
		} else if (l->kind == LAID_SIDE) {
			push_path(&e->mend, path);
			list(e, path, "a side removed: the store lays it again");
		}
	}
	EACH(nodes, c) {
		const Gone *g = c->value;
		const char *paths[2];
		size_t np = 0;
		if (g->file) paths[np++] = g->file;
		if (g->folder) paths[np++] = g->folder;
		UNIT_BEGIN(e, NULL, paths, np)
			node_gone_body(e, c->key, g);
		UNIT_END(e)
	}

	// links the layout now shows that it did not, or to elsewhere: to a half back, a new folder beside a file, a folder renamed
	Omap *now_disk = layout_disk(e->graph, e->layout, e->pass, (int)e->passes);
	EACH(now_disk, c) {
		const Laid *l = c->value;
		const Laid *w = omap_get(e->want, c->key);
		if (l->kind == LAID_LINK && (!w || w->kind != LAID_LINK || !same_text(w->target, l->target))) push_path(&e->mend, c->key);
	}

	// listed
	size_t items = e->trash.count + e->listed.count;
	if (items) {
		op_value *l = op_list();
		for (size_t i = 0; i < e->trash.count + e->listed.count; i++) {
			const fp_listed *it = i < e->trash.count ? &((fp_listed *)e->trash.items)[i] : &((fp_listed *)e->listed.items)[i - e->trash.count];
			op_value *m = op_map();
			op_set(m, "path", op_str(it->path));
			op_set(m, "why", op_str(it->why));
			op_push(l, m);
		}
		const op_value *had_value = fg_value(fg_of(e->api), e->listing);
		size_t had = had_value && had_value->type == OP_LIST ? had_value->count : 0;
		op_patch p = {0};
		p.place.has_range = 1;
		p.place.from = (long)had, p.place.to = (long)had;
		p.has_value = 1;
		p.value = l;
		// listed is the program's own: nothing stops it but the program going
		fg_write(e->api, e->listing, &p, 1, 0);
		op_free(l);
	}
}

// the program ----------------------------------------------------------------------------------------------------------------

struct fp {
	st_store *store;
	fg *graph;
	fp_watch watch;
	fg_api *host;
	char *listed;
	bool started;
	const fp_edit *in;
	size_t in_length;
	fp_done out;
	bool has_out;
	char message[512];
};

// each store watched, and the program watching it
typedef struct {
	st_store *store;
	fp *program;
} Watched;
static Watched *watched;
static size_t watched_count;
static Watched *watching(st_store *store) {
	for (size_t i = 0; i < watched_count; i++)
		if (watched[i].store == store) return &watched[i];
	return NULL;
}
static void unwatch(st_store *store) {
	for (size_t i = 0; i < watched_count; i++)
		if (watched[i].store == store) {
			watched[i] = watched[--watched_count];
			return;
		}
}

fp *fp_new(st_store *store, fg *graph, fp_watch watch) {
	fp *p = calloc(1, sizeof *p);
	if (!p) abort();
	p->store = store;
	p->graph = graph;
	p->watch = watch;
	return p;
}

void fp_set_watch(fp *p, fp_watch watch) {
	p->watch = watch;
}

const char *fp_start(fp *p) {
	if (p->started) return NULL;
	if (watching(p->store)) {
		snprintf(p->message, sizeof p->message, "the store %s is already watched", st_folder(p->store));
		return p->message;
	}
	p->host = fg_actor(p->graph, NULL);
	op_value *empty = op_list();
	const char *e = fg_create(p->host, empty, true, &p->listed);
	op_free(empty);
	if (e) {
		snprintf(p->message, sizeof p->message, "%s", e);
		return p->message;
	}
	watched = realloc(watched, (watched_count + 1) * sizeof *watched);
	if (!watched) abort();
	watched[watched_count++] = (Watched){p->store, p};
	p->started = true;
	if (p->watch.start) p->watch.start(p->watch.context);
	return NULL;
}

void fp_stop(fp *p) {
	if (!p->started) return;
	p->started = false;
	if (p->watch.stop) p->watch.stop(p->watch.context);
	Watched *w = watching(p->store);
	if (w && w->program == p) unwatch(p->store);
}

void fp_free(fp *p) {
	if (!p) return;
	fp_stop(p);
	free(p->listed);
	free(p);
}

const char *fp_listing(const fp *p) {
	return p->listed;
}

// takes the differences in as changes, as the actor: each on its own, a refused one listed, its entry sent to the Trash
// and laid out again there
const fp_done *fp_edit_in(fp *p, const fp_edit *edits, size_t count, const char *actor) {
	p->has_out = false;
	if (!p->started) {
		snprintf(p->message, sizeof p->message, "the program is not running");
		return NULL;
	}
	E *e = grab(sizeof *e);
	e->store = p->store;
	e->api = fg_actor(p->graph, actor);
	e->listing = p->listed;
	Unit top = {.prev = NULL};
	e->unit = &top;
	if (setjmp(top.jump) == 0) {
		edit_all(e, edits, count);
		fp_done *d = &p->out;
		*d = (fp_done){0};
		d->marks = e->marks.items, d->marks_length = e->marks.count;
		d->slots = e->slots.items, d->slots_length = e->slots.count;
		d->unside = e->unside.items, d->unside_length = e->unside.count;
		d->clear = e->clear.items, d->clear_length = e->clear.count;
		d->trash = e->trash.items, d->trash_length = e->trash.count;
		d->mend = e->mend.items, d->mend_length = e->mend.count;
		d->listed = e->listed.items, d->listed_length = e->listed.count;
		p->has_out = true;
		p->message[0] = 0;
		return d;
	}
	snprintf(p->message, sizeof p->message, "%s", e->error);
	return NULL;
}

const char *fp_message(const fp *p) {
	return p->message;
}
