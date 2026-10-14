// Bench for pack and the canonical CBOR codec (compare ../typescript/pack_bench.ts): same workloads.
// Value samples are Json (json.h), written by cborEncode / cborDecode. Not built with the sanitizers.
#define _POSIX_C_SOURCE 200809L
#include "cbor.h"
#include "json.h"
#include "pack.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

// --- the nodes: 1000 ids, three parts each ---

#define N 1000

static pk_entry entries[3 * N];
static nd_node *nodes[3 * N];

static ch_header header(int i) {
	static const ch_site site = {"file:///a.ts", 12, 3, "f", 1};
	return (ch_header){.has_time = 1, .time = 1760000000 + i, .actor = NULL, .reader = "host",
		.external = &site, .external_length = 1};
}

static void build(void) {
	for (int i = 0; i < N; i++) {
		static char ids[N][8];
		snprintf(ids[i], sizeof ids[i], "n%d", i);
		char title[32];
		snprintf(title, sizeof title, "note %d", i);
		op_value *v = op_map(), *home = op_list();
		op_set(v, "title", op_str(title));
		op_set(v, "done", op_bool(i % 2 == 0));
		op_set(v, "size", op_num(i * 1.5));
		for (int k = 1; k <= 10 && i * 10 + k < N; k++) {
			op_value *entry = op_list();
			op_push(entry, op_str("host"));
			char kid[8];
			snprintf(kid, sizeof kid, "n%d", i * 10 + k);
			op_push(entry, op_str(kid));
			op_push(home, entry);
		}
		op_value *children = op_map();
		op_set(children, "home", home);
		op_value *type = op_map();
		op_set(type, "type", op_str("public.folder"));
		op_value *values[3] = {v, type, children};
		const char *parts[3] = {"value", "attributes", "children"};
		for (int p = 0; p < 3; p++) {
			ch_header h = header(i);
			nd_node *n = nd_make(values[p], &h, NULL);
			nodes[3 * i + p] = n;
			entries[3 * i + p] = (pk_entry){tb_string(parts[p]), tb_string(ids[i]), n};
		}
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
	pk_pack(entries, 3 * N, NULL, &b, NULL);
	free(b.data);
}

static void unpack_job(void *x) {
	(void)x;
	pk_read g;
	pk_unpack(graph_bytes.data, graph_bytes.length, NULL, &g);
	pk_free(&g);
}

static void check_job(void *x) {
	(void)x;
	jsonFree(cborDecode(graph_bytes.data, graph_bytes.length, NULL, NULL));
}

static void encode_node_job(void *x) {
	(void)x;
	pk_bytes b = {0};
	pk_encode(nodes[0], NULL, &b);
	free(b.data);
}

static void decode_node_job(void *x) {
	(void)x;
	pk_read g;
	pk_decode(node_bytes.data, node_bytes.length, NULL, &g);
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
	build();

	// the bytes are right before they are timed
	if (pk_pack(entries, 3 * N, NULL, &graph_bytes, NULL) != PK_OK) return puts("pack failed"), 1;
	pk_read g;
	if (pk_unpack(graph_bytes.data, graph_bytes.length, NULL, &g) != PK_OK || g.length != 3 * N)
		return puts("unpack failed"), 1;
	pk_free(&g);
	if (pk_encode(nodes[0], NULL, &node_bytes) != PK_OK) return puts("encode failed"), 1;
	if (pk_decode(node_bytes.data, node_bytes.length, NULL, &g) != PK_OK || g.count != 1)
		return puts("decode failed"), 1;
	pk_free(&g);
	printf("pack %zu bytes, node %zu bytes\n", graph_bytes.length, node_bytes.length);

	bench("pack 3000 nodes", pack_job, NULL);
	bench("unpack 3000 nodes", unpack_job, NULL);
	bench("cborDecode pack", check_job, NULL);
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
