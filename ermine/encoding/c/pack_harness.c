// The C pack on the line protocol (conformance/pack/harness.ts): one JSON request per line in, one
// answer per line out. Requests are Json (json.h), values in their JSON form (ENCODING.tex: "/" for
// bytes, typed arrays, NaN and the infinities), made into op_values for pack; answers are written
// the same way. Bytes are hex.
//
// A symbol is a part or an id {"symbol": name}: a tb_key token, the name's address. One in a value
// or as a reader has no form in C: the node cannot be built, cannot-carry.
#include "json.h"
#include "json_text.h"
#include "pack.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// --- what a request allocates, freed when its answer is written ---

typedef struct {
	void **p;
	size_t n, capacity;
} bag;

static bag blocks, values, made;

static void keep(bag *b, void *p) {
	if (b->n == b->capacity) {
		b->capacity = b->capacity ? b->capacity * 2 : 64;
		b->p = realloc(b->p, b->capacity * sizeof *b->p);
		if (b->p == NULL) abort();
	}
	b->p[b->n++] = p;
}

static void *take(size_t size) {
	void *p = allocate(size);
	keep(&blocks, p);
	return p;
}

static void clear(void) {
	for (size_t i = 0; i < made.n; i++) nd_free_entry(made.p[i]);
	for (size_t i = 0; i < values.n; i++) op_free(values.p[i]);
	for (size_t i = 0; i < blocks.n; i++) free(blocks.p[i]);
	made.n = values.n = blocks.n = 0;
}

// --- a request's nodes ---

// a value from its JSON form, kept for the request; NULL: the form stands for none
static op_value *value_of(Json **slot) {
	// a symbol form has no form here: jsonDecode refuses it
	if (!jsonDecode(slot)) return NULL;
	op_value *v = pk_of_json(*slot);
	keep(&values, v);
	return v;
}

// set when a number given is not one a C node holds (a safe integer, never -0): that node has no
// form, as the reference refuses it
static int bent;

static long number_of(const Json *j) {
	if (j == NULL || !jsonIsNumber(j)) return 0;
	double d = j->number;
	if (!(d >= -9007199254740991.0 && d <= 9007199254740991.0) || d != floor(d) || (d == 0 && signbit(d))) {
		bent = 1;
		return 0;
	}
	return (long)d;
}

static Json **at(Json *j, const char *key) {
	if (j == NULL || j->type != JSON_OBJECT) return NULL;
	for (int i = 0; i < j->object.count; i++)
		if (strcmp(j->object.members[i].key, key) == 0) return &j->object.members[i].value;
	return NULL;
}

static int target(Json *x, op_target *t) {
	Json **path = at(x, "path"), **range = at(x, "range");
	size_t n = path ? (size_t)(*path)->array.count : 0;
	op_key *ks = take(n * sizeof *ks);
	for (size_t i = 0; i < n; i++) {
		const Json *k = (*path)->array.items[i];
		if (jsonIsString(k)) ks[i] = (op_key){.type = OP_STR_KEY, .s = jsonText(k)};
		else ks[i] = (op_key){.type = OP_NUM_KEY, .n = number_of(k)};
	}
	t->path = ks;
	t->length = n;
	if (range != NULL) {
		t->has_range = 1;
		t->from = number_of((*range)->array.items[0]);
		t->to = number_of((*range)->array.items[1]);
	}
	return 1;
}

static int patches(Json *list, const op_patch **out, size_t *n) {
	*n = (size_t)list->array.count;
	op_patch *ps = *n ? take(*n * sizeof *ps) : NULL;
	for (size_t i = 0; i < *n; i++) {
		Json *p = list->array.items[i];
		Json **value = at(p, "value"), **move = at(p, "move");
		target(p, &ps[i].place);
		if (value != NULL) {
			ps[i].has_value = 1;
			if ((ps[i].value = value_of(value)) == NULL) return 0;
		}
		if (move != NULL) ps[i].has_move = 1, target(*move, &ps[i].move);
	}
	*out = ps;
	return 1;
}

// a change as the protocol has it; 0: a value in it has no form
static int header(Json *c, ch_header *h) {
	Json **time = at(c, "time"), **actor = at(c, "actor"), **reader = at(c, "reader");
	Json **external = at(c, "external"), **metadata = at(c, "metadata"), **op = at(c, "op");
	if (time != NULL) h->has_time = 1, h->time = number_of(*time);
	if (actor != NULL && (h->actor = value_of(actor)) == NULL) return 0;
	if (reader != NULL) {
		if (!jsonIsString(*reader)) return 0;
		h->reader = jsonText(*reader);
	}
	if (external != NULL) {
		size_t n = (size_t)(*external)->array.count;
		ch_site *ss = take((n + 1) * sizeof *ss);
		for (size_t i = 0; i < n; i++) {
			Json *s = (*external)->array.items[i];
			Json **column = at(s, "column"), **function = at(s, "function");
			ss[i].file = jsonText(*at(s, "file"));
			ss[i].line = number_of(*at(s, "line"));
			if (column != NULL) ss[i].has_column = 1, ss[i].column = number_of(*column);
			if (function != NULL) ss[i].function = jsonText(*function);
		}
		h->external = ss;
		h->external_length = n;
	}
	if (metadata != NULL) {
		size_t n = (size_t)(*metadata)->array.count;
		ch_entry *es = take((n + 1) * sizeof *es);
		for (size_t i = 0; i < n; i++) {
			Json *e = (*metadata)->array.items[i];
			es[i].key = jsonText(e->array.items[0]);
			if ((es[i].value = value_of(&e->array.items[1])) == NULL) return 0;
		}
		h->metadata = es;
		h->metadata_length = n;
	}
	if (op != NULL) {
		h->has_op = 1;
		if (!patches(*at(*op, "patches"), &h->patches, &h->patches_length)) return 0;
		if (!patches(*at(*op, "undo"), &h->undo, &h->undo_length)) return 0;
	}
	return 1;
}

// a node as the protocol has it, made; NULL: a value in it has no form
static nd_entry *node_of(Json *s) {
	Json **value = at(s, "value"), **change = at(s, "change");
	op_value *v = NULL;
	ch_header h = {0};
	if (value != NULL && (v = value_of(value)) == NULL) return NULL;
	bent = 0;
	if (!header(*change, &h) || bent) return NULL;
	nd_entry_options options = {.in_place = at(s, "cow") != NULL};
	nd_entry *n = nd_make_entry(v, &h, &options);
	if (n == NULL) abort();
	keep(&made, n);
	return n;
}

// --- answers ---

static Json *show_target(Json *to, const op_target *t) {
	Json *path = jsonArray();
	jsonAdd(to, "path", path);
	for (size_t i = 0; i < t->length; i++) {
		const op_key *k = &t->path[i];
		jsonPush(path, k->type == OP_STR_KEY ? jsonString(k->s) : jsonNumber((double)k->n));
	}
	if (t->has_range) {
		Json *range = jsonArray();
		jsonPush(range, jsonNumber((double)t->from));
		jsonPush(range, jsonNumber((double)t->to));
		jsonAdd(to, "range", range);
	}
	return to;
}

static Json *show_patches(const op_patch *ps, size_t n) {
	Json *list = jsonArray();
	for (size_t i = 0; i < n; i++) {
		Json *p = show_target(jsonObject(), &ps[i].place);
		if (ps[i].has_value) jsonAdd(p, "value", pk_to_json(ps[i].value));
		if (ps[i].has_move) jsonAdd(p, "move", show_target(jsonObject(), &ps[i].move));
		jsonPush(list, p);
	}
	return list;
}

static Json *show_node(const nd_entry *n) {
	const ch_header *h = &n->change;
	Json *out = jsonObject(), *c = jsonObject();
	jsonAdd(out, "change", c);
	if (h->has_time) jsonAdd(c, "time", jsonNumber((double)h->time));
	if (h->actor) jsonAdd(c, "actor", pk_to_json(h->actor));
	if (h->reader) jsonAdd(c, "reader", jsonString(h->reader));
	if (h->external) {
		Json *sites = jsonArray();
		for (size_t i = 0; i < h->external_length; i++) {
			const ch_site *s = &h->external[i];
			Json *site = jsonObject();
			jsonAdd(site, "file", jsonString(s->file));
			jsonAdd(site, "line", jsonNumber((double)s->line));
			if (s->has_column) jsonAdd(site, "column", jsonNumber((double)s->column));
			if (s->function) jsonAdd(site, "function", jsonString(s->function));
			jsonPush(sites, site);
		}
		jsonAdd(c, "external", sites);
	}
	if (h->metadata) {
		Json *entries = jsonArray();
		for (size_t i = 0; i < h->metadata_length; i++) {
			Json *entry = jsonArray();
			jsonPush(entry, jsonString(h->metadata[i].key));
			jsonPush(entry, pk_to_json(h->metadata[i].value));
			jsonPush(entries, entry);
		}
		jsonAdd(c, "metadata", entries);
	}
	if (h->has_op) {
		Json *op = jsonObject();
		jsonAdd(op, "patches", show_patches(h->patches, h->patches_length));
		jsonAdd(op, "undo", show_patches(h->undo, h->undo_length));
		jsonAdd(c, "op", op);
	}
	if (n->value) jsonAdd(out, "value", pk_to_json(n->value));
	if (n->in_place) jsonAdd(out, "cow", jsonBoolean(false));
	return out;
}

static void answer(Json *j) {
	char *s = jsonPrint(j);
	puts(s);
	free(s);
	jsonFree(j);
}

static Json *hex(const pk_bytes *b) {
	char *s = allocate(2 * b->length + 1);
	for (size_t i = 0; i < b->length; i++) snprintf(s + 2 * i, 3, "%02x", b->data[i]);
	Json *j = jsonObject();
	jsonAdd(j, "bytes", jsonStringTaking(s, 2 * b->length));
	return j;
}

// a key as the protocol has it: a string, or {"symbol": name}
static Json *shown_key(tb_key k) {
	if (k.symbol == NULL) return jsonString(k.string);
	Json *j = jsonObject();
	jsonAdd(j, "symbol", jsonString(k.symbol));
	return j;
}

static void refused(pk_code code, const pk_entry *where) {
	Json *j = jsonObject();
	jsonAdd(j, "code", jsonString(pk_code_name(code)));
	if (where != NULL) {
		jsonAdd(j, "part", shown_key(where->part));
		jsonAdd(j, "id", shown_key(where->id));
	}
	answer(j);
}

static uint8_t *unhex(const Json *j, size_t *n) {
	const char *s = jsonText(j);
	*n = strlen(s) / 2;
	uint8_t *bytes = take(*n);
	for (size_t i = 0; i < *n; i++) {
		unsigned x;
		if (sscanf(s + 2 * i, "%2x", &x) != 1) abort();
		bytes[i] = (uint8_t)x;
	}
	return bytes;
}

// --- requests ---

// a part or an id: a string, or {"symbol": name}
static tb_key key_of(const Json *j) {
	if (jsonIsString(j)) return tb_string(jsonText(j));
	return tb_symbol(jsonText(jsonGet(j, "symbol")));
}

// {"options": {"op": false}} and {"reading": {"loosyGoosy": true, "limit": 1000}}
static pk_options options_of(Json *r) {
	Json **o = at(r, "options"), **op = o ? at(*o, "op") : NULL;
	return (pk_options){.no_op = op != NULL && (*op)->type == JSON_BOOLEAN && !(*op)->boolean};
}

static pk_reading reading_of(Json *r) {
	Json **o = at(r, "reading"), **l = o ? at(*o, "loosyGoosy") : NULL, **n = o ? at(*o, "limit") : NULL;
	return (pk_reading){.loosy = l != NULL && (*l)->type == JSON_BOOLEAN && (*l)->boolean,
		.limit = n != NULL && jsonIsNumber(*n) ? (size_t)(*n)->number : 0};
}

static void do_pack(Json *r) {
	Json **given = at(r, "nodes"), **list = at(r, "entries");
	size_t nn = given ? (size_t)(*given)->array.count : 0, ne = list ? (size_t)(*list)->array.count : 0;
	nd_entry **nodes = take(nn * sizeof *nodes + 1);
	for (size_t i = 0; i < nn; i++) {
		if ((nodes[i] = node_of((*given)->array.items[i])) == NULL) {
			refused(PK_CANNOT_CARRY, NULL);
			return;
		}
	}
	pk_entry *es = take(ne * sizeof *es + 1);
	for (size_t i = 0; i < ne; i++) {
		const Json *e = (*list)->array.items[i];
		es[i] = (pk_entry){key_of(e->array.items[0]), key_of(e->array.items[1]),
			nodes[(size_t)e->array.items[2]->number]};
	}
	pk_options opts = options_of(r);
	pk_bytes b = {0};
	const pk_entry *where = NULL;
	pk_code code = pk_pack(es, ne, &opts, &b, &where);
	if (code == PK_OK) answer(hex(&b));
	else refused(code, where);
	free(b.data);
}

static void do_unpack(Json *r) {
	size_t n;
	uint8_t *bytes = unhex(*at(r, "bytes"), &n);
	pk_reading reading = reading_of(r);
	pk_read g;
	pk_code code = pk_unpack(bytes, n, &reading, &g);
	if (code != PK_OK) {
		refused(code, NULL);
		return;
	}
	Json *j = jsonObject(), *entries = jsonArray(), *nodes = jsonArray();
	for (size_t i = 0; i < g.length; i++) {
		size_t k = 0;
		while (g.nodes[k] != g.entries[i].node) k++;
		Json *e = jsonArray();
		jsonPush(e, jsonString(g.entries[i].part.string));
		jsonPush(e, jsonString(g.entries[i].id.string));
		jsonPush(e, jsonNumber((double)k));
		jsonPush(entries, e);
	}
	for (size_t i = 0; i < g.count; i++) jsonPush(nodes, show_node(g.nodes[i]));
	jsonAdd(j, "entries", entries);
	jsonAdd(j, "nodes", nodes);
	answer(j);
	pk_free(&g);
}

static void do_encode(Json *r) {
	nd_entry *n = node_of(*at(r, "node"));
	if (n == NULL) {
		refused(PK_CANNOT_CARRY, NULL);
		return;
	}
	pk_options opts = options_of(r);
	pk_bytes b = {0};
	pk_code code = pk_encode(n, &opts, &b);
	if (code == PK_OK) answer(hex(&b));
	else refused(code, NULL);
	free(b.data);
}

static void do_decode(Json *r) {
	size_t n;
	uint8_t *bytes = unhex(*at(r, "bytes"), &n);
	pk_reading reading = reading_of(r);
	pk_read g;
	pk_code code = pk_decode(bytes, n, &reading, &g);
	if (code != PK_OK) {
		refused(code, NULL);
		return;
	}
	Json *j = jsonObject();
	jsonAdd(j, "node", show_node(g.nodes[0]));
	answer(j);
	pk_free(&g);
}

int main(void) {
	char *line = NULL;
	size_t capacity = 0;
	ssize_t length;
	while ((length = getline(&line, &capacity, stdin)) != -1) {
		if (strspn(line, " \t\r\n") == (size_t)length) continue;
		char *why = NULL;
		Json *r = jsonParse(line, (size_t)length, &why);
		if (r == NULL) {
			fprintf(stderr, "harness: %s\n", why);
			return 1;
		}
		const char *op = jsonText(jsonGet(r, "op"));
		if (op == NULL) return fputs("harness: no op\n", stderr), 1;
		if (strcmp(op, "pack") == 0) do_pack(r);
		else if (strcmp(op, "unpack") == 0) do_unpack(r);
		else if (strcmp(op, "encode") == 0) do_encode(r);
		else if (strcmp(op, "decode") == 0) do_decode(r);
		else {
			Json *j = jsonObject();
			jsonAdd(j, "error", jsonString("unknown op"));
			answer(j);
		}
		clear();
		jsonFree(r);
	}
	fflush(stdout);
	free(line);
	return 0;
}
