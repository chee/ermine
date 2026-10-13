// The C places on the line protocol (conformance/places/harness.ts documents it): one JSON request
// per line in, one answer per line out, in order. State lasts for the process: per source a table
// of children nodes (the hole), one places, its opened places and its saved lists.
//
// A symbol key is a token the harness interns by name. In a node's value (an op_value has no
// symbols) it stands as the map {"symbol": name}, and ROOT as {"root": true}: the form it is
// written in, and the one the setup's symbol hooks read back.
#define _POSIX_C_SOURCE 200809L
#include <limits.h>
#include <math.h>
#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "places.h"
#include "../../node/c/shown.h"

// --- errors: a request that cannot be understood answers { error: text } ---

static jmp_buf escape;
static const char *why;
static void refuse(const char *text_) {
	why = text_;
	longjmp(escape, 1);
}

// op_values read for the request being answered, let go of when it is
static op_value **pool;
static size_t npool, cpool;
static op_value *reg(op_value *v) {
	if (npool == cpool) {
		cpool = cpool ? cpool * 2 : 16;
		pool = realloc(pool, cpool * sizeof *pool);
		if (pool == NULL) fail("out of memory");
	}
	return pool[npool++] = v;
}
static void let_go(void) {
	while (npool) op_free(pool[--npool]);
}

static char *mine(const char *s) { return strcpy(take(strlen(s) + 1), s); }

// --- symbols ---

typedef struct symtok {
	struct symtok *next;
	char name[];
} symtok;
static symtok *symbols;

static const void *intern(const char *name) {
	for (symtok *s = symbols; s; s = s->next) if (strcmp(s->name, name) == 0) return s;
	symtok *s = malloc(sizeof *s + strlen(name) + 1);
	if (s == NULL) fail("out of memory");
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

static tb_key key_of(const op_value *v) {
	const void *token;
	if (v->type == OP_STR) return tb_string(mine(v->str));
	if (symbol(NULL, v, &token)) return tb_symbol(token);
	refuse("key: not a string or a symbol");
	return (tb_key){0};
}
static tb_key key_at(const char *span) { return key_of(reg(read_value(span))); }

static void print_key(tb_key k) {
	if (k.symbol == NULL) text(k.string);
	else if (k.symbol == &pl_root_mark) fputs("{\"root\":true}", stdout);
	else {
		fputs("{\"symbol\":", stdout);
		text(((const symtok *)k.symbol)->name);
		putchar('}');
	}
}
static int keq(tb_key a, tb_key b) {
	if (a.symbol || b.symbol) return a.symbol == b.symbol;
	return strcmp(a.string, b.string) == 0;
}

// --- the world: the hole ---

typedef struct {
	tb_key source, id; // string keys are the world's own
	nd_node *node;
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
static nd_node *children(void *ctx, tb_key source, tb_key id) {
	(void)ctx;
	cell *c = cell_of(source, id);
	return c ? c->node : NULL;
}

// --- what a request makes known: reads ---

typedef struct {
	tb_key source, id;
	const char *name;
} told_read;

static told_read *reads;
static size_t nreads, creads;
#define GROW(p, n, c) \
	do { \
		if ((n) == (c)) { \
			(c) = (c) ? (c) * 2 : 16; \
			(p) = realloc((p), (c) * sizeof *(p)); \
			if ((p) == NULL) fail("out of memory"); \
		} \
	} while (0)

static tb_key copy(tb_key k) { return k.symbol ? k : tb_string(mine(k.string)); }

static void on_read(void *ctx, tb_key source, tb_key id, const char *name) {
	(void)ctx;
	GROW(reads, nreads, creads);
	reads[nreads++] = (told_read){copy(source), copy(id), name ? mine(name) : NULL};
}
static void forget_told(void) { nreads = 0; }

// each node's change before a write: what the write gives back must be the nodes whose change it
// moved (a write's patches are a block of its own, made while the old one is still held)
static const op_patch **befores;
static size_t cbefores;
static void before_write(void) {
	if (cbefores < nworld) {
		cbefores = nworld;
		befores = realloc(befores, cbefores * sizeof *befores);
		if (befores == NULL) fail("out of memory");
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

static void made(tb_key source, tb_key id, op_value *value) {
	ch_header h = {.has_time = 1, .time = 0, .actor = "\"setup\""};
	nd_node *n = nd_make(value, &h);
	if (n == NULL) fail("out of memory");
	cell *c = cell_of(source, id);
	if (c) {
		if (!c->borrowed) nd_free(c->node);
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
	int has_last;
	uint64_t last;
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

static void forget_places(void) {
	for (size_t i = 0; i < nopens; i++) {
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
	if (s->v == NULL) fail("out of memory");
	for (size_t k = 0; k < n; k++) s->v[k] = pl_item_ref(v[k]);
	s->n = n;
}

// --- reading requests ---

static const char *must(const char *line, const char *key) {
	const char *f = field(line, key);
	if (f == NULL) refuse("missing field");
	return f;
}
static const char *string_at(const char *span) {
	if (*space(span) != '"') refuse("not a string");
	return string(span);
}
static const char **address_of(const char *line, size_t *n) {
	const char **xs;
	*n = items(must(line, "address"), &xs);
	const char **out = take((*n ? *n : 1) * sizeof *out);
	for (size_t i = 0; i < *n; i++) out[i] = string_at(xs[i]);
	return out;
}

// from, parent: an entry, or a saved item. at is the pl_at to give places; item sits in a saved list
static pl_at spec(const char *span) {
	const op_value *v = reg(read_value(span));
	if (v->type == OP_LIST) {
		if (v->count != 2) refuse("entry: not two keys");
		tb_key s = key_of(v->items[0]), i = key_of(v->items[1]);
		return pl_at_entry(s, i);
	}
	const op_value *name = v->type == OP_MAP ? op_get(v, "item") : NULL;
	if (name != NULL && name->type == OP_STR) {
		const op_value *at = op_get(v, "at");
		size_t k = at != NULL && at->type == OP_NUM && at->num >= 0 ? (size_t)at->num : 0;
		for (size_t i = 0; i < nsaves; i++) {
			if (strcmp(saves[i].name, name->str) == 0 && k < saves[i].n) return pl_at_item(saves[i].v[k]);
		}
		refuse("no such saved item");
	}
	refuse("not an entry or a saved item");
	return (pl_at){0};
}
static pl_at slot_at(const char *span) { return spec(span); }

static void entry_of(const char *span, tb_key *source, tb_key *id) {
	const op_value *v = reg(read_value(span));
	if (v->type != OP_LIST || v->count != 2) refuse("entry: not two keys");
	*source = key_of(v->items[0]);
	*id = key_of(v->items[1]);
}

// a number that is a whole number, else LONG_MAX (never within); absent or null: absent
static long whole(const char *span, long absent) {
	if (span == NULL || strncmp(span, "null", 4) == 0) return absent;
	const op_value *v = reg(read_value(span));
	if (v->type != OP_NUM || v->num != floor(v->num) || fabs(v->num) > 1e15) return LONG_MAX;
	return (long)v->num;
}

static ch_header header_of(const char *line) {
	const char *t = field(line, "time");
	long time = whole(t, 1);
	if (t != NULL && time == LONG_MAX) time = 1;
	return (ch_header){.has_time = 1, .time = time, .actor = "\"me\""};
}

// --- writing answers ---

static void print_item(const pl_item *item) {
	fputs("{\"source\":", stdout);
	print_key(item->source);
	fputs(",\"id\":", stdout);
	print_key(item->id);
	if (item->name != NULL) {
		fputs(",\"name\":", stdout);
		text(item->name);
		printf(",\"at\":%zu", item->at);
	}
	fputs(",\"path\":[", stdout);
	size_t n = pl_path(item, NULL, 0);
	const char **names = take((n ? n : 1) * sizeof *names);
	pl_path(item, names, n);
	for (size_t i = 0; i < n; i++) {
		if (i) putchar(',');
		text(names[i]);
	}
	fputs("]}", stdout);
}
static void print_items(const pl_list *l) {
	putchar('[');
	for (size_t i = 0; i < l->n; i++) {
		if (i) putchar(',');
		print_item(l->items[i]);
	}
	putchar(']');
}
static void print_reads(void) {
	putchar('[');
	for (size_t i = 0; i < nreads; i++) {
		if (i) putchar(',');
		fputs("{\"source\":", stdout);
		print_key(reads[i].source);
		fputs(",\"id\":", stdout);
		print_key(reads[i].id);
		fputs(",\"path\":[", stdout);
		if (reads[i].name) text(reads[i].name);
		fputs("]}", stdout);
	}
	putchar(']');
}
// the list answered, kept under save if asked
static void answer_list(const char *line, pl_list *l, int mine_) {
	const char *sv = field(line, "save");
	if (sv != NULL && *space(sv) == '"') save(string(sv), l->items, l->n);
	print_items(l);
	if (mine_) pl_list_free(l);
}

// the nodes the write gave back: source, id, the value after, the change's time and patches
static void answer_write(int code, const char *at, const pl_changed *c) {
	if (!gave_what_changed(c)) {
		puts("{\"error\":\"a write gave back other than what it changed\"}");
		return;
	}
	putchar('{');
	if (code != PL_OK) {
		printf("\"error\":\"%s\",", pl_code_name(code));
		if (at) fputs("\"at\":", stdout), text(at), putchar(',');
	}
	fputs("\"changes\":[", stdout);
	for (size_t i = 0; i < c->n; i++) {
		const nd_node *n = c->nodes[i].node;
		if (i) putchar(',');
		fputs("{\"source\":", stdout);
		print_key(c->nodes[i].source);
		fputs(",\"id\":", stdout);
		print_key(c->nodes[i].id);
		if (n->value) {
			fputs(",\"value\":", stdout);
			print_value(n->value);
		}
		printf(",\"time\":%lld,\"patches\":[", (long long)n->change.time);
		for (size_t k = 0; k < n->change.patches_length; k++) {
			if (k) putchar(',');
			print_patch(&n->change.patches[k]);
		}
		fputs("]}", stdout);
	}
	putchar(']');
	if (nreads) {
		fputs(",\"reads\":", stdout);
		print_reads();
	}
	puts("}");
}

static opened *opened_named(const char *name) {
	for (size_t i = 0; i < nopens; i++) if (strcmp(opens[i].name, name) == 0) return &opens[i];
	return NULL;
}

static void answer(const char *line) {
	const char *op_span = must(line, "op");
	const char *op = string_at(op_span);
	if (strcmp(op, "children") == 0) {
		tb_key source = key_at(must(line, "source")), id = key_at(must(line, "id"));
		const char *v = field(line, "value");
		op_value *value = v ? read_value(v) : NULL;
		made(source, id, value);
		op_free(value);
		puts("{}");
	} else if (strcmp(op, "nothing") == 0) {
		tb_key source = key_at(must(line, "source")), id = key_at(must(line, "id"));
		cell *c = cell_of(source, id);
		if (c) {
			if (!c->borrowed) nd_free(c->node);
			if (c->source.symbol == NULL) free((void *)c->source.string);
			if (c->id.symbol == NULL) free((void *)c->id.string);
			*c = world[--nworld];
		}
		puts("{}");
	} else if (strcmp(op, "alias") == 0) {
		tb_key source = key_at(must(line, "source")), id = key_at(must(line, "id"));
		const op_value *as = reg(read_value(must(line, "as")));
		if (as->type != OP_LIST || as->count != 2) refuse("alias: as is not two keys");
		tb_key asource = key_of(as->items[0]), aid = key_of(as->items[1]);
		cell *c = cell_of(source, id);
		if (c == NULL) refuse("alias: no node there");
		nd_node *n = c->node;
		cell *a = cell_of(asource, aid);
		if (a != NULL) refuse("alias: something is already there");
		GROW(world, nworld, cworld);
		world[nworld++] = (cell){own(asource), own(aid), n, 1};
		puts("{}");
	} else if (strcmp(op, "node") == 0) {
		tb_key source = key_at(must(line, "source")), id = key_at(must(line, "id"));
		cell *c = cell_of(source, id);
		if (c == NULL) {
			puts("{}");
			return;
		}
		fputs("{\"node\":{", stdout);
		if (c->node->value) fputs("\"value\":", stdout), print_value(c->node->value), putchar(',');
		printf("\"time\":%lld}}\n", (long long)c->node->change.time);
	} else if (strcmp(op, "make") == 0) {
		const op_value *r = reg(read_value(must(line, "root")));
		tb_key source, id;
		if (r->type == OP_LIST) {
			if (r->count != 2) refuse("entry: not two keys");
			source = key_of(r->items[0]);
			id = key_of(r->items[1]);
		} else {
			source = pl_root();
			id = key_of(r);
		}
		forget_places();
		places = make_places(source, id);
		puts("{}");
	} else if (strcmp(op, "get") == 0 || strcmp(op, "lookup") == 0) {
		size_t n;
		const char **address = address_of(line, &n);
		const char *f = field(line, "from");
		pl_at from_ = f ? spec(f) : (pl_at){0};
		const char *all = field(line, "all");
		pl_list *l = op[0] == 'g' ? pl_get(places, address, n, f ? &from_ : NULL)
					  : pl_lookup(places, address, n, f ? &from_ : NULL, all && strncmp(all, "true", 4) == 0);
		fputs("{\"items\":", stdout);
		answer_list(line, l, 1);
		fputs(",\"reads\":", stdout);
		print_reads();
		puts("}");
	} else if (strcmp(op, "names") == 0) {
		pl_strings s = pl_names(places, spec(must(line, "from")));
		fputs("{\"names\":[", stdout);
		for (size_t i = 0; i < s.n; i++) {
			if (i) putchar(',');
			text(s.names[i]);
		}
		fputs("],\"reads\":", stdout);
		print_reads();
		puts("}");
		pl_strings_free(s);
	} else if (strcmp(op, "open") == 0) {
		size_t n;
		const char **address = address_of(line, &n);
		const char *as = string_at(must(line, "as"));
		opened *o = opened_named(as);
		pl_held *h = pl_open(places, address, n);
		if (o) {
			if (nretired == cretired) {
				cretired = cretired ? cretired * 2 : 8;
				retired = realloc(retired, cretired * sizeof *retired);
				if (retired == NULL) fail("out of memory");
			}
			retired[nretired++] = o->held;
		} else {
			GROW(opens, nopens, copens);
			o = &opens[nopens++];
			o->name = strcpy(malloc(strlen(as) + 1), as);
		}
		o->held = h;
		o->has_last = 0;
		puts("{}");
	} else if (strcmp(op, "items") == 0) {
		opened *o = opened_named(string_at(must(line, "open")));
		if (o == NULL) refuse("no such open");
		const pl_list *l = pl_items(o->held);
		int same = o->has_last && o->last == l->serial;
		o->has_last = 1;
		o->last = l->serial;
		fputs("{\"items\":", stdout);
		answer_list(line, (pl_list *)l, 0);
		fputs(",\"reads\":", stdout);
		print_reads();
		printf(",\"same\":%s}\n", same ? "true" : "false");
	} else if (strcmp(op, "drop") == 0) {
		opened *o = opened_named(string_at(must(line, "open")));
		if (o) pl_drop(o->held);
		puts("{}");
	} else if (strcmp(op, "path") == 0) {
		const char *at = field(line, "at");
		char buf[96];
		snprintf(buf, sizeof buf, "{\"item\":%s,\"at\":%s}", raw(must(line, "item")), at ? raw(at) : "0");
		pl_at a = spec(buf);
		if (a.item == NULL) refuse("no such saved item");
		fputs("{\"path\":[", stdout);
		size_t n = pl_path(a.item, NULL, 0);
		const char **names = take((n ? n : 1) * sizeof *names);
		pl_path(a.item, names, n);
		for (size_t i = 0; i < n; i++) {
			if (i) putchar(',');
			text(names[i]);
		}
		puts("]}");
	} else if (strcmp(op, "place") == 0 || strcmp(op, "unplace") == 0 || strcmp(op, "order") == 0 ||
			strcmp(op, "rename") == 0 || strcmp(op, "move") == 0) {
		// every argument is read before places is asked, as the reference does
		const char *pspan = must(line, "parent"), *nspan = must(line, "name");
		pl_at parent = slot_at(pspan);
		const char *name = string_at(nspan);
		ch_header h = header_of(line);
		int code = PL_OK;
		const char *err = NULL;
		pl_changed changed = {0};
		if (strcmp(op, "place") == 0) {
			tb_key source, id;
			entry_of(must(line, "entry"), &source, &id);
			long index = whole(field(line, "index"), PL_END);
			if (index == PL_END && field(line, "index") != NULL && strncmp(field(line, "index"), "null", 4) != 0) index = LONG_MAX;
			forget_told();
			before_write();
			code = pl_place(places, parent, name, source, id, h, index, &err, &changed);
		} else if (strcmp(op, "unplace") == 0) {
			long index = whole(field(line, "index"), LONG_MAX);
			forget_told();
			before_write();
			code = pl_unplace(places, parent, name, index, h, &err, &changed);
		} else if (strcmp(op, "order") == 0) {
			long from_ = whole(field(line, "from"), LONG_MAX), to = whole(field(line, "to"), LONG_MAX);
			forget_told();
			before_write();
			code = pl_order(places, parent, name, from_, to, h, &err, &changed);
		} else if (strcmp(op, "rename") == 0) {
			const char *to = string_at(must(line, "to"));
			forget_told();
			before_write();
			code = pl_rename(places, parent, name, to, h, &err, &changed);
		} else {
			long index = whole(field(line, "index"), LONG_MAX);
			const char *dest = must(line, "to");
			pl_at toat = slot_at(must(dest, "parent"));
			const char *toname = string_at(must(dest, "name"));
			const char *ti = field(line, "toindex");
			long toindex = whole(ti, PL_END);
			forget_told();
			before_write();
			code = pl_move(places, parent, name, index, toat, toname, h, toindex, &err, &changed);
		}
		answer_write(code, err, &changed);
	} else printf("{\"error\":\"unknown op %s\"}\n", op);
}

int main(void) {
	char *line = NULL;
	size_t capacity = 0;
	places = make_places(pl_root(), tb_string("R"));
	// the first places: the root "R", an id
	while (getline(&line, &capacity, stdin) != -1) {
		if (strspn(line, " \t\r\n") == strlen(line)) continue;
		forget_told();
		if (setjmp(escape) == 0) answer(line);
		else printf("{\"error\":\"%s\"}\n", why);
		let_go();
		clear();
		fflush(stdout);
	}
	forget_places();
	for (size_t i = 0; i < nworld; i++) {
		if (!world[i].borrowed) nd_free(world[i].node);
		if (world[i].source.symbol == NULL) free((void *)world[i].source.string);
		if (world[i].id.symbol == NULL) free((void *)world[i].id.string);
	}
	free(world);
	free(opens);
	free(retired);
	free(saves);
	free(reads);
	free(befores);
	while (symbols) {
		symtok *next = symbols->next;
		free(symbols);
		symbols = next;
	}
	free(pool);
	free(line);
	finish();
	return 0;
}
