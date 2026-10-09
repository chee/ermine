// store_test.c: a graph saved to a card and restored reads the same, and an
// ephemeral node is never kept.

#include "../store.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failures = 0;
#define CHECK(cond, what) do { if (!(cond)) { failures++; fprintf(stderr, "FAIL %s\n", what); } else printf("ok %s\n", what); } while (0)

static ErmTime clock = 0;

static Json *parse(const char *text) {
	char *why = NULL;
	Json *v = jsonParse(text, strlen(text), &why);
	if (!v) fprintf(stderr, "bad test JSON: %s\n", why);
	return v;
}

static ErmErr op(ErmInterface g, ErmOp o, ErmResult *out) {
	ErmCtx ctx = { .agent = jsonString("machine") };
	ErmStamp stamp = { .site = parse("{\"file\":\"store_test.c\",\"line\":1}"), .time = ++clock };
	memset(out, 0, sizeof *out);
	return g.vt->op(g.self, &ctx, &stamp, &o, out);
}

static ErmAddress at(const char *a, const char *b) {
	ErmAddress addr = { .fromStart = true };
	if (a) ERM_PUSH(addr.names, a);
	if (b) ERM_PUSH(addr.names, b);
	return addr;
}

static Json *readValue(ErmInterface g, const char *a, const char *b) {
	ErmResult r;
	ErmOp o = { .kind = ERM_OP_READ, .address = at(a, b) };
	if (op(g, o, &r).kind != ERM_OK || !r.items.count) return NULL;
	return r.items.items[0].value;
}

int main(int argc, char **argv) {
	const char *folder = argc > 1 ? argv[1] : "/tmp/ermos-store-test";
	ErmInterface g = ermGraph("machine", NULL);
	ErmResult r;
	uint32_t px[3] = { 0xff0000, 0x00ff00, 0x0000ff };
	ErmOp place = { .kind = ERM_OP_PLACE, .address = at(NULL, NULL), .name = "etc", .id = "etc", .value = jsonNull() };
	CHECK(op(g, place, &r).kind == ERM_OK, "place /etc");
	Json *theme = parse("{\"paper\": 16644330, \"fonts\": {\"text\": {\"name\": \"Geneva\", \"size\": 12}}, \"é\": [1, -0.5, null, true]}");
	ErmOp place2 = { .kind = ERM_OP_PLACE, .address = at("etc", NULL), .name = "theme", .id = "etc-theme", .value = theme };
	CHECK(op(g, place2, &r).kind == ERM_OK, "place /etc/theme");
	ErmOp place3 = { .kind = ERM_OP_PLACE, .address = at("etc", NULL), .name = "px", .id = "etc-px", .value = jsonTyped(JSON_UINT32, px, 3) };
	CHECK(op(g, place3, &r).kind == ERM_OK, "place /etc/px, a typed array");
	ErmOp place4 = { .kind = ERM_OP_PLACE, .address = at("etc", NULL), .name = "gone", .id = "eph", .value = jsonString("ephemeral"), .ephemeral = true };
	CHECK(op(g, place4, &r).kind == ERM_OK, "place an ephemeral node");
	ErmOp write = { .kind = ERM_OP_WRITE, .address = at("etc", "theme"), .patches = parse("[{\"type\":\"set\",\"path\":[],\"key\":\"ink\",\"value\":\"plum\"}]") };
	CHECK(op(g, write, &r).kind == ERM_OK, "write /etc/theme");

	const char *why = NULL;
	CHECK(storeSave(folder, g, &why), "save");
	if (why) fprintf(stderr, "  why: %s\n", why);
	ErmSaved *saved = storeLoad(folder, &why);
	CHECK(saved != NULL, "load");
	if (why) fprintf(stderr, "  why: %s\n", why);
	if (!saved) return 1;
	ErmInterface h = ermGraph("machine", saved);
	CHECK(ermGraphLast(h) == ermGraphLast(g), "the highest time is kept");
	CHECK(jsonEqual(readValue(h, "etc", "theme"), readValue(g, "etc", "theme")), "the theme reads the same");
	CHECK(jsonEqual(readValue(h, "etc", "px"), readValue(g, "etc", "px")), "the typed array reads the same");
	CHECK(readValue(h, "etc", "gone") == NULL, "the ephemeral node is not kept");
	// the change that last wrote the theme: its header kept
	ErmOp rd = { .kind = ERM_OP_READ, .address = at("etc", "theme") };
	ErmResult a, b;
	op(g, rd, &a);
	op(h, rd, &b);
	char *ha = jsonPrint(ermHeaderToJson(a.items.items[0].change)), *hb = jsonPrint(ermHeaderToJson(b.items.items[0].change));
	CHECK(strcmp(ha, hb) == 0, "the theme's last change's header is kept");
	// a second save of the restored graph is the same bytes
	char *again = formatString("%s-again", folder);
	CHECK(storeSave(again, h, &why), "save again");
	char *p1 = formatString("%s/graph.cbor", folder), *p2 = formatString("%s/graph.cbor", again);
	FILE *f1 = fopen(p1, "rb"), *f2 = fopen(p2, "rb");
	unsigned char b1[1 << 16], b2[1 << 16];
	size_t n1 = fread(b1, 1, sizeof b1, f1), n2 = fread(b2, 1, sizeof b2, f2);
	CHECK(n1 == n2 && memcmp(b1, b2, n1) == 0, "saving what was restored writes the same bytes");
	printf("%d failures\n", failures);
	return failures ? 1 : 0;
}
