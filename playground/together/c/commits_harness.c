// The commits a harness makes (commits_harness.h)
#include "commits_harness.h"

#include "../../../ermine/encoding/c/commit_form_harness.h"
#include "../../../ermine/encoding/c/pack.h"

#include <stdlib.h>
#include <string.h>

struct cs_commits {
	cs_made **made;
	size_t length, capacity;
	// one signer for each seed asked for
	sl_seeded **signers;
	size_t signers_length;
};

cs_commits *cs_create(void) { return allocate(sizeof(cs_commits)); }

void cs_destroy(cs_commits *c) {
	for (size_t i = 0; i < c->length; i++) {
		free(c->made[i]->label);
		free(c->made[i]->bytes);
		free(c->made[i]);
	}
	for (size_t i = 0; i < c->signers_length; i++) free(c->signers[i]);
	free(c->made);
	free(c->signers);
	free(c);
}

// whether the request gives any of a commit's fields (table, actor, reader, external, metadata,
// time, seed, nonce, parents, base, lamport, patches)
static bool cs_gives(const op_value *r) {
	static const char *const fields[] = {"table", "actor", "reader", "external", "metadata", "time",
		"seed", "nonce", "parents", "base", "merge", "lamport", "patches"};
	for (size_t i = 0; i < sizeof fields / sizeof *fields; i++)
		if (op_get(r, fields[i]) != NULL) return true;
	return false;
}

const cs_made *cs_get(const cs_commits *c, const char *label) {
	for (size_t i = 0; i < c->length; i++)
		if (strcmp(c->made[i]->label, label) == 0) return c->made[i];
	return NULL;
}

const cs_made *cs_find(const cs_commits *c, const uint8_t name[CM_NAME]) {
	for (size_t i = 0; i < c->length; i++)
		if (memcmp(c->made[i]->name, name, CM_NAME) == 0) return c->made[i];
	return NULL;
}

bool cs_resolve(const cs_commits *c, const op_value *x, uint8_t name[CM_NAME], const char **error) {
	if (x == NULL || x->type != OP_STR) return *error = "not a label or a name", false;
	const cs_made *m = cs_get(c, x->str);
	if (m != NULL) return memcpy(name, m->name, CM_NAME), true;
	uint8_t *b;
	size_t n;
	if (strlen(x->str) == 2 * CM_NAME && cf_unhex(x->str, &b, &n)) return memcpy(name, b, CM_NAME), true;
	return *error = "no such commit", false;
}

void cs_put_name(const cs_commits *c, FILE *out, const uint8_t name[CM_NAME]) {
	const cs_made *m = cs_find(c, name);
	if (m != NULL) op_json_string(out, m->label);
	else cf_put_hex(out, name, CM_NAME);
}

static sl_seeded *signer_of(cs_commits *c, const uint8_t seed[32]) {
	for (size_t i = 0; i < c->signers_length; i++)
		if (memcmp(c->signers[i]->seed, seed, 32) == 0) return c->signers[i];
	sl_seeded *s = allocate(sizeof *s);
	sl_seeded_init(s, seed);
	c->signers = realloc(c->signers, (c->signers_length + 1) * sizeof *c->signers);
	if (c->signers == NULL) abort();
	return c->signers[c->signers_length++] = s;
}

static int by_name(const void *a, const void *b) {
	return cm_compare(*(const uint8_t *const *)a, CM_NAME, *(const uint8_t *const *)b, CM_NAME);
}

// a field a request gives: absent and null are both not given (?? in the TypeScript)
static const op_value *given(const op_value *r, const char *key) {
	const op_value *v = op_get(r, key);
	return v != NULL && v->type != OP_NULL ? v : NULL;
}

const cs_made *cs_make(cs_commits *c, const op_value *r, cs_failure *why) {
	const char **error = &why->text;
	*why = (cs_failure){0};
	const char *label = hh_str(r, "name");
	if (label == NULL) return *error = "a commit needs a label: name", NULL;
	const cs_made *was = cs_get(c, label);
	if (was != NULL) {
		if (cs_gives(r)) return *error = "made already", NULL;
		return was;
	}
	uint8_t seed[32];
	const op_value *s = given(r, "seed");
	if (s == NULL) memset(seed, 1, 32);
	else {
		uint8_t *b;
		size_t n;
		if (s->type != OP_STR || !cf_unhex(s->str, &b, &n)) return *error = "not hex", NULL;
		if (n != 32) return *error = "shape", NULL;
		memcpy(seed, b, 32);
	}
	sl_seeded *signer = signer_of(c, seed);
	// the parents by name, sorted; lamport 1 above the highest made here
	const op_value *given_parents = given(r, "parents");
	if (given_parents != NULL && given_parents->type != OP_LIST) return *error = "parents", NULL;
	size_t np = given_parents ? given_parents->count : 0;
	uint8_t(*parents)[CM_NAME] = hh_take((np + 1) * CM_NAME);
	const uint8_t **sorted = hh_take((np + 1) * sizeof *sorted);
	int64_t top = 0;
	for (size_t i = 0; i < np; i++) {
		if (!cs_resolve(c, given_parents->items[i], parents[i], error)) return NULL;
		const cs_made *p = cs_find(c, parents[i]);
		if (p != NULL && p->lamport > top) top = p->lamport;
		sorted[i] = parents[i];
	}
	qsort(sorted, np, sizeof *sorted, by_name);
	Json *j = jsonObject();
	const op_value *v;
	Json *x;
	jsonAdd(j, "table", (v = given(r, "table")) ? pk_to_json(v) : jsonString("value"));
	x = (v = op_get(r, "actor")) ? pk_to_json(v) : jsonNull();
	jsonAdd(j, "actor", x);
	jsonAdd(j, "time", (v = given(r, "time")) ? pk_to_json(v) : jsonNumber(0));
	jsonAdd(j, "signer", jsonBytes(signer->signer.key, signer->signer.key_length));
	jsonAdd(j, "nonce", (v = given(r, "nonce")) ? pk_to_json(v) : jsonNumber(0));
	Json *ps = jsonArray();
	for (size_t i = 0; i < np; i++) jsonPush(ps, jsonBytes(sorted[i], CM_NAME));
	jsonAdd(j, "parents", ps);
	jsonAdd(j, "lamport", (v = given(r, "lamport")) ? pk_to_json(v) : jsonNumber((double)(1 + top)));
	// replaces: labels or names (68 hex digits), sorted
	Json *patches = (v = given(r, "patches")) ? pk_to_json(v) : jsonArray();
	for (int i = 0; v != NULL && v->type == OP_LIST && i < patches->array.count && (size_t)i < v->count; i++) {
		const op_value *p = v->items[i], *rs = p->type == OP_MAP ? op_get(p, "replaces") : NULL;
		if (rs == NULL || rs->type != OP_LIST) continue;
		uint8_t(*names)[CM_NAME] = hh_take((rs->count + 1) * CM_NAME);
		const uint8_t **order = hh_take((rs->count + 1) * sizeof *order);
		Json *list = jsonArray();
		bool bytes = true;
		for (size_t k = 0; k < rs->count; k++) {
			const op_value *x = rs->items[k];
			if (x->type != OP_STR) {
				bytes = false;
				break;
			}
			if (!cs_resolve(c, x, names[k], error)) return jsonFree(list), jsonFree(patches), jsonFree(j), NULL;
			order[k] = names[k];
		}
		if (!bytes) {
			jsonFree(list);
			continue;
		}
		qsort(order, rs->count, sizeof *order, by_name);
		for (size_t k = 0; k < rs->count; k++) jsonPush(list, jsonBytes(order[k], CM_NAME));
		jsonSet(patches->array.items[i], "replaces", 8, list);
	}
	jsonAdd(j, "patches", patches);
	static const char *const optional[] = {"reader", "external", "metadata"};
	for (size_t i = 0; i < 3; i++)
		if ((v = op_get(r, optional[i])) != NULL) jsonAdd(j, optional[i], pk_to_json(v));
	if ((v = op_get(r, "base")) != NULL) {
		uint8_t base[CM_NAME];
		if (!cs_resolve(c, v, base, error)) return jsonFree(j), NULL;
		jsonAdd(j, "base", jsonBytes(base, CM_NAME));
	}
	if ((v = op_get(r, "merge")) != NULL) jsonAdd(j, "merge", pk_to_json(v));
	uint8_t *bytes;
	size_t length;
	char *field;
	cm_code code = cm_encode_json(j, &bytes, &length, &field);
	if (code != CM_OK) {
		jsonFree(j);
		why->code = code;
		why->field = field;
		return NULL;
	}
	int64_t lamport = (int64_t)jsonGet(j, "lamport")->number;
	jsonFree(j);
	cs_made *m = allocate(sizeof *m);
	m->label = copyString(label);
	m->bytes = bytes;
	m->length = length;
	m->lamport = lamport;
	m->signer = signer;
	cm_name(bytes, length, m->name);
	if (c->length == c->capacity) {
		c->capacity = c->capacity ? c->capacity * 2 : 16;
		c->made = realloc(c->made, c->capacity * sizeof *c->made);
		if (c->made == NULL) abort();
	}
	return c->made[c->length++] = m;
}

const char cs_doc[] = "ermine:00102a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a";

void cs_sealed(const cs_made *m, const char *doc, uint8_t **out, size_t *length) {
	sl_made made = {.commit = NULL};
	memcpy(made.name, m->name, CM_NAME);
	if (sl_seal(m->bytes, m->length, &m->signer->signer, (const uint8_t *)doc, strlen(doc), &made, out, length, NULL,
		    NULL) != SL_OK)
		abort();
}
