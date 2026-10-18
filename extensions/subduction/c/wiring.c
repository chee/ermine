#include "wiring.h"

#include "apply.h"
#include "id.h"

#include "../../../ermine/encoding/c/blop.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// a sealing, storing or sending to do: a stored blop sealed and added, an ephemeral one published
typedef struct {
	char *doc;
	transport_layer layer;
	uint8_t *bytes;
	size_t length;
	Json *blop; // held till done: the blop decoded, and its name
	uint8_t name[32];
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

// -- values: op's to json.h's

static Json *place_json(const op_target *p) {
	Json *j = jsonObject(), *path = jsonArray();
	for (size_t i = 0; i < p->length; i++) {
		const op_key *k = &p->path[i];
		if (k->type == OP_STR_KEY) jsonPush(path, jsonString(k->s));
		else if (k->type == OP_NUM_KEY) jsonPush(path, jsonInteger(k->n));
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

static Json *patch_json(const op_patch *p) {
	Json *j = place_json(&p->place);
	if (p->has_value) jsonAdd(j, "value", p->value ? apply_json(p->value) : jsonNull());
	if (p->has_move) jsonAdd(j, "move", place_json(&p->move));
	return j;
}

static Json *object_json(wiring_where where, const char *name) {
	if (where == WIRING_VALUE) return jsonString("value");
	Json *o = jsonArray();
	jsonPush(o, jsonString(where == WIRING_INFO ? "info" : "children"));
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
	const Json *object = jsonGet(blop, "object");
	wiring_where where = WIRING_VALUE;
	const char *oname = NULL;
	if (object->type == JSON_ARRAY) {
		where = strcmp(object->array.items[0]->string, "info") == 0 ? WIRING_INFO : WIRING_CHILDREN;
		oname = object->array.items[1]->string;
	}
	apply_version *vs = NULL;
	size_t n = apply_versions(c, object, no_time, NULL, &vs);
	char signer[65], named[65];
	hex(jsonGet(blop, "signer")->bytes.data, 32, signer);
	hex(name, 32, named);
	wiring_from from = {.actor = jsonGet(blop, "actor"), .reader = jsonText(jsonGet(blop, "reader")),
		.site = jsonGet(blop, "site"), .cause = jsonGet(blop, "cause"), .signer = signer, .name = named};
	const Json *wallclock = jsonGet(blop, "wallclock");
	if (wallclock) from.has_wallclock = 1, from.wallclock = (int64_t)wallclock->number;
	from.message = jsonText(jsonGet(blop, "message"));
	w->o.versions(w->o.context, doc, where, oname, vs, n, &from);
	free(vs);
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
	for (size_t i = w->job_next; i < w->job_count; i++) free(w->jobs[i].bytes), free(w->jobs[i].doc), jsonFree(w->jobs[i].blop);
	free(w->jobs);
	for (size_t i = 0; i < w->trouble_count; i++) free(w->trouble[i]);
	free(w->trouble);
	for (size_t i = 0; i < w->shown_count; i++) free(w->shown[i]);
	free(w->shown);
	free(w);
}

static void later(wiring *w, const char *doc, transport_layer layer, uint8_t *bytes, size_t length, Json *blop, const uint8_t name[32]) {
	w->jobs = more(w->jobs, w->job_count, &w->job_room, sizeof *w->jobs);
	job *j = &w->jobs[w->job_count++];
	*j = (job){.doc = copyString(doc), .layer = layer, .bytes = bytes, .length = length, .blop = jsonRef(blop)};
	memcpy(j->name, name, 32);
}

// a header as commit takes it (a json.h object): the pieces node.h's header holds that a blop carries
static Json *header_json(const ch_header *h) {
	Json *header = jsonObject();
	jsonAdd(header, "time", jsonInteger(h->has_time ? h->time : 0));
	jsonAdd(header, "actor", h->actor ? jsonRef((Json *)h->actor) : jsonNull());
	if (h->reader) jsonAdd(header, "reader", jsonString(h->reader));
	if (h->external_length) {
		Json *list = jsonArray();
		for (size_t i = 0; i < h->external_length; i++) {
			const ch_site *s = &h->external[i];
			Json *site = jsonObject();
			jsonAdd(site, "file", jsonString(s->file));
			jsonAdd(site, "line", jsonInteger(s->line));
			if (s->has_column) jsonAdd(site, "column", jsonInteger(s->column));
			if (s->function) jsonAdd(site, "function", jsonString(s->function));
			jsonPush(list, site);
		}
		jsonAdd(header, "external", list);
	}
	// the keys a blop carries: cause, wallclock, message. Any other is left out
	Json *meta = jsonObject();
	for (size_t i = 0; i < h->metadata_length; i++) {
		const ch_entry *e = &h->metadata[i];
		Json *value;
		if (e->value == NULL) continue;
		if (strcmp(e->key, "cause") == 0) value = jsonRef((Json *)e->value);
		else if (strcmp(e->key, "wallclock") == 0) value = jsonInteger(*(const int64_t *)e->value);
		else if (strcmp(e->key, "message") == 0) value = jsonString(e->value);
		else continue;
		jsonAdd(meta, e->key, value);
	}
	if (meta->object.count) jsonAdd(header, "metadata", meta);
	else jsonFree(meta);
	return header;
}

void wiring_changed(wiring *w, const wiring_record *r) {
	const char *doc = r->node;
	// a node whose id is not a document's: none
	if (!id_is(doc)) return;
	transport_layer layer = r->ephemeral ? TRANSPORT_EPHEMERAL : TRANSPORT_STORED;
	if (r->ephemeral) show(w, doc);
	Json *change = jsonObject(), *patches = jsonArray();
	for (size_t i = 0; i < r->patch_count; i++) jsonPush(patches, patch_json(&r->patches[i]));
	jsonAdd(change, "node", jsonString(doc));
	jsonAdd(change, "object", object_json(r->where, r->name));
	jsonAdd(change, "patches", patches);
	jsonAdd(change, "header", header_json(&r->header));
	jsonAdd(change, "signer", jsonBytes(w->o.signer.key, 32));
	commit_at at = {COMMIT_VERSION, r->from, r->from + 1};
	if (r->at == WIRING_AT_SPAN) at = (commit_at){COMMIT_SPAN, r->from, r->to};
	else if (r->at == WIRING_AT_POP) at = (commit_at){COMMIT_POP, r->from, r->to};
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
	// taken in now, so that the next change commits against it; the transport takes a hold of the blop
	transport_made made = {.blop = blop};
	memcpy(made.name, name, 32);
	if (transport_take(w->t, doc, bytes, length, layer, &made) != TRANSPORT_OK) {
		trouble(w, "take", "not taken");
		jsonFree(blop);
		free(bytes);
		return;
	}
	// an ephemeral node is its process's own: what it shows is its process's, not the histories' (a
	// process's status is a version in front of its value, the record the first version alone)
	if (!r->ephemeral) settle(w, doc, layer, blop, name);
	later(w, doc, layer, bytes, length, blop, name);
	jsonFree(blop);
}

bool wiring_idle(wiring *w) {
	bool did = false;
	while (w->job_next < w->job_count) {
		job j = w->jobs[w->job_next++];
		did = true;
		if (j.layer == TRANSPORT_STORED) {
			uint8_t *sealed;
			size_t length;
			seal_made sm = {.blop = j.blop};
			memcpy(sm.name, j.name, 32);
			if (seal_seal(j.bytes, j.length, &w->o.signer, &sm, &sealed, &length) != SEAL_OK) trouble(w, "seal", "not sealed");
			else {
				transport_made made = {.blop = j.blop};
				memcpy(made.name, j.name, 32);
				seal_stored(sealed, length, made.stored);
				if (transport_add(w->t, j.doc, sealed, length, &made) != TRANSPORT_OK) trouble(w, "add", "not added");
				free(sealed);
			}
		} else if (transport_publish(w->t, j.doc, j.bytes, j.length) != TRANSPORT_OK) trouble(w, "publish", "not published");
		free(j.bytes);
		free(j.doc);
		jsonFree(j.blop);
	}
	w->job_count = w->job_next = 0;
	return did;
}
