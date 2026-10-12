// Finding items by path, writing by path, and placing ids in lists (places.ts), in C. See places.h.
#include "places.h"

#include <string.h>

typedef struct {
	pl_item *v;
	size_t n, cap;
} vec;

static void *mem(const pl_places *p, size_t n) { return p->alloc(p->ctx, n ? n : 1); }

const char *pl_code_name(int code) {
	switch (code) {
	case PL_WRONG_FIELD: return "wrong-field";
	case PL_ABOVE_ROOT: return "above-root";
	case PL_NOTHING_THERE: return "nothing-there";
	case PL_ALREADY_THERE: return "already-there";
	case PL_RANGE: return "range";
	case PL_NO_BY: return "no-by";
	case PL_MUTATE: return "mutate";
	}
	return "";
}

const char pl_id[] = "id";

// never a name: ".", "..", or anything with a "/"; nor the id marker
static int never(const char *s) {
	return s == pl_id || !strcmp(s, ".") || !strcmp(s, "..") || strchr(s, '/') != NULL;
}

// the id of an address that is one (pl_id), else NULL
static const char *by_id(const char *const *address, size_t naddress) {
	return naddress == 2 && address[0] == pl_id ? address[1] : NULL;
}

static long find(const nd_node *n, const char *name) {
	for (size_t i = 0; i < n->children_length; i++)
		if (!strcmp(n->children[i].name, name)) return (long)i;
	return -1;
}

// the first version's list of name, or NULL
static const nd_list *list(const nd_node *n, const char *name) {
	long e = find(n, name);
	if (e < 0 || n->children[e].object.length == 0) return NULL;
	return n->children[e].object.versions[0].content;
}

static size_t size(const nd_node *n, const char *name) {
	const nd_list *l = list(n, name);
	return l ? l->length : 0;
}

static void say(const pl_depend *d, const char *id, pl_kind kind, const char *name) {
	if (d && d->fn) d->fn(d->ctx, id, (pl_part){kind, name});
}

// the names an address reaches, from the place, and how many are the address's own
typedef struct {
	const char **names;
	size_t n, own, base;
} resolved;

static int resolve(const pl_places *p, const pl_spot *at, const char *const *address,
	size_t naddress, resolved *r) {
	for (size_t i = 0; i < at->nnames; i++)
		if (never(at->names[i])) return PL_WRONG_FIELD;
	size_t i = 0;
	r->names = mem(p, (at->nnames + naddress) * sizeof *r->names);
	r->n = 0;
	if (naddress > 0 && !strcmp(address[0], "/")) i = 1;
	else
		for (; r->n < at->nnames; r->n++) r->names[r->n] = at->names[r->n];
	for (; i < naddress && !strcmp(address[i], ".."); i++) {
		if (r->n == 0) return PL_ABOVE_ROOT;
		r->n--;
	}
	r->own = naddress - i;
	r->base = r->n;
	for (; i < naddress; i++) {
		if (never(address[i])) return PL_WRONG_FIELD;
		r->names[r->n++] = address[i];
	}
	return PL_OK;
}

// down the names from the node of id start (the root, or a trail's); taken: the nodes gone
// through, start first. has_last: the last name's list and the node it was in, none if the walk
// stopped before it. pick: take the last list's first loaded (look does not)
typedef struct {
	const nd_node **taken;
	size_t ntaken;
	pl_step *steps;
	size_t nsteps;
	int has_last;
	const char *lnode, *lname;
	const nd_list *lids;
} walked;

static walked walk(const pl_places *p, const char *const *names, size_t n, const pl_depend *d,
	const char *start, size_t from, int pick) {
	walked w = {0};
	w.taken = mem(p, (n + 1) * sizeof *w.taken);
	w.steps = mem(p, (n + 1) * sizeof *w.steps);
	say(d, start, PL_LOADED, NULL);
	const nd_node *at = p->get(p->ctx, start);
	if (at == NULL) return w;
	w.taken[w.ntaken++] = at;
	for (size_t k = from; k < n; k++) {
		const char *name = names[k];
		// past the first name, said when the id was asked for it
		if (k == from) say(d, at->id, PL_CHILDREN, name);
		const nd_list *ids = list(at, name);
		if (ids == NULL) return w;
		if (k == n - 1) {
			if (pick) {
				for (size_t j = 0; j < ids->length; j++) {
					const char *id = ids->items[j].id;
					if (id == NULL) continue;
					say(d, id, PL_LOADED, NULL);
					const nd_node *c = p->get(p->ctx, id);
					if (c == NULL) continue;
					w.taken[w.ntaken++] = c;
					w.steps[w.nsteps++] = (pl_step){at->id, name, id, j};
					break;
				}
			}
			w.has_last = 1;
			w.lnode = at->id, w.lname = name, w.lids = ids;
			return w;
		}
		const char *next = names[k + 1];
		const nd_node *found = NULL;
		for (size_t j = 0; j < ids->length; j++) {
			const char *id = ids->items[j].id;
			if (id == NULL) continue;
			say(d, id, PL_LOADED, NULL);
			const nd_node *c = p->get(p->ctx, id);
			if (c == NULL) continue;
			say(d, id, PL_CHILDREN, next);
			if (list(c, next) == NULL) continue;
			found = c;
			w.steps[w.nsteps++] = (pl_step){at->id, name, id, j};
			break;
		}
		if (found == NULL) return w;
		w.taken[w.ntaken++] = found;
		at = found;
	}
	return w;
}

static pl_item *push(const pl_places *p, vec *o) {
	if (o->n == o->cap) {
		size_t cap = o->cap ? o->cap * 2 : 8;
		pl_item *v = mem(p, cap * sizeof *v);
		if (o->n) memcpy(v, o->v, o->n * sizeof *v);
		o->v = v, o->cap = cap;
	}
	pl_item *it = &o->v[o->n++];
	memset(it, 0, sizeof *it);
	return it;
}

// an item per id in the list, in order; route then the step to it
static void items_into(const pl_places *p, vec *o, const char *node, const char *name,
	const nd_list *ids, const pl_step *route, size_t nroute, const pl_depend *d, int has_up,
	long up) {
	for (size_t j = 0; j < ids->length; j++) {
		const char *id = ids->items[j].id;
		if (id == NULL) continue;
		say(d, id, PL_LOADED, NULL);
		pl_item *it = push(p, o);
		it->id = id;
		pl_step *r = mem(p, (nroute + 1) * sizeof *r);
		if (nroute) memcpy(r, route, nroute * sizeof *r);
		r[nroute] = (pl_step){node, name, id, j};
		it->route = r, it->nroute = nroute + 1;
		it->node = p->get(p->ctx, id);
		if (has_up) it->has_up = 1, it->up = up;
	}
}

static const pl_depend *dep(const pl_places *p, const pl_depend *d) {
	return d ? d : p->fallback;
}

static int look_into(const pl_places *p, const pl_spot *at, const char *const *address,
	size_t naddress, const pl_depend *d, vec *o) {
	const char *id = by_id(address, naddress);
	if (id) {
		say(d, id, PL_LOADED, NULL);
		pl_item *it = push(p, o);
		it->id = id;
		it->node = p->get(p->ctx, id);
		return PL_OK;
	}
	resolved r;
	int code = resolve(p, at, address, naddress, &r);
	if (code) return code;
	if (r.n == 0) {
		say(d, p->root, PL_LOADED, NULL);
		pl_item *it = push(p, o);
		it->id = p->root;
		it->node = p->get(p->ctx, p->root);
		return PL_OK;
	}
	// with a trail: from the node the last kept name reached, or its parent for none of the
	// address's own; a step it did not take reaches nothing
	size_t from = r.own > 0 ? r.base : r.base - 1;
	if (at->has_trail && from >= at->ntrail) return PL_OK;
	walked w = at->has_trail ? walk(p, r.names, r.n, d, at->trail[from], from, 0)
	                         : walk(p, r.names, r.n, d, p->root, 0, 0);
	if (!w.has_last) return PL_OK;
	// the steps down to the last list, the address's own names only
	size_t walked_n = r.n - (at->has_trail ? from : 0);
	const pl_step *route = NULL;
	size_t nroute = 0;
	if (r.own > 1) route = w.steps + (walked_n - r.own), nroute = r.own - 1;
	items_into(p, o, w.lnode, w.lname, w.lids, route, nroute, d, 0, 0);
	return PL_OK;
}

static int look_out(const pl_places *p, const pl_spot *at, const char *const *address,
	size_t naddress, const pl_depend *d, vec *o) {
	return look_into(p, at, address, naddress, dep(p, d), o);
}

int pl_look(const pl_places *p, const pl_spot *at, const char *const *address, size_t naddress,
	const pl_depend *depend, pl_items *out) {
	vec o = {0};
	int code = look_out(p, at, address, naddress, depend, &o);
	out->items = o.v, out->n = o.n;
	return code;
}

// a trail's nodes, up to the first not loaded
static size_t along(const pl_places *p, const pl_spot *at, const pl_depend *d, const nd_node **out) {
	size_t n = 0;
	for (size_t i = 0; i < at->ntrail; i++) {
		say(d, at->trail[i], PL_LOADED, NULL);
		const nd_node *c = p->get(p->ctx, at->trail[i]);
		if (c == NULL) break;
		out[n++] = c;
	}
	return n;
}

// from n, already said loaded, down path to its last list: an id taken only if it has the next
// name, as a walk takes it; 0 if the path is not there
typedef struct {
	pl_step *steps;
	size_t nsteps;
	const char *node, *name;
	const nd_list *ids;
} downed;

static int down(const pl_places *p, const nd_node *n, const char *const *path, size_t npath,
	const pl_depend *d, downed *o) {
	o->steps = mem(p, npath * sizeof *o->steps);
	o->nsteps = 0;
	const nd_node *at = n;
	for (size_t k = 0; k + 1 < npath; k++) {
		const char *name = path[k], *next = path[k + 1];
		if (k == 0) say(d, at->id, PL_CHILDREN, name);
		const nd_list *ids = list(at, name);
		if (ids == NULL) return 0;
		const nd_node *found = NULL;
		for (size_t j = 0; j < ids->length; j++) {
			const char *id = ids->items[j].id;
			if (id == NULL) continue;
			say(d, id, PL_LOADED, NULL);
			const nd_node *c = p->get(p->ctx, id);
			if (c == NULL) continue;
			say(d, id, PL_CHILDREN, next);
			if (list(c, next) == NULL) continue;
			found = c;
			o->steps[o->nsteps++] = (pl_step){at->id, name, id, j};
			break;
		}
		if (found == NULL) return 0;
		at = found;
	}
	const char *name = path[npath - 1];
	if (npath == 1) say(d, at->id, PL_CHILDREN, name);
	const nd_list *ids = list(at, name);
	if (ids == NULL) return 0;
	o->node = at->id, o->name = name, o->ids = ids;
	return 1;
}

static int search(const pl_places *p, const pl_spot *at, const char *const *path, size_t npath,
	int all, const pl_depend *d, pl_items *out) {
	vec o = {0};
	out->items = NULL, out->n = 0;
	for (size_t i = 0; i < npath; i++)
		if (never(path[i])) return PL_WRONG_FIELD;
	if (npath == 0) return PL_OK;
	resolved r;
	int code = resolve(p, at, NULL, 0, &r);
	if (code) return code;
	const nd_node **taken;
	size_t ntaken;
	if (at->has_trail) {
		taken = mem(p, (at->ntrail + 1) * sizeof *taken);
		ntaken = along(p, at, d, taken);
	} else {
		walked w = walk(p, r.names, r.n, d, p->root, 0, 1);
		taken = w.taken, ntaken = w.ntaken;
	}
	for (size_t i = ntaken; i-- > 0;) {
		downed dn;
		if (!down(p, taken[i], path, npath, d, &dn)) continue;
		size_t start = o.n;
		items_into(p, &o, dn.node, dn.name, dn.ids, dn.steps, dn.nsteps, d, 1,
			(long)(ntaken - 1 - i));
		int loaded = 0;
		for (size_t j = start; j < o.n; j++) loaded |= o.v[j].node != NULL;
		if (!loaded) {
			o.n = start;
			continue;
		}
		if (!all) break;
	}
	out->items = o.v, out->n = o.n;
	return PL_OK;
}

int pl_lookup(const pl_places *p, const pl_spot *at, const char *const *path, size_t npath,
	const pl_depend *depend, pl_items *out) {
	return search(p, at, path, npath, 0, dep(p, depend), out);
}
int pl_lookups(const pl_places *p, const pl_spot *at, const char *const *path, size_t npath,
	const pl_depend *depend, pl_items *out) {
	return search(p, at, path, npath, 1, dep(p, depend), out);
}

int pl_children(const pl_places *p, const pl_spot *at, const char *const *address,
	size_t naddress, const char *name, const pl_depend *depend, pl_items *out) {
	const pl_depend *d = dep(p, depend);
	out->items = NULL, out->n = 0;
	if (never(name)) return PL_WRONG_FIELD;
	vec looked = {0}, o = {0};
	int code = look_into(p, at, address, naddress, d, &looked);
	if (code) return code;
	for (size_t i = 0; i < looked.n; i++) {
		const pl_item *it = &looked.v[i];
		if (it->node == NULL) continue;
		say(d, it->id, PL_CHILDREN, name);
		const nd_list *ids = list(it->node, name);
		if (ids) items_into(p, &o, it->id, name, ids, it->route, it->nroute, d, 0, 0);
	}
	out->items = o.v, out->n = o.n;
	return PL_OK;
}

int pl_names_of(const pl_places *p, const pl_spot *at, const char *const *address,
	size_t naddress, const char *part, const pl_depend *depend, pl_namelist *out) {
	const pl_depend *d = dep(p, depend);
	out->names = NULL, out->n = 0;
	int info = part && !strcmp(part, "info");
	if (!info && !(part && !strcmp(part, "children"))) return PL_WRONG_FIELD;
	vec looked = {0};
	int code = look_into(p, at, address, naddress, d, &looked);
	if (code) return code;
	size_t total = 0;
	for (size_t i = 0; i < looked.n; i++)
		if (looked.v[i].node)
			total += info ? looked.v[i].node->info_length : looked.v[i].node->children_length;
	const char **names = mem(p, total * sizeof *names);
	size_t n = 0;
	for (size_t i = 0; i < looked.n; i++) {
		const nd_node *node = looked.v[i].node;
		if (node == NULL) continue;
		say(d, looked.v[i].id, info ? PL_INFO : PL_CHILDREN, NULL);
		const nd_entry *es = info ? node->info : node->children;
		size_t len = info ? node->info_length : node->children_length;
		for (size_t k = 0; k < len; k++) {
			const char *name = es[k].name;
			size_t j = 0;
			while (j < n && strcmp(names[j], name) != 0) j++;
			if (j == n) names[n++] = name;
		}
	}
	out->names = names, out->n = n;
	return PL_OK;
}

int pl_names(const pl_places *p, const pl_spot *at, const char *const *address, size_t naddress,
	const pl_depend *depend, pl_namelist *out) {
	return pl_names_of(p, at, address, naddress, "children", depend, out);
}

// an object of each item look gives, every version
static int read(const pl_places *p, const pl_spot *at, const char *const *address,
	size_t naddress, const char *info, const pl_depend *d, pl_items *out) {
	vec o = {0};
	int code = look_into(p, at, address, naddress, d, &o);
	out->items = NULL, out->n = 0;
	if (code) return code;
	for (size_t i = 0; i < o.n; i++) {
		pl_item *it = &o.v[i];
		if (it->node == NULL) continue;
		say(d, it->id, info ? PL_INFO : PL_VALUE, info);
		it->has_versions = 1;
		if (info == NULL) {
			it->versions = it->node->value.versions, it->nversions = it->node->value.length;
			continue;
		}
		for (size_t k = 0; k < it->node->info_length; k++)
			if (!strcmp(it->node->info[k].name, info)) {
				it->versions = it->node->info[k].object.versions;
				it->nversions = it->node->info[k].object.length;
			}
	}
	out->items = o.v, out->n = o.n;
	return PL_OK;
}

int pl_content(const pl_places *p, const pl_spot *at, const char *const *address,
	size_t naddress, const pl_depend *depend, pl_items *out) {
	return read(p, at, address, naddress, NULL, dep(p, depend), out);
}

int pl_info(const pl_places *p, const pl_spot *at, const char *const *address, size_t naddress,
	const char *name, const pl_depend *depend, pl_items *out) {
	out->items = NULL, out->n = 0;
	if (never(name)) return PL_WRONG_FIELD;
	return read(p, at, address, naddress, name, dep(p, depend), out);
}

int pl_cd(const pl_places *p, const pl_spot *at, const char *const *address, size_t naddress,
	const pl_depend *depend, pl_spot *out) {
	const pl_depend *d = dep(p, depend);
	resolved r;
	int code = resolve(p, at, address, naddress, &r);
	if (code) return code;
	const char **trail = mem(p, (r.n + 1 + (at->has_trail ? at->ntrail : 0)) * sizeof *trail);
	size_t n = 0;
	if (!at->has_trail) {
		walked w = walk(p, r.names, r.n, d, p->root, 0, 1);
		for (size_t i = 0; i < w.ntaken; i++) trail[n++] = w.taken[i]->id;
	} else if (r.own == 0 || r.base >= at->ntrail) {
		// back up the trail, or past its end: the steps it took, no walk
		for (; n < r.base + 1 && n < at->ntrail; n++) trail[n] = at->trail[n];
	} else {
		for (; n < r.base; n++) trail[n] = at->trail[n];
		walked w = walk(p, r.names, r.n, d, at->trail[r.base], r.base, 1);
		for (size_t i = 0; i < w.ntaken; i++) trail[n++] = w.taken[i]->id;
	}
	*out = (pl_spot){r.names, r.n, 1, trail, n};
	return PL_OK;
}

// placing

static nd_list *mklist(const pl_places *p, size_t n) {
	nd_list *l = mem(p, sizeof *l);
	l->items = mem(p, n * sizeof(nd_item));
	l->length = n;
	return l;
}

static void drop_entry(nd_node *n, long e) {
	memmove(&n->children[e], &n->children[e + 1], (n->children_length - (size_t)e - 1) * sizeof *n->children);
	n->children_length--;
}

// versions as the list of name: none gone, else an entry set or added at the end
static void set_versions(const pl_places *p, nd_node *n, long e, const char *name,
	const nd_version *vs, size_t count) {
	if (count == 0) {
		if (e >= 0) drop_entry(n, e);
		return;
	}
	if (e >= 0) {
		n->children[e].object.versions = vs, n->children[e].object.length = count;
		return;
	}
	nd_entry *es = mem(p, (n->children_length + 1) * sizeof *es);
	if (n->children_length) memcpy(es, n->children, n->children_length * sizeof *es);
	es[n->children_length] = (nd_entry){name, {vs, count}};
	n->children = es;
	n->children_length++;
}

// the entry of name to slot at, the rest in order
static void slot(nd_node *n, const char *name, size_t at) {
	long i = find(n, name);
	if (i < 0) return;
	nd_entry e = n->children[i];
	memmove(&n->children[i], &n->children[i + 1], (n->children_length - (size_t)i - 1) * sizeof e);
	size_t len = n->children_length - 1, pos = at < len ? at : len;
	memmove(&n->children[pos + 1], &n->children[pos], (len - pos) * sizeof e);
	n->children[pos] = e;
}

// a patch to the version from of id's list of name: ids put over [a, b), or the entry at index
// taken out; the versions from to to replaced by what it makes, at from: one change. no
// versions: slots 0 makes the first
typedef struct {
	int take;
	long a, b;
	const nd_item *ins;
	size_t nins;
} patch;

static int edit(const pl_places *p, nd_node *n, const char *name, pl_span slots,
	const patch *pt, const void **change) {
	long e = find(n, name);
	const nd_version *vs = e >= 0 ? n->children[e].object.versions : NULL;
	size_t nv = e >= 0 ? n->children[e].object.length : 0;
	long from = slots.from, to = slots.to;
	int ok = nv == 0 ? (from == 0 && to <= 1) : (from < to && (size_t)to <= nv);
	if (!ok || from < 0) return PL_RANGE;
	static const nd_list empty = {NULL, 0};
	const nd_list *have = nv && vs[from].content ? vs[from].content : &empty;
	size_t len = have->length, head, tail_from;
	if (pt->take) {
		if (pt->a < 0 || pt->a >= pt->b || (size_t)pt->b > len) return PL_RANGE;
	} else if (pt->a < 0 || pt->a > pt->b || (size_t)pt->b > len) return PL_RANGE;
	head = (size_t)pt->a, tail_from = (size_t)pt->b;
	size_t nins = pt->take ? 0 : pt->nins, count = head + nins + (len - tail_from);
	if (p->by == NULL) return PL_NO_BY;
	const void *c = p->by(p->ctx, n->id);
	nd_list *l = count ? mklist(p, count) : NULL;
	if (l) {
		nd_item *it = (nd_item *)l->items;
		if (head) memcpy(it, have->items, head * sizeof *it);
		if (nins) memcpy(it + head, pt->ins, nins * sizeof *it);
		if (len > tail_from) memcpy(it + head + nins, have->items + tail_from, (len - tail_from) * sizeof *it);
	}
	size_t tail = nv > (size_t)to ? nv - (size_t)to : 0, total = (size_t)from + (l ? 1 : 0) + tail;
	nd_version *next = mem(p, total * sizeof *next);
	if (from) memcpy(next, vs, (size_t)from * sizeof *next);
	if (l) next[from] = (nd_version){l, c, nv ? vs[from].because : NULL};
	if (tail) memcpy(next + (size_t)from + (l ? 1 : 0), vs + to, tail * sizeof *next);
	set_versions(p, n, e, name, next, total);
	*change = c;
	return PL_OK;
}

static const pl_span first = {0, 1};

static nd_node *held(const pl_places *p, const char *id) { return p->get(p->ctx, id); }

// ids put in at index, a gap (NULL: the end); a span: the ids there replaced
static int place(const pl_places *p, nd_node *n, const char *name, const nd_item *ids,
	size_t nids, const pl_span *index, const pl_span *slotindex, const void **change) {
	if (never(name)) return PL_WRONG_FIELD;
	// the gap is checked against the list in edit; the end is the list's length
	patch pt = {0, 0, 0, ids, nids};
	long e = find(n, name);
	pl_span s = slotindex ? *slotindex : first;
	if (index) pt.a = index->from, pt.b = index->to;
	else {
		// the end of the version slotindex reads; out of range slots fail in edit
		size_t nv = e >= 0 ? n->children[e].object.length : 0;
		size_t len = 0;
		if (nv && s.from >= 0 && (size_t)s.from < nv)
			len = n->children[e].object.versions[s.from].content
				? ((const nd_list *)n->children[e].object.versions[s.from].content)->length : 0;
		pt.a = pt.b = (long)len;
	}
	return edit(p, n, name, s, &pt, change);
}

int pl_insert(const pl_places *p, const char *id, const char *name, const char *child,
	const pl_span *index, const pl_span *slotindex, const void **change) {
	nd_node *n = held(p, id);
	if (n == NULL) return PL_NOTHING_THERE;
	nd_item it = {child, NULL};
	return place(p, n, name, &it, 1, index, slotindex, change);
}

int pl_pop(const pl_places *p, const char *id, const char *name, pl_span slotindex,
	const void **change) {
	nd_node *n = held(p, id);
	if (n == NULL) return PL_NOTHING_THERE;
	long e = find(n, name);
	size_t nv = e >= 0 ? n->children[e].object.length : 0;
	long from = slotindex.from, to = slotindex.to;
	if (from < 0 || from >= to || (size_t)to > nv) return PL_RANGE;
	if (p->by == NULL) return PL_NO_BY;
	const nd_version *vs = n->children[e].object.versions;
	size_t total = nv - (size_t)(to - from);
	nd_version *next = mem(p, total * sizeof *next);
	if (from) memcpy(next, vs, (size_t)from * sizeof *next);
	if (nv > (size_t)to) memcpy(next + from, vs + to, (nv - (size_t)to) * sizeof *next);
	set_versions(p, n, e, name, next, total);
	*change = p->by(p->ctx, n->id);
	return PL_OK;
}

int pl_remove(const pl_places *p, const char *id, const char *name, pl_span index,
	const pl_span *slotindex, const void **change) {
	nd_node *n = held(p, id);
	if (n == NULL) return PL_NOTHING_THERE;
	patch pt = {1, index.from, index.to, NULL, 0};
	return edit(p, n, name, slotindex ? *slotindex : first, &pt, change);
}

int pl_rename(const pl_places *p, const char *id, const char *name, const char *to,
	const void *changes[2]) {
	nd_node *n = held(p, id);
	if (n == NULL) return PL_NOTHING_THERE;
	if (never(to)) return PL_WRONG_FIELD;
	if (find(n, to) >= 0) return PL_ALREADY_THERE;
	const nd_list *ids = list(n, name);
	if (ids == NULL) return PL_NOTHING_THERE;
	if (p->by == NULL) return PL_NO_BY;
	long at = find(n, name);
	// a removal: the first version gone, the later ones stay
	changes[0] = p->by(p->ctx, n->id);
	const nd_object *o = &n->children[at].object;
	set_versions(p, n, at, name, o->versions + 1, o->length - 1);
	int code = place(p, n, to, ids->items, ids->length, NULL, NULL, &changes[1]);
	if (code) return code;
	slot(n, to, (size_t)at);
	return PL_OK;
}

int pl_move(const pl_places *p, const char *id, const char *name, long index, const char *toid,
	const char *toname, const long *toindex, const void *changes[2], size_t *nchanges) {
	nd_node *from = held(p, id);
	if (from == NULL) return PL_NOTHING_THERE;
	nd_node *to = held(p, toid);
	if (to == NULL) return PL_NOTHING_THERE;
	if (never(toname)) return PL_WRONG_FIELD;
	const nd_list *ids = list(from, name);
	if (ids == NULL || index < 0 || (size_t)index >= ids->length) return PL_RANGE;
	int same = from == to && !strcmp(name, toname);
	long room = (long)size(to, toname) - (same ? 1 : 0);
	long at = toindex ? *toindex : room;
	if (at > room || at < 0) return PL_RANGE;
	if (same) {
		// one change: the first version's list with the entry moved
		if (p->by == NULL) return PL_NO_BY;
		long e = find(from, name);
		const nd_object *o = &from->children[e].object;
		nd_list *l = mklist(p, ids->length);
		nd_item *it = (nd_item *)l->items, entry = ids->items[index];
		size_t k = 0;
		for (size_t j = 0; j < ids->length; j++) {
			if ((long)j == index) continue;
			if ((long)k == at) it[k++] = entry;
			it[k++] = ids->items[j];
		}
		if ((long)k == at) it[k++] = entry;
		const void *c = p->by(p->ctx, from->id);
		nd_version *next = mem(p, o->length * sizeof *next);
		memcpy(next, o->versions, o->length * sizeof *next);
		next[0] = (nd_version){l, c, o->versions[0].because};
		set_versions(p, from, e, name, next, o->length);
		changes[0] = c;
		*nchanges = 1;
		return PL_OK;
	}
	nd_item entry = ids->items[index];
	patch pt = {1, index, index + 1, NULL, 0};
	int code = edit(p, from, name, first, &pt, &changes[0]);
	if (code) return code;
	pl_span where = {at, at};
	code = place(p, to, toname, &entry, 1, &where, NULL, &changes[1]);
	if (code) return code;
	*nchanges = 2;
	return PL_OK;
}

// writing by path

static void quiet(void *ctx, const char *id, pl_part part) { (void)ctx, (void)id, (void)part; }

int pl_at(const pl_places *p, const pl_spot *at, const char *const *address, size_t naddress,
	const long *index, nd_node **out) {
	static const pl_depend none = {quiet, NULL};
	pl_items items;
	int code = pl_look(p, at, address, naddress, &none, &items);
	if (code) return code;
	const pl_item *it = NULL;
	if (index == NULL) {
		for (size_t i = 0; i < items.n && !it; i++)
			if (items.items[i].node) it = &items.items[i];
	} else {
		if (*index < 0 || (size_t)*index >= items.n) return PL_RANGE;
		it = &items.items[*index];
	}
	if (it == NULL || it->node == NULL) return PL_NOTHING_THERE;
	*out = (nd_node *)it->node;
	return PL_OK;
}

int pl_edit(const pl_places *p, nd_node *n, const char *info, pl_span slots,
	const nt_patch *patches, size_t np, const mu_patched *patched, const void **change,
	pl_mutated *mutated) {
	long e = -1;
	nd_object cur = info ? (nd_object){0} : n->value;
	for (size_t i = 0; info && e < 0 && i < n->info_length; i++)
		if (!strcmp(n->info[i].name, info)) e = (long)i, cur = n->info[i].object;
	long from = slots.from, to = slots.to;
	int ok = cur.length == 0 ? (from == 0 && to <= 1) : (from < to && (size_t)to <= cur.length);
	if (!ok || from < 0) return PL_RANGE;
	if (p->by == NULL) return PL_NO_BY;
	// mutate on a node holding only the version from
	size_t nbase = cur.length ? 1 : 0;
	nd_version base = nbase ? cur.versions[from] : (nd_version){0};
	nd_entry entry = {info, {&base, nbase}};
	nd_node scratch = {.id = n->id};
	if (info == NULL) scratch.value = (nd_object){nbase ? &base : NULL, nbase};
	else if (nbase) scratch.info = &entry, scratch.info_length = 1;
	const void *c = p->by(p->ctx, n->id);
	mu_alloc al = {p->alloc, p->ctx};
	size_t failed = 0;
	int code = mu_mutate(&scratch, (mu_which){info ? MU_INFO : MU_VALUE, info}, patches, np, c,
		&al, patched, &failed);
	if (code) {
		if (mutated) *mutated = (pl_mutated){code, failed};
		return PL_MUTATE;
	}
	nd_object made = info ? (nd_object){0} : scratch.value;
	for (size_t i = 0; info && i < scratch.info_length; i++)
		if (!strcmp(scratch.info[i].name, info)) made = scratch.info[i].object;
	size_t tail = cur.length > (size_t)to ? cur.length - (size_t)to : 0;
	size_t total = (size_t)from + made.length + tail;
	nd_version *vs = mem(p, total * sizeof *vs);
	if (from) memcpy(vs, cur.versions, (size_t)from * sizeof *vs);
	if (made.length) memcpy(vs + from, made.versions, made.length * sizeof *vs);
	if (tail) memcpy(vs + from + made.length, cur.versions + to, tail * sizeof *vs);
	if (info == NULL) n->value = (nd_object){vs, total};
	else {
		// the entry set, added at the end, or gone
		nd_entry *es = mem(p, (n->info_length + 1) * sizeof *es);
		size_t m = 0;
		for (size_t j = 0; j < n->info_length; j++) {
			if ((long)j != e) es[m++] = n->info[j];
			else if (total) es[m++] = (nd_entry){n->info[j].name, {vs, total}};
		}
		if (e < 0 && total) {
			char *name = mem(p, strlen(info) + 1);
			es[m++] = (nd_entry){strcpy(name, info), {vs, total}};
		}
		n->info = es, n->info_length = m;
	}
	*change = c;
	return PL_OK;
}

static int written(const pl_places *p, const pl_spot *at, const char *const *address,
	size_t naddress, const char *info, const nt_patch *patches, size_t np, const long *index,
	const pl_span *slotindex, const void **change, pl_mutated *mutated) {
	nd_node *n;
	int code = pl_at(p, at, address, naddress, index, &n);
	if (code) return code;
	return pl_edit(p, n, info, slotindex ? *slotindex : first, patches, np, NULL, change, mutated);
}

int pl_write(const pl_places *p, const pl_spot *at, const char *const *address, size_t naddress,
	const nt_patch *patches, size_t np, const long *index, const pl_span *slotindex,
	const void **change, pl_mutated *mutated) {
	return written(p, at, address, naddress, NULL, patches, np, index, slotindex, change, mutated);
}

int pl_set(const pl_places *p, const pl_spot *at, const char *const *address, size_t naddress,
	const char *name, const nt_patch *patches, size_t np, const long *index,
	const pl_span *slotindex, const void **change, pl_mutated *mutated) {
	if (never(name)) return PL_WRONG_FIELD;
	return written(p, at, address, naddress, name, patches, np, index, slotindex, change, mutated);
}
