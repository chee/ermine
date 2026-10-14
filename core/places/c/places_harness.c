// The C places on the line protocol (places_harness.ts documents it), over the shared loop
// (conformance/c/harness.h). State lasts for the process: per source a table of children nodes
// (the hole), one places, its opened places and its saved lists.
//
// A symbol key is a token the harness interns by name. In a node's value (an op_value has no
// symbols) it stands as the map {"symbol": name}, and ROOT as {"root": true}: the form it is
// written in, and the one the setup's symbol hooks read back.
//
// an answer is written to a buffer first, and a request that cannot be understood (refuse) answers
// { error: text } alone
#define _POSIX_C_SOURCE 200809L
#include <limits.h>
#include <math.h>
#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../../conformance/c/harness.h"
#include "../../../conformance/c/protocol.h"
#include "places.h"

// --- errors: a request that cannot be understood answers { error: text } ---

static jmp_buf escape;
static const char *why;
static void refuse(const char *text_) {
	why = text_;
	longjmp(escape, 1);
}

static char *mine(const char *s) { return strcpy(hh_take(strlen(s) + 1), s); }

#define GROW(p, n, c) \
	do { \
		if ((n) == (c)) { \
			(c) = (c) ? (c) * 2 : 16; \
			(p) = realloc((p), (c) * sizeof *(p)); \
			if ((p) == NULL) hh_fail("out of memory"); \
		} \
	} while (0)

// the actors of the setup's changes and of the writes: values that last
static op_value *setup_actor, *me_actor;

// --- symbols ---

typedef struct symtok {
	struct symtok *next;
	char name[];
} symtok;
static symtok *symbols;

static const void *intern(const char *name) {
	for (symtok *s = symbols; s; s = s->next) if (strcmp(s->name, name) == 0) return s;
	symtok *s = malloc(sizeof *s + strlen(name) + 1);
	if (s == NULL) hh_fail("out of memory");
	strcpy(s->name, name);
	s->next = symbols;
	return symbols = s;
}

static int symbol(void *ctx, const op_value *v, const void **token) {
	(void)ctx;
	if (v->type != OP_MAP || v->count != 1) return 0;
	const op_value *x = v->items[0];
	if (strcmp(v->keys[0], "symbol") == 0 && x->type == OP_STR) {
		*token = intern(x->str);
		return 1;
	}
	if (strcmp(v->keys[0], "root") == 0 && x->type == OP_BOOL && x->bool_) {
		*token = &pl_root_mark;
		return 1;
	}
	return 0;
}
static op_value *symbol_value(void *ctx, const void *token) {
	(void)ctx;
	op_value *m = op_map();
	if (token == &pl_root_mark) op_set(m, "root", op_bool(1));
	else op_set(m, "symbol", op_str(((const symtok *)token)->name));
	return m;
}

// a key: a string (the request's own, for the line), or a symbol
static tb_key key_of(const op_value *v) {
	const void *token;
	if (v->type == OP_STR) return tb_string(v->str);
	if (symbol(NULL, v, &token)) return tb_symbol(token);
	refuse("key: not a string or a symbol");
	return (tb_key){0};
}

static void put_key(FILE *out, tb_key k) {
	if (k.symbol == NULL) op_json_string(out, k.string);
	else if (k.symbol == &pl_root_mark) fputs("{\"root\":true}", out);
	else {
		fputs("{\"symbol\":", out);
		op_json_string(out, ((const symtok *)k.symbol)->name);
		putc('}', out);
	}
}
static int keq(tb_key a, tb_key b) {
	if (a.symbol || b.symbol) return a.symbol == b.symbol;
	return strcmp(a.string, b.string) == 0;
}

// --- the world: the hole ---

typedef struct {
	tb_key source, id; // string keys are the world's own
	nd_entry *node;
	int borrowed; // an alias: the node is another cell's, which frees it
} cell;
static cell *world;
static size_t nworld, cworld;

static tb_key own(tb_key k) {
	if (k.symbol) return k;
	char *s = strcpy(malloc(strlen(k.string) + 1), k.string);
	return tb_string(s);
}
static cell *cell_of(tb_key source, tb_key id) {
	for (size_t i = 0; i < nworld; i++) if (keq(world[i].source, source) && keq(world[i].id, id)) return &world[i];
	return NULL;
}
static nd_entry *children(void *ctx, tb_key source, tb_key id) {
	(void)ctx;
	cell *c = cell_of(source, id);
	return c ? c->node : NULL;
}

// --- what a request makes known: reads ---

typedef struct {
	tb_key source, id;
	const char *name;
	int keys;
} told_read;

static told_read *reads;
static size_t nreads, creads;

static tb_key copy(tb_key k) { return k.symbol ? k : tb_string(mine(k.string)); }

static void on_read(void *ctx, tb_key source, tb_key id, const char *name, int keys) {
	(void)ctx;
	GROW(reads, nreads, creads);
	reads[nreads++] = (told_read){copy(source), copy(id), name ? mine(name) : NULL, keys};
}
// what the sink given to a call was told, apart from the setup's
static told_read *owns;
static size_t nowns, cowns;
static void on_own(void *ctx, tb_key source, tb_key id, const char *name, int keys) {
	(void)ctx;
	GROW(owns, nowns, cowns);
	owns[nowns++] = (told_read){copy(source), copy(id), name ? mine(name) : NULL, keys};
}
static const pl_sink own_sink = {on_own, NULL};
static int is_true(const op_value *v) { return v != NULL && v->type == OP_BOOL && v->bool_; }
// the request's "own": true
static const pl_sink *own_of(const op_value *r) { return is_true(op_get(r, "own")) ? &own_sink : NULL; }
static void forget_told(void) { nreads = 0, nowns = 0; }

// each node's change before a write: what the write gives back must be the nodes whose change it
// moved (a write's patches are a block of its own, made while the old one is still held)
static const op_patch **befores;
static size_t cbefores;
static void before_write(void) {
	if (cbefores < nworld) {
		cbefores = nworld;
		befores = realloc(befores, cbefores * sizeof *befores);
		if (befores == NULL) hh_fail("out of memory");
	}
	for (size_t i = 0; i < nworld; i++) befores[i] = world[i].node->change.patches;
}
static int gave_what_changed(const pl_changed *c) {
	size_t moved = 0;
	for (size_t i = 0; i < nworld; i++) {
		if (world[i].borrowed || world[i].node->change.patches == befores[i]) continue;
		moved++;
		size_t k = 0;
		while (k < c->n && c->nodes[k].node != world[i].node) k++;
		if (k == c->n) return 0;
	}
	return moved == c->n;
}

static void made(tb_key source, tb_key id, op_value *value, int in_place) {
	ch_header h = {.has_time = 1, .time = 0, .actor = setup_actor};
	nd_entry_options options = {.in_place = in_place};
	nd_entry *n = nd_make_entry(value, &h, &options);
	if (n == NULL) hh_fail("out of memory");
	cell *c = cell_of(source, id);
	if (c) {
		if (!c->borrowed) nd_free_entry(c->node);
		c->node = n;
		c->borrowed = 0;
		return;
	}
	GROW(world, nworld, cworld);
	world[nworld++] = (cell){own(source), own(id), n, 0};
}

// --- places, opened places, saved lists ---

typedef struct {
	char *name;
	pl_held *held;
	int has_last, own;
	uint64_t last;
	// the items the last members gave, held (so a pointer is the same item, never a reused one)
	pl_item **members;
	size_t nmembers;
} opened;
static opened *opens;
static size_t nopens, copens;
// opened places replaced by another under the same name stay open until the places is forgotten,
// as in the reference
static pl_held **retired;
static size_t nretired, cretired;

typedef struct {
	char *name;
	pl_item **v;
	size_t n;
} saved_list;
static saved_list *saves;
static size_t nsaves, csaves;

static pl *places;

static pl *make_places(tb_key source, tb_key id) {
	pl_setup s = {.root_source = source, .root_id = id, .children = children, .read = on_read,
		.symbol = symbol, .symbol_value = symbol_value};
	return pl_new(&s);
}

static void drop_members(opened *o) {
	for (size_t i = 0; i < o->nmembers; i++) pl_item_free(o->members[i]);
	free(o->members);
	o->members = NULL;
	o->nmembers = 0;
}

static void forget_places(void) {
	for (size_t i = 0; i < nopens; i++) {
		drop_members(&opens[i]);
		pl_close(opens[i].held);
		free(opens[i].name);
	}
	nopens = 0;
	for (size_t i = 0; i < nretired; i++) pl_close(retired[i]);
	nretired = 0;
	for (size_t i = 0; i < nsaves; i++) {
		for (size_t k = 0; k < saves[i].n; k++) pl_item_free(saves[i].v[k]);
		free(saves[i].v);
		free(saves[i].name);
	}
	nsaves = 0;
	pl_free(places);
	places = NULL;
}

static void save(const char *name, pl_item *const *v, size_t n) {
	saved_list *s = NULL;
	for (size_t i = 0; i < nsaves; i++) if (strcmp(saves[i].name, name) == 0) s = &saves[i];
	if (s) {
		for (size_t k = 0; k < s->n; k++) pl_item_free(s->v[k]);
		free(s->v);
	} else {
		GROW(saves, nsaves, csaves);
		s = &saves[nsaves++];
		s->name = strcpy(malloc(strlen(name) + 1), name);
	}
	s->v = malloc((n ? n : 1) * sizeof *s->v);
	if (s->v == NULL) hh_fail("out of memory");
	for (size_t k = 0; k < n; k++) s->v[k] = pl_item_ref(v[k]);
	s->n = n;
}

// --- reading requests ---

static const op_value *must(const op_value *r, const char *key) {
	const op_value *f = op_get(r, key);
	if (f == NULL) refuse("missing field");
	return f;
}
static const char *string_of(const op_value *v) {
	if (v->type != OP_STR) refuse("not a string");
	return v->str;
}
static const char **address_of(const op_value *r, size_t *n) {
	const op_value *a = must(r, "address");
	if (a->type != OP_LIST) refuse("not a list");
	*n = a->count;
	const char **out = hh_take((*n ? *n : 1) * sizeof *out);
	for (size_t i = 0; i < *n; i++) out[i] = string_of(a->items[i]);
	return out;
}

// the item n (default 0) of the list saved as name
static pl_item *saved_item(const char *name, const op_value *at) {
	size_t k = at != NULL && at->type == OP_NUM && at->num >= 0 ? (size_t)at->num : 0;
	for (size_t i = 0; i < nsaves; i++) {
		if (strcmp(saves[i].name, name) == 0 && k < saves[i].n) return saves[i].v[k];
	}
	refuse("no such saved item");
	return NULL;
}

// from, parent: an entry, or a saved item. at is the pl_at to give places; item sits in a saved list
static pl_at spec(const op_value *v) {
	if (v->type == OP_LIST) {
		if (v->count != 2) refuse("entry: not two keys");
		tb_key s = key_of(v->items[0]), i = key_of(v->items[1]);
		return pl_at_entry(s, i);
	}
	const op_value *name = v->type == OP_MAP ? op_get(v, "item") : NULL;
	if (name != NULL && name->type == OP_STR) return pl_at_item(saved_item(name->str, op_get(v, "at")));
	refuse("not an entry or a saved item");
	return (pl_at){0};
}

static void entry_of(const op_value *v, tb_key *source, tb_key *id) {
	if (v->type != OP_LIST || v->count != 2) refuse("entry: not two keys");
	*source = key_of(v->items[0]);
	*id = key_of(v->items[1]);
}

// a number that is a whole number, else LONG_MAX (never within); absent or null: absent
static long whole(const op_value *v, long absent) {
	if (v == NULL || v->type == OP_NULL) return absent;
	if (v->type != OP_NUM || v->num != floor(v->num) || fabs(v->num) > 1e15) return LONG_MAX;
	return (long)v->num;
}

static ch_header header_of(const op_value *r) {
	const op_value *t = op_get(r, "time");
	long time = whole(t, 1);
	if (t != NULL && time == LONG_MAX) time = 1;
	return (ch_header){.has_time = 1, .time = time, .actor = me_actor};
}

// --- writing answers ---

static void put_names(FILE *out, const pl_item *item) {
	putc('[', out);
	size_t n = pl_path(item, NULL, 0);
	const char **names = hh_take((n ? n : 1) * sizeof *names);
	pl_path(item, names, n);
	for (size_t i = 0; i < n; i++) {
		if (i) putc(',', out);
		op_json_string(out, names[i]);
	}
	putc(']', out);
}
static void put_item(FILE *out, const pl_item *item) {
	fputs("{\"source\":", out);
	put_key(out, item->source);
	fputs(",\"id\":", out);
	put_key(out, item->id);
	if (item->name != NULL) {
		fputs(",\"name\":", out);
		op_json_string(out, item->name);
		fprintf(out, ",\"at\":%zu", item->at);
	}
	fputs(",\"path\":", out);
	put_names(out, item);
	putc('}', out);
}
static void put_items(FILE *out, const pl_list *l) {
	putc('[', out);
	for (size_t i = 0; i < l->n; i++) {
		if (i) putc(',', out);
		put_item(out, l->items[i]);
	}
	putc(']', out);
}
static void put_told(FILE *out, const told_read *reads, size_t nreads) {
	putc('[', out);
	for (size_t i = 0; i < nreads; i++) {
		if (i) putc(',', out);
		fputs("{\"source\":", out);
		put_key(out, reads[i].source);
		fputs(",\"id\":", out);
		put_key(out, reads[i].id);
		fputs(",\"path\":[", out);
		if (reads[i].name) op_json_string(out, reads[i].name);
		fputs(reads[i].keys ? "],\"keys\":true}" : "]}", out);
	}
	putc(']', out);
}
static void put_reads(FILE *out) { put_told(out, reads, nreads); }
// ,"own": the sink's, when the call had one
static void put_own(FILE *out, int had) {
	if (!had) return;
	fputs(",\"own\":", out);
	put_told(out, owns, nowns);
}
// the list answered, kept under save if asked
static void answer_list(FILE *out, const op_value *r, pl_list *l, int mine_) {
	const op_value *sv = op_get(r, "save");
	if (sv != NULL && sv->type == OP_STR) save(sv->str, l->items, l->n);
	put_items(out, l);
	if (mine_) pl_list_free(l);
}

// the nodes the write gave back: source, id, the value after, the change's time and patches
static void answer_write(FILE *out, int code, const char *at, const pl_changed *c) {
	if (!gave_what_changed(c)) {
		hh_error(out, "a write gave back other than what it changed");
		return;
	}
	putc('{', out);
	if (code != PL_OK) {
		fprintf(out, "\"error\":\"%s\",", pl_code_name(code));
		if (at) fputs("\"at\":", out), op_json_string(out, at), putc(',', out);
	}
	fputs("\"changes\":[", out);
	for (size_t i = 0; i < c->n; i++) {
		const nd_entry *n = c->nodes[i].node;
		if (i) putc(',', out);
		fputs("{\"source\":", out);
		put_key(out, c->nodes[i].source);
		fputs(",\"id\":", out);
		put_key(out, c->nodes[i].id);
		if (n->value) {
			fputs(",\"value\":", out);
			op_json_write(out, n->value);
		}
		fprintf(out, ",\"time\":%lld,\"patches\":[", (long long)n->change.time);
		for (size_t k = 0; k < n->change.patches_length; k++) {
			if (k) putc(',', out);
			hh_put_patch(out, &n->change.patches[k]);
		}
		fputs("]}", out);
	}
	putc(']', out);
	if (nreads) {
		fputs(",\"reads\":", out);
		put_reads(out);
	}
	putc('}', out);
}

static opened *opened_named(const char *name) {
	for (size_t i = 0; i < nopens; i++) if (strcmp(opens[i].name, name) == 0) return &opens[i];
	return NULL;
}

static void answer(const op_value *r, FILE *out) {
	const char *op = string_of(must(r, "op"));
	if (strcmp(op, "children") == 0) {
		tb_key source = key_of(must(r, "source")), id = key_of(must(r, "id"));
		made(source, id, (op_value *)op_get(r, "value"), is_true(op_get(r, "inplace")));
		fputs("{}", out);
	} else if (strcmp(op, "nothing") == 0) {
		tb_key source = key_of(must(r, "source")), id = key_of(must(r, "id"));
		cell *c = cell_of(source, id);
		if (c) {
			if (!c->borrowed) nd_free_entry(c->node);
			if (c->source.symbol == NULL) free((void *)c->source.string);
			if (c->id.symbol == NULL) free((void *)c->id.string);
			*c = world[--nworld];
		}
		fputs("{}", out);
	} else if (strcmp(op, "alias") == 0) {
		tb_key source = key_of(must(r, "source")), id = key_of(must(r, "id"));
		const op_value *as = must(r, "as");
		if (as->type != OP_LIST || as->count != 2) refuse("alias: as is not two keys");
		tb_key asource = key_of(as->items[0]), aid = key_of(as->items[1]);
		cell *c = cell_of(source, id);
		if (c == NULL) refuse("alias: no node there");
		nd_entry *n = c->node;
		cell *a = cell_of(asource, aid);
		if (a != NULL) refuse("alias: something is already there");
		GROW(world, nworld, cworld);
		world[nworld++] = (cell){own(asource), own(aid), n, 1};
		fputs("{}", out);
	} else if (strcmp(op, "node") == 0) {
		tb_key source = key_of(must(r, "source")), id = key_of(must(r, "id"));
		cell *c = cell_of(source, id);
		if (c == NULL) {
			fputs("{}", out);
			return;
		}
		fputs("{\"node\":{", out);
		if (c->node->value) fputs("\"value\":", out), op_json_write(out, c->node->value), putc(',', out);
		fprintf(out, "\"time\":%lld}}", (long long)c->node->change.time);
	} else if (strcmp(op, "make") == 0) {
		const op_value *root = must(r, "root");
		tb_key source, id;
		if (root->type == OP_LIST) {
			if (root->count != 2) refuse("entry: not two keys");
			source = key_of(root->items[0]);
			id = key_of(root->items[1]);
		} else {
			source = pl_root();
			id = key_of(root);
		}
		forget_places();
		places = make_places(source, id);
		fputs("{}", out);
	} else if (strcmp(op, "get") == 0 || strcmp(op, "lookup") == 0) {
		size_t n;
		const char **address = address_of(r, &n);
		const op_value *f = op_get(r, "from");
		pl_at from_ = f ? spec(f) : (pl_at){0};
		const pl_sink *to = own_of(r);
		pl_list *l = op[0] == 'g' ? pl_get(places, address, n, f ? &from_ : NULL, to)
					  : pl_lookup(places, address, n, f ? &from_ : NULL, is_true(op_get(r, "all")), to);
		fputs("{\"items\":", out);
		answer_list(out, r, l, 1);
		fputs(",\"reads\":", out);
		put_reads(out);
		put_own(out, to != NULL);
		fputs("}", out);
	} else if (strcmp(op, "names") == 0) {
		const pl_sink *to = own_of(r);
		pl_strings s = pl_names(places, spec(must(r, "from")), to);
		fputs("{\"names\":[", out);
		for (size_t i = 0; i < s.n; i++) {
			if (i) putc(',', out);
			op_json_string(out, s.names[i]);
		}
		fputs("],\"reads\":", out);
		put_reads(out);
		put_own(out, to != NULL);
		fputs("}", out);
		pl_strings_free(s);
	} else if (strcmp(op, "open") == 0) {
		size_t n;
		const char **address = address_of(r, &n);
		const char *as = string_of(must(r, "as"));
		opened *o = opened_named(as);
		const pl_sink *to = own_of(r);
		pl_held *h = pl_open(places, address, n, to);
		if (o) {
			GROW(retired, nretired, cretired);
			retired[nretired++] = o->held;
		} else {
			GROW(opens, nopens, copens);
			o = &opens[nopens++];
			o->name = strcpy(malloc(strlen(as) + 1), as);
			o->members = NULL, o->nmembers = 0;
		}
		o->held = h;
		o->own = to != NULL;
		o->has_last = 0;
		drop_members(o);
		fputs("{}", out);
	} else if (strcmp(op, "items") == 0) {
		opened *o = opened_named(string_of(must(r, "open")));
		if (o == NULL) refuse("no such open");
		const pl_sink *to = own_of(r);
		const pl_list *l = pl_items(o->held, to);
		int same = o->has_last && o->last == l->serial;
		o->has_last = 1;
		o->last = l->serial;
		fputs("{\"items\":", out);
		answer_list(out, r, (pl_list *)l, 0);
		fputs(",\"reads\":", out);
		put_reads(out);
		fprintf(out, ",\"same\":%s", same ? "true" : "false");
		put_own(out, to != NULL || o->own);
		fputs("}", out);
	} else if (strcmp(op, "members") == 0) {
		const op_value *open_ = op_get(r, "open");
		if (open_ == NULL) {
			const pl_sink *to = own_of(r);
			pl_list *l = pl_members_at(places, spec(must(r, "from")), to);
			fputs("{\"items\":", out);
			answer_list(out, r, l, 1);
			fputs(",\"reads\":", out);
			put_reads(out);
			put_own(out, to != NULL);
			fputs("}", out);
		} else {
			opened *o = opened_named(string_of(open_));
			if (o == NULL) refuse("no such open");
			const pl_sink *to = own_of(r);
			const pl_list *l = pl_members(o->held, to);
			// the same item as the last call's, by pointer (held, so none is reused)
			int *same = hh_take((l->n ? l->n : 1) * sizeof *same);
			for (size_t i = 0; i < l->n; i++) {
				same[i] = 0;
				for (size_t k = 0; k < o->nmembers && !same[i]; k++) same[i] = o->members[k] == l->items[i];
			}
			drop_members(o);
			o->members = malloc((l->n ? l->n : 1) * sizeof *o->members);
			if (o->members == NULL) hh_fail("out of memory");
			for (size_t i = 0; i < l->n; i++) o->members[i] = pl_item_ref(l->items[i]);
			o->nmembers = l->n;
			fputs("{\"items\":", out);
			answer_list(out, r, (pl_list *)l, 0);
			fputs(",\"reads\":", out);
			put_reads(out);
			fputs(",\"same\":[", out);
			for (size_t i = 0; i < l->n; i++) fputs(same[i] ? (i ? ",true" : "true") : (i ? ",false" : "false"), out);
			putc(']', out);
			put_own(out, to != NULL || o->own);
			fputs("}", out);
		}
	} else if (strcmp(op, "drop") == 0) {
		opened *o = opened_named(string_of(must(r, "open")));
		if (o) pl_drop(o->held);
		fputs("{}", out);
	} else if (strcmp(op, "path") == 0) {
		pl_item *item = saved_item(string_of(must(r, "item")), op_get(r, "at"));
		fputs("{\"path\":", out);
		put_names(out, item);
		fputs("}", out);
	} else if (strcmp(op, "place") == 0 || strcmp(op, "unplace") == 0 || strcmp(op, "order") == 0 ||
			strcmp(op, "rename") == 0 || strcmp(op, "move") == 0) {
		// every argument is read before places is asked, as the reference does
		const op_value *pspan = must(r, "parent"), *nspan = must(r, "name");
		pl_at parent = spec(pspan);
		const char *name = string_of(nspan);
		ch_header h = header_of(r);
		int code = PL_OK;
		const char *err = NULL;
		pl_changed changed = {0};
		if (strcmp(op, "place") == 0) {
			tb_key source, id;
			entry_of(must(r, "entry"), &source, &id);
			const op_value *ix = op_get(r, "index");
			long index = whole(ix, PL_END);
			if (index == PL_END && ix != NULL && ix->type != OP_NULL) index = LONG_MAX;
			forget_told();
			before_write();
			code = pl_place(places, parent, name, source, id, h, index, &err, &changed);
		} else if (strcmp(op, "unplace") == 0) {
			long index = whole(op_get(r, "index"), LONG_MAX);
			forget_told();
			before_write();
			code = pl_unplace(places, parent, name, index, h, &err, &changed);
		} else if (strcmp(op, "order") == 0) {
			long from_ = whole(op_get(r, "from"), LONG_MAX), to = whole(op_get(r, "to"), LONG_MAX);
			forget_told();
			before_write();
			code = pl_order(places, parent, name, from_, to, h, &err, &changed);
		} else if (strcmp(op, "rename") == 0) {
			const char *to = string_of(must(r, "to"));
			forget_told();
			before_write();
			code = pl_rename(places, parent, name, to, h, &err, &changed);
		} else {
			long index = whole(op_get(r, "index"), LONG_MAX);
			const op_value *dest = must(r, "to");
			if (dest->type != OP_MAP) refuse("missing field");
			pl_at toat = spec(must(dest, "parent"));
			const char *toname = string_of(must(dest, "name"));
			long toindex = whole(op_get(r, "toindex"), PL_END);
			forget_told();
			before_write();
			code = pl_move(places, parent, name, index, toat, toname, h, toindex, &err, &changed);
		}
		answer_write(out, code, err, &changed);
	} else hh_unknown(out, r);
}

void hh_answer(const op_value *r, FILE *out) {
	if (me_actor == NULL) {
		me_actor = op_str("me");
		setup_actor = op_str("setup");
		// the first places: the root "R", an id
		places = make_places(pl_root(), tb_string("R"));
	}
	forget_told();
	char *text;
	size_t size;
	FILE *buffer = open_memstream(&text, &size);
	if (buffer == NULL) hh_fail("out of memory");
	if (setjmp(escape) == 0) {
		answer(r, buffer);
		fclose(buffer);
		fputs(text, out);
	} else {
		fclose(buffer);
		hh_error(out, "%s", why);
	}
	free(text);
}

void hh_finish(void) {
	forget_places();
	for (size_t i = 0; i < nworld; i++) {
		if (!world[i].borrowed) nd_free_entry(world[i].node);
		if (world[i].source.symbol == NULL) free((void *)world[i].source.string);
		if (world[i].id.symbol == NULL) free((void *)world[i].id.string);
	}
	free(world);
	free(opens);
	free(retired);
	free(saves);
	free(reads);
	free(owns);
	free(befores);
	while (symbols) {
		symtok *next = symbols->next;
		free(symbols);
		symbols = next;
	}
	op_free(me_actor);
	op_free(setup_actor);
}
