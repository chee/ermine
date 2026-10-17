// A commit (commit.h), in C. The rules are commit.ts's, on a Json: a key not listed, then the first
// field that says no, in the table's order. A commit is encoded and decoded by cbor.c, so the bytes
// are commit.ts's.
#include "commit.h"

#include "blake3/blake3.h"
#include "cbor.h"
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

void cm_name(const uint8_t *bytes, size_t length, uint8_t name[32]) {
	blake3_hasher h;
	blake3_hasher_init(&h);
	blake3_hasher_update(&h, bytes, length);
	blake3_hasher_finalize(&h, name, 32);
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
// an integer from 0 to 2^53 - 1
static bool whole(const Json *x) {
	if (x == NULL || x->type != JSON_NUMBER) return false;
	double d = x->number;
	return d >= 0 && d <= 9007199254740991.0 && d == floor(d) && !(d == 0 && signbit(d));
}
// a list's index, a site's line or column: an integer from 0 to 2^31 - 1, what any long holds
static bool small(const Json *x) { return whole(x) && x->number <= 2147483647.0; }
static bool is_key(const Json *k) { return jsonIsString(k) || small(k); }
static bool is_range(const Json *r) {
	return is_array(r) && r->array.count == 2 && whole(r->array.items[0]) && whole(r->array.items[1]);
}
static bool sized(const Json *b, size_t n) { return b != NULL && b->type == JSON_BYTES && b->bytes.length == n; }

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
int cm_multikey(const uint8_t *b, size_t length) { return cm_key_split(b, length, NULL, NULL, NULL); }
size_t cm_key_join(uint64_t code, const uint8_t *key, size_t key_length, uint8_t *out) {
	size_t n = 0;
	for (; code >= 0x80; code >>= 7) out[n++] = (uint8_t)(code & 0x7f) | 0x80;
	out[n++] = (uint8_t)code;
	memcpy(out + n, key, key_length);
	return n + key_length;
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
	static const char *const patch_keys[] = {"path", "range", "value", "move", NULL};
	if (!is_fields(x) || !only(x, patch ? patch_keys : (const char *const[]){"path", "range", NULL})) return false;
	const Json *path = jsonGet(x, "path"), *range = jsonGet(x, "range");
	if (!is_array(path)) return false;
	for (int i = 0; i < path->array.count; i++)
		if (!is_key(path->array.items[i])) return false;
	return range == NULL || is_range(range);
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
	case TABLE: return jsonIsString(v) && v->stringLength > 0;
	case ACTOR: return true;
	case READER: return jsonIsString(v);
	case EXTERNAL:
		if (!is_array(v)) return false;
		for (int i = 0; i < v->array.count; i++)
			if (!site(v->array.items[i])) return false;
		return true;
	case METADATA:
		if (!is_array(v)) return false;
		for (int i = 0; i < v->array.count; i++) {
			const Json *e = v->array.items[i];
			if (!is_array(e) || e->array.count != 2 || !jsonIsString(e->array.items[0])) return false;
		}
		return true;
	case TIME:
	case NONCE: return whole(v);
	case SIGNER: return v != NULL && v->type == JSON_BYTES && cm_multikey(v->bytes.data, v->bytes.length);
	case PARENTS:
		if (!is_array(v)) return false;
		for (int i = 0; i < v->array.count; i++) {
			if (!sized(v->array.items[i], 32)) return false;
			if (i > 0 && memcmp(v->array.items[i - 1]->bytes.data, v->array.items[i]->bytes.data, 32) >= 0)
				return false;
		}
		return true;
	case BASE: {
		const Json *parents = jsonGet(c, "parents");
		if (!sized(v, 32) || !is_array(parents) || parents->array.count < 2) return false;
		for (int i = 0; i < parents->array.count; i++) {
			const Json *p = parents->array.items[i];
			if (p->type == JSON_BYTES && p->bytes.length == 32 && memcmp(p->bytes.data, v->bytes.data, 32) == 0)
				return true;
		}
		return false;
	}
	// a rule's name, with several parents and no base
	case MERGE: {
		const Json *parents = jsonGet(c, "parents");
		return jsonIsString(v) && v->stringLength > 0 && is_array(parents) && parents->array.count >= 2 &&
			jsonGet(c, "base") == NULL;
	}
	case LAMPORT: return whole(v) && v->number >= 1;
	case PATCHES:
		if (!is_array(v)) return false;
		for (int i = 0; i < v->array.count; i++) {
			const Json *p = v->array.items[i];
			if (!place(p, true)) return false;
			const Json *move = jsonGet(p, "move");
			if (move != NULL && (jsonGet(p, "value") != NULL || !place(move, false))) return false;
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

cm_code cm_check(const Json *c, char **field) {
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
	if (stray != NULL) {
		name_field(field, stray->key, stray->keyLength);
		return CM_NOT_A_COMMIT;
	}
	for (int k = 0; k < FIELDS; k++) {
		const Json *v = jsonGet(c, NAMES[k]);
		bool ok;
		if (v == NULL) {
			const Json *parents = jsonGet(c, "parents");
			ok = optional(k) &&
				!(k == BASE && is_array(parents) && parents->array.count >= 2 && jsonGet(c, "merge") == NULL);
		} else ok = rule(k, v, c);
		if (!ok) {
			name_field(field, NAMES[k], strlen(NAMES[k]));
			return CM_NOT_A_COMMIT;
		}
	}
	return CM_OK;
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

cm_code cm_encode(const cm_commit *commit, uint8_t **out, size_t *length, char **field) {
	if (field != NULL) *field = NULL;
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
static char *dup(arena *a, const Json *s) {
	char *p = grab(a, s->stringLength + 1);
	memcpy(p, s->string, s->stringLength);
	return p;
}
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

cm_code cm_of_json(const Json *c, cm_commit *out, char **field) {
	*out = (cm_commit){0};
	cm_code code = cm_check(c, field);
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
		ch_entry *es = grab(a, ((size_t)metadata->array.count + 1) * sizeof *es);
		for (int i = 0; i < metadata->array.count; i++) {
			const Json *e = metadata->array.items[i];
			es[i].key = dup(a, e->array.items[0]);
			es[i].value = hold(a, e->array.items[1]);
		}
		h->metadata = es;
		h->metadata_length = (size_t)metadata->array.count;
	}
	const Json *signer = jsonGet(c, "signer");
	memcpy(out->signer, signer->bytes.data, signer->bytes.length);
	out->signer_length = signer->bytes.length;
	out->nonce = (int64_t)jsonGet(c, "nonce")->number;
	const Json *parents = jsonGet(c, "parents"), *base = jsonGet(c, "base"), *patches = jsonGet(c, "patches");
	uint8_t(*ps)[32] = grab(a, (size_t)parents->array.count * 32);
	for (int i = 0; i < parents->array.count; i++) memcpy(ps[i], parents->array.items[i]->bytes.data, 32);
	out->parents = (const uint8_t(*)[32])ps;
	out->parents_length = (size_t)parents->array.count;
	if (base != NULL) out->has_base = 1, memcpy(out->base, base->bytes.data, 32);
	const Json *merge = jsonGet(c, "merge");
	if (merge != NULL) out->merge = dup(a, merge);
	out->lamport = (int64_t)jsonGet(c, "lamport")->number;
	op_patch *list = grab(a, (size_t)patches->array.count * sizeof *list);
	for (int i = 0; i < patches->array.count; i++) {
		const Json *p = patches->array.items[i], *value = jsonGet(p, "value"), *move = jsonGet(p, "move");
		read_target(a, p, &list[i].place);
		if (value != NULL) list[i].has_value = 1, list[i].value = hold(a, value);
		if (move != NULL) list[i].has_move = 1, read_target(a, move, &list[i].move);
	}
	out->patches = list;
	out->patches_length = (size_t)patches->array.count;
	return CM_OK;
}

cm_code cm_decode(const uint8_t *bytes, size_t length, cm_commit *out, char **field) {
	*out = (cm_commit){0};
	if (field != NULL) *field = NULL;
	Json *x = cborDecode(bytes, length, NULL, NULL);
	if (x == NULL) return CM_NOT_A_COMMIT;
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
		Json *entries = jsonArray();
		jsonAdd(j, "metadata", entries);
		for (size_t i = 0; i < h->metadata_length; i++) {
			Json *v = h->metadata[i].value ? pk_to_json(h->metadata[i].value) : jsonNull();
			if (v == NULL) goto bad;
			Json *e = jsonArray();
			jsonPush(entries, e);
			jsonPush(e, jsonString(h->metadata[i].key));
			jsonPush(e, v);
		}
	}
	jsonAdd(j, "time", jsonNumber((double)h->time));
	jsonAdd(j, "signer", jsonBytes(c->signer, c->signer_length));
	jsonAdd(j, "nonce", jsonNumber((double)c->nonce));
	Json *parents = jsonArray();
	jsonAdd(j, "parents", parents);
	for (size_t i = 0; i < c->parents_length; i++) jsonPush(parents, jsonBytes(c->parents[i], 32));
	if (c->has_base) jsonAdd(j, "base", jsonBytes(c->base, 32));
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
	}
	return j;
bad:
	jsonFree(j);
	return NULL;
}
