// words.c: the API's words by name (words.h): the one dispatch, from values to a value.

#include "words.h"

#include <stdlib.h>
#include <string.h>

// --- the words and what each takes

typedef enum {
	W_LOOK, W_LOOKUP, W_LOOKUPS, W_CONTENT, W_CHILDREN, W_INFO, W_NODE, W_WRITE, W_SET, W_INSERT, W_REMOVE, W_POP, W_RENAME,
	W_MOVE, W_CREATE, W_START, W_CALL, W_CLEANUP, W_NONE
} Word;

static const struct {
	const char *name;
	const char *const fields[7];
} words[] = {
	[W_LOOK] = { "look", { "address" } },
	[W_LOOKUP] = { "lookup", { "address" } },
	[W_LOOKUPS] = { "lookups", { "address" } },
	[W_CONTENT] = { "content", { "address" } },
	[W_CHILDREN] = { "children", { "address", "name" } },
	[W_INFO] = { "info", { "address", "name" } },
	[W_NODE] = { "node", { "id" } },
	[W_WRITE] = { "write", { "address", "patches", "index" } },
	[W_SET] = { "set", { "address", "name", "patches", "index" } },
	[W_INSERT] = { "insert", { "id", "name", "child", "index" } },
	[W_REMOVE] = { "remove", { "id", "name", "index" } },
	[W_POP] = { "pop", { "id", "name", "index" } },
	[W_RENAME] = { "rename", { "id", "name", "to" } },
	[W_MOVE] = { "move", { "id", "name", "index", "to", "toname", "toindex" } },
	[W_CREATE] = { "create", { "value", "id", "ephemeral" } },
	[W_START] = { "start", { "address", "program", "code", "name", "deep", "data" } },
	[W_CALL] = { "call", { "address", "args" } },
	[W_CLEANUP] = { "onCleanup", { "fn" } },
};

static Word wordOf(const char *name) {
	for (int w = 0; name && w < W_NONE; w++)
		if (!strcmp(words[w].name, name)) return (Word)w;
	return W_NONE;
}

const char *const *wdFields(const char *word) {
	Word w = wordOf(word);
	return w == W_NONE ? NULL : words[w].fields;
}

// --- arguments

static const char *textOf(const op_value *v) { return v && v->type == OP_STR ? v->str : NULL; }

/** a number, or a list whose first is one; false when none */
static bool indexOf(const op_value *v, long *out) {
	if (v && v->type == OP_LIST && v->count) v = v->items[0];
	if (!v || v->type != OP_NUM) return false;
	*out = (long)v->num;
	return true;
}

static int truth(const op_value *v) {
	if (!v) return 0;
	switch (v->type) {
	case OP_NULL: return 0;
	case OP_BOOL: return v->bool_;
	case OP_NUM: return v->num != 0;
	case OP_STR: return v->bytes > 0;
	default: return 1;
	}
}

const char *const *wdNames(ap_os *os, const op_value *list, size_t *n) {
	if (!list || list->type != OP_LIST) return NULL;
	const char **out = ap_temp(os, sizeof *out * (list->count + 1));
	for (size_t i = 0; i < list->count; i++)
		if (!(out[i] = textOf(list->items[i]))) return NULL;
	out[list->count] = NULL;
	*n = list->count;
	return out;
}

// --- patches

/** a place in a value, {path, range?}: its keys the turn's, borrowed from the value */
static op_target targetOf(ap_os *os, const op_value *path, const op_value *range) {
	op_target t = { 0 };
	size_t n = path && path->type == OP_LIST ? path->count : 0;
	op_key *keys = ap_temp(os, sizeof *keys * (n ? n : 1));
	for (size_t i = 0; i < n; i++) {
		const op_value *k = path->items[i];
		keys[i] = k->type == OP_NUM ? (op_key){ .type = OP_NUM_KEY, .n = (long)k->num } : (op_key){ .type = OP_STR_KEY, .s = textOf(k) ? k->str : "" };
	}
	t.path = keys, t.length = n;
	if (range && range->type == OP_LIST && range->count == 2 && range->items[0]->type == OP_NUM && range->items[1]->type == OP_NUM)
		t.has_range = 1, t.from = (long)range->items[0]->num, t.to = (long)range->items[1]->num;
	return t;
}

static const op_value *field(const op_value *m, const char *key) { return m && m->type == OP_MAP ? op_get(m, key) : NULL; }

op_patch *wdPatches(ap_os *os, const op_value *list, size_t *n, const char **why) {
	if (!list || list->type != OP_LIST) return *why = "patches are a list", NULL;
	*n = list->count;
	op_patch *ps = ap_temp(os, sizeof *ps * (*n ? *n : 1));
	for (size_t i = 0; i < *n; i++) {
		const op_value *p = list->items[i];
		if (p->type != OP_MAP) return *why = "a patch is a map", NULL;
		const char *type = textOf(field(p, "type"));
		bool snapshot = type && !strcmp(type, "snapshot"), set = type && !strcmp(type, "set");
		if (type && !snapshot && !set && strcmp(type, "splice")) return *why = "a patch of a kind the kit does not know", NULL;
		const op_value *value = field(p, "value"), *move = field(p, "move");
		ps[i] = (op_patch){ .place = targetOf(os, snapshot ? NULL : field(p, "path"), snapshot ? NULL : field(p, "range")) };
		if (set) {
			// the old core's set: its key the path's last
			const char *key = textOf(field(p, "key"));
			op_key *keys = ap_temp(os, sizeof *keys * (ps[i].place.length + 1));
			memcpy(keys, ps[i].place.path, sizeof *keys * ps[i].place.length);
			keys[ps[i].place.length] = (op_key){ .type = OP_STR_KEY, .s = key ? key : "" };
			ps[i].place.path = keys, ps[i].place.length++;
		}
		if (value) ps[i].has_value = 1, ps[i].value = value;
		if (move && !type) ps[i].has_move = 1, ps[i].move = targetOf(os, field(move, "path"), field(move, "range"));
	}
	return ps;
}

// --- items

static op_value *changeOf(const ap_change *c) {
	op_value *o = op_map();
	op_set(o, "time", op_num((double)c->time));
	if (c->actor) op_set(o, "actor", op_ref((op_value *)c->actor));
	if (c->reader) op_set(o, "reader", op_str(c->reader));
	if (c->site) op_set(o, "site", op_ref((op_value *)c->site));
	if (c->cause) op_set(o, "cause", op_ref((op_value *)c->cause));
	return o;
}

op_value *wdItems(const ap_items *items) {
	op_value *a = op_list();
	for (size_t i = 0; i < items->n; i++) {
		const ap_item *it = &items->items[i];
		op_value *o = op_map(), *route = op_list();
		op_set(o, "id", op_str(it->id));
		for (size_t r = 0; r < it->nroute; r++) {
			op_value *step = op_map();
			op_set(step, "name", op_str(it->route[r]));
			op_push(route, step);
		}
		op_set(o, "route", route);
		if (it->from) op_set(o, "from", op_str(it->from));
		if (it->node) {
			op_value *node = op_map();
			op_set(node, "id", op_str(it->id));
			op_set(o, "node", node);
			op_set(o, "ephemeral", op_bool(it->ephemeral));
		}
		if (it->node && it->has_versions) {
			op_value *vs = op_list();
			for (size_t k = 0; k < it->nversions; k++) {
				const ap_version *v = &it->versions[k];
				op_value *ver = op_map();
				op_set(ver, "content", v->content ? op_ref((op_value *)v->content) : op_null());
				op_set(ver, "change", changeOf(&v->change));
				if (v->status) {
					op_value *because = op_map();
					op_set(because, "layer", op_str("scheduler"));
					op_set(because, "place", op_str("status"));
					op_set(ver, "because", because);
				}
				op_push(vs, ver);
			}
			op_set(o, "versions", vs);
		}
		op_push(a, o);
	}
	return a;
}

// --- the dispatch

static op_value *namesOf(const ap_namelist *list) {
	op_value *out = op_list();
	for (size_t i = 0; i < list->n; i++) op_push(out, op_str(list->names[i]));
	return out;
}

const ap_error *wdDo(ap_given *g, ap_api *api, const char *word, const op_value *const *args, size_t n, op_value **out) {
	ap_os *os = api->os;
	*out = NULL;
	Word w = wordOf(word);
	const op_value *a[7] = { 0 };
	for (size_t i = 0; i < n && i < 7; i++) a[i] = args[i];
	const char *why = NULL;
	const ap_error *e = NULL;
	size_t k = 0;
	const char *const *address = NULL;
	ap_items items = { 0 };
	int64_t time = 0;
	long index = 0;
#define WRONG(text) \
	do { \
		why = (text); \
		goto done; \
	} while (0)
	switch (w) {
	case W_LOOK:
	case W_LOOKUP:
	case W_LOOKUPS:
	case W_CONTENT:
		if (!(address = wdNames(os, a[0], &k))) WRONG("an address is a list of names");
		e = w == W_LOOK ? ap_look(api, address, k, &items)
		  : w == W_LOOKUP ? ap_lookup(api, address, k, &items)
		  : w == W_LOOKUPS ? ap_lookups(api, address, k, &items)
		  : ap_content(api, address, k, &items);
		if (!e) *out = wdItems(&items);
		break;
	case W_CHILDREN:
	case W_INFO: {
		const char *list = textOf(a[1]);
		if (!(address = wdNames(os, a[0], &k))) WRONG("an address is a list of names");
		if (!list && w == W_CHILDREN) {
			ap_namelist names = { 0 };
			if (!(e = ap_names(api, address, k, &names))) *out = namesOf(&names);
			break;
		}
		if (!list) WRONG("info takes a name");
		e = w == W_CHILDREN ? ap_children(api, address, k, list, &items) : ap_info(api, address, k, list, &items);
		if (!e) *out = wdItems(&items);
		break;
	}
	case W_NODE: {
		const char *id = textOf(a[0]);
		op_value *node = NULL;
		if (!id) WRONG("node takes an id");
		if (!(e = ap_node(api, id, &node))) *out = op_ref(node); // the turn's: a hold of the caller's
		break;
	}
	case W_WRITE:
	case W_SET: {
		bool set = w == W_SET;
		const char *list = set ? textOf(a[1]) : NULL;
		const op_value *patches = set ? a[2] : a[1], *ix = set ? a[3] : a[2];
		if (!(address = wdNames(os, a[0], &k))) WRONG("an address is a list of names");
		if (set && !list) WRONG("set takes a name");
		size_t np = 0;
		op_patch *ps = wdPatches(os, patches, &np, &why);
		if (!ps) goto done;
		bool hasIndex = indexOf(ix, &index);
		e = set ? ap_set(api, address, k, list, ps, np, hasIndex ? &index : NULL, &time)
		        : ap_write(api, address, k, ps, np, hasIndex ? &index : NULL, &time);
		if (!e) *out = op_num((double)time);
		break;
	}
	case W_INSERT: {
		const char *id = textOf(a[0]), *list = textOf(a[1]), *child = textOf(a[2]);
		bool hasIndex = indexOf(a[3], &index);
		if (!id || !list || !child) WRONG("insert takes an id, a name and a child");
		if (!(e = ap_insert(api, id, list, child, hasIndex ? &index : NULL, &time))) *out = op_num((double)time);
		break;
	}
	case W_REMOVE:
	case W_POP: {
		const char *id = textOf(a[0]), *list = textOf(a[1]);
		if (!id || !list || !indexOf(a[2], &index)) WRONG("remove takes an id, a name and an index");
		if (!(e = ap_remove(api, id, list, index, &time))) *out = op_num((double)time);
		break;
	}
	case W_RENAME: {
		const char *id = textOf(a[0]), *list = textOf(a[1]), *to = textOf(a[2]);
		if (!id || !list || !to) WRONG("rename takes an id, a name and to");
		if (!(e = ap_rename(api, id, list, to, &time))) *out = op_num((double)time);
		break;
	}
	case W_MOVE: {
		const char *id = textOf(a[0]), *list = textOf(a[1]), *to = textOf(a[3]), *toname = textOf(a[4]);
		long into = 0;
		bool hasTo = indexOf(a[5], &into);
		if (!indexOf(a[2], &index)) index = 0;
		if (!id || !list || !to || !toname) WRONG("move takes an id, a name, an index, to and toname");
		if (!(e = ap_move(api, id, list, index, to, toname, hasTo ? &into : NULL, &time))) *out = op_num((double)time);
		break;
	}
	case W_CREATE: {
		const char *made = NULL;
		if (!(e = ap_create(api, a[0], textOf(a[1]), truth(a[2]), &made))) *out = op_str(made);
		break;
	}
	case W_START: {
		ap_startop s = { 0 };
		if (!g) WRONG("start outside a part");
		if (!(s.address = wdNames(os, a[0], &s.naddress))) WRONG("start takes an address, a list of names");
		const op_value *code = a[2];
		if (a[1]) {
			if (!(s.program = wdNames(os, a[1], &s.nprogram))) WRONG("a program is a path, a list of names");
		} else if (code && (s.compute = ap_live_fn(os, code))) {
			// a setup as code: run once, as a compute whose value is its own
		} else if (code && code->type == OP_MAP) {
			s.compute = ap_live_fn(os, op_get(code, "compute"));
			s.effect = ap_live_fn(os, op_get(code, "effect"));
		}
		if (!s.program && !s.compute) WRONG("start takes a program (a path) or code (a function, or {compute, effect})");
		s.name = textOf(a[3]);
		s.deep = truth(a[4]);
		s.data = a[5];
		const char *pid = NULL;
		if (!(e = ap_start(g, &s, &pid))) *out = op_str(pid);
		break;
	}
	case W_CALL: {
		op_value *answer = NULL;
		if (!g) WRONG("call outside a part");
		if (!(address = wdNames(os, a[0], &k))) WRONG("call takes an address");
		if (!(e = ap_call(g, address, k, a[1], &answer)) && answer) *out = op_ref(answer); // the turn's: a hold of the caller's
		break;
	}
	case W_CLEANUP: {
		ap_fn *f = a[0] ? ap_live_fn(os, a[0]) : NULL;
		if (!g) WRONG("onCleanup outside a part");
		if (!f) WRONG("onCleanup takes a function");
		e = ap_cleanup(g, f);
		break;
	}
	case W_NONE: WRONG("no such operation");
	}
#undef WRONG
done:
	if (why) return ap_error_new(os, "wrong-field", why);
	return e;
}
