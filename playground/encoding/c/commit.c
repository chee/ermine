// A commit (commit.h), in C. The rules are commit.ts's, on a Json: a key not listed, then the first
// field that says no, in the table's order. A commit is encoded and decoded by cbor.c, so the bytes
// are commit.ts's: a cm_commit written by pieces (cbor.h's writer, pack.h's pk_put), its Json form by
// cborEncode, the same bytes.
#include "commit.h"

#include "../../../ermine/encoding/c/blake3/blake3.h"
#include "../../../ermine/encoding/c/cbor.h"
#include "pack.h"

#include <math.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

const char *cm_code_name(cm_code code) {
	switch (code) {
	case CM_NOT_A_COMMIT: return "not-a-commit";
	case CM_CANNOT_CARRY: return "cannot-carry";
	case CM_OK: break;
	}
	return "";
}

void cm_digest(const uint8_t *bytes, size_t length, uint8_t out[32]) {
	blake3_hasher h;
	blake3_hasher_init(&h);
	blake3_hasher_update(&h, bytes, length);
	blake3_hasher_finalize(&h, out, 32);
}

void cm_name(const uint8_t *bytes, size_t length, uint8_t name[CM_NAME]) {
	uint8_t digest[32];
	cm_digest(bytes, length, digest);
	cm_name_join(CM_BLAKE3, digest, 32, name);
}

int cm_compare(const uint8_t *a, size_t a_length, const uint8_t *b, size_t b_length) {
	size_t n = a_length < b_length ? a_length : b_length;
	int c = n ? memcmp(a, b, n) : 0;
	if (c != 0) return c;
	return a_length < b_length ? -1 : a_length > b_length;
}

// --- the rules ---

// the table's order: the first field that says no is the one named
enum { TABLE, ACTOR, READER, EXTERNAL, METADATA, TIME, SIGNER, NONCE, PARENTS, BASE, MERGE, LAMPORT, PATCHES, FIELDS };
static const char *const NAMES[FIELDS] = {"table", "actor", "reader", "external", "metadata", "time",
	"signer", "nonce", "parents", "base", "merge", "lamport", "patches"};

static bool optional(int k) { return k == READER || k == EXTERNAL || k == METADATA || k == BASE || k == MERGE; }

static bool is_fields(const Json *x) { return x != NULL && x->type == JSON_OBJECT; }
static bool is_array(const Json *x) { return x != NULL && x->type == JSON_ARRAY; }
// each rule on what it says of a commit, for both forms (Json, cm_commit: fits, below)
// an integer from 0 to 2^53 - 1
static bool whole_number(double d) { return d >= 0 && d <= 9007199254740991.0 && d == floor(d); }
// a list's index, a site's line or column: an integer from 0 to 2^31 - 1, what any long holds
static bool small_number(double d) { return whole_number(d) && d <= 2147483647.0; }
// a table, a merge rule: a name, not empty
static bool named(size_t length) { return length > 0; }
static bool lamport_number(double d) { return whole_number(d) && d >= 1; }
// parents and replaces: ascending, each once
static bool ascending(const uint8_t *a, const uint8_t *b) { return memcmp(a, b, CM_NAME) < 0; }
// base: one of several parents
static bool base_rule(size_t parents, bool among) { return parents >= 2 && among; }
// merge: with several parents and no base
static bool merge_rule(size_t parents, bool base) { return parents >= 2 && !base; }
// no base: needed with several parents, no merge and a patch that is no key patch
static bool baseless_rule(size_t parents, bool merge, bool keys_only) { return parents < 2 || merge || keys_only; }

static bool whole(const Json *x) { return x != NULL && x->type == JSON_NUMBER && whole_number(x->number); }
static bool small(const Json *x) { return x != NULL && x->type == JSON_NUMBER && small_number(x->number); }
static bool is_key(const Json *k) { return jsonIsString(k) || small(k); }
static bool is_range(const Json *r) {
	return is_array(r) && r->array.count == 2 && whole(r->array.items[0]) && whole(r->array.items[1]);
}

int cm_key_split(const uint8_t *b, size_t length, uint64_t *code, const uint8_t **key, size_t *key_length) {
	size_t i = 0;
	while (i < length && i < 7 && (b[i] & 0x80)) i++;
	if (i >= length || i >= 7 || (i > 0 && b[i] == 0) || i + 1 >= length || length > CM_SIGNER_MAX) return 0;
	uint64_t c = 0;
	for (size_t k = 0; k <= i; k++) c |= (uint64_t)(b[k] & 0x7f) << (7 * k);
	if (code != NULL) *code = c;
	if (key != NULL) *key = b + i + 1;
	if (key_length != NULL) *key_length = length - i - 1;
	return 1;
}
// whether the bytes are a multikey
static int cm_multikey(const uint8_t *b, size_t length) { return cm_key_split(b, length, NULL, NULL, NULL); }
size_t cm_key_join(uint64_t code, const uint8_t *key, size_t key_length, uint8_t *out) {
	size_t n = 0;
	for (; code >= 0x80; code >>= 7) out[n++] = (uint8_t)(code & 0x7f) | 0x80;
	out[n++] = (uint8_t)code;
	memcpy(out + n, key, key_length);
	return n + key_length;
}

// a varint in its shortest form, 1 to 7 bytes, at b: 0 when it is not one
static size_t varint(const uint8_t *b, size_t length, uint64_t *n) {
	*n = 0;
	for (size_t k = 0; k < 7 && k < length; k++) {
		*n |= (uint64_t)(b[k] & 0x7f) << (7 * k);
		if (!(b[k] & 0x80)) return k > 0 && b[k] == 0 ? 0 : k + 1;
	}
	return 0;
}
// the hashes known: BLAKE3, and the length of its digest
static int hash_known(uint64_t code, size_t *digest_length) {
	if (code != CM_BLAKE3) return 0;
	*digest_length = 32;
	return 1;
}
int cm_name_split(const uint8_t *b, size_t length, uint64_t *code, const uint8_t **digest, size_t *digest_length) {
	uint64_t c = 0, n = 0;
	size_t known, at = varint(b, length, &c), k = at ? varint(b + at, length - at, &n) : 0;
	if (at == 0 || k == 0 || !hash_known(c, &known) || n != known || length != at + k + known) return 0;
	if (code != NULL) *code = c;
	if (digest != NULL) *digest = b + at + k;
	if (digest_length != NULL) *digest_length = known;
	return 1;
}
size_t cm_name_join(uint64_t code, const uint8_t *digest, size_t digest_length, uint8_t *out) {
	size_t n = 0;
	for (; code >= 0x80; code >>= 7) out[n++] = (uint8_t)(code & 0x7f) | 0x80;
	out[n++] = (uint8_t)code;
	out[n++] = (uint8_t)digest_length;
	memcpy(out + n, digest, digest_length);
	return n + digest_length;
}
// whether the bytes are a name
static bool is_name(const Json *b) {
	return b != NULL && b->type == JSON_BYTES && cm_name_split(b->bytes.data, b->bytes.length, NULL, NULL, NULL);
}

static bool only(const Json *x, const char *const *keys) {
	for (int i = 0; i < x->object.count; i++) {
		const char *const *k = keys;
		while (*k != NULL && strcmp(*k, x->object.members[i].key) != 0) k++;
		if (*k == NULL) return false;
	}
	return true;
}

static bool place(const Json *x, bool patch) {
	static const char *const patch_keys[] = {"path", "range", "value", "move", "replaces", NULL};
	if (!is_fields(x) || !only(x, patch ? patch_keys : (const char *const[]){"path", "range", NULL})) return false;
	const Json *path = jsonGet(x, "path"), *range = jsonGet(x, "range");
	if (!is_array(path)) return false;
	for (int i = 0; i < path->array.count; i++)
		if (!is_key(path->array.items[i])) return false;
	return range == NULL || is_range(range);
}

// a key patch: a set or a delete at a path of keys, no range, move or list index
static bool key_patch(const Json *p) {
	if (!is_fields(p) || jsonGet(p, "range") != NULL || jsonGet(p, "move") != NULL) return false;
	const Json *path = jsonGet(p, "path");
	if (!is_array(path)) return false;
	for (int i = 0; i < path->array.count; i++)
		if (!jsonIsString(path->array.items[i])) return false;
	return true;
}
static bool keys_only(const Json *patches) {
	if (!is_array(patches)) return false;
	for (int i = 0; i < patches->array.count; i++)
		if (!key_patch(patches->array.items[i])) return false;
	return true;
}

static bool site(const Json *x) {
	static const char *const keys[] = {"file", "line", "column", "function", NULL};
	if (!is_fields(x) || !jsonIsString(jsonGet(x, "file")) || !small(jsonGet(x, "line"))) return false;
	if (!only(x, keys)) return false;
	const Json *column = jsonGet(x, "column"), *function = jsonGet(x, "function");
	if (column != NULL && !small(column)) return false;
	return function == NULL || jsonIsString(function);
}

// each field's own rule, given the commit for base's
static bool rule(int k, const Json *v, const Json *c) {
	switch (k) {
	case TABLE: return jsonIsString(v) && named(v->stringLength);
	case ACTOR: return true;
	case READER: return jsonIsString(v);
	case EXTERNAL:
		if (!is_array(v)) return false;
		for (int i = 0; i < v->array.count; i++)
			if (!site(v->array.items[i])) return false;
		return true;
	// a map, any keys
	case METADATA: return is_fields(v);
	case TIME:
	case NONCE: return whole(v);
	case SIGNER: return v != NULL && v->type == JSON_BYTES && cm_multikey(v->bytes.data, v->bytes.length);
	case PARENTS:
		if (!is_array(v)) return false;
		for (int i = 0; i < v->array.count; i++) {
			if (!is_name(v->array.items[i])) return false;
			if (i > 0 && !ascending(v->array.items[i - 1]->bytes.data, v->array.items[i]->bytes.data)) return false;
		}
		return true;
	case BASE: {
		const Json *parents = jsonGet(c, "parents");
		if (!is_name(v) || !is_array(parents)) return false;
		bool among = false;
		for (int i = 0; i < parents->array.count && !among; i++) {
			const Json *p = parents->array.items[i];
			among = p->type == JSON_BYTES && p->bytes.length == CM_NAME && memcmp(p->bytes.data, v->bytes.data, CM_NAME) == 0;
		}
		return base_rule((size_t)parents->array.count, among);
	}
	// a rule's name
	case MERGE: {
		const Json *parents = jsonGet(c, "parents");
		return jsonIsString(v) && named(v->stringLength) && is_array(parents) &&
			merge_rule((size_t)parents->array.count, jsonGet(c, "base") != NULL);
	}
	case LAMPORT: return v != NULL && v->type == JSON_NUMBER && lamport_number(v->number);
	case PATCHES:
		if (!is_array(v)) return false;
		for (int i = 0; i < v->array.count; i++) {
			const Json *p = v->array.items[i];
			if (!place(p, true)) return false;
			const Json *move = jsonGet(p, "move");
			if (move != NULL && (jsonGet(p, "value") != NULL || !place(move, false))) return false;
			const Json *replaces = jsonGet(p, "replaces");
			if (replaces != NULL && !is_array(replaces)) return false;
			for (int r = 0; replaces != NULL && r < replaces->array.count; r++) {
				if (!is_name(replaces->array.items[r])) return false;
				if (r > 0 && !ascending(replaces->array.items[r - 1]->bytes.data, replaces->array.items[r]->bytes.data))
					return false;
			}
		}
		return true;
	}
	return false;
}

// a key's bytes as the encoding has them: U+0000 held as C0 80 is the byte 00
static size_t real(const char *s, size_t n, unsigned char *out) {
	size_t m = 0;
	for (size_t i = 0; i < n; i++) {
		if ((unsigned char)s[i] == 0xC0 && i + 1 < n && (unsigned char)s[i + 1] == 0x80) {
			if (out) out[m] = 0;
			m++, i++;
		} else {
			if (out) out[m] = (unsigned char)s[i];
			m++;
		}
	}
	return m;
}
// canonical order: shorter first, then bytewise
static int canonical(const JsonMember *a, const JsonMember *b) {
	size_t x = real(a->key, a->keyLength, NULL), y = real(b->key, b->keyLength, NULL);
	if (x != y) return x < y ? -1 : 1;
	unsigned char *p = allocate(x + 1), *q = allocate(y + 1);
	real(a->key, a->keyLength, p), real(b->key, b->keyLength, q);
	int c = memcmp(p, q, x);
	free(p), free(q);
	return c;
}

static void name_field(char **field, const char *name, size_t length) {
	if (field != NULL) *field = copyStringOfLength(name, length);
}

// strict: a key no commit has is refused (encode); decode leaves it out, a later device's
static cm_code check(const Json *c, char **field, bool strict) {
	if (field != NULL) *field = NULL;
	if (!is_fields(c)) return CM_NOT_A_COMMIT;
	// of several keys not listed, the first in canonical order
	const JsonMember *stray = NULL;
	for (int i = 0; i < c->object.count; i++) {
		const JsonMember *m = &c->object.members[i];
		int k = 0;
		while (k < FIELDS && strcmp(NAMES[k], m->key) != 0) k++;
		if (k == FIELDS && (stray == NULL || canonical(m, stray) < 0)) stray = m;
	}
	if (strict && stray != NULL) {
		name_field(field, stray->key, stray->keyLength);
		return CM_NOT_A_COMMIT;
	}
	for (int k = 0; k < FIELDS; k++) {
		const Json *v = jsonGet(c, NAMES[k]);
		bool ok;
		if (v == NULL) {
			const Json *parents = jsonGet(c, "parents");
			ok = optional(k) && (k != BASE || !is_array(parents) ||
				baseless_rule((size_t)parents->array.count, jsonGet(c, "merge") != NULL, keys_only(jsonGet(c, "patches"))));
		} else ok = rule(k, v, c);
		if (!ok) {
			name_field(field, NAMES[k], strlen(NAMES[k]));
			return CM_NOT_A_COMMIT;
		}
	}
	return CM_OK;
}

cm_code cm_check(const Json *c, char **field) {
	return check(c, field, true);
}

cm_code cm_check_decoded(const Json *c, char **field) {
	return check(c, field, false);
}

// --- the bytes ---

cm_code cm_encode_json(const Json *c, uint8_t **out, size_t *length, char **field) {
	*out = NULL;
	*length = 0;
	cm_code code = cm_check(c, field);
	if (code != CM_OK) return code;
	size_t n;
	if (!cborEncode(c, NULL, 0, &n, NULL)) {
		// which: each again, only when one failed
		for (int k = 0; k < FIELDS; k++) {
			const Json *v = jsonGet(c, NAMES[k]);
			if (v != NULL && !cborEncode(v, NULL, 0, &n, NULL)) {
				name_field(field, NAMES[k], strlen(NAMES[k]));
				break;
			}
		}
		return CM_CANNOT_CARRY;
	}
	uint8_t *bytes = allocate(n ? n : 1);
	cborEncode(c, bytes, n, &n, NULL);
	*out = bytes;
	*length = n;
	return CM_OK;
}

// the rules on a cm_commit, as check holds its Json form (cm_to_json) to them: true only when it would
// take that form. A no names nothing here: cm_encode asks the Json form which field
static bool key_ok(const op_key *k) {
	return k->type == OP_STR_KEY ? k->s != NULL : k->type == OP_NUM_KEY && small_number((double)k->n);
}
static bool target_ok(const op_target *t) {
	for (size_t i = 0; i < t->length; i++)
		if (!key_ok(&t->path[i])) return false;
	return !t->has_range || (whole_number((double)t->from) && whole_number((double)t->to));
}
static bool fits(const cm_commit *c) {
	const ch_header *h = &c->change;
	if (c->table == NULL || !named(strlen(c->table)) || !whole_number((double)h->time) || !whole_number((double)c->nonce) ||
		!lamport_number((double)c->lamport) || !cm_multikey(c->signer, c->signer_length))
		return false;
	for (size_t i = 0; h->external != NULL && i < h->external_length; i++) {
		const ch_site *x = &h->external[i];
		if (x->file == NULL || !small_number((double)x->line) || (x->has_column && !small_number((double)x->column))) return false;
	}
	bool among = false, keys = true;
	for (size_t i = 0; i < c->parents_length; i++) {
		if (!cm_name_split(c->parents[i], CM_NAME, NULL, NULL, NULL) || (i > 0 && !ascending(c->parents[i - 1], c->parents[i])))
			return false;
		among |= c->has_base && memcmp(c->parents[i], c->base, CM_NAME) == 0;
	}
	if (c->has_base && (!cm_name_split(c->base, CM_NAME, NULL, NULL, NULL) || !base_rule(c->parents_length, among))) return false;
	if (c->merge != NULL && (!named(strlen(c->merge)) || !merge_rule(c->parents_length, c->has_base))) return false;
	for (size_t i = 0; i < c->patches_length; i++) {
		const op_patch *p = &c->patches[i];
		if (!target_ok(&p->place) || (p->has_move && (p->has_value || !target_ok(&p->move)))) return false;
		keys &= !p->place.has_range && !p->has_move;
		for (size_t k = 0; k < p->place.length; k++) keys &= p->place.path[k].type == OP_STR_KEY;
		const cm_replaces *r = c->replaces != NULL && c->replaces[i].has ? &c->replaces[i] : NULL;
		for (size_t k = 0; r != NULL && k < r->length; k++)
			if (!cm_name_split(r->names[k], CM_NAME, NULL, NULL, NULL) || (k > 0 && !ascending(r->names[k - 1], r->names[k])))
				return false;
	}
	return c->has_base || baseless_rule(c->parents_length, c->merge != NULL, keys);
}

// a commit's bytes, written as cm_to_json and cborEncode would (the keys in canonical order); false
// when something in it has no encoding (text not UTF-8, a value pk_put cannot write, a metadata key
// twice)
static bool text(CborOut *o, const char *s) { return cborPutText(o, s, strlen(s)); }
static void put_names(CborOut *o, const uint8_t (*names)[CM_NAME], size_t n) {
	cborPutHead(o, 4, n);
	for (size_t i = 0; i < n; i++) cborPutBytes(o, names[i], CM_NAME);
}
static bool put_path(CborOut *o, const op_target *t) {
	text(o, "path");
	cborPutHead(o, 4, t->length);
	for (size_t i = 0; i < t->length; i++) {
		if (t->path[i].type == OP_NUM_KEY) cborPutInteger(o, t->path[i].n);
		else if (!text(o, t->path[i].s)) return false;
	}
	return true;
}
static void put_range(CborOut *o, const op_target *t) {
	text(o, "range");
	cborPutHead(o, 4, 2);
	cborPutInteger(o, t->from), cborPutInteger(o, t->to);
}
static bool put_value(CborOut *o, const void *v) {
	if (v == NULL) return cborPutNull(o), true;
	return pk_put(o, v);
}
static int entry_order(const void *a, const void *b) {
	const char *x = (*(const ch_entry *const *)a)->key, *y = (*(const ch_entry *const *)b)->key;
	return cborKeyCompare(x, strlen(x), y, strlen(y));
}
static bool put_metadata(CborOut *o, const ch_header *h) {
	const ch_entry **order = allocate((h->metadata_length + 1) * sizeof *order);
	for (size_t i = 0; i < h->metadata_length; i++) order[i] = &h->metadata[i];
	qsort(order, h->metadata_length, sizeof *order, entry_order);
	bool ok = true;
	cborPutHead(o, 5, h->metadata_length);
	for (size_t i = 0; i < h->metadata_length && ok; i++)
		ok = (i == 0 || entry_order(&order[i - 1], &order[i]) != 0) && text(o, order[i]->key) && put_value(o, order[i]->value);
	free(order);
	return ok;
}
static bool put_commit(CborOut *o, const cm_commit *c) {
	const ch_header *h = &c->change;
	cborPutHead(o, 5, 8 + (h->reader != NULL) + (h->external != NULL) + (h->metadata != NULL) + (c->has_base != 0) + (c->merge != NULL));
	if (c->has_base) text(o, "base"), cborPutBytes(o, c->base, CM_NAME);
	text(o, "time"), cborPutInteger(o, h->time);
	if (text(o, "actor"), !put_value(o, h->actor)) return false;
	if (c->merge != NULL && (text(o, "merge"), !text(o, c->merge))) return false;
	text(o, "nonce"), cborPutInteger(o, c->nonce);
	if (text(o, "table"), !text(o, c->table)) return false;
	if (h->reader != NULL && (text(o, "reader"), !text(o, h->reader))) return false;
	text(o, "signer"), cborPutBytes(o, c->signer, c->signer_length);
	text(o, "lamport"), cborPutInteger(o, c->lamport);
	text(o, "parents"), put_names(o, c->parents, c->parents_length);
	text(o, "patches");
	cborPutHead(o, 4, c->patches_length);
	for (size_t i = 0; i < c->patches_length; i++) {
		const op_patch *p = &c->patches[i];
		const cm_replaces *r = c->replaces != NULL && c->replaces[i].has ? &c->replaces[i] : NULL;
		cborPutHead(o, 5, 1 + (p->place.has_range != 0) + (p->has_value != 0) + (p->has_move != 0) + (r != NULL));
		if (p->has_move) {
			text(o, "move");
			cborPutHead(o, 5, 1 + (p->move.has_range != 0));
			if (!put_path(o, &p->move)) return false;
			if (p->move.has_range) put_range(o, &p->move);
		}
		if (!put_path(o, &p->place)) return false;
		if (p->place.has_range) put_range(o, &p->place);
		if (p->has_value && (text(o, "value"), p->value == NULL || !pk_put(o, p->value))) return false;
		if (r != NULL) text(o, "replaces"), put_names(o, r->names, r->length);
	}
	if (h->external != NULL) {
		text(o, "external");
		cborPutHead(o, 4, h->external_length);
		for (size_t i = 0; i < h->external_length; i++) {
			const ch_site *x = &h->external[i];
			cborPutHead(o, 5, 2 + (x->has_column != 0) + (x->function != NULL));
			if (text(o, "file"), !text(o, x->file)) return false;
			text(o, "line"), cborPutInteger(o, x->line);
			if (x->has_column) text(o, "column"), cborPutInteger(o, x->column);
			if (x->function != NULL && (text(o, "function"), !text(o, x->function))) return false;
		}
	}
	if (h->metadata != NULL && (text(o, "metadata"), !put_metadata(o, h))) return false;
	return true;
}

cm_code cm_encode(const cm_commit *commit, uint8_t **out, size_t *length, char **field) {
	if (field != NULL) *field = NULL;
	// counted, then written into exactly that
	CborOut o = {NULL, 0, 0, false};
	if (fits(commit) && put_commit(&o, commit)) {
		o = (CborOut){allocate(o.length ? o.length : 1), o.length, 0, false};
		put_commit(&o, commit);
		*out = o.data;
		*length = o.length;
		return CM_OK;
	}
	// a no: the Json form says which, and names the field (the rules in one place)
	Json *j = cm_to_json(commit);
	if (j == NULL) return *out = NULL, *length = 0, CM_CANNOT_CARRY;
	cm_code code = cm_encode_json(j, out, length, field);
	jsonFree(j);
	return code;
}

// --- a commit and its Json form ---

typedef struct {
	void **p;
	size_t n, capacity;
} pile;
typedef struct {
	pile blocks, values;
} arena;

static void add(pile *l, void *p) {
	if (l->n == l->capacity) {
		l->capacity = l->capacity ? l->capacity * 2 : 8;
		l->p = realloc(l->p, l->capacity * sizeof *l->p);
		if (l->p == NULL) abort();
	}
	l->p[l->n++] = p;
}
static void *grab(arena *a, size_t n) {
	void *p = allocate(n ? n : 1);
	add(&a->blocks, p);
	return p;
}
static char *dup_of_length(arena *a, const char *s, size_t n) {
	char *p = grab(a, n + 1);
	memcpy(p, s, n);
	return p;
}
static char *dup(arena *a, const Json *s) { return dup_of_length(a, s->string, s->stringLength); }
static op_value *hold(arena *a, const Json *j) {
	op_value *v = pk_of_json(j);
	add(&a->values, v);
	return v;
}

void cm_free(cm_commit *c) {
	arena *a = c->own;
	if (a != NULL) {
		for (size_t i = 0; i < a->values.n; i++) op_free(a->values.p[i]);
		for (size_t i = 0; i < a->blocks.n; i++) free(a->blocks.p[i]);
		free(a->values.p), free(a->blocks.p);
		free(a);
	}
	*c = (cm_commit){0};
}

// x checked (cm_check): a key's number fits a long, a range's ends an int64_t
static void read_target(arena *a, const Json *x, op_target *t) {
	const Json *path = jsonGet(x, "path"), *range = jsonGet(x, "range");
	op_key *ks = grab(a, (size_t)path->array.count * sizeof *ks);
	for (int i = 0; i < path->array.count; i++) {
		const Json *k = path->array.items[i];
		if (jsonIsString(k)) ks[i] = (op_key){.type = OP_STR_KEY, .s = dup(a, k)};
		else ks[i] = (op_key){.type = OP_NUM_KEY, .n = (long)k->number};
	}
	t->path = ks;
	t->length = (size_t)path->array.count;
	if (range != NULL) {
		t->has_range = 1;
		t->from = (int64_t)range->array.items[0]->number;
		t->to = (int64_t)range->array.items[1]->number;
	}
}

// a checked commit in its Json form (what cm_check holds to be a commit), made into a cm_commit
static cm_code cm_of_json(const Json *c, cm_commit *out, char **field) {
	*out = (cm_commit){0};
	cm_code code = check(c, field, false);
	if (code != CM_OK) return code;
	arena *a = allocate(sizeof *a);
	out->own = a;
	out->table = dup(a, jsonGet(c, "table"));
	ch_header *h = &out->change;
	h->has_time = 1;
	h->time = (int64_t)jsonGet(c, "time")->number;
	h->actor = hold(a, jsonGet(c, "actor"));
	const Json *reader = jsonGet(c, "reader"), *external = jsonGet(c, "external"), *metadata = jsonGet(c, "metadata");
	if (reader != NULL) h->reader = dup(a, reader);
	if (external != NULL) {
		// an empty list is none yet, not none: a block of its own
		ch_site *ss = grab(a, ((size_t)external->array.count + 1) * sizeof *ss);
		for (int i = 0; i < external->array.count; i++) {
			const Json *s = external->array.items[i], *column = jsonGet(s, "column"), *function = jsonGet(s, "function");
			ss[i].file = dup(a, jsonGet(s, "file"));
			// checked: under 2^31, as any long holds
			ss[i].line = (long)jsonGet(s, "line")->number;
			if (column != NULL) ss[i].has_column = 1, ss[i].column = (long)column->number;
			if (function != NULL) ss[i].function = dup(a, function);
		}
		h->external = ss;
		h->external_length = (size_t)external->array.count;
	}
	if (metadata != NULL) {
		// a map's keys are unique: the entries' too
		ch_entry *es = grab(a, ((size_t)metadata->object.count + 1) * sizeof *es);
		for (int i = 0; i < metadata->object.count; i++) {
			const JsonMember *m = &metadata->object.members[i];
			es[i].key = dup_of_length(a, m->key, m->keyLength);
			es[i].value = hold(a, m->value);
		}
		h->metadata = es;
		h->metadata_length = (size_t)metadata->object.count;
	}
	const Json *signer = jsonGet(c, "signer");
	memcpy(out->signer, signer->bytes.data, signer->bytes.length);
	out->signer_length = signer->bytes.length;
	out->nonce = (int64_t)jsonGet(c, "nonce")->number;
	const Json *parents = jsonGet(c, "parents"), *base = jsonGet(c, "base"), *patches = jsonGet(c, "patches");
	uint8_t(*ps)[CM_NAME] = grab(a, (size_t)parents->array.count * CM_NAME);
	for (int i = 0; i < parents->array.count; i++) memcpy(ps[i], parents->array.items[i]->bytes.data, CM_NAME);
	out->parents = (const uint8_t(*)[CM_NAME])ps;
	out->parents_length = (size_t)parents->array.count;
	if (base != NULL) out->has_base = 1, memcpy(out->base, base->bytes.data, CM_NAME);
	const Json *merge = jsonGet(c, "merge");
	if (merge != NULL) out->merge = dup(a, merge);
	out->lamport = (int64_t)jsonGet(c, "lamport")->number;
	op_patch *list = grab(a, (size_t)patches->array.count * sizeof *list);
	cm_replaces *replaces = NULL;
	for (int i = 0; i < patches->array.count; i++) {
		const Json *p = patches->array.items[i], *value = jsonGet(p, "value"), *move = jsonGet(p, "move");
		read_target(a, p, &list[i].place);
		if (value != NULL) list[i].has_value = 1, list[i].value = hold(a, value);
		if (move != NULL) list[i].has_move = 1, read_target(a, move, &list[i].move);
		const Json *r = jsonGet(p, "replaces");
		if (r == NULL) continue;
		if (replaces == NULL) {
			replaces = grab(a, (size_t)patches->array.count * sizeof *replaces);
			memset(replaces, 0, (size_t)patches->array.count * sizeof *replaces);
		}
		uint8_t(*names)[CM_NAME] = grab(a, (size_t)r->array.count * CM_NAME);
		for (int k = 0; k < r->array.count; k++) memcpy(names[k], r->array.items[k]->bytes.data, CM_NAME);
		replaces[i] = (cm_replaces){.has = 1, .names = (const uint8_t(*)[CM_NAME])names, .length = (size_t)r->array.count};
	}
	out->patches = list;
	out->replaces = replaces;
	out->patches_length = (size_t)patches->array.count;
	return CM_OK;
}

// metadata in the old form, a list of [key, value] pairs, as a map: of a key repeated, the first.
// NULL: not that form
static Json *pairs(const Json *list) {
	for (int i = 0; i < list->array.count; i++) {
		const Json *e = list->array.items[i];
		if (!is_array(e) || e->array.count != 2 || !jsonIsString(e->array.items[0])) return NULL;
	}
	Json *map = jsonObject();
	for (int i = 0; i < list->array.count; i++) {
		const Json *k = list->array.items[i]->array.items[0];
		if (jsonGetOfLength(map, k->string, k->stringLength) == NULL)
			jsonAddOfLength(map, k->string, k->stringLength, jsonRef(list->array.items[i]->array.items[1]));
	}
	return map;
}

cm_code cm_decode(const uint8_t *bytes, size_t length, cm_commit *out, char **field) {
	*out = (cm_commit){0};
	if (field != NULL) *field = NULL;
	Json *x = cborDecode(bytes, length, NULL, NULL);
	if (x == NULL) return CM_NOT_A_COMMIT;
	// metadata in the old form, a list of [key, value] pairs: read as a map
	const Json *old = is_fields(x) ? jsonGet(x, "metadata") : NULL;
	Json *map = is_array(old) ? pairs(old) : NULL;
	if (map != NULL) jsonSet(x, "metadata", strlen("metadata"), map);
	cm_code code = cm_of_json(x, out, field);
	jsonFree(x);
	return code;
}

static Json *target_json(Json *to, const op_target *t) {
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

Json *cm_to_json(const cm_commit *c) {
	const ch_header *h = &c->change;
	Json *j = jsonObject();
	jsonAdd(j, "table", jsonString(c->table));
	Json *actor = h->actor ? pk_to_json(h->actor) : jsonNull();
	if (actor == NULL) goto bad;
	jsonAdd(j, "actor", actor);
	if (h->reader != NULL) jsonAdd(j, "reader", jsonString(h->reader));
	if (h->external != NULL) {
		Json *sites = jsonArray();
		jsonAdd(j, "external", sites);
		for (size_t i = 0; i < h->external_length; i++) {
			const ch_site *s = &h->external[i];
			Json *o = jsonObject();
			jsonPush(sites, o);
			jsonAdd(o, "file", jsonString(s->file));
			jsonAdd(o, "line", jsonNumber((double)s->line));
			if (s->has_column) jsonAdd(o, "column", jsonNumber((double)s->column));
			if (s->function != NULL) jsonAdd(o, "function", jsonString(s->function));
		}
	}
	if (h->metadata != NULL) {
		// a map: the entries' keys unique (ch_header's), the caller's to keep
		Json *map = jsonObject();
		jsonAdd(j, "metadata", map);
		for (size_t i = 0; i < h->metadata_length; i++) {
			Json *v = h->metadata[i].value ? pk_to_json(h->metadata[i].value) : jsonNull();
			if (v == NULL) goto bad;
			jsonAdd(map, h->metadata[i].key, v);
		}
	}
	jsonAdd(j, "time", jsonNumber((double)h->time));
	jsonAdd(j, "signer", jsonBytes(c->signer, c->signer_length));
	jsonAdd(j, "nonce", jsonNumber((double)c->nonce));
	Json *parents = jsonArray();
	jsonAdd(j, "parents", parents);
	for (size_t i = 0; i < c->parents_length; i++) jsonPush(parents, jsonBytes(c->parents[i], CM_NAME));
	if (c->has_base) jsonAdd(j, "base", jsonBytes(c->base, CM_NAME));
	if (c->merge != NULL) jsonAdd(j, "merge", jsonString(c->merge));
	jsonAdd(j, "lamport", jsonNumber((double)c->lamport));
	Json *patches = jsonArray();
	jsonAdd(j, "patches", patches);
	for (size_t i = 0; i < c->patches_length; i++) {
		const op_patch *p = &c->patches[i];
		Json *o = target_json(jsonObject(), &p->place);
		jsonPush(patches, o);
		if (p->has_value) {
			Json *v = p->value ? pk_to_json(p->value) : NULL;
			if (v == NULL) goto bad;
			jsonAdd(o, "value", v);
		}
		if (p->has_move) jsonAdd(o, "move", target_json(jsonObject(), &p->move));
		if (c->replaces != NULL && c->replaces[i].has) {
			Json *names = jsonArray();
			jsonAdd(o, "replaces", names);
			for (size_t k = 0; k < c->replaces[i].length; k++) jsonPush(names, jsonBytes(c->replaces[i].names[k], CM_NAME));
		}
	}
	return j;
bad:
	jsonFree(j);
	return NULL;
}
