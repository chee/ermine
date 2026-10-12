#include "wiring.h"

#include "apply.h"
#include "id.h"

#include "../../encoding/c/blop.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// a sealing, storing or sending to do: a stored blop sealed and added, an ephemeral one published
typedef struct {
	char *doc;
	transport_layer layer;
	uint8_t *bytes;
	size_t length;
} job;

struct wiring {
	transport *t;
	wiring_options o;
	job *jobs;
	size_t job_count, job_room, job_next;
	char **trouble;
	size_t trouble_count, trouble_room, trouble_next;
	// documents whose ephemeral layer is what their objects show: an ephemeral change was made or heard
	// there. Which layer an object shows is open (WIRING.tex scenarios)
	char **shown;
	size_t shown_count, shown_room;
};

static void *grab(size_t n) {
	void *p = malloc(n ? n : 1);
	if (p == NULL) abort();
	return p;
}

static void *more(void *items, size_t count, size_t *room, size_t size) {
	if (count < *room) return items;
	*room = *room ? *room * 2 : 8;
	items = realloc(items, *room * size);
	if (items == NULL) abort();
	return items;
}

static void hex(const uint8_t *b, size_t n, char *out) {
	for (size_t i = 0; i < n; i++) snprintf(out + 2 * i, 3, "%02x", b[i]);
}

static void trouble(wiring *w, const char *what, const char *why) {
	size_t n = strlen(what) + strlen(why) + 3;
	char *m = grab(n);
	snprintf(m, n, "%s: %s", what, why);
	w->trouble = more(w->trouble, w->trouble_count, &w->trouble_room, sizeof *w->trouble);
	w->trouble[w->trouble_count++] = m;
}

const char *wiring_trouble(wiring *w) {
	if (w->trouble_next == w->trouble_count) {
		for (size_t i = 0; i < w->trouble_count; i++) free(w->trouble[i]);
		w->trouble_count = w->trouble_next = 0;
		return NULL;
	}
	return w->trouble[w->trouble_next++];
}

static bool is_shown(const wiring *w, const char *doc) {
	for (size_t i = 0; i < w->shown_count; i++)
		if (strcmp(w->shown[i], doc) == 0) return true;
	return false;
}

static void show(wiring *w, const char *doc) {
	if (is_shown(w, doc)) return;
	w->shown = more(w->shown, w->shown_count, &w->shown_room, sizeof *w->shown);
	w->shown[w->shown_count++] = copyString(doc);
}

// -- values: the graph's (protect's, notify's) to json.h's, and back

static const char *kept(pr_arena *a, const char *s, size_t n) {
	char *c = pr_alloc(a, n + 1);
	memcpy(c, s, n);
	c[n] = 0;
	return c;
}

// a json.h value as protect's, in the arena; what protect's has no kind for (bytes, typed arrays) is null
static pr_value pr_of(pr_arena *a, const Json *j) {
	pr_value v;
	switch (j->type) {
	case JSON_BOOLEAN: return pr_bool(j->boolean);
	case JSON_NUMBER: return pr_num(j->number);
	case JSON_STRING: return pr_str(a, j->string, j->stringLength);
	case JSON_ARRAY:
		v = pr_list();
		for (int i = 0; i < j->array.count; i++) pr_push(a, &v, pr_of(a, j->array.items[i]));
		return v;
	case JSON_OBJECT:
		v = pr_map();
		for (int i = 0; i < j->object.count; i++)
			pr_put(a, &v, kept(a, j->object.members[i].key, j->object.members[i].keyLength), pr_of(a, j->object.members[i].value));
		return v;
	default: return pr_null();
	}
}

static const pr_value *pr_ptr(pr_arena *a, const Json *j) {
	if (j == NULL) return NULL;
	pr_value *v = pr_alloc(a, sizeof *v);
	*v = pr_of(a, j);
	return v;
}

static Json *json_of_pr(const pr_value *v) {
	Json *j;
	switch (v->kind) {
	case PR_BOOL: return jsonBoolean(v->yes != 0);
	case PR_NUM: return jsonNumber(v->num);
	case PR_STR: return jsonStringOfLength(v->str, v->n);
	case PR_LIST:
		j = jsonArray();
		for (size_t i = 0; i < v->n; i++) jsonPush(j, json_of_pr(&v->items[i]));
		return j;
	case PR_MAP:
		j = jsonObject();
		for (size_t i = 0; i < v->n; i++) jsonAdd(j, v->keys[i], json_of_pr(&v->items[i]));
		return j;
	default: return jsonNull();
	}
}

static Json *json_of_nt(const nt_value *v) {
	Json *j;
	switch (v->type) {
	case NT_NULL: return jsonNull();
	case NT_BOOL: return jsonBoolean(v->bool_);
	case NT_NUM: return jsonNumber(v->num);
	case NT_STR: return jsonStringOfLength(v->str, v->bytes);
	case NT_BYTES: return jsonBytes(v->data, v->bytes);
	case NT_TYPED: return jsonTyped((JsonKind)v->kind, v->data, nt_length(v));
	case NT_STAND: return jsonStand(json_of_nt(v->items[0]));
	case NT_LIST:
		j = jsonArray();
		for (size_t i = 0; i < v->count; i++) jsonPush(j, json_of_nt(v->items[i]));
		return j;
	default:
		j = jsonObject();
		for (size_t i = 0; i < v->count; i++) jsonAdd(j, v->keys[i], json_of_nt(v->items[i]));
		return j;
	}
}

static Json *place_json(const nt_place *p) {
	Json *j = jsonObject(), *path = jsonArray();
	for (size_t i = 0; i < p->length; i++) {
		const nt_key *k = &p->path[i];
		if (k->type == NT_STR_KEY) jsonPush(path, jsonString(k->s));
		else if (k->type == NT_NUM_KEY) jsonPush(path, jsonInteger(k->n));
		else {
			Json *span = jsonArray();
			jsonPush(span, jsonInteger(k->a));
			jsonPush(span, jsonInteger(k->b));
			jsonPush(path, span);
		}
	}
	jsonAdd(j, "path", path);
	if (p->has_range) {
		Json *range = jsonArray();
		jsonPush(range, jsonInteger(p->from));
		jsonPush(range, jsonInteger(p->to));
		jsonAdd(j, "range", range);
	}
	return j;
}

static Json *patch_json(const nt_patch *p) {
	Json *j = place_json(&p->place);
	if (p->has_value) jsonAdd(j, "value", json_of_nt(p->value));
	if (p->has_move) jsonAdd(j, "move", place_json(&p->move));
	return j;
}

static Json *object_json(gr_where where, const char *name) {
	if (where == GR_VALUE) return jsonString("value");
	Json *o = jsonArray();
	jsonPush(o, jsonString(where == GR_INFO ? "info" : "children"));
	jsonPush(o, jsonString(name));
	return o;
}

// -- in: an object's versions

static int64_t no_time(void *context, const char *name) {
	(void)context, (void)name;
	return 0;
}

// the object's versions made the histories', after the blop taken in
static void settle(wiring *w, const char *doc, transport_layer layer, const Json *blop, const uint8_t name[32]) {
	histories *c = transport_histories(w->t, doc, layer);
	if (c == NULL) return;
	// what versions is handed is borrowed for the call: made here, let go of after
	pr_arena scratch = {0}, *a = &scratch;
	const Json *object = jsonGet(blop, "object");
	gr_where where = GR_VALUE;
	const char *oname = NULL;
	if (object->type == JSON_ARRAY) {
		where = strcmp(object->array.items[0]->string, "info") == 0 ? GR_INFO : GR_CHILDREN;
		oname = object->array.items[1]->string;
	}
	apply_version *vs = NULL;
	size_t n = apply_versions(c, object, no_time, NULL, &vs);
	gr_incoming *list = grab(n * sizeof *list);
	gr_change *changes = grab(n * sizeof *changes);
	gr_synced *because = grab(n * sizeof *because);
	for (size_t i = 0; i < n; i++) {
		const apply_version *v = &vs[i];
		const ch_header *h = &v->change.header;
		gr_change *ch = &changes[i];
		memset(ch, 0, sizeof *ch);
		ch->actor = pr_ptr(a, h->actor);
		ch->reader = h->reader;
		ch->cause = pr_ptr(a, h->cause);
		ch->node = v->change.node;
		if (h->has_site) {
			pr_value *site = pr_alloc(a, sizeof *site);
			*site = pr_map();
			pr_put(a, site, "file", pr_str(a, h->site.file, strlen(h->site.file)));
			pr_put(a, site, "line", pr_num((double)h->site.line));
			if (h->site.column) pr_put(a, site, "column", pr_num((double)h->site.column));
			if (h->site.function) pr_put(a, site, "function", pr_str(a, h->site.function, strlen(h->site.function)));
			ch->site = site;
		}
		because[i] = (gr_synced){v->because.layer, v->place.lamport, v->place.name, v->why.signer};
		list[i] = (gr_incoming){v->content, ch, &because[i]};
	}
	char signer[65], named[65];
	hex(jsonGet(blop, "signer")->bytes.data, 32, signer);
	hex(name, 32, named);
	const Json *reader = jsonGet(blop, "reader");
	gr_from from = {pr_ptr(a, jsonGet(blop, "actor")), jsonText(reader), pr_ptr(a, jsonGet(blop, "site")),
		pr_ptr(a, jsonGet(blop, "cause")), signer, named};
	w->o.versions(w->o.context, doc, where, oname, list, n, &from);
	free(list);
	free(changes);
	free(because);
	free(vs);
	pr_free(&scratch);
}

static void arrived(void *context, const transport_arrival *arrival) {
	wiring *w = context;
	if (arrival->heard) show(w, arrival->doc);
	transport_layer layer = is_shown(w, arrival->doc) ? TRANSPORT_EPHEMERAL : TRANSPORT_STORED;
	if (arrival->layer != layer) return;
	settle(w, arrival->doc, layer, arrival->blop, arrival->name);
}

// -- out: a record

wiring *wiring_create(transport *t, const wiring_options *options) {
	wiring *w = calloc(1, sizeof *w);
	if (w == NULL) abort();
	w->t = t;
	w->o = *options;
	transport_arrived(t, arrived, w);
	return w;
}

void wiring_free(wiring *w) {
	if (w == NULL) return;
	for (size_t i = w->job_next; i < w->job_count; i++) free(w->jobs[i].bytes), free(w->jobs[i].doc);
	free(w->jobs);
	for (size_t i = 0; i < w->trouble_count; i++) free(w->trouble[i]);
	free(w->trouble);
	for (size_t i = 0; i < w->shown_count; i++) free(w->shown[i]);
	free(w->shown);
	free(w);
}

static void later(wiring *w, const char *doc, transport_layer layer, uint8_t *bytes, size_t length) {
	w->jobs = more(w->jobs, w->job_count, &w->job_room, sizeof *w->jobs);
	w->jobs[w->job_count++] = (job){copyString(doc), layer, bytes, length};
}

void wiring_changed(wiring *w, const gr_record *r) {
	const char *doc = r->node;
	// a node whose id is not a document's: none
	if (!id_is(doc)) return;
	transport_layer layer = r->ephemeral ? TRANSPORT_EPHEMERAL : TRANSPORT_STORED;
	if (r->ephemeral) show(w, doc);
	Json *change = jsonObject(), *header = jsonObject(), *patches = jsonArray();
	for (size_t i = 0; i < r->npatches; i++) jsonPush(patches, patch_json(&r->patches[i]));
	const gr_change *h = r->header;
	jsonAdd(header, "time", jsonInteger(h->time));
	jsonAdd(header, "actor", h->actor ? json_of_pr(h->actor) : jsonNull());
	if (h->reader) jsonAdd(header, "reader", jsonString(h->reader));
	if (h->site) jsonAdd(header, "site", json_of_pr(h->site));
	if (h->cause) jsonAdd(header, "cause", json_of_pr(h->cause));
	jsonAdd(change, "node", jsonString(doc));
	jsonAdd(change, "object", object_json(r->where, r->name));
	jsonAdd(change, "patches", patches);
	jsonAdd(change, "header", header);
	jsonAdd(change, "signer", jsonBytes(w->o.signer.key, 32));
	commit_at at = {COMMIT_VERSION, r->from, r->from + 1};
	if (r->at == GR_AT_SPAN) at = (commit_at){COMMIT_SPAN, r->from, r->to};
	else if (r->at == GR_AT_POP) at = (commit_at){COMMIT_POP, r->from, r->to};
	histories *c = transport_histories(w->t, doc, layer);
	commit_code code;
	Json *blop = c ? commit_make(c, change, at, w->o.roots, w->o.root_count, w->o.random, w->o.random_context, &code) : NULL;
	// the blop holds what it shares of the change
	jsonFree(change);
	if (blop == NULL) {
		trouble(w, "commit", c ? commit_code_name(code) : "not a document");
		return;
	}
	uint8_t *bytes, name[32];
	size_t length;
	blop_error error = blop_encode(blop, &bytes, &length);
	if (error.code != BLOP_OK) {
		free(error.field);
		jsonFree(blop);
		trouble(w, "commit", "not a blop");
		return;
	}
	blop_name(bytes, length, name);
	// taken in now, so that the next change commits against it; the transport keeps its own, decoded
	if (transport_take(w->t, doc, bytes, length, layer) != TRANSPORT_OK) {
		trouble(w, "take", "not taken");
		jsonFree(blop);
		free(bytes);
		return;
	}
	settle(w, doc, layer, blop, name);
	jsonFree(blop);
	later(w, doc, layer, bytes, length);
}

bool wiring_idle(wiring *w) {
	bool did = false;
	while (w->job_next < w->job_count) {
		job j = w->jobs[w->job_next++];
		did = true;
		if (j.layer == TRANSPORT_STORED) {
			uint8_t *sealed;
			size_t length;
			if (seal_seal(j.bytes, j.length, &w->o.signer, &sealed, &length) != SEAL_OK) trouble(w, "seal", "not sealed");
			else {
				if (transport_add(w->t, j.doc, sealed, length) != TRANSPORT_OK) trouble(w, "add", "not added");
				free(sealed);
			}
		} else if (transport_publish(w->t, j.doc, j.bytes, j.length) != TRANSPORT_OK) trouble(w, "publish", "not published");
		free(j.bytes);
		free(j.doc);
	}
	w->job_count = w->job_next = 0;
	return did;
}
