// The C transport on the line protocol (extensions/subduction/typescript/transport_harness.ts has it): one JSON
// request per line in, one answer per line out. Several devices in one process, linked by in-memory
// pipes: what one device is asked to send (transport_next) the other is handed (transport_received).
// Values in their JSON form; names, stored ids, keys, seeds, nonces and blobs as lowercase hex.
//   {op: "reset"}, {op: "device", name, seed, store?, lazy?}, {op: "drop", device}, {op: "follow", device, doc}, {op: "link", a, b},
//   {op: "unlink", a, b}, {op: "commit", device, doc, object, patches, actor, nonce, at?, layer?},
//   {op: "put", device, doc, head, parents, blob},
//   {op: "putfragment", device, doc, head, boundary, checkpoints, blob}, {op: "pump"},
//   {op: "state", device, doc, object?, layer?}, {op: "fragments", device, doc} (answered {fragments: [...]}),
//   {op: "stored", device, doc} (answered {stored: [...]}), {op: "publish", device, doc, payload}, {op: "expire"}
// A request holding values the histories keep is not freed.
#include "transport.h"

#include "commit.h"
#include "seal.h"

#include "ed25519/ed25519.h"
#include "../../../ermine/encoding/c/blop.h"
#include "../../../ermine/encoding/c/json_text.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static void hex(const uint8_t *b, size_t n) {
	for (size_t i = 0; i < n; i++) printf("%02x", b[i]);
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

static void names(uint8_t (*list)[32], size_t count) {
	putchar('[');
	for (size_t i = 0; i < count; i++) {
		if (i) putchar(',');
		putchar('"');
		hex(list[i], 32);
		putchar('"');
	}
	putchar(']');
}

// a history's row (history_harness.c's)
static void row(const history_row *r) {
	fputs("{\"name\":\"", stdout);
	hex(r->name, 32);
	fputs("\",", stdout);
	if (r->kind == HISTORY_REFUSED) printf("\"refused\":\"%s\"", history_refusal_name(r->refusal));
	else {
		fputs(r->kind == HISTORY_WAITING ? "\"waiting\":" : "\"stuck\":", stdout);
		names(r->names, r->count);
	}
	putchar('}');
}

typedef struct {
	char *name;
	uint8_t seed[32], key[32];
	transport *t;
} device;

typedef struct {
	device *a, *b;
	uint64_t ca, cb;
	bool live;
} wire;

// stores by name, kept after a device is dropped: a device made with the name takes in what one holds
typedef struct {
	char *name;
	ErmStore *store;
} kept;
static kept *stores;
static size_t store_count;

static device *devices;
static size_t device_count;
static wire *links;
static size_t link_count;
static size_t moved;

static device *named(const char *name) {
	for (size_t i = 0; name && i < device_count; i++)
		if (devices[i].name && strcmp(devices[i].name, name) == 0) return &devices[i];
	return NULL;
}

static void reset(void) {
	for (size_t i = 0; i < device_count; i++) {
		transport_free(devices[i].t);
		free(devices[i].name);
	}
	free(devices);
	free(links);
	for (size_t i = 0; i < store_count; i++) free(stores[i].name);
	free(stores);
	stores = NULL, store_count = 0;
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

// everything runs until quiet: no message crossing, nothing left to take in or build
static bool pump(void) {
	size_t quiet = 0, last = (size_t)-1;
	for (int round = 0; round < 2000; round++) {
		bool waiting = true;
		for (size_t i = 0; i < device_count; i++)
			if (devices[i].t && run(&devices[i]) == 0) waiting = false;
		if (moved == last && waiting) {
			if (++quiet >= 5) return true;
		} else quiet = 0, last = moved;
		nap();
	}
	return false;
}

// a request's member decoded from its JSON form, in place: the request keeps it
static Json *value(Json *request, const char *name) {
	for (int i = 0; i < request->object.count; i++) {
		if (strcmp(request->object.members[i].key, name) != 0) continue;
		if (!jsonDecode(&request->object.members[i].value)) fputs("bad value\n", stderr), exit(1);
		return request->object.members[i].value;
	}
	return NULL;
}

// the host's random bytes: the nonce asked for
static void nonce(void *context, size_t n, uint8_t *out) {
	if (n != 8) fputs("random: not a nonce\n", stderr), exit(1);
	memcpy(out, context, n);
}

static size_t sign(void *context, const uint8_t *message, size_t length, uint8_t signature[64]) {
	ermEd25519Sign(context, message, length, signature);
	return 64;
}

static void error(const char *why) {
	printf("{\"error\":\"%s\"}\n", why);
}

static void commit_op(Json *request, device *d, const char *doc, transport_layer layer) {
	Json *change = jsonObject(), *header = jsonObject();
	Json *object = value(request, "object"), *patches = value(request, "patches"), *actor = value(request, "actor");
	size_t n;
	uint8_t *random = unhex(jsonText(jsonGet(request, "nonce")), &n);
	jsonAdd(change, "node", jsonString(doc));
	jsonAdd(change, "object", object);
	jsonAdd(change, "patches", patches);
	jsonAdd(header, "time", jsonInteger(0));
	jsonAdd(header, "actor", actor);
	jsonAdd(change, "header", header);
	jsonAdd(change, "signer", jsonBytes(d->key, 32));
	const Json *at = jsonGet(request, "at");
	long version = at ? (long)at->number : 0;
	commit_code code;
	histories *c = transport_histories(d->t, doc, layer);
	if (c == NULL) {
		error("not a document");
		return;
	}
	Json *blop = commit_make(c, change, (commit_at){COMMIT_VERSION, version, version + 1}, NULL, 0, nonce, random, &code);
	if (blop == NULL) {
		error(commit_code_name(code));
		return;
	}
	uint8_t *bytes, *sealed, name[32], stored[32];
	size_t length, sealed_length;
	if (blop_encode(blop, &bytes, &length).code != BLOP_OK) {
		error("not a blop");
		return;
	}
	blop_name(bytes, length, name);
	if (layer == TRANSPORT_EPHEMERAL) {
		// not sealed, and it has no stored id
		if (transport_publish(d->t, doc, bytes, length) != TRANSPORT_OK) {
			error("not taken");
			return;
		}
		fputs("{\"name\":\"", stdout);
		hex(name, 32);
		puts("\"}");
		free(bytes);
		return;
	}
	seal_signer signer = {{0}, sign, d->seed};
	memcpy(signer.key, d->key, 32);
	if (seal_seal(bytes, length, &signer, NULL, &sealed, &sealed_length) != SEAL_OK) {
		error("not sealed");
		return;
	}
	seal_stored(sealed, sealed_length, stored);
	if (transport_add(d->t, doc, sealed, sealed_length, NULL) != TRANSPORT_OK) {
		error("not taken");
		return;
	}
	fputs("{\"name\":\"", stdout);
	hex(name, 32);
	fputs("\",\"stored\":\"", stdout);
	hex(stored, 32);
	puts("\"}");
	free(bytes);
	free(sealed);
	free(random);
}

static int by_id(const void *x, const void *y) {
	return memcmp(x, y, 32);
}

static void state_op(Json *request, device *d, const char *doc, transport_layer layer) {
	Json *object = value(request, "object");
	if (object == NULL) object = jsonString("value");
	histories *c = transport_histories(d->t, doc, layer);
	if (c == NULL) {
		error("not a document");
		return;
	}
	history_head *heads;
	size_t n = history_heads(c, object, &heads);
	fputs("{\"heads\":[", stdout);
	for (size_t i = 0; i < n; i++) {
		if (i) putchar(',');
		putchar('"');
		hex(heads[i].name, 32);
		putchar('"');
	}
	free(heads);
	history_row *rows;
	for (int k = 0; k < 2; k++) {
		n = k == 0 ? history_waiting(c, &rows) : history_refused(c, &rows);
		fputs(k == 0 ? "],\"history\":{\"waiting\":[" : "],\"refused\":[", stdout);
		for (size_t i = 0; i < n; i++) {
			if (i) putchar(',');
			row(&rows[i]);
		}
		history_rows_free(rows, n);
	}
	transport_taking taking = transport_taking_of(d->t, doc, layer);
	fputs("]},\"taking\":{\"waiting\":[", stdout);
	for (size_t i = 0; i < taking.waiting_count; i++) {
		if (i) putchar(',');
		fputs("{\"commit\":\"", stdout);
		hex(taking.waiting[i].commit, 32);
		fputs("\",\"waiting\":", stdout);
		names(taking.waiting[i].names, taking.waiting[i].count);
		putchar('}');
	}
	fputs("],\"refused\":[", stdout);
	// refused and stuck, merged by id
	for (size_t i = 0, k = 0; i < taking.refused_count || k < taking.stuck_count;) {
		if (i + k) putchar(',');
		if (k < taking.stuck_count && (i == taking.refused_count || memcmp(taking.stuck[k].commit, taking.refused[i].id, 32) < 0)) {
			fputs("{\"commit\":\"", stdout);
			hex(taking.stuck[k].commit, 32);
			fputs("\",\"stuck\":", stdout);
			names(taking.stuck[k].names, taking.stuck[k].count);
			putchar('}');
			k++;
			continue;
		}
		printf("{\"%s\":\"", taking.refused[i].fragment ? "fragment" : "commit");
		hex(taking.refused[i].id, 32);
		printf("\",\"refused\":\"%s\"}", transport_refusal_name(taking.refused[i].code));
		i++;
	}
	puts("]}}");
	transport_taking_free(&taking);
}

int main(void) {
	char *line = NULL;
	size_t capacity = 0;
	while (getline(&line, &capacity, stdin) != -1) {
		if (strspn(line, " \t\r\n") == strlen(line)) continue;
		char *why = NULL;
		Json *request = jsonParse(line, strlen(line), &why);
		if (request == NULL) fprintf(stderr, "bad request: %s\n", why), exit(1);
		const char *op = jsonText(jsonGet(request, "op")), *doc = jsonText(jsonGet(request, "doc"));
		device *d = named(jsonText(jsonGet(request, "device")));
		const char *layer_name = jsonText(jsonGet(request, "layer"));
		transport_layer layer = layer_name && strcmp(layer_name, "ephemeral") == 0 ? TRANSPORT_EPHEMERAL : TRANSPORT_STORED;
		// a request holding values kept by the histories lives on
		bool free_request = true;
		if (op == NULL) error("unknown op undefined");
		else if (strcmp(op, "reset") == 0) {
			reset();
			puts("{}");
		} else if (strcmp(op, "device") == 0) {
			size_t n;
			uint8_t *seed = unhex(jsonText(jsonGet(request, "seed")), &n);
			devices = realloc(devices, (device_count + 1) * sizeof *devices);
			if (devices == NULL || n != 32) abort();
			device *x = &devices[device_count++];
			x->name = copyString(jsonText(jsonGet(request, "name")));
			memcpy(x->seed, seed, 32);
			free(seed);
			ermEd25519Public(x->seed, x->key);
			ErmStore *store = NULL;
			const char *label = jsonText(jsonGet(request, "store"));
			for (size_t i = 0; label && i < store_count; i++)
				if (strcmp(stores[i].name, label) == 0) store = stores[i].store;
			if (store == NULL) {
				store = malloc(sizeof *store);
				if (store == NULL) abort();
				*store = ermStoreMemory();
				if (label) {
					stores = realloc(stores, (store_count + 1) * sizeof *stores);
					if (stores == NULL) abort();
					stores[store_count++] = (kept){copyString(label), store};
				}
			}
			const Json *lazy = jsonGet(request, "lazy");
			x->t = transport_create_lazy(x->seed, store, lazy != NULL && lazy->type == JSON_BOOLEAN && lazy->boolean, NULL, NULL);
			fputs("{\"key\":\"", stdout);
			hex(x->key, 32);
			puts("\"}");
		} else if (strcmp(op, "drop") == 0) {
			// the device gone, with its links; what its store holds stays
			if (d == NULL) error("no device");
			else {
				for (size_t i = 0; i < link_count; i++)
					if (links[i].a == d || links[i].b == d) links[i].live = false;
				transport_free(d->t);
				free(d->name);
				d->t = NULL, d->name = NULL;
				puts("{}");
			}
		} else if (strcmp(op, "link") == 0) {
			device *a = named(jsonText(jsonGet(request, "a"))), *b = named(jsonText(jsonGet(request, "b")));
			if (a == NULL || b == NULL) error("no device");
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
			if (pump()) puts("{}");
			else error("never quiet");
		} else if (strcmp(op, "expire") == 0) {
			for (size_t i = 0; i < device_count; i++)
				if (devices[i].t) transport_expire(devices[i].t);
			puts("{}");
		} else if (d == NULL || doc == NULL) error("no device");
		else if (strcmp(op, "publish") == 0) {
			size_t payload_length;
			uint8_t *payload = unhex(jsonText(jsonGet(request, "payload")), &payload_length);
			transport_publish(d->t, doc, payload, payload_length);
			free(payload);
			puts("{}");
		} else if (strcmp(op, "follow") == 0) {
			if (transport_follow(d->t, doc) == TRANSPORT_OK) puts("{}");
			else error("not a document");
		} else if (strcmp(op, "commit") == 0) {
			commit_op(request, d, doc, layer);
			free_request = false;
		} else if (strcmp(op, "put") == 0) {
			size_t head_length, blob_length, n;
			uint8_t *head = unhex(jsonText(jsonGet(request, "head")), &head_length);
			uint8_t *blob = unhex(jsonText(jsonGet(request, "blob")), &blob_length);
			const Json *list = jsonGet(request, "parents");
			uint8_t(*parents)[32] = malloc((size_t)list->array.count * 32 + 1);
			for (int i = 0; i < list->array.count; i++) {
				uint8_t *p = unhex(jsonText(list->array.items[i]), &n);
				memcpy(parents[i], p, 32);
				free(p);
			}
			if (transport_put(d->t, doc, head, (const uint8_t(*)[32])parents, (size_t)list->array.count, blob, blob_length) == TRANSPORT_OK) puts("{}");
			else error("not a document");
			free(head);
			free(blob);
			free(parents);
		} else if (strcmp(op, "putfragment") == 0) {
			size_t head_length, blob_length;
			uint8_t *head = unhex(jsonText(jsonGet(request, "head")), &head_length);
			uint8_t *blob = unhex(jsonText(jsonGet(request, "blob")), &blob_length);
			uint8_t(*lists[2])[32];
			size_t counts[2];
			const char *keys[2] = {"boundary", "checkpoints"};
			for (int k = 0; k < 2; k++) {
				const Json *list = jsonGet(request, keys[k]);
				counts[k] = (size_t)list->array.count;
				lists[k] = malloc(counts[k] * 32 + 1);
				for (size_t i = 0; i < counts[k]; i++) {
					size_t n;
					uint8_t *id = unhex(jsonText(list->array.items[i]), &n);
					memcpy(lists[k][i], id, 32);
					free(id);
				}
			}
			if (transport_put_fragment(d->t, doc, head, (const uint8_t(*)[32])lists[0], counts[0], (const uint8_t(*)[32])lists[1], counts[1], blob, blob_length) == TRANSPORT_OK) puts("{}");
			else error("not a document");
			free(head);
			free(blob);
			free(lists[0]);
			free(lists[1]);
		} else if (strcmp(op, "state") == 0) {
			state_op(request, d, doc, layer);
			free_request = false;
		} else if (strcmp(op, "fragments") == 0) {
			size_t n;
			const fragment *fs = transport_fragments(d->t, doc, &n);
			fputs("{\"fragments\":[", stdout);
			for (size_t i = 0; i < n; i++) {
				if (i) putchar(',');
				fputs("{\"head\":\"", stdout);
				hex(fs[i].head, 32);
				fputs("\",\"members\":", stdout);
				names(fs[i].members.ids, fs[i].members.count);
				fputs(",\"boundary\":", stdout);
				names(fs[i].boundary.ids, fs[i].boundary.count);
				putchar('}');
			}
			puts("]}");
		} else if (strcmp(op, "stored") == 0) {
			uint8_t(*ids)[32];
			size_t n = transport_stored(d->t, doc, &ids);
			qsort(ids, n, 32, by_id);
			fputs("{\"stored\":", stdout);
			names(ids, n);
			puts("}");
			free(ids);
		} else {
			printf("{\"error\":\"unknown op %s\"}\n", op);
		}
		if (free_request) jsonFree(request);
		fflush(stdout);
	}
	reset();
	free(line);
	return 0;
}
