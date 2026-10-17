// The C wiring on the line protocol: one JSON request per line in, one answer per line out, in order.
// Several named devices in one process, each a wiring (wiring.h) over a transport device (transport.h),
// linked by in-memory pipes as transport_harness.c links them. Values in their JSON form; keys and seeds
// as lowercase hex. There is no scheduler or graph here (core has none to wire to): the host's side is
// two operations, a change made and a log of the versions handed back.
//   {op: "reset"}, {op: "device", name, seed, root}, {op: "follow", device, doc},
//   {op: "link", a, b}, {op: "unlink", a, b}, {op: "pump"}, {op: "stored", device, doc}
//   {op: "changed", device, node, object, patches, header, at, ephemeral}  -> {}
//     header: {time, actor, reader?, external?: [site], metadata?: [[key, value]]}, as commit takes it;
//     at: a version, [from, to), or {pop: version or [from, to)}
//   {op: "received", device, node?}  -> [{node, object, versions: [{content?, change, because}], from}]
//     what the versions callback was given since last asked (the node's only, when one is named)
// The values a request builds are not freed (the log and the records hold them), so this leaks them.
#define _POSIX_C_SOURCE 200809L
#include "wiring.h"

#include "id.h"

#include "ed25519/ed25519.h"
#include "../../../ermine/encoding/c/blop.h"
#include "../../../ermine/encoding/c/json_text.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#if defined(__has_feature)
#if __has_feature(address_sanitizer)
const char *__asan_default_options(void) { return "detect_leaks=0"; }
#endif
#elif defined(__SANITIZE_ADDRESS__)
const char *__asan_default_options(void) { return "detect_leaks=0"; }
#endif

static void hex(const uint8_t *b, size_t n, char *out) {
	for (size_t i = 0; i < n; i++) snprintf(out + 2 * i, 3, "%02x", b[i]);
}

static uint8_t *unhex(const char *s, size_t *n) {
	*n = strlen(s) / 2;
	uint8_t *bytes = malloc(*n ? *n : 1);
	if (bytes == NULL) abort();
	for (size_t i = 0; i < *n; i++) {
		unsigned x;
		if (sscanf(s + 2 * i, "%2x", &x) != 1) fputs("bad hex\n", stderr), exit(1);
		bytes[i] = (uint8_t)x;
	}
	return bytes;
}

static void print(const Json *j) {
	char *s = jsonPrint(j);
	puts(s);
	free(s);
}

static void print_error(const char *why) {
	Json *j = jsonObject();
	jsonAdd(j, "error", jsonString(why));
	print(j);
}

// -- json.h's to op's headers and patches, and versions to json.h's

static bool whole(const Json *x, long *out) {
	int64_t n;
	if (x == NULL || !jsonIsWhole(x, &n)) return false;
	*out = (long)n;
	return true;
}

// a header as node.h holds it: the actor, cause and the texts borrowed from the request, which is kept
static ch_header header_of(const Json *h) {
	ch_header out = {0};
	int64_t t;
	if (jsonGet(h, "time") && jsonIsWhole(jsonGet(h, "time"), &t)) out.has_time = 1, out.time = t;
	out.actor = jsonGet(h, "actor");
	out.reader = jsonText(jsonGet(h, "reader"));
	const Json *external = jsonGet(h, "external"), *meta = jsonGet(h, "metadata");
	if (external && external->type == JSON_ARRAY) {
		ch_site *sites = calloc((size_t)external->array.count + 1, sizeof *sites);
		for (int i = 0; i < external->array.count; i++) {
			const Json *s = external->array.items[i];
			long line = 0, column = 0;
			whole(jsonGet(s, "line"), &line);
			sites[i] = (ch_site){.file = jsonText(jsonGet(s, "file")), .line = line, .function = jsonText(jsonGet(s, "function"))};
			if (whole(jsonGet(s, "column"), &column)) sites[i].column = column, sites[i].has_column = 1;
		}
		out.external = sites;
		out.external_length = (size_t)external->array.count;
	}
	if (meta && meta->type == JSON_ARRAY) {
		ch_entry *entries = calloc((size_t)meta->array.count + 1, sizeof *entries);
		for (int i = 0; i < meta->array.count; i++) {
			const Json *pair = meta->array.items[i];
			const char *key = jsonText(pair->array.items[0]);
			const Json *value = pair->array.items[1];
			const void *v = value;
			if (strcmp(key, "wallclock") == 0) {
				int64_t *n = malloc(sizeof *n);
				*n = (int64_t)value->number;
				v = n;
			} else if (strcmp(key, "message") == 0) v = jsonText(value);
			entries[i] = (ch_entry){key, v};
		}
		out.metadata = entries;
		out.metadata_length = (size_t)meta->array.count;
	}
	return out;
}

static Json *site_json(const ch_site *s) {
	Json *j = jsonObject();
	jsonAdd(j, "file", jsonString(s->file));
	jsonAdd(j, "line", jsonInteger(s->line));
	if (s->has_column) jsonAdd(j, "column", jsonInteger(s->column));
	if (s->function) jsonAdd(j, "function", jsonString(s->function));
	return j;
}

// a version as answered: the time and the entries only as the header holds them
static Json *version_json(const apply_version *v) {
	Json *j = jsonObject(), *change = jsonObject(), *because = jsonObject(), *place = jsonObject(), *why = jsonObject();
	const ch_header *h = &v->change;
	if (v->content) jsonAdd(j, "content", apply_json(v->content));
	if (h->has_time) jsonAdd(change, "time", jsonInteger(h->time));
	jsonAdd(change, "actor", h->actor ? jsonRef((Json *)h->actor) : jsonNull());
	if (h->reader) jsonAdd(change, "reader", jsonString(h->reader));
	if (h->external_length) {
		Json *list = jsonArray();
		for (size_t i = 0; i < h->external_length; i++) jsonPush(list, site_json(&h->external[i]));
		jsonAdd(change, "external", list);
	}
	if (h->metadata_length) {
		Json *list = jsonArray();
		for (size_t i = 0; i < h->metadata_length; i++) {
			const ch_entry *e = &h->metadata[i];
			Json *pair = jsonArray();
			jsonPush(pair, jsonString(e->key));
			if (strcmp(e->key, "cause") == 0) jsonPush(pair, jsonRef((Json *)e->value));
			else if (strcmp(e->key, "wallclock") == 0) jsonPush(pair, jsonInteger(*(const int64_t *)e->value));
			else jsonPush(pair, jsonString(e->value));
			jsonPush(list, pair);
		}
		jsonAdd(change, "metadata", list);
	}
	jsonAdd(j, "change", change);
	jsonAdd(because, "layer", jsonString(v->layer));
	jsonAdd(place, "lamport", jsonInteger(v->lamport));
	jsonAdd(place, "name", jsonString(v->name));
	jsonAdd(because, "place", place);
	jsonAdd(why, "signer", jsonString(v->signer));
	jsonAdd(because, "why", why);
	jsonAdd(j, "because", because);
	return j;
}

// -- the devices

typedef struct device {
	char *name;
	uint8_t seed[32], key[32];
	transport *t;
	wiring *w;
	size_t calls;
	// what versions was given since last asked
	Json *received;
} device;

typedef struct {
	device *a, *b;
	uint64_t ca, cb;
	bool live;
} wire;

static device **devices;
static size_t device_count;
static wire *links;
static size_t link_count;
static size_t moved;

static device *named(const char *name) {
	for (size_t i = 0; name && i < device_count; i++)
		if (strcmp(devices[i]->name, name) == 0) return devices[i];
	return NULL;
}

static void reset(void) {
	for (size_t i = 0; i < device_count; i++) {
		device *d = devices[i];
		wiring_free(d->w);
		transport_free(d->t);
		free(d->name);
		free(d);
	}
	free(devices);
	free(links);
	devices = NULL, links = NULL, device_count = link_count = 0;
}

// runs a device, handing what it sends to the other end of its link
static int64_t run(device *d) {
	int64_t wait = transport_run(d->t);
	transport_out out;
	while (transport_next(d->t, &out)) {
		if (out.kind == TRANSPORT_SEND) {
			for (size_t i = 0; i < link_count; i++) {
				wire *l = &links[i];
				if (!l->live) continue;
				if (l->a == d && l->ca == out.conn) transport_received(l->b->t, l->cb, out.bytes, out.length);
				else if (l->b == d && l->cb == out.conn) transport_received(l->a->t, l->ca, out.bytes, out.length);
				else continue;
				moved++;
				break;
			}
		}
		transport_out_free(&out);
	}
	return wait;
}

static void nap(void) {
	nanosleep(&(struct timespec){0, 1000000}, NULL);
}

// everything runs until quiet: no message crossing, no sealing, taking in or committing left
static const char *pump(void) {
	size_t quiet = 0, last = (size_t)-1;
	for (int round = 0; round < 2000; round++) {
		bool waiting = true;
		for (size_t i = 0; i < device_count; i++) {
			device *d = devices[i];
			if (wiring_idle(d->w)) moved++;
			if (run(d) == 0) waiting = false;
			const char *why = wiring_trouble(d->w);
			if (why) return why;
		}
		if (moved == last && waiting) {
			if (++quiet >= 5) return NULL;
		} else quiet = 0, last = moved;
		nap();
	}
	return "never quiet";
}

// -- what a device's wiring is given

static size_t sign(void *context, const uint8_t *message, size_t length, uint8_t signature[64]) {
	ermEd25519Sign(context, message, length, signature);
	return 64;
}

// the k-th call gives n bytes, the first four k big-endian, the rest zero
static void random_of(void *context, size_t n, uint8_t *out) {
	device *d = context;
	memset(out, 0, n);
	uint32_t k = (uint32_t)++d->calls;
	for (size_t i = 0; i < 4 && i < n; i++) out[i] = (uint8_t)(k >> (24 - 8 * i));
}

// the versions the wiring hands the host: logged as answered
static void versions(void *context, const char *node, wiring_where where, const char *name,
	const apply_version *list, size_t count, const wiring_from *from) {
	device *d = context;
	Json *j = jsonObject(), *vs = jsonArray(), *f = jsonObject();
	jsonAdd(j, "node", jsonString(node));
	if (where == WIRING_VALUE) jsonAdd(j, "object", jsonString("value"));
	else {
		Json *o = jsonArray();
		jsonPush(o, jsonString(where == WIRING_INFO ? "info" : "children"));
		jsonPush(o, jsonString(name));
		jsonAdd(j, "object", o);
	}
	for (size_t i = 0; i < count; i++) jsonPush(vs, version_json(&list[i]));
	jsonAdd(j, "versions", vs);
	jsonAdd(f, "actor", from->actor ? jsonRef((Json *)from->actor) : jsonNull());
	if (from->reader) jsonAdd(f, "reader", jsonString(from->reader));
	if (from->site) jsonAdd(f, "site", jsonRef((Json *)from->site));
	if (from->cause) jsonAdd(f, "cause", jsonRef((Json *)from->cause));
	if (from->has_wallclock) jsonAdd(f, "wallclock", jsonInteger(from->wallclock));
	if (from->message) jsonAdd(f, "message", jsonString(from->message));
	jsonAdd(f, "signer", jsonString(from->signer));
	jsonAdd(f, "name", jsonString(from->name));
	jsonAdd(j, "from", f);
	jsonPush(d->received, j);
}

static Json *answer_error(const char *code) {
	Json *j = jsonObject();
	jsonAdd(j, "error", jsonString(code));
	return j;
}

// a change made on the device
static Json *changed_op(device *d, const Json *r) {
	wiring_record rec = {0};
	op_patch *patches;
	size_t n;
	if (!apply_patches(jsonGet(r, "patches"), &patches, &n)) return answer_error("not a value");
	rec.node = jsonText(jsonGet(r, "node"));
	const Json *object = jsonGet(r, "object"), *at = jsonGet(r, "at");
	if (rec.node == NULL || object == NULL) return answer_error("no node");
	if (object->type == JSON_ARRAY) {
		rec.where = strcmp(object->array.items[0]->string, "info") == 0 ? WIRING_INFO : WIRING_CHILDREN;
		rec.name = object->array.items[1]->string;
	}
	rec.patches = patches;
	rec.patch_count = n;
	rec.header = header_of(jsonGet(r, "header"));
	long a, b;
	rec.at = WIRING_AT_VERSION;
	const Json *pop = at && at->type == JSON_OBJECT ? jsonGet(at, "pop") : NULL;
	const Json *where = pop ? pop : at;
	if (where && whole(where, &a)) rec.from = a, rec.to = a + 1;
	else if (where && where->type == JSON_ARRAY && whole(where->array.items[0], &a) && whole(where->array.items[1], &b)) {
		rec.from = a, rec.to = b, rec.at = WIRING_AT_SPAN;
	} else return answer_error("bad at");
	if (pop) rec.at = WIRING_AT_POP;
	const Json *eph = jsonGet(r, "ephemeral");
	rec.ephemeral = eph && eph->boolean;
	wiring_changed(d->w, &rec);
	apply_patches_free(patches, n);
	return jsonObject();
}

static Json *received_op(device *d, const Json *r) {
	const char *node = jsonText(jsonGet(r, "node"));
	Json *out = jsonArray();
	for (int i = 0; i < d->received->array.count; i++) {
		Json *x = d->received->array.items[i];
		if (node == NULL || strcmp(jsonText(jsonGet(x, "node")), node) == 0) jsonPush(out, x);
	}
	d->received = jsonArray();
	return out;
}

static int by_id(const void *x, const void *y) {
	return memcmp(x, y, 32);
}

static Json *device_op(const Json *r) {
	size_t k;
	uint8_t *seed = unhex(jsonText(jsonGet(r, "seed")), &k);
	device *d = calloc(1, sizeof *d);
	if (d == NULL || k != 32) abort();
	d->name = copyString(jsonText(jsonGet(r, "name")));
	memcpy(d->seed, seed, 32);
	free(seed);
	ermEd25519Public(d->seed, d->key);
	d->received = jsonArray();
	ErmStore *store = malloc(sizeof *store);
	if (store == NULL) abort();
	*store = ermStoreMemory();
	d->t = transport_create(d->seed, store);
	wiring_options wo = {0};
	wo.versions = versions;
	wo.context = d;
	memcpy(wo.signer.key, d->key, 32);
	wo.signer.sign = sign;
	wo.signer.context = d->seed;
	wo.random = random_of;
	wo.random_context = d;
	d->w = wiring_create(d->t, &wo);
	devices = realloc(devices, (device_count + 1) * sizeof *devices);
	if (devices == NULL) abort();
	devices[device_count++] = d;
	const char *root = jsonText(jsonGet(r, "root"));
	if (root && id_is(root)) transport_follow(d->t, root);
	Json *j = jsonObject();
	char key[65];
	hex(d->key, 32, key);
	jsonAdd(j, "key", jsonString(key));
	return j;
}

int main(void) {
	char *line = NULL;
	size_t capacity = 0;
	while (getline(&line, &capacity, stdin) != -1) {
		if (strspn(line, " \t\r\n") == strlen(line)) continue;
		char *why = NULL;
		Json *request = jsonParse(line, strlen(line), &why);
		if (request == NULL) fprintf(stderr, "bad request: %s\n", why), exit(1);
		if (!jsonDecode(&request)) fputs("bad value\n", stderr), exit(1);
		const char *op = jsonText(jsonGet(request, "op")), *doc = jsonText(jsonGet(request, "doc"));
		device *d = named(jsonText(jsonGet(request, "device")));
		if (op == NULL) print_error("unknown op undefined");
		else if (strcmp(op, "reset") == 0) {
			reset();
			puts("{}");
		} else if (strcmp(op, "device") == 0) print(device_op(request));
		else if (strcmp(op, "link") == 0) {
			device *a = named(jsonText(jsonGet(request, "a"))), *b = named(jsonText(jsonGet(request, "b")));
			if (a == NULL || b == NULL) print_error("no device");
			else {
				links = realloc(links, (link_count + 1) * sizeof *links);
				if (links == NULL) abort();
				size_t before_a = transport_connected(a->t), before_b = transport_connected(b->t);
				links[link_count++] = (wire){a, b, transport_connect(a->t, "ermine"), transport_connect(b->t, "ermine"), true};
				// the handshake done
				for (int round = 0; round < 2000 && (transport_connected(a->t) == before_a || transport_connected(b->t) == before_b); round++) {
					run(a);
					run(b);
					nap();
				}
				puts("{}");
			}
		} else if (strcmp(op, "unlink") == 0) {
			device *a = named(jsonText(jsonGet(request, "a"))), *b = named(jsonText(jsonGet(request, "b")));
			for (size_t i = 0; a && b && i < link_count; i++) {
				wire *l = &links[i];
				if (!l->live || !((l->a == a && l->b == b) || (l->a == b && l->b == a))) continue;
				transport_closed(l->a->t, l->ca);
				transport_closed(l->b->t, l->cb);
				l->live = false;
			}
			puts("{}");
		} else if (strcmp(op, "pump") == 0) {
			const char *trouble = pump();
			if (trouble) print_error(trouble);
			else puts("{}");
		} else if (d == NULL) print_error("no device");
		else if (strcmp(op, "changed") == 0) print(changed_op(d, request));
		else if (strcmp(op, "follow") == 0) {
			if (doc && transport_follow(d->t, doc) == TRANSPORT_OK) puts("{}");
			else print_error("not a document");
		} else if (strcmp(op, "received") == 0) print(received_op(d, request));
		else if (strcmp(op, "stored") == 0 && doc) {
			uint8_t(*ids)[32];
			size_t n = transport_stored(d->t, doc, &ids);
			qsort(ids, n, 32, by_id);
			Json *out = jsonArray();
			for (size_t i = 0; i < n; i++) {
				char h[65];
				hex(ids[i], 32, h);
				jsonPush(out, jsonString(h));
			}
			free(ids);
			print(out);
		} else {
			char m[128];
			snprintf(m, sizeof m, "unknown op %s", op);
			print_error(m);
		}
		fflush(stdout);
	}
	reset();
	free(line);
	return 0;
}
