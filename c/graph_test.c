// graph_test.c: `make check`. CORE Ephemeral nodes, straight through the
// graph's interface: an ephemeral node is unique (one-place), goes as soon as
// it is unplaced from its slot, and takes what ephemeral it held with it,
// children before parents, each member taken out an unplacement of its own.
#include "ermine.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failures = 0;
#define CHECK(c) \
	do { \
		if (!(c)) { \
			failures++; \
			fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #c); \
		} \
	} while (0)

static ErmApi host;
static ErmTime now = 0;
static ERM_LIST(const ErmChange *) sent;

static ErmAddress at(int count, const char *const *names) {
	ErmAddress address = { 0 };
	for (int i = 0; i < count; i++) ERM_PUSH(address.names, names[i]);
	return address;
}
#define AT(...) at(sizeof((const char *[]){ __VA_ARGS__ }) / sizeof(const char *), (const char *[]){ __VA_ARGS__ })
#define ROOT ((ErmAddress){ 0 })

/** the code of an error, "" for none */
static const char *codeOf(ErmErr err) {
	return err.kind ? jsonText(jsonGet(err.why, "code")) : "";
}

/** the graph's last time, as a change at time 1 is told it */
static ErmTime lastTime(void) {
	// a write whose patch is not one: told the time when it is too early, else not-a-patch, and nothing changes
	Json *patches = jsonArray();
	jsonPush(patches, jsonObject());
	ErmOp op = { .kind = ERM_OP_WRITE, .patches = patches };
	ErmStamp stamp = { NULL, 1 };
	ErmResult out = { 0 };
	ErmErr err = ermApiOp(host, &stamp, &op, &out);
	if (strcmp(codeOf(err), "time") != 0) return 0;
	return jsonGet(err.why, "last")->number;
}

static ErmErr run(ErmOp op, ErmResult *out) {
	ErmStamp stamp = { NULL, ++now };
	*out = (ErmResult){ 0 };
	ErmErr err = ermApiOp(host, &stamp, &op, out);
	now = lastTime();
	return err;
}

static ErmErr make(ErmAddress address, const char *name, const char *id, bool ephemeral, ErmResult *out) {
	return run((ErmOp){ .kind = ERM_OP_PLACE, .address = address, .name = name, .id = id, .value = jsonString(id), .ephemeral = ephemeral }, out);
}

static ErmErr put(ErmAddress address, const char *name, const char *id, ErmResult *out) {
	return run((ErmOp){ .kind = ERM_OP_PLACE, .address = address, .name = name, .id = id }, out);
}

static ErmErr move(ErmAddress address, const char *name, const char *id, int64_t position, ErmResult *out) {
	return run((ErmOp){ .kind = ERM_OP_PLACE, .address = address, .name = name, .id = id, .hasPosition = true, .position = position }, out);
}

static ErmErr take(ErmAddress address, const char *name, const char *id, ErmResult *out) {
	return run((ErmOp){ .kind = ERM_OP_UNPLACE, .address = address, .name = name, .id = id }, out);
}

static int readCount(ErmAddress address) {
	ErmOp op = { .kind = ERM_OP_READ, .address = address };
	ErmResult out = { 0 };
	ErmStamp none = { 0 };
	ermApiOp(host, &none, &op, &out);
	return out.items.count;
}

/** the gone list, joined by spaces */
static char *goneOf(const ErmResult *out) {
	static char text[256];
	text[0] = 0;
	for (int i = 0; i < out->gone.count; i++) {
		if (i) strcat(text, " ");
		strcat(text, out->gone.items[i]);
	}
	return text;
}

static void onChange(void *data, const ErmChange *change, const ErmItems *reaches) {
	(void)data;
	(void)reaches;
	ERM_PUSH(sent, change);
}

static void fresh(void) {
	host = ermBind(ermGraph("root"), (ErmCtx){ .agent = jsonString("host") });
	now = 0;
	sent.count = 0;
}

static void uniqueness(void) {
	fresh();
	ErmResult out;
	CHECK(!make(ROOT, "e", "E", true, &out).kind);
	CHECK(!make(ROOT, "o", "O", false, &out).kind);
	// a second slot, of another node or another slot of its own parent: one-place
	CHECK(!strcmp(codeOf(put(AT("o"), "x", "E", &out)), "one-place"));
	CHECK(!strcmp(codeOf(put(ROOT, "f", "E", &out)), "one-place"));
	// within its slot: again, and to another position
	CHECK(!put(ROOT, "e", "E", &out).kind);
	CHECK(!make(ROOT, "e", "E2", true, &out).kind);
	CHECK(!move(ROOT, "e", "E", 2, &out).kind);
	// one-place comes after exists and ephemeral-parent, before position
	CHECK(!strcmp(codeOf(make(ROOT, "z", "E", true, &out)), "exists"));
	CHECK(!strcmp(codeOf(move(AT("o"), "x", "E", 9, &out)), "one-place"));
	CHECK(!strcmp(codeOf(make(AT("e"), "k", "K", false, &out)), "ephemeral-parent"));
	// making an ephemeral node with an id a slot holds, a mount included, is one-place; an ordinary one fills the mount
	CHECK(!put(AT("o"), "m", "M", &out).kind);
	CHECK(!strcmp(codeOf(make(ROOT, "n", "M", true, &out)), "one-place"));
	CHECK(!make(ROOT, "n", "M", false, &out).kind);
	// an ordinary node may go in many slots, an ephemeral one's included
	CHECK(!put(AT("e"), "o", "O", &out).kind);
}

static void cascade(void) {
	fresh();
	ErmResult out;
	int64_t sub;
	ErmAddress empty = ROOT;
	CHECK(!host.iface.vt->subscribe(host.iface.self, &host.ctx, &empty, onChange, NULL, &sub).kind);
	CHECK(!make(ROOT, "top", "E", true, &out).kind);                  // 1
	CHECK(!make(AT("top"), "b", "B", true, &out).kind);               // 2
	CHECK(!make(AT("top", "b"), "m", "M", true, &out).kind);          // 3
	CHECK(!make(AT("top"), "a", "A1", true, &out).kind);              // 4
	CHECK(!make(AT("top", "a"), "k", "K", true, &out).kind);          // 5
	CHECK(!make(AT("top"), "a", "A2", true, &out).kind);              // 6
	CHECK(!move(AT("top"), "a", "A2", 0, &out).kind);                 // 7
	CHECK(!make(ROOT, "o", "O", false, &out).kind);                   // 8
	CHECK(!make(AT("o"), "x", "X", true, &out).kind);                 // 9
	CHECK(!put(AT("top"), "c", "O", &out).kind);                      // 10
	CHECK(!put(AT("top"), "c", "P", &out).kind);                      // 11: a mount
	CHECK(!take(ROOT, "o", "O", &out).kind);                          // 12
	CHECK(!out.gone.count);
	sent.count = 0;
	CHECK(!take(ROOT, "top", "E", &out).kind);                        // 13, then 14 ...
	CHECK(!strcmp(goneOf(&out), "A2 K A1 M B E"));
	CHECK(out.change->time == 13);
	// the subscription to the root is sent the one change to the root: the operation's own
	CHECK(sent.count == 1 && !strcmp(sent.items[0]->id, "E"));
	// then a member taken out at each time from 14: A2, K, A1, M, B, O, P
	CHECK(now == 20);
	// the ordinary node stays, here but unreachable; placed again, it is there, with its ephemeral child
	CHECK(!readCount(AT("top")));
	CHECK(!put(ROOT, "back", "O", &out).kind);
	CHECK(readCount(AT("back", "x")) == 1);
	// a gone id names nothing: placing it mounts a node that is not here, and making it again makes a new one
	CHECK(!put(ROOT, "top", "E", &out).kind);
	CHECK(!readCount(AT("top")));
	CHECK(!strcmp(codeOf(make(ROOT, "again", "K", true, &out)), ""));
}

/** a cascade's unplacements each have a time of their own; a subscriber inside is sent only the change that broke its route */
static void cascadeOrder(void) {
	fresh();
	ErmResult out;
	CHECK(!make(ROOT, "top", "E", true, &out).kind);
	CHECK(!make(AT("top"), "b", "B", true, &out).kind);
	CHECK(!make(AT("top", "b"), "m", "M", true, &out).kind);
	CHECK(!make(AT("top"), "a", "A", true, &out).kind);
	const char *const paths[][2] = { { "top", NULL }, { "top", "b" }, { "top", "a" } };
	for (int i = 0; i < 3; i++) {
		ErmAddress address = paths[i][1] ? AT(paths[i][0], paths[i][1]) : AT(paths[i][0]);
		int64_t sub;
		CHECK(!host.iface.vt->subscribe(host.iface.self, &host.ctx, &address, onChange, NULL, &sub).kind);
	}
	sent.count = 0;
	CHECK(!take(ROOT, "top", "E", &out).kind);
	CHECK(!strcmp(goneOf(&out), "A M B E"));
	// A, M and B are each taken out by a change of their own, after the first; their parents are unreachable by then,
	// so each subscription is sent only the first, its route broken
	CHECK(sent.count == 3);
	for (int i = 0; i < sent.count; i++) CHECK(sent.items[i] == out.change);
	CHECK(now == out.change->time + 3);
}

/** a deep chain of ephemeral nodes goes without recursion: each made at the place of the one before */
static void deep(void) {
	fresh();
	enum { DEPTH = 10000 };
	ErmIds place = { 0 };
	for (int i = 0; i < DEPTH; i++) {
		char *id = malloc(16);
		snprintf(id, 16, "n%d", i);
		ErmCtx ctx = host.ctx;
		ctx.place.names = place;
		ErmOp op = { .kind = ERM_OP_PLACE, .name = "c", .id = id, .value = jsonNull(), .ephemeral = true };
		ErmStamp stamp = { NULL, ++now };
		ErmResult res = { 0 };
		CHECK(!ermApiOp(ermBind(host.iface, ctx), &stamp, &op, &res).kind);
		if (failures) return;
		ERM_PUSH(place, "c");
	}
	ErmResult out;
	CHECK(!take(ROOT, "c", "n0", &out).kind);
	CHECK(out.gone.count == DEPTH);
	CHECK(out.gone.count == DEPTH && !strcmp(out.gone.items[0], "n9999") && !strcmp(out.gone.items[DEPTH - 1], "n0"));
	CHECK(now == out.change->time + DEPTH - 1);
}

int main(void) {
	uniqueness();
	cascade();
	cascadeOrder();
	deep();
	if (failures) {
		fprintf(stderr, "graph: %d failed\n", failures);
		return 1;
	}
	printf("graph: all passed\n");
	return 0;
}
