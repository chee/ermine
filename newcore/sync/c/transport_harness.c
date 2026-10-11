// The C transport on the line protocol (newcore/conformance/transport/harness.ts has it): one JSON
// request per line in, one answer per line out. Several devices in one process, linked by in-memory
// pipes: what one device is asked to send (transport_next) the other is handed (transport_received).
// Values in their JSON form; names, stored ids, keys, seeds, nonces and blobs as lowercase hex.
//   {op: "reset"}, {op: "device", name, seed}, {op: "follow", device, doc}, {op: "link", a, b},
//   {op: "unlink", a, b}, {op: "commit", device, doc, object, patches, actor, nonce, at?, layer?},
//   {op: "put", device, doc, head, parents, blob},
//   {op: "putfragment", device, doc, head, boundary, checkpoints, blob}, {op: "pump"},
//   {op: "state", device, doc, object?, layer?}, {op: "fragments", device, doc},
//   {op: "stored", device, doc}, {op: "topic", device, topic}, {op: "chirp", device, topic, payload},
//   {op: "heard", device, topic}, {op: "untopic", device, topic}
// A request holding values the chains keep is not freed.
#include "transport.h"

#include "commit.h"
#include "seal.h"

#include "../../c/ed25519/ed25519.h"
#include "../../encoding/c/blop.h"

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

// a chain's row (chain_harness.c's)
static void row(const chain_row *r) {
	fputs("{\"name\":\"", stdout);
	hex(r->name, 32);
	fputs("\",", stdout);
	if (r->kind == CHAIN_REFUSED) printf("\"refused\":\"%s\"", chain_refusal_name(r->refusal));
	else {
		fputs(r->kind == CHAIN_WAITING ? "\"waiting\":" : "\"stuck\":", stdout);
		names(r->names, r->count);
	}
	putchar('}');
}

// what an open topic was handed, as the JSON of "heard"'s answer's items, in order
typedef struct opened {
	uint8_t id[32];
	char *text;
	size_t length, count;
	struct opened *next;
} opened;

typedef struct {
	char *name;
	uint8_t seed[32], key[32];
	transport *t;
	opened *topics;
} device;

static bool topic_op(const char *op) {
	return strcmp(op, "topic") == 0 || strcmp(op, "chirp") == 0 || strcmp(op, "heard") == 0 || strcmp(op, "untopic") == 0;
}

static void heard(void *context, const uint8_t from[32], const uint8_t *payload, size_t length) {
	opened *l = context;
	size_t room = 2 * (32 + 32 + length) * 2 + 64;
	l->text = realloc(l->text, l->length + room);
	if (l->text == NULL) abort();
	char *at = l->text + l->length, *end = at + room;
	at += snprintf(at, (size_t)(end - at), "%s{\"from\":\"", l->count ? "," : "");
	for (size_t i = 0; i < 32; i++) at += snprintf(at, (size_t)(end - at), "%02x", from[i]);
	at += snprintf(at, (size_t)(end - at), "\",\"payload\":\"");
	for (size_t i = 0; i < length; i++) at += snprintf(at, (size_t)(end - at), "%02x", payload[i]);
	at += snprintf(at, (size_t)(end - at), "\"}");
	l->length = (size_t)(at - l->text);
	l->count++;
}

typedef struct {
	device *a, *b;
	uint64_t ca, cb;
	bool live;
} wire;

static device *devices;
static size_t device_count;
static wire *links;
static size_t link_count;
static size_t moved;

static device *named(const char *name) {
	for (size_t i = 0; name && i < device_count; i++)
		if (strcmp(devices[i].name, name) == 0) return &devices[i];
	return NULL;
}

static void reset(void) {
	for (size_t i = 0; i < device_count; i++) {
		transport_free(devices[i].t);
		free(devices[i].name);
		while (devices[i].topics) {
			opened *o = devices[i].topics;
			devices[i].topics = o->next;
			free(o->text);
			free(o);
		}
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

// everything runs until quiet: no message crossing, nothing left to take in or build
static bool pump(void) {
	size_t quiet = 0, last = (size_t)-1;
	for (int round = 0; round < 2000; round++) {
		bool waiting = true;
		for (size_t i = 0; i < device_count; i++)
			if (run(&devices[i]) == 0) waiting = false;
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
	chains *c = transport_chains(d->t, doc, layer);
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
	seal_signer signer = {{0}, sign, d->seed};
	memcpy(signer.key, d->key, 32);
	if (seal_seal(bytes, length, &signer, &sealed, &sealed_length) != SEAL_OK) {
		error("not sealed");
		return;
	}
	seal_stored(sealed, sealed_length, stored);
	transport_code result = layer == TRANSPORT_EPHEMERAL ? transport_publish(d->t, doc, sealed, sealed_length)
	                                                     : transport_add(d->t, doc, sealed, sealed_length);
	if (result != TRANSPORT_OK) {
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
	chains *c = transport_chains(d->t, doc, layer);
	if (c == NULL) {
		error("not a document");
		return;
	}
	chain_head *heads;
	size_t n = chain_heads(c, object, &heads);
	fputs("{\"heads\":[", stdout);
	for (size_t i = 0; i < n; i++) {
		if (i) putchar(',');
		putchar('"');
		hex(heads[i].name, 32);
		putchar('"');
	}
	free(heads);
	chain_row *rows;
	for (int k = 0; k < 2; k++) {
		n = k == 0 ? chain_waiting(c, &rows) : chain_refused(c, &rows);
		fputs(k == 0 ? "],\"chain\":{\"waiting\":[" : "],\"refused\":[", stdout);
		for (size_t i = 0; i < n; i++) {
			if (i) putchar(',');
			row(&rows[i]);
		}
		chain_rows_free(rows, n);
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
		// a request holding values kept by the chains lives on
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
			ErmStore *store = malloc(sizeof *store);
			if (store == NULL) abort();
			*store = ermStoreMemory();
			x->t = transport_create(x->seed, store);
			x->topics = NULL;
			fputs("{\"key\":\"", stdout);
			hex(x->key, 32);
			puts("\"}");
		} else if (strcmp(op, "link") == 0) {
			device *a = named(jsonText(jsonGet(request, "a"))), *b = named(jsonText(jsonGet(request, "b")));
			if (a == NULL || b == NULL) error("no device");
			else {
				links = realloc(links, (link_count + 1) * sizeof *links);
				if (links == NULL) abort();
				size_t before_a = transport_connected(a->t), before_b = transport_connected(b->t);
				links[link_count++] = (wire){a, b, transport_connect(a->t), transport_connect(b->t), true};
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
		} else if (d == NULL && topic_op(op)) error("no device");
		else if (topic_op(op)) {
			size_t topic_length, payload_length = 0;
			uint8_t *id = unhex(jsonText(jsonGet(request, "topic")), &topic_length);
			opened **at = &d->topics;
			while (topic_length == 32 && *at && memcmp((*at)->id, id, 32) != 0) at = &(*at)->next;
			if (topic_length != 32) error("not a topic");
			else if (strcmp(op, "topic") == 0) {
				if (*at == NULL) {
					*at = calloc(1, sizeof **at);
					if (*at == NULL) abort();
					memcpy((*at)->id, id, 32);
				}
				transport_topic(d->t, id, heard, *at);
				puts("{}");
			} else if (*at == NULL) error("no topic");
			else if (strcmp(op, "chirp") == 0) {
				uint8_t *payload = unhex(jsonText(jsonGet(request, "payload")), &payload_length);
				transport_chirp(d->t, id, payload, payload_length);
				free(payload);
				puts("{}");
			} else if (strcmp(op, "heard") == 0) printf("[%.*s]\n", (int)(*at)->length, (*at)->text ? (*at)->text : "");
			else {
				opened *o = *at;
				transport_untopic(d->t, id);
				*at = o->next;
				free(o->text);
				free(o);
				puts("{}");
			}
			free(id);
		} else if (d == NULL || doc == NULL) error("no device");
		else if (strcmp(op, "follow") == 0) {
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
			putchar('[');
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
			puts("]");
		} else if (strcmp(op, "stored") == 0) {
			uint8_t(*ids)[32];
			size_t n = transport_stored(d->t, doc, &ids);
			qsort(ids, n, 32, by_id);
			names(ids, n);
			putchar('\n');
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
