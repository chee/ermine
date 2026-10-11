// Bench for pack and the canonical CBOR codec (compare newcore/encoding/ts/pack_bench.ts): same workloads.
// Values are Json (json.h); the codec is cborEncode / cborDecode. Not built with the sanitizers.
#define _POSIX_C_SOURCE 200809L
#include "cbor.h"
#include "json.h"
#include "pack.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

// --- the codec ---

static unsigned char *scratch;
static size_t room;

static int encode(void *context, const void *value, pk_bytes *out) {
	(void)context;
	size_t n = 0;
	const char *why;
	if (!value || !cborEncode(value, scratch, room, &n, &why)) return 1;
	if (n > room) {
		scratch = realloc(scratch, room = n);
		cborEncode(value, scratch, room, &n, &why);
	}
	pk_put(out, scratch, n);
	return 0;
}

static int decode(void *context, const uint8_t *item, size_t length, const void **value) {
	(void)context;
	*value = cborDecode(item, length, NULL, NULL);
	return *value == NULL;
}

static const pk_codec codec = {encode, decode, NULL};

// --- the tree: 1000 nodes, 10 under each ---

#define N 1000

typedef struct {
	char ids[10][8];
	nd_item items[10];
	nd_list lists[2];
	nd_version value, type, home[2];
	nd_entry info, children;
	nd_node *node;
} holder;

static holder *held;

static const nd_node *get(void *context, const char *id) {
	(void)context;
	return id[0] == 'n' ? held[atoi(id + 1)].node : NULL;
}

static Json *change(void) {
	Json *c = jsonObject();
	jsonAdd(c, "time", jsonNumber(1760000000000.0));
	jsonAdd(c, "actor", jsonString("a"));
	jsonAdd(c, "node", jsonString("x"));
	return c;
}

static void build(void) {
	held = calloc(N, sizeof *held);
	for (int i = 0; i < N; i++) {
		holder *h = &held[i];
		size_t k = 0;
		for (int j = 0; j < 10; j++) {
			int id = i * 10 + j + 1;
			if (id >= N) break;
			snprintf(h->ids[k], sizeof h->ids[k], "n%d", id);
			h->items[k].id = h->ids[k];
			k++;
		}
		h->lists[0] = (nd_list){h->items, k};
		h->lists[1] = (nd_list){h->items + (k ? 1 : 0), k ? k - 1 : 0};
		char title[32];
		snprintf(title, sizeof title, "note %d", i);
		Json *v = jsonObject();
		jsonAdd(v, "title", jsonString(title));
		jsonAdd(v, "done", jsonBoolean(i % 2 == 0));
		jsonAdd(v, "size", jsonNumber(i * 1.5));
		h->value = (nd_version){v, change(), NULL};
		h->type = (nd_version){jsonString("public.folder"), change(), NULL};
		h->home[0] = (nd_version){&h->lists[0], change(), NULL};
		h->home[1] = (nd_version){&h->lists[1], change(), NULL};
		h->info = (nd_entry){"type", {&h->type, 1}};
		h->children = (nd_entry){"home", {h->home, 2}};
		nd_contents c = {{&h->value, 1}, &h->info, 1, &h->children, 1};
		nd_header header = {1, 1760000000000LL + i, jsonString("host"), NULL, 0, {0}, NULL};
		char id[8];
		snprintf(id, sizeof id, "n%d", i);
		h->node = nd_make(id, &c, &header, NULL);
	}
}

// --- freeing what the codec made when unpack read it ---

static void drop(const void *v) {
	if (v) jsonFree((Json *)v);
}

static void drop_object(const nd_object *o) {
	for (size_t i = 0; i < o->length; i++) drop(o->versions[i].change), drop(o->versions[i].because);
}

static void drop_values(const pk_graph *g) {
	for (size_t i = 0; i < g->length; i++) {
		const nd_node *n = g->nodes[i];
		for (size_t k = 0; k < n->value.length; k++) drop(n->value.versions[k].content);
		drop_object(&n->value);
		for (size_t e = 0; e < n->info_length; e++) {
			for (size_t k = 0; k < n->info[e].object.length; k++)
				drop(n->info[e].object.versions[k].content);
			drop_object(&n->info[e].object);
		}
		for (size_t e = 0; e < n->children_length; e++) drop_object(&n->children[e].object);
		drop(n->header.actor), drop(n->header.cause);
	}
}

// --- timing ---

static double now(void) {
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return t.tv_sec * 1e9 + t.tv_nsec;
}

typedef void (*job)(void *);

static void bench(const char *name, job f, void *x) {
	for (int i = 0; i < 5; i++) f(x); // warm up
	size_t n = 1;
	double took;
	for (;;) { // a batch of 50ms or more says how many make 0.5s
		double t = now();
		for (size_t i = 0; i < n; i++) f(x);
		took = now() - t;
		if (took >= 5e7) break;
		n *= 2;
	}
	size_t runs = (size_t)(5e8 / (took / n)) + 1;
	double t = now();
	for (size_t i = 0; i < runs; i++) f(x);
	double each = (now() - t) / runs;
	const char *unit = "ns";
	double shown = each;
	if (each >= 1e6) shown = each / 1e6, unit = "ms";
	else if (each >= 1e3) shown = each / 1e3, unit = "us";
	printf("%-24s %9.2f %s %14.0f /s\n", name, shown, unit, 1e9 / each);
}

// --- the jobs ---

static pk_bytes graph_bytes, node_bytes;

static void pack_job(void *x) {
	(void)x;
	pk_bytes b = {0};
	pk_pack("n0", get, NULL, &codec, &b, NULL);
	free(b.data);
}

static void unpack_job(void *x) {
	(void)x;
	pk_graph g;
	pk_unpack(graph_bytes.data, graph_bytes.length, &codec, &g);
	drop_values(&g);
	pk_free(&g);
}

static void check_job(void *x) {
	(void)x;
	jsonFree(cborDecode(graph_bytes.data, graph_bytes.length, NULL, NULL));
}

static void encode_node_job(void *x) {
	(void)x;
	pk_bytes b = {0};
	pk_encode(held[1].node, &codec, &b);
	free(b.data);
}

static void decode_node_job(void *x) {
	(void)x;
	pk_graph g;
	pk_decode(node_bytes.data, node_bytes.length, &codec, &g);
	drop_values(&g);
	pk_free(&g);
}

typedef struct {
	Json *value;
	unsigned char *bytes;
	size_t length;
} sample;

static void encode_job(void *x) {
	sample *s = x;
	size_t n;
	cborEncode(s->value, s->bytes, s->length, &n, NULL);
}

static void decode_job(void *x) {
	sample *s = x;
	jsonFree(cborDecode(s->bytes, s->length, NULL, NULL));
}

static void sampled(const char *name, Json *value) {
	sample s = {value, NULL, 0};
	cborEncode(value, NULL, 0, &s.length, NULL);
	s.bytes = malloc(s.length);
	cborEncode(value, s.bytes, s.length, &s.length, NULL);
	char label[64];
	snprintf(label, sizeof label, "%s: encode", name);
	bench(label, encode_job, &s);
	snprintf(label, sizeof label, "%s: decode", name);
	bench(label, decode_job, &s);
	free(s.bytes);
}

int main(void) {
	room = 1 << 16;
	scratch = malloc(room);
	build();

	// the bytes are right before they are timed
	if (pk_pack("n0", get, NULL, &codec, &graph_bytes, NULL) != PK_OK) return puts("pack failed"), 1;
	pk_graph g;
	if (pk_unpack(graph_bytes.data, graph_bytes.length, &codec, &g) != PK_OK || g.length != N)
		return puts("unpack failed"), 1;
	drop_values(&g);
	pk_free(&g);
	if (pk_encode(held[1].node, &codec, &node_bytes) != PK_OK) return puts("encode failed"), 1;
	if (pk_decode(node_bytes.data, node_bytes.length, &codec, &g) != PK_OK || g.length != 1)
		return puts("decode failed"), 1;
	drop_values(&g);
	pk_free(&g);
	printf("graph %zu bytes, node %zu bytes\n", graph_bytes.length, node_bytes.length);

	bench("pack 1000 nodes", pack_job, NULL);
	bench("unpack 1000 nodes", unpack_job, NULL);
	bench("cborDecode graph", check_job, NULL);
	bench("encode one node", encode_node_job, NULL);
	bench("decode one node", decode_node_job, NULL);

	Json *small = jsonObject();
	jsonAdd(small, "title", jsonString("hello"));
	jsonAdd(small, "done", jsonBoolean(false));
	jsonAdd(small, "size", jsonNumber(12));
	Json *tags = jsonArray();
	jsonPush(tags, jsonString("a"));
	jsonPush(tags, jsonString("b"));
	jsonAdd(small, "tags", tags);
	sampled("small", small);

	size_t unit = strlen("lorem ipsum ");
	char *body = malloc(unit * 10000 + 1);
	for (int i = 0; i < 10000; i++) memcpy(body + i * unit, "lorem ipsum ", unit);
	body[unit * 10000] = 0;
	Json *text = jsonObject();
	jsonAdd(text, "body", jsonString(body));
	sampled("text", text);

	static double xs[10000];
	Json *numbers = jsonArray();
	for (int i = 0; i < 10000; i++) xs[i] = i * 0.25, jsonPush(numbers, jsonNumber(xs[i]));
	sampled("numbers", numbers);
	sampled("typed", jsonTyped(JSON_FLOAT64, xs, 10000));
	return 0;
}
