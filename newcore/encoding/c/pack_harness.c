// The C pack on the line protocol (newcore/conformance/pack/harness.ts): one JSON request per
// line in, one answer per line out. Values are kept as their JSON text (shown.c), in their JSON
// form (ENCODING.tex: "/" for bytes, typed arrays, NaN and the infinities); the codec writes that
// as canonical CBOR (json.c, cbor.c) and reads CBOR back as it. Bytes are hex.
#include "cbor.h"
#include "json.h"
#include "pack.h"
#include "../../nodes/c/shown.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// --- the codec: JSON text to canonical CBOR, and back (json.c, cbor.c) ---

static int encode(void *context, const void *value, pk_bytes *out) {
	(void)context;
	if (value == NULL) return 1;
	char *why = NULL;
	Json *x = jsonParse(value, strlen(value), &why);
	if (x == NULL) return free(why), 1;
	// the "/" forms: bytes, typed arrays, numbers JSON cannot write
	if (!jsonDecode(&x, false)) return jsonFree(x), 1;
	size_t n = 0;
	const char *reason;
	int bad = !cborEncode(x, NULL, 0, &n, &reason);
	if (!bad) {
		unsigned char *bytes = take(n);
		cborEncode(x, bytes, n, &n, &reason);
		pk_put(out, bytes, n);
	}
	jsonFree(x);
	return bad;
}

static int decode(void *context, const uint8_t *item, size_t length, const void **value) {
	(void)context;
	Json *x = cborDecode(item, length, NULL, NULL);
	if (x == NULL) return 1;
	char *printed = jsonPrint(x);
	char *s = take(strlen(printed) + 1);
	strcpy(s, printed);
	free(printed);
	jsonFree(x);
	*value = s;
	return 0;
}

static const pk_codec codec = {encode, decode, NULL};

// --- the nodes a request loads ---

typedef struct {
	nd_node **nodes;
	size_t length;
} table;

static const nd_node *get(void *context, const char *id) {
	const table *t = context;
	for (size_t i = 0; i < t->length; i++)
		if (strcmp(t->nodes[i]->id, id) == 0) return t->nodes[i];
	return NULL;
}

static table load(const char *line) {
	table t = {0};
	const char *given = field(line, "nodes");
	if (given == NULL) return t;
	const char **xs;
	t.length = items(given, &xs);
	t.nodes = take(t.length * sizeof *t.nodes);
	for (size_t i = 0; i < t.length; i++) t.nodes[i] = parse_node(xs[i]);
	return t;
}

static void unload(table t) {
	for (size_t i = 0; i < t.length; i++) nd_free(t.nodes[i]);
}

// --- answers ---

static const char *codes[] = {"", "nothing-there", "cannot-carry", "not-a-graph", "not-a-node", "no-memory"};

static void error(pk_code code, const char *id) {
	printf("{\"code\":\"%s\"", codes[code]);
	if (id) fputs(",\"id\":", stdout), text(id);
	puts("}");
}

static void graph(const pk_graph *g) {
	fputs("{\"graph\":{\"root\":", stdout);
	text(g->root);
	fputs(",\"nodes\":[", stdout);
	for (size_t i = 0; i < g->length; i++) {
		if (i) putchar(',');
		show_node(g->nodes[i]);
	}
	fputs("],\"missing\":[", stdout);
	for (size_t i = 0; i < g->missing_length; i++) {
		if (i) putchar(',');
		text(g->missing[i]);
	}
	puts("]}}");
}

static void walk(const char *line) {
	table t = load(line);
	const char *root = string(field(line, "root"));
	pk_graph g;
	pk_code code = pk_walk(root, get, &t, &g);
	if (code == PK_OK) graph(&g);
	else error(code, code == PK_NOTHING_THERE ? root : NULL);
	pk_free(&g);
	unload(t);
}

static void pack(const char *line) {
	table t = load(line);
	const char *root = string(field(line, "root")), *id = NULL;
	pk_bytes b = {0};
	pk_code code = pk_pack(root, get, &t, &codec, &b, &id);
	if (code == PK_OK) {
		fputs("{\"bytes\":\"", stdout);
		for (size_t i = 0; i < b.length; i++) printf("%02x", b.data[i]);
		puts("\"}");
	} else error(code, code == PK_NOTHING_THERE ? root : id);
	free(b.data);
	unload(t);
}

static uint8_t *unhex(const char *hex, size_t *n) {
	*n = strlen(hex) / 2;
	uint8_t *bytes = take(*n);
	for (size_t i = 0; i < *n; i++) {
		unsigned x;
		if (sscanf(hex + 2 * i, "%2x", &x) != 1) fail("bad hex");
		bytes[i] = (uint8_t)x;
	}
	return bytes;
}

static void unpack(const char *line) {
	size_t n;
	uint8_t *bytes = unhex(string(field(line, "bytes")), &n);
	pk_graph g;
	pk_code code = pk_unpack(bytes, n, &codec, &g);
	if (code == PK_OK) graph(&g);
	else error(code, NULL);
	pk_free(&g);
}

static void encode_op(const char *line) {
	const nd_node *n = parse_node(field(line, "node"));
	pk_bytes b = {0};
	pk_code code = pk_encode(n, &codec, &b);
	if (code == PK_OK) {
		fputs("{\"bytes\":\"", stdout);
		for (size_t i = 0; i < b.length; i++) printf("%02x", b.data[i]);
		puts("\"}");
	} else error(code, n->id);
	free(b.data);
	nd_free((nd_node *)n);
}

static void decode_op(const char *line) {
	size_t n;
	uint8_t *bytes = unhex(string(field(line, "bytes")), &n);
	pk_graph g;
	pk_code code = pk_decode(bytes, n, &codec, &g);
	if (code == PK_OK) {
		fputs("{\"node\":", stdout);
		show_node(g.nodes[0]);
		puts("}");
	} else error(code, NULL);
	pk_free(&g);
}

int main(void) {
	char *line = NULL;
	size_t capacity = 0;
	while (getline(&line, &capacity, stdin) != -1) {
		if (strspn(line, " \t\r\n") == strlen(line)) continue;
		const char *op = field(line, "op");
		if (op == NULL) fail("no op");
		char *name = string(op);
		if (strcmp(name, "walk") == 0) walk(line);
		else if (strcmp(name, "pack") == 0) pack(line);
		else if (strcmp(name, "unpack") == 0) unpack(line);
		else if (strcmp(name, "encode") == 0) encode_op(line);
		else if (strcmp(name, "decode") == 0) decode_op(line);
		else printf("{\"error\":\"unknown op %s\"}\n", name);
		clear();
	}
	fflush(stdout);
	free(line);
	finish();
	return 0;
}
