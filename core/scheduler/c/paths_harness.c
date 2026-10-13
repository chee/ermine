// The C paths (paths.h) on the line protocol of conformance/paths/harness.ts: one JSON request per
// line in, one answer per line out, in order. Lines are read and answers printed with
// ermine/encoding/c/json.h. A symbol is a token per name, the harness's.
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "paths.h"
#include "../../../ermine/encoding/c/json.h"

static pt_paths *paths;

// symbols: one token per name, kept to the end
static char **names;
static size_t count, capacity;

// a source or an id: a string, or {"symbol": name}; 0 when neither
static int key_of(const Json *j, pt_key *out) {
	if (jsonIsString(j)) return *out = pt_string(jsonText(j)), 1;
	const char *name = jsonText(jsonGet(j, "symbol"));
	if (name == NULL) return 0;
	for (size_t i = 0; i < count; i++)
		if (strcmp(names[i], name) == 0) return *out = pt_symbol(names[i]), 1;
	if (count == capacity) {
		capacity = capacity ? capacity * 2 : 8;
		names = realloc(names, capacity * sizeof *names);
		if (names == NULL) abort();
	}
	names[count] = copyString(name);
	*out = pt_symbol(names[count++]);
	return 1;
}

// keys: numbers and strings; NULL when j is not a list of them. *n how many
static op_key *path_of(const Json *j, size_t *n) {
	if (!jsonIsArray(j)) return NULL;
	op_key *keys = allocate(((size_t)j->array.count + 1) * sizeof *keys);
	for (int i = 0; i < j->array.count; i++) {
		const Json *k = j->array.items[i];
		int64_t x;
		if (jsonIsString(k)) keys[i] = (op_key){.type = OP_STR_KEY, .s = jsonText(k)};
		else if (jsonIsWhole(k, &x) && x >= 0) keys[i] = (op_key){.type = OP_NUM_KEY, .n = (long)x};
		else return free(keys), NULL;
	}
	*n = (size_t)j->array.count;
	return keys;
}

// the value: only its kind and a list's length are read, but it is made whole
static op_value *value_of(const Json *j) {
	switch (j->type) {
	case JSON_NULL: return op_null();
	case JSON_BOOLEAN: return op_bool(j->boolean);
	case JSON_NUMBER: return op_num(j->number);
	case JSON_STRING: return op_str_n(j->string, j->stringLength);
	case JSON_ARRAY: {
		op_value *v = op_list();
		for (int i = 0; i < j->array.count; i++) op_push(v, value_of(j->array.items[i]));
		return v;
	}
	case JSON_OBJECT: {
		op_value *v = op_map();
		for (int i = 0; i < j->object.count; i++)
			op_set(v, j->object.members[i].key, value_of(j->object.members[i].value));
		return v;
	}
	default: return op_null();
	}
}

static int target_of(const Json *j, op_target *t) {
	*t = (op_target){0};
	if (!jsonIsObject(j) || (t->path = path_of(jsonGet(j, "path"), &t->length)) == NULL) return 0;
	const Json *r = jsonGet(j, "range");
	if (r == NULL) return 1;
	int64_t a, b;
	if (!jsonIsArray(r) || r->array.count != 2 || !jsonIsWhole(r->array.items[0], &a) ||
		!jsonIsWhole(r->array.items[1], &b))
		return 0;
	t->has_range = 1;
	t->from = (long)a;
	t->to = (long)b;
	return 1;
}
static void free_patch(op_patch *p) {
	free((void *)p->place.path);
	free((void *)p->move.path);
	op_free((op_value *)p->value);
}
static int patch_of(const Json *j, op_patch *p) {
	*p = (op_patch){0};
	if (!target_of(j, &p->place)) return 0;
	const Json *v = jsonGet(j, "value"), *m = jsonGet(j, "move");
	if (v != NULL) {
		p->has_value = 1;
		p->value = value_of(v);
	}
	if (m != NULL) {
		p->has_move = 1;
		if (!target_of(m, &p->move)) return 0;
	}
	return 1;
}

static Json *shown(const pt_spot *s) {
	if (s->change) return jsonString("change");
	Json *a = jsonArray();
	for (size_t i = 0; i < s->length; i++) {
		const op_key *k = &s->path[i];
		jsonPush(a, k->type == OP_NUM_KEY ? jsonInteger(k->n) : jsonString(k->s));
	}
	return a;
}
static Json *spots(pt_spot *const *out, size_t n) {
	Json *a = jsonArray();
	for (size_t i = 0; i < n; i++) jsonPush(a, shown(out[i]));
	Json *o = jsonObject();
	jsonAdd(o, "spots", a);
	return o;
}

static Json *answer(const Json *r, const char **why) {
	const char *op = jsonText(jsonGet(r, "op"));
	if (op == NULL) return *why = "no op", NULL;
	if (strcmp(op, "kept") == 0) {
		pt_kept k = pt_kept_of(paths);
		Json *o = jsonObject();
		jsonAdd(o, "keys", jsonInteger((int64_t)k.keys));
		jsonAdd(o, "spots", jsonInteger((int64_t)k.spots));
		jsonAdd(o, "steps", jsonInteger((int64_t)k.steps));
		return o;
	}
	if (strcmp(op, "marks") == 0) {
		op_patch p;
		const Json *ps = jsonGet(r, "paths");
		if (!patch_of(jsonGet(r, "patch"), &p) || !jsonIsArray(ps)) {
			free_patch(&p);
			return *why = "bad patch or paths", NULL;
		}
		Json *a = jsonArray();
		for (int i = 0; i < ps->array.count; i++) {
			size_t n;
			op_key *path = path_of(ps->array.items[i], &n);
			if (path == NULL) {
				free_patch(&p);
				jsonFree(a);
				return *why = "bad path", NULL;
			}
			jsonPush(a, jsonBoolean(pt_marks(&p, path, n)));
			free(path);
		}
		free_patch(&p);
		Json *o = jsonObject();
		jsonAdd(o, "marks", a);
		return o;
	}
	pt_key source, id;
	if (!key_of(jsonGet(r, "source"), &source) || !key_of(jsonGet(r, "id"), &id))
		return *why = "a source or id is a string or a symbol", NULL;
	if (strcmp(op, "change") == 0) return pt_change_of(paths, source, id), jsonObject();
	size_t n = 0;
	if (strcmp(op, "event") == 0) {
		pt_spot *const *out = pt_event(paths, source, id, &n);
		return spots(out, n);
	}
	if (strcmp(op, "mark") == 0) {
		const Json *ps = jsonGet(r, "patches");
		if (!jsonIsArray(ps)) return *why = "no patches", NULL;
		op_patch *patches = allocate(((size_t)ps->array.count + 1) * sizeof *patches);
		int good = 1, i = 0;
		for (; i < ps->array.count && good; i++) good = patch_of(ps->array.items[i], &patches[i]);
		Json *o = NULL;
		if (good) {
			pt_spot *const *out = pt_mark(paths, source, id, patches, (size_t)i, &n);
			o = spots(out, n);
		} else *why = "bad patch";
		while (i-- > 0) free_patch(&patches[i]);
		free(patches);
		return o;
	}
	const Json *pj = jsonGet(r, "path");
	op_key *path = pj == NULL ? NULL : path_of(pj, &n);
	if (pj != NULL && path == NULL) return *why = "bad path", NULL;
	Json *o = jsonObject();
	if (strcmp(op, "spot") == 0 && path == NULL) {
		jsonFree(o);
		o = NULL;
		*why = "no path";
	} else if (strcmp(op, "spot") == 0) pt_spot_of(paths, source, id, path, n);
	// made, then let go: a spot not there stays not there
	else if (strcmp(op, "release") == 0)
		pt_release(paths, path ? pt_spot_of(paths, source, id, path, n) : pt_change_of(paths, source, id));
	else {
		jsonFree(o);
		o = NULL;
		*why = "unknown op";
	}
	free(path);
	return o;
}

int main(void) {
	paths = pt_new();
	char *line = NULL;
	size_t size = 0;
	ssize_t got;
	while ((got = getline(&line, &size, stdin)) > 0) {
		if (strspn(line, " \t\r\n") == (size_t)got) continue;
		char *bad = NULL;
		Json *r = jsonParse(line, (size_t)got, &bad);
		const char *why = bad;
		Json *a = r ? answer(r, &why) : NULL;
		if (a == NULL) {
			a = jsonObject();
			jsonAdd(a, "error", jsonString(why ? why : "bad request"));
		}
		char *text = jsonPrint(a);
		puts(text);
		free(text);
		jsonFree(a);
		jsonFree(r);
		free(bad);
	}
	fflush(stdout);
	free(line);
	pt_free(paths);
	for (size_t i = 0; i < count; i++) free(names[i]);
	free(names);
	return 0;
}
