// The C run on the line protocol (conformance/c/harness.h): requests and answers as
// extensions/together/typescript/run_harness.ts has them. State lasts for the process: the commits made by
// label, each sealed by its seed's signer, and the runs packed by label
#include "run.h"

#include "commits_harness.h"
#include "../../../ermine/encoding/c/cbor.h"
#include "../../../ermine/encoding/c/commit_form_harness.h"
#include "../../../ermine/encoding/c/pack.h"
#include "../../../ermine/encoding/c/json_text.h"

#include <stdlib.h>
#include <string.h>

typedef struct {
	char *label;
	uint8_t *bytes;
	size_t length;
} kept;
typedef struct {
	kept *p;
	size_t n, capacity;
} pile;

static cs_commits *commits;
// sealed commits by the label they were made under, and runs by the label they were packed under
static pile seals, runs;

void hh_start(void) { commits = cs_create(); }

// kept under a label, taking the bytes; the label's bytes before them let go of
static void keep(pile *l, const char *label, uint8_t *bytes, size_t length) {
	for (size_t i = 0; i < l->n; i++) {
		if (strcmp(l->p[i].label, label) == 0) {
			free(l->p[i].bytes);
			l->p[i].bytes = bytes;
			l->p[i].length = length;
			return;
		}
	}
	if (l->n == l->capacity) {
		l->capacity = l->capacity ? l->capacity * 2 : 16;
		l->p = realloc(l->p, l->capacity * sizeof *l->p);
		if (l->p == NULL) abort();
	}
	l->p[l->n++] = (kept){copyString(label), bytes, length};
}

static const kept *find(const pile *l, const char *label) {
	for (size_t i = 0; i < l->n; i++)
		if (strcmp(l->p[i].label, label) == 0) return &l->p[i];
	return NULL;
}

void hh_finish(void) {
	for (size_t i = 0; i < seals.n; i++) free(seals.p[i].label), free(seals.p[i].bytes);
	for (size_t i = 0; i < runs.n; i++) free(runs.p[i].label), free(runs.p[i].bytes);
	free(seals.p);
	free(runs.p);
	cs_destroy(commits);
}

// sealed bytes from a label or hex
static bool sealed_of(const op_value *x, uint8_t **bytes, size_t *length, FILE *out) {
	if (x == NULL || x->type != OP_STR) return hh_error(out, "not a commit"), false;
	const kept *k = find(&seals, x->str);
	if (k != NULL) return *bytes = k->bytes, *length = k->length, true;
	if (!cf_unhex(x->str, bytes, length)) return hh_error(out, "not hex"), false;
	return true;
}

// a run from a label or hex
static bool run_of(const op_value *x, uint8_t **bytes, size_t *length, FILE *out) {
	if (x == NULL || x->type != OP_STR) return hh_error(out, "not a run"), false;
	const kept *k = find(&runs, x->str);
	if (k != NULL) return *bytes = k->bytes, *length = k->length, true;
	if (!cf_unhex(x->str, bytes, length)) return hh_error(out, "not hex"), false;
	return true;
}

static void put_refusal(FILE *out, rn_code code, const char *column) {
	fprintf(out, "{\"error\":\"%s\"", rn_code_name(code));
	if (column != NULL) fputs(",\"column\":", out), op_json_string(out, column);
	fputc('}', out);
}

static void make(const op_value *r, FILE *out) {
	cs_failure why;
	const cs_made *m = cs_make(commits, r, &why);
	if (m == NULL) {
		hh_error(out, "%s", why.text ? why.text : cm_code_name(why.code));
		free(why.field);
		return;
	}
	if (find(&seals, m->label) == NULL) {
		uint8_t *sealed;
		size_t length;
		cs_sealed(m, cs_doc, &sealed, &length);
		keep(&seals, m->label, sealed, length);
	}
	fputs("{}", out);
}

static void sealed(const op_value *r, FILE *out) {
	uint8_t *bytes;
	size_t length;
	if (!sealed_of(op_get(r, "commit"), &bytes, &length, out)) return;
	fputs("{\"sealed\":", out);
	cf_put_hex(out, bytes, length);
	fputc('}', out);
}

static void pack(const op_value *r, FILE *out) {
	const op_value *list = op_get(r, "commits");
	if (list == NULL || list->type != OP_LIST) {
		hh_error(out, "commits");
		return;
	}
	rn_item *items = hh_take((list->count + 1) * sizeof *items);
	for (size_t i = 0; i < list->count; i++) {
		uint8_t *b;
		size_t n;
		const op_value *x = list->items[i];
		// { vouched: label, stored? }: the commit without its seal, its stored id (default its seal's)
		if (x->type == OP_MAP) {
			const op_value *label = op_get(x, "vouched"), *id = op_get(x, "stored");
			const cs_made *m = label != NULL && label->type == OP_STR ? cs_get(commits, label->str) : NULL;
			if (m == NULL || !sealed_of(label, &b, &n, out)) {
				if (m == NULL) hh_error(out, "no commit");
				return;
			}
			uint8_t *stored = hh_take(32);
			if (id == NULL) sl_stored(b, n, stored);
			else {
				uint8_t *h;
				size_t hn;
				if (id->type != OP_STR || !cf_unhex(id->str, &h, &hn) || hn != 32) {
					hh_error(out, "not hex");
					return;
				}
				memcpy(stored, h, 32);
			}
			items[i] = (rn_item){m->bytes, m->length, stored};
			continue;
		}
		if (!sealed_of(x, &b, &n, out)) return;
		items[i] = (rn_item){b, n, NULL};
	}
	uint8_t *run;
	size_t length;
	rn_code code = rn_pack(items, list->count, &run, &length);
	if (code != RN_OK) {
		hh_error(out, "not sealed commits");
		return;
	}
	fputs("{\"run\":", out);
	cf_put_hex(out, run, length);
	fputc('}', out);
	const char *name = hh_str(r, "name");
	if (name != NULL) keep(&runs, name, run, length);
	else free(run);
}

// the run to unpack, with its columns set and dropped: its bytes (the line's)
static bool edited(const op_value *r, uint8_t **bytes, size_t *length, FILE *out) {
	const op_value *value = op_get(r, "value"), *set = op_get(r, "set"), *drop = op_get(r, "drop");
	if (value != NULL) {
		if (!cf_value_bytes(value, bytes, length)) return hh_error(out, "no encoding"), false;
		return true;
	}
	if (!run_of(op_get(r, "run"), bytes, length, out)) return false;
	if (set == NULL && drop == NULL) return true;
	Json *o = cborDecode(*bytes, *length, NULL, NULL);
	if (o == NULL || o->type != JSON_OBJECT) return jsonFree(o), hh_error(out, "not a run"), false;
	for (size_t i = 0; set != NULL && set->type == OP_MAP && i < set->count; i++) {
		Json *v = pk_to_json(set->items[i]);
		jsonSet(o, set->keys[i], strlen(set->keys[i]), v);
	}
	for (size_t i = 0; drop != NULL && drop->type == OP_LIST && i < drop->count; i++)
		if (drop->items[i]->type == OP_STR) jsonRemove(o, drop->items[i]->str, strlen(drop->items[i]->str));
	size_t n;
	bool ok = cborEncode(o, NULL, 0, &n, NULL);
	if (ok) {
		*bytes = hh_take(n + 1);
		cborEncode(o, *bytes, n, length, NULL);
	} else hh_error(out, "no encoding");
	jsonFree(o);
	return ok;
}

static void unpack(const op_value *r, FILE *out) {
	uint8_t *bytes;
	size_t length;
	if (!edited(r, &bytes, &length, out)) return;
	rn_unpacked u;
	char *column;
	rn_code code = rn_unpack(bytes, length, &u, &column);
	if (code != RN_OK) {
		put_refusal(out, code, column);
		free(column);
		return;
	}
	fputs("{\"sealed\":[", out);
	for (size_t i = 0; i < u.count; i++) {
		if (i) fputc(',', out);
		const rn_member *m = &u.members[i];
		if (m->sealed != NULL) {
			const char *label = NULL;
			for (size_t k = 0; k < seals.n && label == NULL; k++)
				if (seals.p[k].length == m->sealed_length && memcmp(seals.p[k].bytes, m->sealed, m->sealed_length) == 0) {
					label = seals.p[k].label;
				}
			if (label != NULL) op_json_string(out, label);
			else cf_put_hex(out, m->sealed, m->sealed_length);
			continue;
		}
		// vouched for: its label (or name), and its stored id when it is not its seal's
		fputs("{\"vouched\":", out);
		cs_put_name(commits, out, m->name);
		const cs_made *made = cs_find(commits, m->name);
		const kept *seal = made != NULL ? find(&seals, made->label) : NULL;
		uint8_t id[32];
		if (seal != NULL) sl_stored(seal->bytes, seal->length, id);
		if (seal == NULL || memcmp(id, m->stored, 32) != 0) fputs(",\"stored\":", out), cf_put_hex(out, m->stored, 32);
		fputc('}', out);
	}
	fputs("]}", out);
	rn_free(&u);
}

static void columns(const op_value *r, FILE *out) {
	uint8_t *bytes;
	size_t length;
	if (!run_of(op_get(r, "run"), &bytes, &length, out)) return;
	Json *x = cborDecode(bytes, length, NULL, NULL);
	if (x == NULL) {
		hh_error(out, "not CBOR");
		return;
	}
	char *text = jsonPrint(x);
	fprintf(out, "{\"columns\":%s}", text);
	free(text);
	jsonFree(x);
}

void hh_answer(const op_value *r, FILE *out) {
	const char *op = hh_str(r, "op");
	if (op == NULL) hh_unknown(out, r);
	else if (strcmp(op, "make") == 0) make(r, out);
	else if (strcmp(op, "sealed") == 0) sealed(r, out);
	else if (strcmp(op, "pack") == 0) pack(r, out);
	else if (strcmp(op, "unpack") == 0) unpack(r, out);
	else if (strcmp(op, "columns") == 0) columns(r, out);
	else hh_unknown(out, r);
}
