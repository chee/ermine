// The C layout on the line protocol (playground/files/typescript/layout_harness.ts): one JSON request per line in, one
// answer per line out, in order. Every request stands alone; the shapes are in the reference harness's header.
#include "layout.h"

#include "../../../ermine/encoding/c/json.h"
#include "names.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// the names passed over unless the request gives others (names.ts PASS)
static const char *const PASS[] = {".DS_Store", ".localized", "._*", "Icon\r", "*~", "*.swp", "#*#", "4913"};

static const char *text(const Json *j) {
	const char *s = jsonText(j);
	return s ? s : "";
}

static const char *get(const Json *o, const char *key) {
	return text(jsonGet(o, key));
}

/** an object's members in the order JavaScript's Object.entries gives: array indexes ascending, then the rest as given */
static const JsonMember **members(const Json *o, int *count) {
	*count = jsonIsObject(o) ? o->object.count : 0;
	const JsonMember **out = layout_grab((*count + 1) * sizeof *out);
	int n = 0;
	// an array index: a canonical decimal below 2^32 - 1
	int *index = layout_grab((*count + 1) * sizeof *index);
	for (int i = 0; i < *count; i++) {
		const char *k = o->object.members[i].key;
		size_t length = strlen(k);
		bool digits = length > 0 && length <= 10 && (k[0] != '0' || length == 1);
		for (size_t j = 0; digits && j < length; j++) digits = k[j] >= '0' && k[j] <= '9';
		index[i] = digits && strtoull(k, NULL, 10) < 4294967295ull;
	}
	for (int i = 0; i < *count; i++)
		if (index[i]) {
			int at = n++;
			while (at > 0 && strtoull(out[at - 1]->key, NULL, 10) > strtoull(o->object.members[i].key, NULL, 10)) out[at] = out[at - 1], at--;
			out[at] = &o->object.members[i];
		}
	for (int i = 0; i < *count; i++)
		if (!index[i]) out[n++] = &o->object.members[i];
	return out;
}

static Strs *strings(const Json *list) {
	Strs *out = strs_new();
	for (int i = 0; jsonIsArray(list) && i < list->array.count; i++) strs_push(out, text(list->array.items[i]));
	return out;
}

static Info infoin(const Json *list) {
	Info info = {0};
	if (!jsonIsArray(list)) return info;
	info.count = list->array.count;
	info.items = layout_grab((info.count + 1) * sizeof *info.items);
	for (int i = 0; i < info.count; i++) {
		const Json *t = list->array.items[i];
		info.items[i] = (Item){text(t->array.items[0]), text(t->array.items[1]), text(t->array.items[2])};
	}
	return info;
}

static const uint8_t *unhex(const char *s, size_t *n) {
	*n = strlen(s) / 2;
	uint8_t *bytes = layout_grab(*n);
	for (size_t i = 0; i < *n; i++) {
		unsigned x;
		if (sscanf(s + 2 * i, "%2x", &x) != 1) fputs("bad hex\n", stderr), exit(1);
		bytes[i] = (uint8_t)x;
	}
	return bytes;
}

static Graph *graphin(const Json *j) {
	Graph *g = layout_grab(sizeof *g);
	g->root = get(j, "root");
	g->nodes = omap_new();
	int count;
	const JsonMember **list = members(jsonGet(j, "nodes"), &count);
	for (int i = 0; i < count; i++) {
		const Json *t = list[i]->value;
		Node *n = layout_grab(sizeof *n);
		const Json *kept = jsonGet(t, "kept");
		n->hash = text(kept->array.items[0]), n->form = text(kept->array.items[1]);
		if (jsonIsString(jsonGet(t, "head"))) n->head = unhex(get(t, "head"), &n->length);
		const Json *sides = jsonGet(t, "sides");
		n->nsides = jsonIsArray(sides) ? sides->array.count : 0;
		n->sides = layout_grab((n->nsides + 1) * sizeof *n->sides);
		for (int s = 0; s < n->nsides; s++) {
			const Json *side = sides->array.items[s];
			n->sides[s].hash = text(side->array.items[0]), n->sides[s].form = text(side->array.items[1]);
			if (side->array.count > 2) n->sides[s].head = unhex(text(side->array.items[2]), &n->sides[s].length);
		}
		n->info = infoin(jsonGet(t, "info"));
		n->directory = omap_new();
		int slots;
		const JsonMember **dir = members(jsonGet(t, "directory"), &slots);
		for (int s = 0; s < slots; s++) omap_set(n->directory, dir[s]->key, strings(dir[s]->value));
		omap_set(g->nodes, list[i]->key, n);
	}
	return g;
}

static Omap *layoutin(const Json *j) {
	Omap *out = omap_new();
	int count;
	const JsonMember **list = members(j, &count);
	for (int i = 0; i < count; i++) {
		const Json *t = list[i]->value;
		Layout *r = layout_grab(sizeof *r);
		const Json *home = jsonGet(t, "home");
		if (jsonIsArray(home)) {
			Home *h = layout_grab(sizeof *h);
			*h = (Home){text(home->array.items[0]), text(home->array.items[1]), (int)home->array.items[2]->number};
			r->home = h;
		}
		if (jsonIsString(jsonGet(t, "file"))) r->file = get(t, "file");
		if (jsonIsString(jsonGet(t, "laid"))) r->laid = get(t, "laid");
		if (jsonIsString(jsonGet(t, "was"))) r->was = get(t, "was");
		if (jsonIsArray(jsonGet(t, "sides"))) r->sides = strings(jsonGet(t, "sides"));
		if (jsonIsArray(jsonGet(t, "left"))) r->left = strings(jsonGet(t, "left"));
		const Json *f = jsonGet(t, "folder"), *a = jsonGet(t, "away");
		r->folder = f && f->type == JSON_BOOLEAN && f->boolean;
		r->away = a && a->type == JSON_BOOLEAN && a->boolean;
		const Json *entries = jsonGet(t, "entries");
		if (jsonIsObject(entries)) {
			int n;
			const JsonMember **es = members(entries, &n);
			r->entries = omap_new();
			for (int e = 0; e < n; e++) {
				Entry *entry = layout_grab(sizeof *entry);
				if (jsonIsArray(es[e]->value)) entry->stems = strings(es[e]->value);
				else entry->stem = text(es[e]->value);
				omap_set(r->entries, es[e]->key, entry);
			}
		}
		omap_set(out, list[i]->key, r);
	}
	return out;
}

static Json *list(const Strs *s) {
	Json *a = jsonArray();
	for (int i = 0; i < s->count; i++) jsonPush(a, jsonString(s->items[i]));
	return a;
}

static Json *home(const Home *h) {
	Json *a = jsonArray();
	jsonPush(a, jsonString(h->holder)), jsonPush(a, jsonString(h->name)), jsonPush(a, jsonInteger(h->position));
	return a;
}

static Json *info(Info info) {
	Json *a = jsonArray();
	for (int i = 0; i < info.count; i++) {
		Json *t = jsonArray();
		jsonPush(t, jsonString(info.items[i].name)), jsonPush(t, jsonString(info.items[i].hash)), jsonPush(t, jsonString(info.items[i].form));
		jsonPush(a, t);
	}
	return a;
}

static Json *recordout(const Layout *r) {
	Json *o = jsonObject();
	if (r->home) jsonAdd(o, "home", home(r->home));
	if (r->file) jsonAdd(o, "file", jsonString(r->file));
	if (r->laid) jsonAdd(o, "laid", jsonString(r->laid));
	if (r->was) jsonAdd(o, "was", jsonString(r->was));
	if (r->sides) jsonAdd(o, "sides", list(r->sides));
	if (r->folder) jsonAdd(o, "folder", jsonBoolean(true));
	if (r->entries) {
		Json *e = jsonObject();
		for (int i = 0; i < r->entries->count; i++) {
			if (!r->entries->entries[i].live) continue;
			const Entry *x = r->entries->entries[i].value;
			jsonAdd(e, r->entries->entries[i].key, x->stems ? list(x->stems) : jsonString(x->stem));
		}
		jsonAdd(o, "entries", e);
	}
	if (r->left) jsonAdd(o, "left", list(r->left));
	if (r->away) jsonAdd(o, "away", jsonBoolean(true));
	return o;
}

static Json *layoutout(const Omap *m) {
	Json *o = jsonObject();
	for (int i = 0; i < m->count; i++)
		if (m->entries[i].live) jsonAdd(o, m->entries[i].key, recordout(m->entries[i].value));
	return o;
}

static Json *laidout(const Laid *l) {
	Json *o = jsonObject();
	static const char *const kinds[] = {"file", "side", "folder", "union", "link"};
	jsonAdd(o, "kind", jsonString(kinds[l->kind]));
	if (l->kind == LAID_UNION) {
		jsonAdd(o, "holder", jsonString(l->holder)), jsonAdd(o, "name", jsonString(l->name));
		return o;
	}
	jsonAdd(o, "id", jsonString(l->id));
	if (l->home) jsonAdd(o, "home", home(l->home));
	if (l->kind == LAID_SIDE) jsonAdd(o, "side", jsonInteger(l->side));
	if (l->kind == LAID_FILE || l->kind == LAID_SIDE) jsonAdd(o, "form", jsonString(l->form)), jsonAdd(o, "hash", jsonString(l->hash));
	if (l->kind == LAID_FILE || l->kind == LAID_FOLDER) jsonAdd(o, "info", info(l->info));
	if (l->kind == LAID_LINK) jsonAdd(o, "target", jsonString(l->target)), jsonAdd(o, "half", jsonString(l->half));
	return o;
}

static Json *foundout(Found f) {
	Json *o = jsonObject();
	switch (f.kind) {
	case FOUND_NONE: jsonFree(o); return jsonNull();
	case FOUND_FILE: jsonAdd(o, "file", jsonString(f.text)); break;
	case FOUND_LINK: jsonAdd(o, "link", jsonString(f.text)); break;
	case FOUND_FOLDER: jsonAdd(o, "folder", f.known ? jsonNumber(f.ino) : jsonNull()); break;
	}
	return o;
}

static Json *stepout(const Step *s) {
	Json *o = jsonObject();
	jsonAdd(o, "number", jsonInteger(s->number));
	jsonAdd(o, "what", jsonString(s->what));
	if (s->from) jsonAdd(o, "from", jsonString(s->from));
	if (s->to) jsonAdd(o, "to", jsonString(s->to));
	jsonAdd(o, "before", foundout(s->before));
	jsonAdd(o, "after", foundout(s->after));
	if (s->id) jsonAdd(o, "id", jsonString(s->id));
	if (s->slot) {
		Json *a = jsonArray();
		jsonPush(a, jsonString(s->holder)), jsonPush(a, jsonString(s->name));
		jsonAdd(o, "slot", a);
	}
	if (s->form) jsonAdd(o, "form", jsonString(s->form));
	if (s->hasinfo) jsonAdd(o, "info", info(s->info));
	if (s->side) jsonAdd(o, "side", jsonInteger(s->side));
	return o;
}

typedef struct {
	const Json *probe, *ino;
} Given;

static const Strs *probing(void *context, const char *folder) {
	const Given *g = context;
	const Json *names = jsonGet(g->probe, folder);
	return names ? strings(names) : NULL;
}

static bool inoing(void *context, const char *path, double *id) {
	const Given *g = context;
	const Json *n = jsonGet(g->ino, path);
	if (!jsonIsNumber(n)) return false;
	*id = n->number;
	return true;
}

/** {key: value}, taking the value */
static Json *one(const char *key, Json *value) {
	Json *o = jsonObject();
	jsonAdd(o, key, value);
	return o;
}

/** the answer to a request, a fresh value */
static Json *answer(const Json *request, const char *op) {
	if (strcmp(op, "relative") == 0) return one("path", jsonString(layout_relative(get(request, "from"), get(request, "to"))));
	if (strcmp(op, "sameInfo") == 0)
		return one("same", jsonBoolean(layout_sameinfo(infoin(jsonGet(request, "a")), infoin(jsonGet(request, "b")))));
	if (strcmp(op, "dir") == 0) {
		const char *d = layout_dir(layoutin(jsonGet(request, "layout")), get(request, "id"));
		return one("path", d ? jsonString(d) : jsonNull());
	}
	// the names passed over
	const Json *pj = jsonGet(request, "pass");
	Strs *given = jsonIsArray(pj) ? strings(pj) : NULL;
	const char *const *pass = given ? given->items : PASS;
	int count = given ? given->count : (int)(sizeof PASS / sizeof *PASS);
	if (strcmp(op, "disk") == 0) {
		Omap *m = layout_disk(graphin(jsonGet(request, "graph")), layoutin(jsonGet(request, "layout")), pass, count);
		Json *o = jsonObject();
		for (int i = 0; i < m->count; i++)
			if (m->entries[i].live) jsonAdd(o, m->entries[i].key, laidout(m->entries[i].value));
		return one("laid", o);
	}
	if (strcmp(op, "prune") == 0)
		return one("layout", layoutout(layout_prune(graphin(jsonGet(request, "graph")), layoutin(jsonGet(request, "layout")))));
	if (strcmp(op, "lay") == 0) {
		Given g = {jsonGet(request, "probe"), jsonGet(request, "ino")};
		const Json *before = jsonGet(request, "before"), *time = jsonGet(request, "time");
		Laying l = layout_lay(graphin(jsonGet(request, "graph")), layoutin(jsonGet(request, "old")), probing, &g,
			jsonIsNumber(time) ? time->number : 0, pass, count, before ? graphin(before) : NULL,
			jsonIsObject(g.ino) ? inoing : NULL, &g);
		Json *o = jsonObject(), *plan = jsonArray();
		for (int i = 0; i < l.count; i++) jsonPush(plan, stepout(&l.plan[i]));
		jsonAdd(o, "layout", layoutout(l.layout));
		jsonAdd(o, "changed", layoutout(l.changed));
		jsonAdd(o, "plan", plan);
		return o;
	}
	char message[200];
	snprintf(message, sizeof message, "unknown op %s", op);
	Json *o = jsonObject();
	jsonAdd(o, "error", jsonString(message));
	return o;
}

int main(void) {
	char *line = NULL;
	size_t capacity = 0;
	while (getline(&line, &capacity, stdin) != -1) {
		if (strspn(line, " \t\r\n") == strlen(line)) continue;
		char *why = NULL;
		Json *request = jsonParse(line, strlen(line), &why);
		if (request == NULL) {
			fprintf(stderr, "bad request: %s\n", why);
			return 1;
		}
		Json *a = answer(request, get(request, "op"));
		char *s = jsonPrint(a);
		puts(s);
		free(s);
		jsonFree(a);
		jsonFree(request);
		layout_release();
	}
	free(line);
	return 0;
}
