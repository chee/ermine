// Nodes under keys (pack.h), in C. A node is built as a Json tree, and its pieces written by
// cbor.c: the one canonical encoding, so the bytes are pack.ts's; the columns pack.ts's header
// lists are made from them, and deflated (deflate.c, included here). Reading is the reverse:
// cbor.c's tree is checked as pack.ts checks it, then made into nodes.
#include "pack.h"

#include "cbor.h"

#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "deflate.c"

_Static_assert((int)JSON_FLOAT64 == (int)OP_FLOAT64 && (int)JSON_INT8 == (int)OP_INT8 &&
		(int)JSON_UINT32 == (int)OP_UINT32,
	"typed arrays' kinds are in one order");
#if defined(__BYTE_ORDER__) && __BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__
#error "a typed array is copied between json.h and value.h as it is: little-endian machines only"
#endif

static void *xrealloc(void *p, size_t n) {
	void *q = realloc(p, n);
	if (q == NULL && n != 0) {
		fputs("pack: out of memory\n", stderr);
		abort();
	}
	return q;
}
// room for one more at index count
#define GROW(p, count, capacity) \
	do { \
		if ((count) == (capacity)) { \
			(capacity) = (capacity) ? (capacity) * 2 : 8; \
			(p) = xrealloc((p), (capacity) * sizeof *(p)); \
		} \
	} while (0)

const char *pk_code_name(pk_code code) {
	switch (code) {
	case PK_NOT_A_PACK: return "not-a-pack";
	case PK_NOT_A_NODE: return "not-a-node";
	case PK_CANNOT_CARRY: return "cannot-carry";
	case PK_ALREADY_THERE: return "already-there";
	case PK_OK: break;
	}
	return "";
}

// --- bytes ---

static void room(pk_bytes *b, size_t more) {
	if (b->length + more <= b->capacity) return;
	size_t c = b->capacity ? b->capacity : 256;
	while (c < b->length + more) c *= 2;
	b->data = xrealloc(b->data, c);
	b->capacity = c;
}

static void put(pk_bytes *b, const void *data, size_t n) {
	room(b, n);
	if (n) memcpy(b->data + b->length, data, n);
	b->length += n;
}

// a head: the major type and its argument, in the fewest bytes
static void head(pk_bytes *b, int major, uint64_t n) {
	uint8_t h[9];
	size_t size = 1;
	h[0] = (uint8_t)(major << 5);
	if (n < 24) h[0] |= (uint8_t)n;
	else {
		int bytes = n < 0x100 ? 1 : n < 0x10000 ? 2 : n < 0x100000000u ? 4 : 8;
		h[0] |= (uint8_t)(bytes == 1 ? 24 : bytes == 2 ? 25 : bytes == 4 ? 26 : 27);
		for (int i = 0; i < bytes; i++) h[1 + i] = (uint8_t)(n >> (8 * (bytes - 1 - i)));
		size += (size_t)bytes;
	}
	put(b, h, size);
}

// text as cbor.c writes it: U+0000, held as C0 80, is the byte 00
static void text(pk_bytes *b, const char *s) {
	size_t n = strlen(s), real = n;
	for (size_t i = 0; i + 1 < n; i++)
		if ((unsigned char)s[i] == 0xC0 && (unsigned char)s[i + 1] == 0x80) real--, i++;
	head(b, 3, real);
	if (real == n) {
		put(b, s, n);
		return;
	}
	room(b, real);
	for (size_t i = 0; i < n; i++) {
		if ((unsigned char)s[i] == 0xC0 && i + 1 < n && (unsigned char)s[i + 1] == 0x80) {
			b->data[b->length++] = 0;
			i++;
		} else b->data[b->length++] = (uint8_t)s[i];
	}
}

// a number, as the shortest float
static void number(pk_bytes *b, double d) {
	Json j = {.type = JSON_NUMBER, .number = d};
	unsigned char buf[9];
	size_t n;
	cborEncode(&j, buf, sizeof buf, &n, NULL);
	put(b, buf, n);
}

// a key as it sorts (the encoding of [part, id]), written to b; 0 when a string is no text
static int key_bytes(pk_bytes *b, const char *part, const char *id) {
	if (!cborText(part, strlen(part)) || !cborText(id, strlen(id))) return 0;
	head(b, 4, 2);
	text(b, part);
	text(b, id);
	return 1;
}

// --- values and Json ---

// a container being made, and where it is in the one it comes from; kid: a stand-in's kind
typedef struct {
	const op_value *from;
	Json *to, *kid;
	size_t at;
} down;

static Json *leaf(const op_value *v) {
	switch (v->type) {
	case OP_NULL: return jsonNull();
	case OP_BOOL: return jsonBoolean(v->bool_);
	case OP_NUM: return jsonNumber(v->num);
	case OP_STR: return jsonStringOfLength(v->str, v->bytes);
	case OP_BYTES: return jsonBytes(v->data, v->bytes);
	case OP_TYPED: return jsonTyped((JsonKind)v->kind, v->data, op_length(v));
	default: return NULL;
	}
}

Json *pk_to_json(const op_value *root) {
	down *stack = NULL;
	size_t n = 0, capacity = 0;
	Json *out = NULL;
	const op_value *v = root;
	for (;;) {
		Json *j;
		if (v != NULL) {
			if (v->type == OP_LIST || v->type == OP_MAP || v->type == OP_STAND) {
				GROW(stack, n, capacity);
				Json *to = v->type == OP_LIST ? jsonArray() : v->type == OP_MAP ? jsonObject() : NULL;
				stack[n++] = (down){v, to, NULL, 0};
				v = NULL;
				continue;
			}
			j = leaf(v);
			v = NULL;
			if (j == NULL) goto bad;
		} else {
			down *f = &stack[n - 1];
			if (f->at < f->from->count) {
				v = f->from->items[f->at++];
				continue;
			}
			if (f->from->type == OP_STAND) j = f->kid != NULL ? jsonStand(f->kid) : NULL;
			else j = f->to;
			if (j == NULL) goto bad;
			n--;
		}
		if (n == 0) {
			out = j;
			break;
		}
		down *f = &stack[n - 1];
		if (f->from->type == OP_LIST) jsonPush(f->to, j);
		else if (f->from->type == OP_MAP) jsonAdd(f->to, f->from->keys[f->at - 1], j);
		else f->kid = j;
	}
	free(stack);
	return out;
bad:
	for (size_t i = 0; i < n; i++) jsonFree(stack[i].to), jsonFree(stack[i].kid);
	free(stack);
	return NULL;
}

// the same, from Json
typedef struct {
	const Json *from;
	op_value *to, *kid;
	int at;
} up;

static op_value *of_leaf(const Json *j) {
	switch (j->type) {
	case JSON_NULL: return op_null();
	case JSON_BOOLEAN: return op_bool(j->boolean);
	case JSON_NUMBER: return op_num(j->number);
	case JSON_STRING: return op_str_n(j->string, j->stringLength);
	case JSON_BYTES: return op_bytes(j->bytes.data, j->bytes.length);
	default: return op_typed((op_elements)j->typed.kind, j->typed.data, j->typed.count);
	}
}

static int children(const Json *j) {
	return j->type == JSON_ARRAY ? j->array.count : j->type == JSON_OBJECT ? j->object.count : 1;
}

op_value *pk_of_json(const Json *root) {
	up *stack = NULL;
	size_t n = 0, capacity = 0;
	op_value *out = NULL;
	const Json *j = root;
	for (;;) {
		op_value *v;
		if (j != NULL) {
			if (j->type == JSON_ARRAY || j->type == JSON_OBJECT || j->type == JSON_STAND) {
				GROW(stack, n, capacity);
				op_value *to = j->type == JSON_ARRAY ? op_list() : j->type == JSON_OBJECT ? op_map() : NULL;
				stack[n++] = (up){j, to, NULL, 0};
				j = NULL;
				continue;
			}
			v = of_leaf(j);
			j = NULL;
		} else {
			up *f = &stack[n - 1];
			if (f->at < children(f->from)) {
				int i = f->at++;
				j = f->from->type == JSON_ARRAY ? f->from->array.items[i]
					: f->from->type == JSON_OBJECT ? f->from->object.members[i].value
					: f->from->stand.kind;
				continue;
			}
			v = f->from->type == JSON_STAND ? op_stand(f->kid) : f->to;
			n--;
		}
		if (n == 0) {
			out = v;
			break;
		}
		up *f = &stack[n - 1];
		if (f->from->type == JSON_ARRAY) op_push(f->to, v);
		else if (f->from->type == JSON_OBJECT) op_set(f->to, f->from->object.members[f->at - 1].key, v);
		else f->kid = v;
	}
	free(stack);
	return out;
}

// --- writing ---

// whether a whole number is one pack writes: a safe integer, as whole reads it
static int safe(long long v) { return v >= -9007199254740991LL && v <= 9007199254740991LL; }

// path and range of a target, added to its object; 0 when a key is no key
static int target(Json *to, const op_target *t) {
	Json *path = jsonArray();
	jsonAdd(to, "path", path);
	for (size_t i = 0; i < t->length; i++) {
		const op_key *k = &t->path[i];
		if (k->type == OP_NUM_KEY && safe(k->n)) jsonPush(path, jsonNumber((double)k->n));
		else if (k->type == OP_STR_KEY && k->s != NULL) jsonPush(path, jsonString(k->s));
		else return 0;
	}
	if (t->has_range) {
		if (!safe(t->from) || !safe(t->to)) return 0;
		Json *range = jsonArray();
		jsonPush(range, jsonNumber((double)t->from));
		jsonPush(range, jsonNumber((double)t->to));
		jsonAdd(to, "range", range);
	}
	return 1;
}

// a patch; NULL when it cannot be carried
static Json *json_patch(const op_patch *p) {
	Json *j = jsonObject();
	if (!target(j, &p->place)) goto bad;
	if (p->has_value) {
		if (p->value == NULL) goto bad;
		Json *v = pk_to_json(p->value);
		if (v == NULL) goto bad;
		jsonAdd(j, "value", v);
	}
	if (p->has_move) {
		Json *move = jsonObject();
		jsonAdd(j, "move", move);
		if (!target(move, &p->move)) goto bad;
	}
	return j;
bad:
	jsonFree(j);
	return NULL;
}

static int json_patches(Json *to, const char *name, const op_patch *ps, size_t n) {
	Json *patches = jsonArray();
	jsonAdd(to, name, patches);
	for (size_t i = 0; i < n; i++) {
		Json *p = json_patch(&ps[i]);
		if (p == NULL) return 0;
		jsonPush(patches, p);
	}
	return 1;
}

// a node as it is written; NULL when it cannot be carried
static Json *json_node(const nd_entry *n, const pk_options *o) {
	const ch_header *h = &n->change;
	Json *node = jsonObject(), *change = jsonObject();
	jsonAdd(node, "change", change);
	if (!h->has_time || !safe(h->time)) goto bad;
	jsonAdd(change, "time", jsonNumber((double)h->time));
	if (h->actor != NULL) {
		Json *a = pk_to_json(h->actor);
		if (a == NULL) goto bad;
		jsonAdd(change, "actor", a);
	}
	if (h->reader != NULL) jsonAdd(change, "reader", jsonString(h->reader));
	if (h->external != NULL) {
		Json *sites = jsonArray();
		jsonAdd(change, "external", sites);
		for (size_t i = 0; i < h->external_length; i++) {
			const ch_site *s = &h->external[i];
			if (s->file == NULL || !safe(s->line) || (s->has_column && !safe(s->column))) goto bad;
			Json *site = jsonObject();
			jsonPush(sites, site);
			jsonAdd(site, "file", jsonString(s->file));
			jsonAdd(site, "line", jsonNumber((double)s->line));
			if (s->has_column) jsonAdd(site, "column", jsonNumber((double)s->column));
			if (s->function != NULL) jsonAdd(site, "function", jsonString(s->function));
		}
	}
	if (h->metadata != NULL) {
		Json *entries = jsonArray();
		jsonAdd(change, "metadata", entries);
		for (size_t i = 0; i < h->metadata_length; i++) {
			const ch_entry *e = &h->metadata[i];
			if (e->key == NULL || e->value == NULL) goto bad;
			Json *v = pk_to_json(e->value);
			if (v == NULL) goto bad;
			Json *entry = jsonArray();
			jsonPush(entries, entry);
			jsonPush(entry, jsonString(e->key));
			jsonPush(entry, v);
		}
	}
	if (h->has_op && !(o != NULL && o->no_op)) {
		Json *op = jsonObject();
		jsonAdd(change, "op", op);
		if (!json_patches(op, "patches", h->patches, h->patches_length) ||
			!json_patches(op, "undo", h->undo, h->undo_length))
			goto bad;
	}
	if (n->value != NULL) {
		Json *v = pk_to_json(n->value);
		if (v == NULL) goto bad;
		jsonAdd(node, "value", v);
	}
	// cow: false is a node changed in place
	if (n->in_place) jsonAdd(node, "cow", jsonBoolean(false));
	return node;
bad:
	jsonFree(node);
	return NULL;
}

// a value's encoding, appended to out; 0 when it cannot be carried
static int json_bytes(const Json *j, pk_bytes *out) {
	size_t length = 0;
	room(out, 1);
	int ok = cborEncode(j, out->data + out->length, out->capacity - out->length, &length, NULL);
	if (ok && length > out->capacity - out->length) {
		room(out, length);
		ok = cborEncode(j, out->data + out->length, out->capacity - out->length, &length, NULL);
	}
	if (ok) out->length += length;
	return ok;
}

// a node's encoding, appended to out; 0 when it cannot be carried
static int node_bytes(const nd_entry *n, const pk_options *o, pk_bytes *out) {
	Json *j = json_node(n, o);
	if (j == NULL) return 0;
	int ok = json_bytes(j, out);
	jsonFree(j);
	return ok;
}

pk_code pk_encode(const nd_entry *node, const pk_options *options, pk_bytes *out) {
	return node_bytes(node, options, out) ? PK_OK : PK_CANNOT_CARRY;
}

// an entry with its key's encoding, at keys[off, off + length)
typedef struct {
	size_t off, length;
	const pk_entry *entry;
} row;

static int compare(const uint8_t *keys, const row *a, const row *b) {
	size_t n = a->length < b->length ? a->length : b->length;
	int c = memcmp(keys + a->off, keys + b->off, n);
	if (c != 0) return c;
	return a->length < b->length ? -1 : a->length > b->length;
}

// stable, bottom-up: the rows by their keys' encodings
static void sort(row *rows, size_t n, const uint8_t *keys) {
	row *tmp = xrealloc(NULL, (n ? n : 1) * sizeof *tmp);
	for (size_t width = 1; width < n; width *= 2) {
		for (size_t lo = 0; lo < n; lo += 2 * width) {
			size_t mid = lo + width < n ? lo + width : n, hi = lo + 2 * width < n ? lo + 2 * width : n;
			size_t i = lo, j = mid, k = lo;
			while (i < mid && j < hi) tmp[k++] = compare(keys, &rows[j], &rows[i]) < 0 ? rows[j++] : rows[i++];
			while (i < mid) tmp[k++] = rows[i++];
			while (j < hi) tmp[k++] = rows[j++];
		}
		memcpy(rows, tmp, n * sizeof *rows);
	}
	free(tmp);
}

// nodes numbered: open addressing on the node's address, kept under half full
typedef struct {
	const nd_entry *node;
	size_t number;
} seat;

// ids numbered: the same, on the text
typedef struct {
	const char *id;
	size_t number;
} id_seat;

// a column of items: their encodings back to back, and where each starts
typedef struct {
	pk_bytes data;
	size_t *start, n, capacity;
} column;

// a new item, written to c->data by the caller
static void begin(column *c) {
	GROW(c->start, c->n, c->capacity);
	c->start[c->n++] = c->data.length;
}

static size_t item_length(const column *c, size_t i) {
	return (i + 1 < c->n ? c->start[i + 1] : c->data.length) - c->start[i];
}

static int same_item(const column *c, size_t i, size_t j) {
	return item_length(c, i) == item_length(c, j) &&
		memcmp(c->data.data + c->start[i], c->data.data + c->start[j], item_length(c, i)) == 0;
}

static void free_column(column *c) {
	free(c->data.data);
	free(c->start);
}

// whole numbers, 7 bits a byte, the low first, the high bit on all but the last
static void var(pk_bytes *b, uint64_t x) {
	while (x >= 128) {
		uint8_t byte = (uint8_t)((x & 127) | 128);
		put(b, &byte, 1);
		x >>= 7;
	}
	uint8_t byte = (uint8_t)x;
	put(b, &byte, 1);
}

// everything a pack is made of
typedef struct {
	column ids, parts, actor, reader, external, metadata, op, values;
	pk_bytes which, named, has, time;
	int64_t before;
} packing;

static void free_packing(packing *p) {
	free_column(&p->ids), free_column(&p->parts), free_column(&p->actor), free_column(&p->reader);
	free_column(&p->external), free_column(&p->metadata), free_column(&p->op), free_column(&p->values);
	free(p->which.data), free(p->named.data), free(p->has.data), free(p->time.data);
}

enum { HAS_ACTOR = 1, HAS_READER = 2, HAS_EXTERNAL = 4, HAS_METADATA = 8, HAS_OP = 16, HAS_VALUE = 32, HAS_COW = 64 };

// a node's pieces, each in its column, and what it has and its time; 0 when it cannot be carried
static int node_pieces(const nd_entry *n, const pk_options *o, packing *p) {
	Json *node = json_node(n, o);
	if (node == NULL) return 0;
	const Json *change = jsonGet(node, "change"), *x;
	unsigned has = 0;
#define PIECE(from, field, bit, column) \
	if ((x = jsonGet(from, field)) != NULL) { \
		has |= (bit); \
		begin(&p->column); \
		if (!json_bytes(x, &p->column.data)) goto bad; \
	}
	PIECE(change, "actor", HAS_ACTOR, actor)
	PIECE(change, "reader", HAS_READER, reader)
	PIECE(change, "external", HAS_EXTERNAL, external)
	PIECE(change, "metadata", HAS_METADATA, metadata)
	PIECE(change, "op", HAS_OP, op)
	PIECE(node, "value", HAS_VALUE, values)
#undef PIECE
	if (jsonGet(node, "cow") != NULL) has |= HAS_COW;
	var(&p->has, has);
	// the time, as its difference from the one before, zigzag
	int64_t time = (int64_t)jsonGet(change, "time")->number, d = time - p->before;
	var(&p->time, d >= 0 ? (uint64_t)d * 2 : (uint64_t)(-d) * 2 - 1);
	p->before = time;
	jsonFree(node);
	return 1;
bad:
	jsonFree(node);
	return 0;
}

// an ermine:// id: the scheme, then 64 lowercase hex digits
static int ermine_id(const char *id, uint8_t *bytes) {
	if (strlen(id) != 73 || memcmp(id, "ermine://", 9) != 0) return 0;
	for (int i = 0; i < 32; i++) {
		int v = 0;
		for (int k = 0; k < 2; k++) {
			char c = id[9 + 2 * i + k];
			int digit = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1;
			if (digit < 0) return 0;
			v = v * 16 + digit;
		}
		bytes[i] = (uint8_t)v;
	}
	return 1;
}

static size_t text_hash(const char *s) {
	uint64_t h = 1469598103934665603u;
	for (; *s; s++) h = (h ^ (unsigned char)*s) * 1099511628211u;
	return (size_t)h;
}

// each stretch of equal items as [it, how many]: the list of them, written to out
static void runs(const column *c, pk_bytes *out) {
	size_t count = 0, j;
	for (size_t i = 0; i < c->n; i = j) {
		for (j = i + 1; j < c->n && same_item(c, j, i);) j++;
		count++;
	}
	head(out, 4, count);
	for (size_t i = 0; i < c->n; i = j) {
		for (j = i + 1; j < c->n && same_item(c, j, i);) j++;
		put(out, "\x82", 1);
		put(out, c->data.data + c->start[i], item_length(c, i));
		number(out, (double)(j - i));
	}
}

// the items, a list
static void list(const column *c, pk_bytes *out) {
	head(out, 4, c->n);
	put(out, c->data.data, c->data.length);
}

// a byte string
static void byte_string(const pk_bytes *b, pk_bytes *out) {
	head(out, 2, b->length);
	put(out, b->data, b->length);
}

// the map of columns being made: a name and its value at a time, then v is spent
typedef struct {
	pk_bytes map;
	size_t count;
} fields;

static void field(fields *f, const char *name, pk_bytes *v) {
	text(&f->map, name);
	put(&f->map, v->data, v->length);
	f->count++;
	v->length = 0;
}

pk_code pk_pack(const pk_entry *entries, size_t length, const pk_options *options, pk_bytes *out,
	const pk_entry **at) {
	pk_code code = PK_OK;
	row *rows = xrealloc(NULL, (length ? length : 1) * sizeof *rows);
	size_t n = 0, slots = 4, count = 0, id_count = 0;
	pk_bytes keys = {0};
	packing p = {0};
	seat *seats = NULL;
	id_seat *id_seats = NULL;
	for (size_t i = 0; i < length; i++) {
		const pk_entry *e = &entries[i];
		size_t off = keys.length;
		// a symbol has no encoding
		if (e->part.symbol != NULL || e->id.symbol != NULL ||
			!key_bytes(&keys, e->part.string, e->id.string)) {
			if (at != NULL) *at = e;
			code = PK_CANNOT_CARRY;
			goto done;
		}
		rows[n++] = (row){off, keys.length - off, e};
	}
	sort(rows, n, keys.data);
	while (slots < 2 * n + 2) slots *= 2;
	seats = xrealloc(NULL, slots * sizeof *seats);
	id_seats = xrealloc(NULL, slots * sizeof *id_seats);
	memset(seats, 0, slots * sizeof *seats);
	memset(id_seats, 0, slots * sizeof *id_seats);
	const row *last = NULL;
	for (size_t i = 0; i < n; i++) {
		const row *r = &rows[i];
		const pk_entry *e = r->entry;
		if (last != NULL && compare(keys.data, last, r) == 0) {
			if (last->entry->node != e->node) {
				if (at != NULL) *at = e;
				code = PK_ALREADY_THERE;
				goto done;
			}
			continue;
		}
		last = r;
		begin(&p.parts);
		text(&p.parts.data, e->part.string);
		// its id's place in the ids, which are in the order the keys first name them
		size_t s = text_hash(e->id.string) & (slots - 1);
		while (id_seats[s].id != NULL && strcmp(id_seats[s].id, e->id.string) != 0) s = (s + 1) & (slots - 1);
		if (id_seats[s].id == NULL) {
			id_seats[s] = (id_seat){e->id.string, id_count++};
			uint8_t raw[32];
			begin(&p.ids);
			if (ermine_id(e->id.string, raw)) head(&p.ids.data, 2, 32), put(&p.ids.data, raw, 32);
			else text(&p.ids.data, e->id.string);
		}
		var(&p.which, id_seats[s].number);
		s = (size_t)(((uintptr_t)e->node >> 4) * 0x9E3779B97F4A7C15u) & (slots - 1);
		while (seats[s].node != NULL && seats[s].node != e->node) s = (s + 1) & (slots - 1);
		if (seats[s].node != NULL) {
			var(&p.named, seats[s].number + 1);
			continue;
		}
		if (!node_pieces(e->node, options, &p)) {
			if (at != NULL) *at = e;
			code = PK_CANNOT_CARRY;
			goto done;
		}
		seats[s] = (seat){e->node, count++};
		var(&p.named, 0);
	}
	{
		// the columns, each left out when empty, in the canonical order of their names
		fields f = {0};
		pk_bytes v = {0}, z = {0};
		if (p.op.n) list(&p.op, &v), field(&f, "op", &v);
		if (p.has.length) byte_string(&p.has, &v), field(&f, "has", &v);
		if (p.ids.n) list(&p.ids, &v), field(&f, "ids", &v);
		if (p.time.length) byte_string(&p.time, &v), field(&f, "time", &v);
		if (p.actor.n) runs(&p.actor, &v), field(&f, "actor", &v);
		if (p.named.length) byte_string(&p.named, &v), field(&f, "nodes", &v);
		if (p.parts.n) runs(&p.parts, &v), field(&f, "parts", &v);
		if (p.which.length) byte_string(&p.which, &v), field(&f, "which", &v);
		if (p.reader.n) runs(&p.reader, &v), field(&f, "reader", &v);
		if (p.values.n) list(&p.values, &v), field(&f, "values", &v);
		if (p.external.n) runs(&p.external, &v), field(&f, "external", &v);
		if (p.metadata.n) runs(&p.metadata, &v), field(&f, "metadata", &v);
		head(&z, 5, f.count);
		put(&z, f.map.data, f.map.length);
		uint8_t *deflated;
		size_t deflated_length;
		df_deflate(z.data, z.length, &deflated, &deflated_length);
		put(out, "\xa1\x67" "columns", 9);
		head(out, 2, deflated_length);
		put(out, deflated, deflated_length);
		free(deflated), free(v.data), free(z.data), free(f.map.data);
	}
done:
	free(seats);
	free(id_seats);
	free(rows);
	free(keys.data);
	free_packing(&p);
	return code;
}

// --- reading ---

typedef struct {
	void **p;
	size_t n, capacity;
} pile;

// what a read allocated: blocks, values and nodes, freed by pk_free
typedef struct {
	pile blocks, values, nodes;
	int loose;
} arena;

static void add(pile *l, void *p) {
	GROW(l->p, l->n, l->capacity);
	l->p[l->n++] = p;
}
static void *grab(arena *a, size_t n) {
	void *p = xrealloc(NULL, n ? n : 1);
	memset(p, 0, n ? n : 1);
	add(&a->blocks, p);
	return p;
}
static char *dup(arena *a, const char *s, size_t n) {
	char *p = grab(a, n + 1);
	memcpy(p, s, n);
	return p;
}
static op_value *hold(arena *a, op_value *v) {
	add(&a->values, v);
	return v;
}

void pk_free(pk_read *r) {
	arena *a = r->own;
	if (a != NULL) {
		for (size_t i = 0; i < a->nodes.n; i++) nd_free_entry(a->nodes.p[i]);
		for (size_t i = 0; i < a->values.n; i++) op_free(a->values.p[i]);
		for (size_t i = 0; i < a->blocks.n; i++) free(a->blocks.p[i]);
		free(a->nodes.p), free(a->values.p), free(a->blocks.p);
		free(a);
	}
	*r = (pk_read){0};
}

// a whole number, as pack.ts has it: a safe integer (to 2^53 - 1 either side), never -0
static int whole64(const Json *j, int64_t *out) {
	if (j == NULL || j->type != JSON_NUMBER) return 0;
	double d = j->number;
	if (!(d >= -9007199254740991.0 && d <= 9007199254740991.0) || d != floor(d) || (d == 0 && signbit(d)))
		return 0;
	*out = (int64_t)d;
	return 1;
}

// one a long holds too: every one where a long is 64 bits
static int whole(const Json *j, long *out) {
	int64_t n;
	if (!whole64(j, &n) || n < LONG_MIN || n > LONG_MAX) return 0;
	*out = (long)n;
	return 1;
}

static int array(const Json *j) { return j != NULL && j->type == JSON_ARRAY; }
static int string(const Json *j) { return j != NULL && j->type == JSON_STRING; }

#define KEYS(...) ((const char *const[]){__VA_ARGS__, NULL})

// every key of need is in the object, and none but those of may
static int only(const arena *a, const Json *o, const char *const *need, const char *const *may) {
	if (o == NULL || o->type != JSON_OBJECT) return 0;
	for (; *need; need++)
		if (jsonGet(o, *need) == NULL) return 0;
	for (int i = 0; !a->loose && i < o->object.count; i++) {
		const char *const *m = may;
		while (*m != NULL && strcmp(*m, o->object.members[i].key) != 0) m++;
		if (*m == NULL) return 0;
	}
	return 1;
}

static int read_target(arena *a, const Json *x, op_target *t, const char *const *may) {
	if (!only(a, x, KEYS("path"), may)) return 0;
	const Json *path = jsonGet(x, "path");
	if (!array(path)) return 0;
	op_key *ks = grab(a, (size_t)path->array.count * sizeof *ks);
	for (int i = 0; i < path->array.count; i++) {
		const Json *k = path->array.items[i];
		long m;
		if (string(k)) ks[i] = (op_key){.type = OP_STR_KEY, .s = dup(a, k->string, k->stringLength)};
		else if (whole(k, &m)) ks[i] = (op_key){.type = OP_NUM_KEY, .n = m};
		else return 0;
	}
	t->path = ks;
	t->length = (size_t)path->array.count;
	const Json *range = jsonGet(x, "range");
	if (range != NULL) {
		if (!array(range) || range->array.count != 2) return 0;
		if (!whole(range->array.items[0], &t->from) || !whole(range->array.items[1], &t->to)) return 0;
		t->has_range = 1;
	}
	return 1;
}

static int read_patch(arena *a, const Json *x, op_patch *p) {
	if (!read_target(a, x, &p->place, KEYS("path", "range", "value", "move"))) return 0;
	const Json *v = jsonGet(x, "value"), *move = jsonGet(x, "move");
	if (v != NULL) p->has_value = 1, p->value = hold(a, pk_of_json(v));
	if (move != NULL) {
		p->has_move = 1;
		if (!read_target(a, move, &p->move, KEYS("path", "range"))) return 0;
	}
	return 1;
}

// the patches of a list; NULL when there are none
static int read_patches(arena *a, const Json *given, const op_patch **out, size_t *n) {
	if (!array(given)) return 0;
	op_patch *ps = given->array.count ? grab(a, (size_t)given->array.count * sizeof *ps) : NULL;
	for (int i = 0; i < given->array.count; i++)
		if (!read_patch(a, given->array.items[i], &ps[i])) return 0;
	*out = ps;
	*n = (size_t)given->array.count;
	return 1;
}

static int read_site(arena *a, const Json *x, ch_site *s) {
	if (!only(a, x, KEYS("file", "line"), KEYS("file", "line", "column", "function"))) return 0;
	const Json *file = jsonGet(x, "file"), *column = jsonGet(x, "column"), *function = jsonGet(x, "function");
	if (!string(file) || !whole(jsonGet(x, "line"), &s->line)) return 0;
	s->file = dup(a, file->string, file->stringLength);
	if (column != NULL) {
		if (!whole(column, &s->column)) return 0;
		s->has_column = 1;
	}
	if (function != NULL) {
		if (!string(function)) return 0;
		s->function = dup(a, function->string, function->stringLength);
	}
	return 1;
}

// a change's fields, each one NULL when not there
static int read_fields(arena *a, int64_t time, const Json *actor, const Json *reader, const Json *external,
	const Json *metadata, const Json *op, ch_header *h) {
	h->has_time = 1;
	h->time = time;
	if (actor != NULL) h->actor = hold(a, pk_of_json(actor));
	if (reader != NULL) {
		if (!string(reader)) return 0;
		h->reader = dup(a, reader->string, reader->stringLength);
	}
	if (external != NULL) {
		if (!array(external)) return 0;
		// an empty list is none yet, not none: a block of its own
		ch_site *ss = grab(a, ((size_t)external->array.count + 1) * sizeof *ss);
		for (int i = 0; i < external->array.count; i++)
			if (!read_site(a, external->array.items[i], &ss[i])) return 0;
		h->external = ss;
		h->external_length = (size_t)external->array.count;
	}
	if (metadata != NULL) {
		if (!array(metadata)) return 0;
		ch_entry *es = grab(a, ((size_t)metadata->array.count + 1) * sizeof *es);
		for (int i = 0; i < metadata->array.count; i++) {
			const Json *e = metadata->array.items[i];
			if (!array(e) || e->array.count != 2 || !string(e->array.items[0])) return 0;
			es[i].key = dup(a, e->array.items[0]->string, e->array.items[0]->stringLength);
			es[i].value = hold(a, pk_of_json(e->array.items[1]));
		}
		h->metadata = es;
		h->metadata_length = (size_t)metadata->array.count;
	}
	if (op != NULL) {
		if (!only(a, op, KEYS("patches", "undo"), KEYS("patches", "undo"))) return 0;
		if (!read_patches(a, jsonGet(op, "patches"), &h->patches, &h->patches_length)) return 0;
		if (!read_patches(a, jsonGet(op, "undo"), &h->undo, &h->undo_length)) return 0;
		h->has_op = 1;
	}
	return 1;
}

static int read_header(arena *a, const Json *x, ch_header *h) {
	if (!only(a, x, KEYS("time"), KEYS("time", "actor", "reader", "external", "metadata", "op"))) return 0;
	int64_t time;
	if (!whole64(jsonGet(x, "time"), &time)) return 0;
	return read_fields(a, time, jsonGet(x, "actor"), jsonGet(x, "reader"), jsonGet(x, "external"),
		jsonGet(x, "metadata"), jsonGet(x, "op"), h);
}

// a node made of a header and a value (NULL: none)
static nd_entry *make_node(arena *a, ch_header *h, const Json *v, int in_place) {
	nd_entry_options options = {.in_place = in_place};
	nd_entry *n = nd_make_entry(v != NULL ? hold(a, pk_of_json(v)) : NULL, h, &options);
	if (n == NULL) {
		fputs("pack: out of memory\n", stderr);
		abort();
	}
	add(&a->nodes, n);
	return n;
}

// a node as written, new; NULL when it is not one
static nd_entry *read_node(arena *a, const Json *x) {
	if (!only(a, x, KEYS("change"), KEYS("change", "value", "cow"))) return NULL;
	const Json *cow = jsonGet(x, "cow");
	// nothing but false
	if (cow != NULL && !(cow->type == JSON_BOOLEAN && !cow->boolean)) return NULL;
	ch_header h = {0};
	if (!read_header(a, jsonGet(x, "change"), &h)) return NULL;
	return make_node(a, &h, jsonGet(x, "value"), cow != NULL);
}

// the first form, {keys, nodes}
static int read_first(arena *a, const Json *x, pk_entry **entries_out, size_t *kn_out, nd_entry ***made_out,
	size_t *nn_out) {
	pk_bytes key = {0}, last = {0};
	nd_entry **made = NULL;
	pk_entry *entries = NULL;
	size_t nn = 0, kn = 0, next = 0;
	const Json *keys, *nodes;
	if (!only(a, x, KEYS("keys", "nodes"), KEYS("keys", "nodes"))) goto bad;
	keys = jsonGet(x, "keys"), nodes = jsonGet(x, "nodes");
	if (!array(keys) || !array(nodes)) goto bad;
	nn = (size_t)nodes->array.count, kn = (size_t)keys->array.count;
	made = grab(a, nn * sizeof *made);
	for (size_t i = 0; i < nn; i++)
		if ((made[i] = read_node(a, nodes->array.items[i])) == NULL) goto bad;
	entries = grab(a, kn * sizeof *entries);
	for (size_t i = 0; i < kn; i++) {
		const Json *k = keys->array.items[i];
		if (!array(k) || k->array.count != 3) goto bad;
		const Json *part = k->array.items[0], *id = k->array.items[1];
		long m;
		if (!string(part) || !string(id)) goto bad;
		// numbered in the order first named
		if (!whole(k->array.items[2], &m) || m < 0 || (size_t)m > next || (size_t)m >= nn) goto bad;
		if ((size_t)m == next) next++;
		// sorted, none twice
		key.length = 0;
		if (!key_bytes(&key, part->string, id->string)) goto bad;
		if (i > 0) {
			size_t c = key.length < last.length ? key.length : last.length;
			int d = memcmp(last.data, key.data, c);
			if (d > 0 || (d == 0 && last.length >= key.length)) goto bad;
		}
		pk_bytes swap = last;
		last = key;
		key = swap;
		entries[i] = (pk_entry){tb_string(dup(a, part->string, part->stringLength)),
			tb_string(dup(a, id->string, id->stringLength)), made[m]};
	}
	// every node under a key
	if (next != nn) goto bad;
	free(key.data), free(last.data);
	*entries_out = entries, *kn_out = kn, *made_out = made, *nn_out = nn;
	return 1;
bad:
	free(key.data), free(last.data);
	return 0;
}

// --- the columns

static void *scratch(pile *l, size_t n) {
	void *p = xrealloc(NULL, n ? n : 1);
	add(l, p);
	return p;
}

// the items of a column that is a list; none when it is left out; 0: it is not a list (null included)
static int items_of(const Json *c, const char *name, Json *const **items, size_t *n) {
	const Json *v = jsonGet(c, name);
	*items = NULL, *n = 0;
	if (v == NULL) return 1;
	if (!array(v)) return 0;
	*items = v->array.items, *n = (size_t)v->array.count;
	return 1;
}

// a column of whole numbers, 7 bits a byte, the low first, the high bit on all but a number's last
// byte; none when it is left out; 0: it is not bytes, a number never ends, or is 2^64 or more (no
// column has one)
static int numbers_of(const Json *c, const char *name, pile *tmp, uint64_t **out, size_t *n) {
	const Json *v = jsonGet(c, name);
	*out = NULL, *n = 0;
	if (v == NULL) return 1;
	if (v->type != JSON_BYTES) return 0;
	uint64_t *xs = scratch(tmp, (v->bytes.length + 1) * sizeof *xs);
	size_t count = 0;
	for (size_t at = 0; at < v->bytes.length;) {
		uint64_t x = 0;
		for (unsigned shift = 0;; shift += 7) {
			if (at >= v->bytes.length || shift > 63) return 0;
			unsigned char byte = v->bytes.data[at++];
			if (shift == 63 && (byte & 127) > 1) return 0;
			x |= (uint64_t)(byte & 127) << shift;
			if (byte < 128) break;
		}
		xs[count++] = x;
	}
	*out = xs, *n = count;
	return 1;
}

// runs [[it, how many], ...] spread out, each how many whole and at least 1; more than bound
// altogether: 0, as no pack has more
static int spread(const Json *c, const char *name, pile *tmp, size_t bound, const Json ***out, size_t *n) {
	Json *const *runs;
	size_t nr, total = 0, at = 0;
	*out = NULL, *n = 0;
	if (!items_of(c, name, &runs, &nr)) return 0;
	for (size_t i = 0; i < nr; i++) {
		long m;
		if (!array(runs[i]) || runs[i]->array.count != 2 || !whole(runs[i]->array.items[1], &m) || m < 1) return 0;
		if ((size_t)m > bound - total) return 0;
		total += (size_t)m;
	}
	const Json **xs = scratch(tmp, (total + 1) * sizeof *xs);
	for (size_t i = 0; i < nr; i++) {
		long m = 0;
		whole(runs[i]->array.items[1], &m);
		for (long k = 0; k < m; k++) xs[at++] = runs[i]->array.items[0];
	}
	*out = xs, *n = total;
	return 1;
}

// an id as it is carried: the text, or an ermine:// id as its 32 bytes
typedef struct {
	const char *text;
	size_t length;
} carried;

static int read_columns(arena *a, const Json *x, size_t limit, pk_entry **entries_out, size_t *kn_out,
	nd_entry ***made_out, size_t *nn_out) {
	static const char *const COLUMNS[] = {"ids", "parts", "which", "nodes", "has", "time", "actor", "reader",
		"external", "metadata", "op", "values", NULL};
	pile tmp = {0};
	pk_bytes key = {0}, last = {0};
	uint8_t *inner = NULL;
	size_t inner_length = 0;
	Json *c = NULL;
	int ok = 0;
	const Json *z = jsonGet(x, "columns");
	if (z->type != JSON_BYTES) goto end;
	if (df_inflate(z->bytes.data, z->bytes.length, limit, &inner, &inner_length) != DF_OK) goto end;
	if ((c = cborDecode(inner, inner_length, NULL, NULL)) == NULL) goto end;
	if (!only(a, c, (const char *const[]){NULL}, COLUMNS)) goto end;
	{
		Json *const *id_items, *const *op, *const *values;
		size_t ni, nop, nv;
		uint64_t *which, *named, *has, *times;
		size_t nwhich, nnamed, m, ntimes;
		const Json **parts, **actor, **reader, **external, **metadata;
		size_t k, na, nr, ne, nm;
		if (!items_of(c, "ids", &id_items, &ni) || !items_of(c, "op", &op, &nop) || !items_of(c, "values", &values, &nv))
			goto end;
		if (!numbers_of(c, "which", &tmp, &which, &nwhich) || !numbers_of(c, "nodes", &tmp, &named, &nnamed) ||
			!numbers_of(c, "has", &tmp, &has, &m) || !numbers_of(c, "time", &tmp, &times, &ntimes))
			goto end;
		if (!spread(c, "parts", &tmp, nwhich, &parts, &k)) goto end;
		if (nwhich != k || nnamed != k || ntimes != m) goto end;
		if (!spread(c, "actor", &tmp, m, &actor, &na) || !spread(c, "reader", &tmp, m, &reader, &nr) ||
			!spread(c, "external", &tmp, m, &external, &ne) || !spread(c, "metadata", &tmp, m, &metadata, &nm))
			goto end;
		// the ids
		carried *ids = scratch(&tmp, (ni + 1) * sizeof *ids);
		for (size_t i = 0; i < ni; i++) {
			const Json *id = id_items[i];
			uint8_t raw[32];
			if (id->type == JSON_STRING && !ermine_id(id->string, raw)) ids[i] = (carried){id->string, id->stringLength};
			else if (id->type == JSON_BYTES && id->bytes.length == 32) {
				char *text = scratch(&tmp, 74);
				memcpy(text, "ermine://", 9);
				for (int b = 0; b < 32; b++) snprintf(text + 9 + 2 * b, 3, "%02x", id->bytes.data[b]);
				ids[i] = (carried){text, 73};
			} else goto end;
		}
		// ids in the order the keys first name them, each named
		size_t seen = 0;
		for (size_t i = 0; i < k; i++) {
			if (which[i] > seen || which[i] >= ni) goto end;
			if (which[i] == seen) seen++;
		}
		if (seen != ni) goto end;
		// the nodes
		nd_entry **made = grab(a, (m + 1) * sizeof *made);
		size_t ia = 0, ir = 0, ie = 0, im = 0, io = 0, iv = 0;
		int64_t time = 0;
		for (size_t i = 0; i < m; i++) {
			if (has[i] > 127) goto end;
			unsigned bits = (unsigned)has[i];
			// zigzag: how far, then which way; one farther than twice the safe integers lands outside them
			uint64_t far = times[i] / 2 + times[i] % 2;
			if (far > 2 * 9007199254740991ull) goto end;
			time += times[i] % 2 == 0 ? (int64_t)far : -(int64_t)far;
			if (time > 9007199254740991 || time < -9007199254740991) goto end;
			const Json *fa = NULL, *fr = NULL, *fe = NULL, *fm = NULL, *fo = NULL, *fv = NULL;
			if (bits & HAS_ACTOR) {
				if (ia >= na) goto end;
				fa = actor[ia++];
			}
			if (bits & HAS_READER) {
				if (ir >= nr) goto end;
				fr = reader[ir++];
			}
			if (bits & HAS_EXTERNAL) {
				if (ie >= ne) goto end;
				fe = external[ie++];
			}
			if (bits & HAS_METADATA) {
				if (im >= nm) goto end;
				fm = metadata[im++];
			}
			if (bits & HAS_OP) {
				if (io >= nop) goto end;
				fo = op[io++];
			}
			if (bits & HAS_VALUE) {
				if (iv >= nv) goto end;
				fv = values[iv++];
			}
			ch_header h = {0};
			if (!read_fields(a, time, fa, fr, fe, fm, fo, &h)) goto end;
			made[i] = make_node(a, &h, fv, (bits & HAS_COW) != 0);
		}
		if (ia != na || ir != nr || ie != ne || im != nm || io != nop || iv != nv) goto end;
		// the entries
		pk_entry *entries = grab(a, (k + 1) * sizeof *entries);
		size_t next = 0;
		for (size_t i = 0; i < k; i++) {
			const Json *part = parts[i];
			if (!string(part)) goto end;
			carried id = ids[which[i]];
			size_t n;
			if (named[i] == 0) n = next++;
			else if (named[i] - 1 < next) n = (size_t)(named[i] - 1);
			else goto end;
			if (n >= m) goto end;
			// sorted, none twice
			key.length = 0;
			if (!key_bytes(&key, part->string, id.text)) goto end;
			if (i > 0) {
				size_t len = key.length < last.length ? key.length : last.length;
				int d = memcmp(last.data, key.data, len);
				if (d > 0 || (d == 0 && last.length >= key.length)) goto end;
			}
			pk_bytes swap = last;
			last = key;
			key = swap;
			entries[i] = (pk_entry){tb_string(dup(a, part->string, part->stringLength)),
				tb_string(dup(a, id.text, id.length)), made[n]};
		}
		// every node under a key
		if (next != m) goto end;
		*entries_out = entries, *kn_out = k, *made_out = made, *nn_out = m;
		ok = 1;
	}
end:
	for (size_t i = 0; i < tmp.n; i++) free(tmp.p[i]);
	free(tmp.p), free(key.data), free(last.data), free(inner);
	jsonFree(c);
	return ok;
}

pk_code pk_unpack(const uint8_t *bytes, size_t length, const pk_reading *reading, pk_read *out) {
	*out = (pk_read){0};
	Json *x = cborDecode(bytes, length, NULL, NULL);
	if (x == NULL) return PK_NOT_A_PACK;
	arena *a = xrealloc(NULL, sizeof *a);
	*a = (arena){.loose = reading != NULL && reading->loosy};
	nd_entry **made = NULL;
	pk_entry *entries = NULL;
	size_t nn = 0, kn = 0;
	size_t limit = reading != NULL && reading->limit ? reading->limit : (size_t)1 << 30;
	int ok = jsonGet(x, "columns") != NULL && only(a, x, KEYS("columns"), KEYS("columns"))
		? read_columns(a, x, limit, &entries, &kn, &made, &nn)
		: read_first(a, x, &entries, &kn, &made, &nn);
	jsonFree(x);
	if (!ok) {
		pk_free(&(pk_read){.own = a});
		return PK_NOT_A_PACK;
	}
	*out = (pk_read){entries, kn, made, nn, a};
	return PK_OK;
}

pk_code pk_decode(const uint8_t *bytes, size_t length, const pk_reading *reading, pk_read *out) {
	*out = (pk_read){0};
	Json *x = cborDecode(bytes, length, NULL, NULL);
	if (x == NULL) return PK_NOT_A_NODE;
	arena *a = xrealloc(NULL, sizeof *a);
	*a = (arena){.loose = reading != NULL && reading->loosy};
	nd_entry *n = read_node(a, x);
	jsonFree(x);
	if (n == NULL) {
		pk_free(&(pk_read){.own = a});
		return PK_NOT_A_NODE;
	}
	nd_entry **made = grab(a, sizeof *made);
	made[0] = n;
	*out = (pk_read){NULL, 0, made, 1, a};
	return PK_OK;
}
