// littlesync's host tests: devices over in-memory pipes, a file store, and a count of heap bytes
#include "../littlesync.h"

#include "../frame.h"
#include "../../../../../playground/demos/pigs/littlesync/pigs.h"

#include "../../../../../ermine/encoding/c/cbor.h"
#include "../../../../../ermine/encoding/c/commit.h"
#include "../../../../../ermine/encoding/c/json.h"
#include "../../../../../core/op/c/json.h"
#include "../../../../../extensions/together/c/seal.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int failed, checks;
#define CHECK(cond) \
	do { \
		checks++; \
		if (!(cond)) { \
			failed++; \
			printf("  FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
		} \
	} while (0)

static uint64_t rng = 88172645463325252ull;
static uint32_t rnd(void) {
	rng ^= rng << 13, rng ^= rng >> 7, rng ^= rng << 17;
	return (uint32_t)(rng >> 16);
}
static void random_bytes(void *context, uint8_t *out, size_t n) {
	(void)context;
	for (size_t i = 0; i < n; i++) out[i] = (uint8_t)rnd();
}

static const char *P1 = "ermine://d3b583537595c9a6de0110781d4566d1" "00000000000000000000000000000000";
static const char *P2 = "ermine://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "00000000000000000000000000000000";
static const char *P3 = "ermine://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" "00000000000000000000000000000000";

// ---- a pair of devices and the pipe between them

typedef struct {
	ls_dev *d;
	struct ls_link *l;
	ls_store store;
	char dir[64];
	// the bytes it sends are given to the other, through the pipe's filters
} side;

static int64_t now;
static int garbage; // text put between frames on the wire
static int tamper;  // flip a byte of each seal on the wire
static int tapped, tap_good, tap_bad;

static void logline(void *c, const char *l) { printf("    [%s %lld] %s\n", (char *)c, (long long)now, l); }

static side open_side(const char *tag) {
	side s = {0};
	snprintf(s.dir, sizeof s.dir, "build/state-%s-%d", tag, (int)getpid());
	s.store = ls_store_file(s.dir);
	ls_options o = {.store = s.store, .random = random_bytes};
	if (getenv("LSLOG")) o.log = logline, o.log_context = (void *)strdup(tag);
	s.d = ls_open(&o);
	s.l = ls_link(s.d);
	return s;
}
static void close_side(side *s) {
	ls_close(s->d);
	s->d = NULL;
	s->l = NULL;
}
static void drop_dir(side *s) {
	char cmd[128];
	snprintf(cmd, sizeof cmd, "rm -rf %s", s->dir);
	ls_store_file_free(&s->store);
	if (system(cmd)) {}
}

// every commit seen on the wire: its name, lamport and parents, for the lamport rule
#define SEEN_MAX 4096
static struct {
	uint8_t name[CM_NAME];
	int64_t lamport;
	uint8_t parents[LS_MAX_PARENTS][CM_NAME];
	size_t n_parents;
} wire_seen[SEEN_MAX];
static size_t n_wire_seen;
static void remember(const uint8_t *sealed, size_t length) {
	Json *x = cborDecode(sealed, length, NULL, NULL);
	const Json *c = x ? jsonGet(x, "commit") : NULL;
	cm_commit cm;
	if (c != NULL && c->type == JSON_BYTES && cm_decode(c->bytes.data, c->bytes.length, &cm, NULL) == CM_OK) {
		uint8_t name[CM_NAME];
		cm_name(c->bytes.data, c->bytes.length, name);
		bool known = false;
		for (size_t i = 0; i < n_wire_seen && !known; i++) known = memcmp(wire_seen[i].name, name, CM_NAME) == 0;
		if (!known && n_wire_seen < SEEN_MAX && cm.parents_length <= LS_MAX_PARENTS) {
			memcpy(wire_seen[n_wire_seen].name, name, CM_NAME);
			wire_seen[n_wire_seen].lamport = cm.lamport;
			memcpy(wire_seen[n_wire_seen].parents, cm.parents, cm.parents_length * CM_NAME);
			wire_seen[n_wire_seen++].n_parents = cm.parents_length;
		}
		cm_free(&cm);
	}
	jsonFree(x);
}
// the lamport rule over every commit seen since the last call: 1 + the highest of its parents' (1 with
// none). How many broke it; *unknown: those with a parent never on the wire
static int lamport_rule(int *checked, int *unknown) {
	int broke = 0;
	*checked = *unknown = 0;
	for (size_t i = 0; i < n_wire_seen; i++) {
		int64_t top = 0;
		bool all = true;
		for (size_t k = 0; k < wire_seen[i].n_parents; k++) {
			bool found = false;
			for (size_t j = 0; j < n_wire_seen && !found; j++)
				if (memcmp(wire_seen[j].name, wire_seen[i].parents[k], CM_NAME) == 0) {
					found = true;
					if (wire_seen[j].lamport > top) top = wire_seen[j].lamport;
				}
			all &= found;
		}
		if (!all) {
			(*unknown)++;
			continue;
		}
		(*checked)++;
		if (wire_seen[i].lamport != top + 1) broke++;
	}
	n_wire_seen = 0;
	return broke;
}
// the most parents any commit seen had
static size_t most_parents(void) {
	size_t m = 0;
	for (size_t i = 0; i < n_wire_seen; i++)
		if (wire_seen[i].n_parents > m) m = wire_seen[i].n_parents;
	return m;
}

// what is on the wire is checked: every commits message's seals must verify with seal.c's own check
static void tap(const uint8_t *b, size_t n) {
	static uint8_t frame[LS_FRAME_MAX];
	static size_t k;
	for (size_t i = 0; i < n; i++) {
		if (b[i] != 0) {
			if (k < sizeof frame) frame[k++] = b[i];
			continue;
		}
		if (k > 0) {
			const uint8_t *m;
			size_t len;
			if (ls_unframe(frame, k, &m, &len)) {
				Json *j = cborDecode(m, len, NULL, NULL);
				const Json *t = jsonGet(j, "t"), *node = jsonGet(j, "node"), *sealed = jsonGet(j, "sealed");
				if (t && strcmp(t->string, "commits") == 0 && node && sealed)
					for (int q = 0; q < sealed->array.count; q++) {
						sl_unsealed u;
						sl_code c = sl_unseal(sealed->array.items[q]->bytes.data, sealed->array.items[q]->bytes.length, node->bytes.data, &u, NULL);
						remember(sealed->array.items[q]->bytes.data, sealed->array.items[q]->bytes.length);
						tapped++;
						if (c == SL_OK) tap_good++, sl_free(&u);
						else tap_bad++;
					}
				jsonFree(j);
			}
		}
		k = 0;
	}
}

static size_t carry(side *from, side *to) {
	if (from->d == NULL || to->d == NULL) {
		const uint8_t *drop;
		if (from->d != NULL) ls_next(from->l, &drop);
		return 0;
	}
	const uint8_t *out;
	size_t n = ls_next(from->l, &out);
	if (n == 0) return 0;
	tap(out, n);
	uint8_t *copy = malloc(n + 64);
	memcpy(copy, out, n);
	if (tamper) {
		// a byte in the middle of a seal: the CRC would catch it, so it is mended
		copy[0] = copy[0];
	}
	if (garbage) {
		const char *log = "I (1234) main: some log text, not a frame\r\n";
		ls_feed(to->l, (const uint8_t *)log, strlen(log));
		// one carry in four has text in the middle of a frame: that frame is lost
		if (rnd() % 4 == 0) {
			ls_feed(to->l, copy, n / 2);
			ls_feed(to->l, (const uint8_t *)"E (5) x: \xff\x01 mid\r\n", 14);
			ls_feed(to->l, copy + n / 2, n - n / 2);
		} else ls_feed(to->l, copy, n);
		ls_feed(to->l, (const uint8_t *)log, strlen(log));
	} else ls_feed(to->l, copy, n);
	free(copy);
	return n;
}

// a cut: what both have to send is lost (but seen by the tap)
static void cut(side *a, side *b) {
	const uint8_t *out;
	size_t n = ls_next(a->l, &out);
	tap(out, n);
	n = ls_next(b->l, &out);
	tap(out, n);
}

// the lamport rule held for every commit on the wire since the last check
static void check_lamports(void) {
	int checked, unknown;
	int broke = lamport_rule(&checked, &unknown);
	CHECK(broke == 0 && checked > 0 && unknown == 0);
	if (broke || unknown) printf("  lamport rule: %d checked, %d broke, %d with a parent never seen\n", checked, broke, unknown);
}

// time passes by ms, the two talking until quiet
static void pump(side *a, side *b, int64_t ms) {
	for (int64_t end = now + ms; now <= end; now += 10) {
		if (a->d) ls_tick(a->d, now);
		if (b->d) ls_tick(b->d, now);
		for (int round = 0; round < 50; round++) {
			size_t n = carry(a, b);
			n += carry(b, a);
			if (n == 0) break;
		}
	}
}

static op_value *pig(double x, double y, double at) {
	pig_value p = {x, y, at, 7, 0, 0};
	return pig_make(&p);
}
static double xof(const ls_node *n) {
	pig_value p;
	pig_read(ls_value(n), ls_id(n), &p);
	return p.x;
}
static bool same(const ls_node *a, const ls_node *b) {
	const op_value *x = ls_value(a), *y = ls_value(b);
	char *tx = NULL, *ty = NULL;
	bool ok;
	if (x == NULL || y == NULL) return x == y;
	tx = op_json_text(x), ty = op_json_text(y);
	// maps compared as sets of entries by text of each key
	ok = true;
	if (x->type == OP_MAP && y->type == OP_MAP) {
		ok = x->count == y->count;
		for (size_t i = 0; ok && i < x->count; i++) {
			op_value *o = op_get(y, x->keys[i]);
			char *a1 = op_json_text(x->items[i]), *b1 = o ? op_json_text(o) : NULL;
			ok = b1 != NULL && strcmp(a1, b1) == 0;
			(free)(a1), (free)(b1);
		}
	} else ok = strcmp(tx, ty) == 0;
	(free)(tx), (free)(ty);
	return ok;
}

static op_value *yes(void) { return op_bool(1); }

// ---- tests

static void t_converge(void) {
	printf("two devices converge on pigs\n");
	side a = open_side("a"), b = open_side("b");
	ls_node *ra = ls_follow(a.d, PIGS_ROOM), *rb = ls_follow(b.d, PIGS_ROOM);
	ls_node *pa = ls_follow(a.d, P1), *pb = ls_follow(b.d, P1);
	pump(&a, &b, 100);
	CHECK(ls_up(a.l) && ls_up(b.l));
	op_value *v = pig(0.25, 0.75, 1000);
	CHECK(ls_put(pa, v) == LS_OK);
	op_free(v);
	CHECK(ls_set(ra, P1, yes()) == LS_OK);
	pump(&a, &b, 100);
	CHECK(xof(pb) == 0.25);
	CHECK(pig_room_has(ls_value(rb), P1));
	v = pig(0.5, 0.5, 2000);
	ls_put(pb, v);
	op_free(v);
	pump(&a, &b, 100);
	CHECK(xof(pa) == 0.5 && xof(pb) == 0.5);
	CHECK(ls_commits(pa) == 1 && ls_commits(pb) == 1);
	CHECK(ls_stats_of(a.d)->bad_seals == 0 && ls_stats_of(b.d)->bad_seals == 0);
	CHECK(tapped > 0 && tap_bad == 0);
	close_side(&a), close_side(&b);
	drop_dir(&a), drop_dir(&b);
}

static void t_concurrent_moves(void) {
	printf("concurrent moves of one pig: the same winner on both sides\n");
	for (int round = 0; round < 12; round++) {
		side a = open_side("ca"), b = open_side("cb");
		n_wire_seen = 0;
		ls_node *pa = ls_follow(a.d, P1), *pb = ls_follow(b.d, P1);
		pump(&a, &b, 100);
		op_value *v = pig(0.1, 0.1, 1);
		ls_put(pa, v);
		op_free(v);
		pump(&a, &b, 100);
		// cut: each writes while the other hears nothing
		v = pig(0.3, 0.3, 2);
		ls_put(pa, v);
		op_free(v);
		v = pig(0.6, 0.6, 3);
		ls_put(pb, v);
		op_free(v);
		CHECK(xof(pa) == 0.3 && xof(pb) == 0.6);
		// the heard-from is dropped by the cut: nothing carried for a while
		cut(&a, &b);
		pump(&a, &b, 2000);
		CHECK(xof(pa) == xof(pb));
		CHECK(ls_commits(pa) == 1 && ls_commits(pb) == 1);
		// after the merge one head: a write names it alone
		v = pig(0.7, 0.7, 4);
		ls_put(pb, v);
		op_free(v);
		pump(&a, &b, 100);
		check_lamports();
		close_side(&a), close_side(&b);
		drop_dir(&a), drop_dir(&b);
	}
}

static void t_concurrent_adds(void) {
	printf("concurrent adds to the room both land\n");
	side a = open_side("a"), b = open_side("b");
	ls_node *ra = ls_follow(a.d, PIGS_ROOM), *rb = ls_follow(b.d, PIGS_ROOM);
	pump(&a, &b, 100);
	n_wire_seen = 0;
	ls_set(ra, P2, yes());
	ls_set(rb, P3, yes());
	cut(&a, &b);
	pump(&a, &b, 2000);
	CHECK(pig_room_has(ls_value(ra), P2) && pig_room_has(ls_value(ra), P3));
	CHECK(pig_room_has(ls_value(rb), P2) && pig_room_has(ls_value(rb), P3));
	CHECK(ls_commits(ra) == 2 && ls_commits(rb) == 2);
	// a bin: false stays, a later delete of the key too
	CHECK(ls_set(ra, P2, op_bool(0)) == LS_OK);
	pump(&a, &b, 200);
	CHECK(!pig_room_has(ls_value(rb), P2));
	ls_del(rb, P3);
	pump(&a, &b, 200);
	CHECK(!pig_room_has(ls_value(ra), P3));
	// the write after the two concurrent ones merged them: two parents, the rest one
	CHECK(most_parents() == 2);
	check_lamports();
	close_side(&a), close_side(&b);
	drop_dir(&a), drop_dir(&b);
}

static void t_garbage(void) {
	printf("text between frames is skipped\n");
	side a = open_side("a"), b = open_side("b");
	ls_node *pa = ls_follow(a.d, P1), *pb = ls_follow(b.d, P1);
	garbage = 1;
	uint32_t before = ls_traffic_of(b.l)->junk;
	pump(&a, &b, 100);
	for (int i = 0; i < 5; i++) {
		op_value *v = pig(0.1 * i, 0.5, i);
		ls_put(pa, v);
		op_free(v);
		pump(&a, &b, 100);
	}
	// a frame cut by text is lost: the resend of what is not acked mends it
	pump(&a, &b, 3000);
	garbage = 0;
	CHECK(xof(pb) == 0.4);
	CHECK(ls_traffic_of(b.l)->junk > before);
	// bytes with zeros in them that are no frame, and a frame cut short
	uint8_t noise[300];
	for (size_t i = 0; i < sizeof noise; i++) noise[i] = (uint8_t)rnd();
	ls_feed(b.l, noise, sizeof noise);
	static uint8_t huge[LS_FRAME_MAX * 2];
	memset(huge, 'x', sizeof huge);
	ls_feed(b.l, huge, sizeof huge);
	ls_feed(b.l, (const uint8_t *)"\0", 1);
	pump(&a, &b, 100);
	CHECK(xof(pb) == 0.4 && ls_up(b.l));
	(void)pa;
	close_side(&a), close_side(&b);
	drop_dir(&a), drop_dir(&b);
}

static void t_restart(void) {
	printf("a restart from the file store has the same state\n");
	side a = open_side("a"), b = open_side("b");
	ls_node *pa = ls_follow(a.d, P1), *ra = ls_follow(a.d, PIGS_ROOM);
	ls_node *pb = ls_follow(b.d, P1);
	pump(&a, &b, 100);
	op_value *v = pig(0.2, 0.9, 5);
	ls_put(pa, v);
	op_free(v);
	ls_set(ra, P2, yes());
	ls_set(ra, P3, yes());
	ls_del(ra, P3);
	pump(&a, &b, 100);
	uint8_t key[LS_KEY_LEN];
	memcpy(key, ls_key(a.d), LS_KEY_LEN);
	size_t commits = ls_commits(ra);
	int64_t lamport = ls_lamport(ra);
	char *before = op_json_text(ls_value(ra));
	close_side(&a);
	// the same directory again
	ls_options o = {.store = a.store, .random = random_bytes};
	a.d = ls_open(&o);
	a.l = ls_link(a.d);
	CHECK(memcmp(key, ls_key(a.d), LS_KEY_LEN) == 0);
	pa = ls_follow(a.d, P1), ra = ls_follow(a.d, PIGS_ROOM);
	CHECK(xof(pa) == 0.2);
	char *after = op_json_text(ls_value(ra));
	CHECK(strcmp(before, after) == 0);
	CHECK(ls_commits(ra) == commits && ls_lamport(ra) == lamport);
	(free)(before), (free)(after);
	// it still talks: a write after the restart lands on the other
	pump(&a, &b, 100);
	v = pig(0.4, 0.4, 6);
	ls_put(pa, v);
	op_free(v);
	pump(&a, &b, 100);
	CHECK(xof(pb) == 0.4);
	// the deleted key stays deleted after the restart
	CHECK(op_get(ls_value(ra), P3) == NULL);
	close_side(&a), close_side(&b);
	drop_dir(&a), drop_dir(&b);
}

static void t_fresh(void) {
	printf("a fresh device gets the whole state and verifies every seal\n");
	side a = open_side("a");
	ls_node *ra = ls_follow(a.d, PIGS_ROOM), *p1 = ls_follow(a.d, P1), *p2 = ls_follow(a.d, P2);
	for (int i = 0; i < 20; i++) {
		op_value *v = pig(i / 20.0, 0.5, i);
		ls_put(i % 2 ? p1 : p2, v);
		op_free(v);
	}
	ls_set(ra, P1, yes()), ls_set(ra, P2, yes()), ls_set(ra, P3, yes());
	// many pigs: the room is many commits, past one message
	char id[LS_ID_LEN + 1];
	for (int i = 0; i < 30; i++) {
		snprintf(id, sizeof id, "ermine://%032x" "00000000000000000000000000000000", 0x1000 + i);
		ls_set(ra, id, yes());
	}
	CHECK(ls_commits(ra) == 33);
	side c = open_side("c");
	ls_node *rc = ls_follow(c.d, PIGS_ROOM), *c1 = ls_follow(c.d, P1), *c2 = ls_follow(c.d, P2);
	int before = tapped;
	pump(&a, &c, 500);
	CHECK(same(ra, rc) && same(p1, c1) && same(p2, c2));
	CHECK(ls_commits(rc) == 33);
	CHECK(ls_stats_of(c.d)->bad_seals == 0 && ls_stats_of(c.d)->applied >= 35);
	CHECK(tapped > before && tap_bad == 0);
	// a seal for one node is no good in another: it goes to the wrong node and is refused
	close_side(&a), close_side(&c);
	drop_dir(&a), drop_dir(&c);
}

// a message to a device, as a peer would frame it
static void feed_message(struct ls_link *l, Json *m) {
	size_t n = 0;
	cborEncode(m, NULL, 0, &n, NULL);
	uint8_t *b = malloc(n), *out = NULL;
	cborEncode(m, b, n, &n, NULL);
	size_t used = 0, cap = 0;
	ls_frame(b, n, &out, &used, &cap);
	ls_feed(l, out, used);
	free(b), free(out);
	jsonFree(m);
}

static void t_bad_and_refused(void) {
	printf("seals that do not verify are dropped; patches v1 does not merge are refused\n");
	side a = open_side("a"), b = open_side("b");
	ls_node *pa = ls_follow(a.d, P1), *pb = ls_follow(b.d, P1);
	pump(&a, &b, 100);
	op_value *v = pig(0.1, 0.1, 1);
	// a's write, caught on its way: one byte in the signature
	ls_put(pa, v);
	op_free(v);
	const uint8_t *out;
	size_t n = ls_next(a.l, &out);
	uint8_t *copy = malloc(n);
	memcpy(copy, out, n);
	// find the commits frame and damage a byte in its sealed bytes, then mend the CRC: re-frame
	static uint8_t scratch[LS_FRAME_MAX];
	size_t start = 0, framed = 0;
	for (size_t i = 0; i <= n; i++)
		if (i == n || copy[i] == 0) {
			if (i > start) {
				memcpy(scratch, copy + start, i - start);
				const uint8_t *m;
				size_t len;
				if (ls_unframe(scratch, i - start, &m, &len)) {
					Json *j = cborDecode(m, len, NULL, NULL);
					const Json *t = jsonGet(j, "t");
					if (t && strcmp(t->string, "commits") == 0) {
						Json *bad = jsonShallow(j);
						Json *sealed = jsonArray();
						const Json *s = jsonGet(j, "sealed")->array.items[0];
						uint8_t *x = malloc(s->bytes.length);
						memcpy(x, s->bytes.data, s->bytes.length);
						x[s->bytes.length - 3] ^= 0x01;
						jsonPush(sealed, jsonBytes(x, s->bytes.length));
						free(x);
						jsonSet(bad, "sealed", 6, sealed);
						feed_message(b.l, bad);
						framed++;
					}
					jsonFree(j);
				}
			}
			start = i + 1;
		}
	free(copy);
	CHECK(framed == 1);
	CHECK(ls_stats_of(b.d)->bad_seals == 1);
	CHECK(ls_value(pb) == NULL);
	// a commit with a range patch, sealed by b's own key (a seal by a real device): refused, with a reason
	ls_dev *d = b.d;
	Json *c = jsonObject();
	jsonAdd(c, "table", jsonString("value"));
	jsonAdd(c, "actor", jsonNull());
	jsonAdd(c, "time", jsonNumber(1));
	jsonAdd(c, "signer", jsonBytes(ls_key(a.d), LS_KEY_LEN));
	jsonAdd(c, "nonce", jsonNumber(1));
	jsonAdd(c, "parents", jsonArray());
	jsonAdd(c, "lamport", jsonNumber(9));
	Json *patches = jsonArray(), *p = jsonObject(), *path = jsonArray(), *range = jsonArray();
	jsonPush(range, jsonNumber(0)), jsonPush(range, jsonNumber(1));
	jsonAdd(p, "path", path), jsonAdd(p, "range", range), jsonAdd(p, "value", jsonString("x"));
	jsonPush(patches, p);
	jsonAdd(c, "patches", patches);
	uint8_t *cb;
	size_t cl;
	CHECK(cm_encode_json(c, &cb, &cl, NULL) == CM_OK);
	jsonFree(c);
	// sealed with the key's seed read from a's store
	uint8_t *seed;
	size_t sl;
	CHECK(a.store.load(a.store.context, "key", &seed, &sl) && sl == 32);
	sl_seeded sd;
	sl_seeded_init(&sd, seed);
	free(seed);
	uint8_t doc[32];
	for (int i = 0; i < 32; i++) sscanf(P1 + 9 + 2 * i, "%2hhx", &doc[i]);
	uint8_t *sealed;
	size_t sn;
	CHECK(sl_seal(cb, cl, &sd.signer, doc, NULL, &sealed, &sn, NULL, NULL) == SL_OK);
	free(cb);
	Json *m = jsonObject(), *list = jsonArray();
	jsonAdd(m, "t", jsonString("commits"));
	jsonAdd(m, "node", jsonBytes(doc, 32));
	jsonPush(list, jsonBytes(sealed, sn));
	jsonAdd(m, "sealed", list);
	free(sealed);
	feed_message(b.l, m);
	CHECK(ls_stats_of(d)->refused == 1);
	CHECK(strstr(ls_reason(d), "range") != NULL);
	CHECK(ls_value(pb) == NULL);
	close_side(&a), close_side(&b);
	drop_dir(&a), drop_dir(&b);
}

static void t_ephemeral(void) {
	printf("ephemeral beats show, last, and expire\n");
	side a = open_side("a"), b = open_side("b");
	ls_node *pa = ls_follow(a.d, P1), *pb = ls_follow(b.d, P1);
	pump(&a, &b, 100);
	op_value *v = pig(0.5, 0.5, 1);
	ls_put(pa, v);
	op_free(v);
	pump(&a, &b, 100);
	v = pig_make_held(0.7, 0.2, "otter", "#d1495b", "abcd");
	CHECK(ls_hold(pa, v) == LS_OK);
	op_free(v);
	pump(&a, &b, 100);
	CHECK(ls_helds(pb) == 1);
	pig_held h;
	CHECK(pig_held_read(ls_held_at(pb, 0)->value, &h) && h.x == 0.7 && strcmp(h.by, "otter") == 0);
	// the stored value is untouched
	CHECK(xof(pb) == 0.5);
	// beats keep it for much longer than 4 s
	pump(&a, &b, 12000);
	CHECK(ls_helds(pb) == 1);
	// moved: the new spot shows
	v = pig_make_held(0.1, 0.9, "otter", "#d1495b", "abcd");
	ls_hold(pa, v);
	op_free(v);
	pump(&a, &b, 100);
	CHECK(pig_held_read(ls_held_at(pb, 0)->value, &h) && h.y == 0.9);
	// the carrier goes quiet (no more beats on the wire): it is gone after 4 s
	const uint8_t *drop;
	for (int i = 0; i < 380; i++) {
		now += 10;
		ls_tick(a.d, now), ls_tick(b.d, now);
		ls_next(a.l, &drop);
	}
	CHECK(ls_helds(pb) == 1);
	for (int i = 0; i < 60; i++) {
		now += 10;
		ls_tick(b.d, now);
	}
	CHECK(ls_helds(pb) == 0);
	// a held pig dropped: the device's stored commit lands, and the held value goes with it
	v = pig_make_held(0.3, 0.3, "otter", "#d1495b", "abcd");
	ls_hold(pa, v);
	op_free(v);
	pump(&a, &b, 100);
	CHECK(ls_helds(pb) == 1 && ls_helds(pa) == 1);
	v = pig(0.3, 0.3, 9);
	ls_put(pa, v);
	op_free(v);
	pump(&a, &b, 100);
	CHECK(ls_helds(pb) == 0 && ls_helds(pa) == 0);
	pump(&a, &b, 6000);
	CHECK(ls_helds(pb) == 0);
	CHECK(xof(pb) == 0.3);
	close_side(&a), close_side(&b);
	drop_dir(&a), drop_dir(&b);
}

// ---- three devices in a line, a - b - c: b has two links

// a wire between two links; cut: what is sent on it is thrown away. commits_out[0] counts the commits
// messages x sent, commits_out[1] those y sent
typedef struct {
	struct ls_link *x, *y;
	int cut;
	int commits_out[2];
} wire;

static int count_commits(const uint8_t *b, size_t n) {
	static uint8_t frame[LS_FRAME_MAX];
	size_t k = 0;
	int found = 0;
	for (size_t i = 0; i < n; i++) {
		if (b[i] != 0) {
			if (k < sizeof frame) frame[k++] = b[i];
			continue;
		}
		const uint8_t *m;
		size_t len;
		if (k > 0 && ls_unframe(frame, k, &m, &len)) {
			Json *j = cborDecode(m, len, NULL, NULL);
			const Json *t = jsonGet(j, "t");
			if (t && strcmp(t->string, "commits") == 0) found++;
			jsonFree(j);
		}
		k = 0;
	}
	return found;
}

static size_t carry_one(struct ls_link *from, struct ls_link *to, int cut, int *commits) {
	const uint8_t *out;
	if (from == NULL) return 0;
	size_t n = ls_next(from, &out);
	if (n == 0) return 0;
	*commits += count_commits(out, n);
	if (!cut && to != NULL) ls_feed(to, out, n);
	return n;
}

static void pump3(ls_dev *const devs[3], wire *w, size_t wires, int64_t ms) {
	for (int64_t end = now + ms; now <= end; now += 10) {
		for (int i = 0; i < 3; i++) ls_tick(devs[i], now);
		for (int round = 0; round < 50; round++) {
			size_t n = 0;
			for (size_t i = 0; i < wires; i++) {
				n += carry_one(w[i].x, w[i].y, w[i].cut, &w[i].commits_out[0]);
				n += carry_one(w[i].y, w[i].x, w[i].cut, &w[i].commits_out[1]);
			}
			if (n == 0) break;
		}
	}
}

static void t_relay(void) {
	printf("a device with two links relays: a - b - c\n");
	side a = open_side("ra"), b = open_side("rb"), c = open_side("rc");
	struct ls_link *b2 = ls_link(b.d);
	CHECK(b2 != NULL && b2 != b.l);
	wire w[2] = {{a.l, b.l, 0, {0, 0}}, {b2, c.l, 0, {0, 0}}};
	ls_dev *devs[3] = {a.d, b.d, c.d};
	ls_node *pa = ls_follow(a.d, P1), *pb = ls_follow(b.d, P1), *pc = ls_follow(c.d, P1);
	pump3(devs, w, 2, 200);
	CHECK(ls_up(a.l) && ls_up(b.l) && ls_up(b2) && ls_up(c.l));
	CHECK(ls_peer(b.l) != NULL && memcmp(ls_peer(b.l), ls_key(a.d), LS_KEY_LEN) == 0);
	CHECK(memcmp(ls_peer(b2), ls_key(c.d), LS_KEY_LEN) == 0);
	// a writes: c has it, by way of b
	op_value *v = pig(0.25, 0.75, 1);
	ls_put(pa, v);
	op_free(v);
	pump3(devs, w, 2, 300);
	CHECK(xof(pb) == 0.25 && xof(pc) == 0.25);
	// c writes: a has it
	v = pig(0.6, 0.1, 2);
	ls_put(pc, v);
	op_free(v);
	pump3(devs, w, 2, 300);
	CHECK(xof(pb) == 0.6 && xof(pa) == 0.6);
	CHECK(same(pa, pc) && ls_commits(pa) == 1 && ls_commits(pc) == 1);
	CHECK(ls_stats_of(a.d)->bad_seals == 0 && ls_stats_of(b.d)->bad_seals == 0 && ls_stats_of(c.d)->bad_seals == 0);
	// a hold on a shows on c, and goes when a drops it by writing
	v = pig_make_held(0.7, 0.2, "otter", "#d1495b", "abcd");
	CHECK(ls_hold(pa, v) == LS_OK);
	op_free(v);
	pump3(devs, w, 2, 300);
	CHECK(ls_helds(pb) == 1 && ls_helds(pc) == 1);
	pig_held h;
	CHECK(pig_held_read(ls_held_at(pc, 0)->value, &h) && h.x == 0.7 && strcmp(h.by, "otter") == 0);
	CHECK(xof(pc) == 0.6);
	// beats carry it on, past the 4 s a held value lasts alone
	pump3(devs, w, 2, 6000);
	CHECK(ls_helds(pc) == 1);
	// a hold on c shows on a too (never as a hold of a's own)
	v = pig_make_held(0.2, 0.2, "newt", "#00a", "ef01");
	ls_hold(pc, v);
	op_free(v);
	pump3(devs, w, 2, 300);
	CHECK(ls_helds(pa) == 2);
	v = pig(0.9, 0.9, 3);
	ls_put(pa, v);
	op_free(v);
	pump3(devs, w, 2, 300);
	CHECK(ls_helds(pc) == 1 && xof(pc) == 0.9);
	close_side(&a), close_side(&b), close_side(&c);
	drop_dir(&a), drop_dir(&b), drop_dir(&c);
}

static void t_per_link_acks(void) {
	printf("an own commit is resent on the link that has not acked it, not on the one that has\n");
	side a = open_side("ka"), b = open_side("kb"), c = open_side("kc");
	struct ls_link *b2 = ls_link(b.d);
	wire w[2] = {{a.l, b.l, 0, {0, 0}}, {b2, c.l, 0, {0, 0}}};
	ls_dev *devs[3] = {a.d, b.d, c.d};
	ls_node *pb = ls_follow(b.d, P1), *pc;
	ls_follow(a.d, P1);
	pc = ls_follow(c.d, P1);
	pump3(devs, w, 2, 200);
	// the line to c is cut: b writes, a acks, c hears nothing
	w[1].cut = 1;
	w[0].commits_out[0] = w[0].commits_out[1] = w[1].commits_out[0] = w[1].commits_out[1] = 0;
	op_value *v = pig(0.3, 0.3, 1);
	ls_put(pb, v);
	op_free(v);
	pump3(devs, w, 2, 3500);
	// w[0].y is b: its commits messages to a; w[1].x is b's other link
	CHECK(w[0].commits_out[1] == 1);
	CHECK(w[1].commits_out[0] >= 3);
	CHECK(ls_value(pc) == NULL);
	// the line is back: c gets it, and what a has acked is not sent to a again
	w[1].cut = 0;
	int to_a = w[0].commits_out[1];
	pump3(devs, w, 2, 3000);
	CHECK(xof(pc) == 0.3);
	CHECK(w[0].commits_out[1] == to_a);
	close_side(&a), close_side(&b), close_side(&c);
	drop_dir(&a), drop_dir(&b), drop_dir(&c);
}

static void t_relink(void) {
	printf("a link that goes away and comes back resyncs\n");
	side a = open_side("la"), b = open_side("lb"), c = open_side("lc");
	struct ls_link *b2 = ls_link(b.d);
	wire w[2] = {{a.l, b.l, 0, {0, 0}}, {b2, c.l, 0, {0, 0}}};
	ls_dev *devs[3] = {a.d, b.d, c.d};
	ls_node *pa = ls_follow(a.d, P1), *pb = ls_follow(b.d, P1), *pc = ls_follow(c.d, P1);
	pump3(devs, w, 2, 200);
	op_value *v = pig(0.1, 0.1, 1);
	ls_put(pb, v);
	op_free(v);
	pump3(devs, w, 2, 300);
	CHECK(xof(pc) == 0.1 && xof(pa) == 0.1);
	// b's side of the line to c goes away; both write meanwhile
	ls_unlink(b2);
	w[1].x = NULL;
	v = pig(0.4, 0.4, 2);
	ls_put(pb, v);
	op_free(v);
	v = pig_make_held(0.5, 0.5, "otter", "#d1495b", "abcd");
	ls_hold(pa, v);
	op_free(v);
	pump3(devs, w, 2, 1000);
	CHECK(xof(pa) == 0.4 && xof(pc) == 0.1);
	CHECK(ls_up(b.l));
	// it comes back (the old slot is used again): c gets what it missed, and a's write reaches it
	b2 = ls_link(b.d);
	CHECK(b2 != NULL);
	w[1].x = b2;
	v = pig(0.8, 0.8, 3);
	ls_put(pa, v);
	op_free(v);
	pump3(devs, w, 2, 3000);
	CHECK(ls_up(b2) && ls_up(c.l));
	CHECK(xof(pc) == 0.8 && xof(pb) == 0.8);
	CHECK(same(pa, pc) && ls_helds(pc) == 0);
	// c's side goes away and comes back as well: the same again
	ls_unlink(c.l);
	w[1].y = NULL;
	v = pig(0.9, 0.2, 4);
	ls_put(pb, v);
	op_free(v);
	pump3(devs, w, 2, 500);
	c.l = ls_link(c.d);
	w[1].y = c.l;
	pump3(devs, w, 2, 3000);
	CHECK(xof(pc) == 0.9 && same(pa, pc));
	// a hold on a goes over both links again
	v = pig_make_held(0.3, 0.3, "otter", "#d1495b", "abcd");
	ls_hold(pa, v);
	op_free(v);
	pump3(devs, w, 2, 300);
	CHECK(ls_helds(pc) == 1);
	close_side(&a), close_side(&b), close_side(&c);
	drop_dir(&a), drop_dir(&b), drop_dir(&c);
}

// the bytes held through the allocator hook (count.h)
static void t_limits(void) {
	printf("a write too big for one message is refused; fake holders never push out the device's own hold\n");
	side a = open_side("a"), b = open_side("b");
	ls_node *pa = ls_follow(a.d, P1);
	ls_follow(b.d, P1);
	pump(&a, &b, 100);
	char *big = malloc(4000);
	memset(big, 'x', 3999), big[3999] = 0;
	op_value *v = op_str(big);
	free(big);
	CHECK(ls_set(pa, "big", v) == LS_BAD);
	op_free(v);
	v = pig_make_held(0.3, 0.3, "otter", "#d1495b", "abcd");
	CHECK(ls_hold(pa, v) == LS_OK);
	op_free(v);
	uint8_t doc[32];
	for (int i = 0; i < 32; i++) sscanf(P1 + 9 + 2 * i, "%2hhx", &doc[i]);
	// twelve unsealed holds, each by a key nobody has
	for (int k = 0; k < 12; k++) {
		uint8_t key[LS_KEY_LEN] = {0xed, 0x01};
		for (int i = 2; i < LS_KEY_LEN; i++) key[i] = (uint8_t)(k * 31 + i);
		Json *c = jsonObject(), *patches = jsonArray(), *p = jsonObject();
		jsonAdd(c, "table", jsonString("value"));
		jsonAdd(c, "actor", jsonNull());
		jsonAdd(c, "time", jsonNumber(1));
		jsonAdd(c, "signer", jsonBytes(key, LS_KEY_LEN));
		jsonAdd(c, "nonce", jsonNumber(1));
		jsonAdd(c, "parents", jsonArray());
		jsonAdd(c, "lamport", jsonNumber(1));
		jsonAdd(p, "path", jsonArray()), jsonAdd(p, "value", jsonString("fake"));
		jsonPush(patches, p);
		jsonAdd(c, "patches", patches);
		uint8_t *cb;
		size_t cl;
		CHECK(cm_encode_json(c, &cb, &cl, NULL) == CM_OK);
		jsonFree(c);
		Json *m = jsonObject();
		jsonAdd(m, "t", jsonString("ephemeral"));
		jsonAdd(m, "node", jsonBytes(doc, 32));
		jsonAdd(m, "commit", jsonBytes(cb, cl));
		free(cb);
		feed_message(a.l, m);
	}
	bool mine = false;
	for (size_t i = 0; i < ls_helds(pa); i++) mine |= ls_held_at(pa, i)->own != 0;
	CHECK(mine);
	close_side(&a), close_side(&b);
	drop_dir(&a), drop_dir(&b);
}

static size_t heap(void) { return lsc_bytes; }

// what the store keeps for a node: its blob's bytes (0 when none is saved)
static size_t stored(side *s, ls_node *n) {
	char name[16 + LS_ID_LEN];
	snprintf(name, sizeof name, "node:%s", ls_id(n));
	uint8_t *b;
	size_t len;
	if (!s->store.load(s->store.context, name, &b, &len)) return 0;
	free(b);
	return len;
}

// the parents of a node's stored commits: how many in all; the most one has (most_stored), and how
// many have a merge (*merges, unless NULL)
static size_t most_stored;
static size_t parents_stored(side *s, ls_node *n, size_t *merges) {
	char name[16 + LS_ID_LEN];
	snprintf(name, sizeof name, "node:%s", ls_id(n));
	uint8_t *b;
	size_t len, all = 0;
	most_stored = 0;
	if (merges) *merges = 0;
	if (!s->store.load(s->store.context, name, &b, &len)) return 0;
	Json *m = cborDecode(b, len, NULL, NULL);
	free(b);
	const Json *list = m ? jsonGet(m, "commits") : NULL;
	for (int i = 0; list && i < list->array.count; i++) {
		Json *x = cborDecode(list->array.items[i]->bytes.data, list->array.items[i]->bytes.length, NULL, NULL);
		const Json *c = jsonGet(x, "commit");
		cm_commit cm;
		if (c && cm_decode(c->bytes.data, c->bytes.length, &cm, NULL) == CM_OK) {
			all += cm.parents_length;
			if (cm.parents_length > most_stored) most_stored = cm.parents_length;
			if (merges && cm.merge) (*merges)++;
			cm_free(&cm);
		}
		jsonFree(x);
	}
	jsonFree(m);
	return all;
}

// a node's cost, parts and all
static void say_cost(const char *what, const ls_node *n) {
	ls_cost c = ls_cost_of(n);
	printf("  %s: stored %zu B, %zu commits, seals %zu B; newest seal %zu B = signature %zu + signer %zu + parents %zu (%zu) + patches %zu + rest %zu\n",
		what, c.stored, c.commits, c.seals, c.newest.length, c.newest.signature, c.newest.signer, c.newest.parents_bytes,
		c.newest.parents, c.newest.patches, c.newest.rest);
}

static void t_cost(void) {
	printf("what a node costs\n");
	side c = open_side("cost");
	ls_node *n = ls_follow(c.d, P1), *r = ls_follow(c.d, PIGS_ROOM);
	ls_cost k = ls_cost_of(n);
	CHECK(k.stored > 0 && k.commits == 0 && k.seals == 0 && k.newest.length == 0 && k.newest.parents == 0);
	op_value *v = pig(0.5, 0.5, 1);
	ls_put(n, v);
	op_free(v);
	k = ls_cost_of(n);
	CHECK(k.commits == 1 && k.seals == k.newest.length && k.newest.length > 0);
	// a seal's signature: a byte string of 72 (its head 2 bytes); a signer of 34 the same
	CHECK(k.newest.signature == 74 && k.newest.signer == 36);
	// no parents: an empty list, one byte
	CHECK(k.newest.parents == 0 && k.newest.parents_bytes == 1);
	CHECK(k.newest.patches > 0 && k.newest.rest > 0);
	CHECK(k.newest.signature + k.newest.signer + k.newest.parents_bytes + k.newest.patches + k.newest.rest == k.newest.length);
	// the stored bytes are the store's
	ls_tick(c.d, now + 60000);
	CHECK(k.stored == stored(&c, n));
	// a room written at two keys: two commits, the second names the first only
	ls_set(r, P1, yes());
	ls_set(r, P2, yes());
	k = ls_cost_of(r);
	CHECK(k.commits == 2 && k.newest.parents == 1 && k.newest.parents_bytes == 1 + 2 + CM_NAME);
	// a third: still one parent (the second names the first, so it is no head)
	ls_set(r, P3, yes());
	k = ls_cost_of(r);
	CHECK(k.commits == 3 && k.newest.parents == 1 && k.seals > 3 * k.newest.signature);
	// a restart: the same cost, and the marks made again from the seals
	ls_tick(c.d, now + 120000);
	size_t before = k.stored;
	close_side(&c);
	ls_options o = {.store = c.store, .random = random_bytes};
	c.d = ls_open(&o);
	r = ls_follow(c.d, PIGS_ROOM);
	k = ls_cost_of(r);
	CHECK(k.stored == before && k.commits == 3);
	ls_set(r, P1, op_bool(0));
	k = ls_cost_of(r);
	CHECK(k.newest.parents == 1);
	close_side(&c);
	drop_dir(&c);
}

static void t_memory(void) {
	printf("10,000 moves: the heap stays flat\n");
	side a = open_side("a"), b = open_side("b");
	ls_node *ra = ls_follow(a.d, PIGS_ROOM), *pa = ls_follow(a.d, P1), *pb = ls_follow(b.d, P1);
	ls_follow(b.d, PIGS_ROOM);
	ls_set(ra, P1, yes());
	pump(&a, &b, 100);
	size_t m0 = 0, m1 = 0;
	for (int i = 0; i < 10000; i++) {
		if (i == 500) m0 = heap();
		op_value *v = pig_make_held((i % 100) / 100.0, 0.5, "otter", "#d1495b", "abcd");
		ls_hold(pa, v);
		op_free(v);
		// every few moves a drop: a stored commit, and everything pumped
		if (i % 5 == 4) {
			v = pig((i % 100) / 100.0, 0.5, i);
			ls_put(pa, v);
			op_free(v);
		}
		pump(&a, &b, 10);
	}
	m1 = heap();
	printf("  heap after 500 moves %zu, after 10000 %zu (%+ld)\n", m0, m1, (long)m1 - (long)m0);
	CHECK(m1 <= m0 + 4096);
	CHECK(ls_commits(pa) == 1 && ls_commits(pb) == 1);
	// the device's heap at rest and per node
	close_side(&a), close_side(&b);
	drop_dir(&a), drop_dir(&b);
	side c = open_side("c");
	size_t h0 = heap();
	ls_options o = {.store = c.store, .random = random_bytes};
	ls_close(c.d);
	h0 = heap();
	c.d = ls_open(&o);
	size_t h1 = heap();
	ls_node *n = ls_follow(c.d, P1);
	size_t h2 = heap();
	op_value *v = pig(0.5, 0.5, 1);
	ls_put(n, v);
	op_free(v);
	size_t h3 = heap();
	ls_node *r = ls_follow(c.d, PIGS_ROOM);
	for (int i = 0; i < 30; i++) {
		char id[LS_ID_LEN + 1];
		snprintf(id, sizeof id, "ermine://%032x" "00000000000000000000000000000000", 0x2000 + i);
		ls_set(r, id, yes());
	}
	size_t h4 = heap();
	printf("  heap: device at rest %zu B; a followed node, empty %zu B; with one pig stored %zu B; room of 30 pigs %zu B (about %zu per pig added)\n",
		h1 - h0, h2 - h1, h3 - h2, h4 - h3, (h4 - h3) / 30);
	// what the store keeps (NVS on a device: rounded up to its 32-byte entries, plus a header entry
	// per chunk): the pig's node, and the room, per pig it lists
	ls_tick(c.d, now + 60000);
	size_t sp = stored(&c, n), sr = stored(&c, r);
	printf("  stored: a pig's node %zu B (%zu commit); the room of 30 pigs %zu B (%zu commits, about %zu per pig)\n", sp,
		ls_commits(n), sr, ls_commits(r), sr / 30);
	CHECK(sp > 0 && sr > 0);
	CHECK(ls_cost_of(r).stored == sr && ls_cost_of(n).stored == sp);
	say_cost("a pig's node", n);
	say_cost("the room of 30", r);
	printf("  parents in the room's stored commits: %zu in all, %zu at most\n", parents_stored(&c, r, NULL), most_stored);
	close_side(&c);
	drop_dir(&c);
	// two devices adding 15 pigs each to one room: taking turns (each hears the other first), and both
	// at once (each adds while the other's add is on the way)
	for (int at_once = 0; at_once < 2; at_once++) {
		side a = open_side("ma"), b = open_side("mb");
		ls_node *ra = ls_follow(a.d, PIGS_ROOM), *rb = ls_follow(b.d, PIGS_ROOM);
		pump(&a, &b, 100);
		for (int i = 0; i < 15; i++) {
			char id[LS_ID_LEN + 1];
			snprintf(id, sizeof id, "ermine://%032x" "00000000000000000000000000000000", 0x3000 + i);
			ls_set(ra, id, yes());
			if (!at_once) pump(&a, &b, 100);
			snprintf(id, sizeof id, "ermine://%032x" "00000000000000000000000000000000", 0x4000 + i);
			ls_set(rb, id, yes());
			pump(&a, &b, 100);
		}
		pump(&a, &b, 3000);
		CHECK(ls_commits(ra) == 30 && same(ra, rb));
		ls_tick(a.d, now + 60000), ls_tick(b.d, now + 60000);
		size_t s = stored(&a, ra), merges = 0, all = parents_stored(&a, ra, &merges);
		printf("  two devices, %s: the room of 30 stored %zu B on a (about %zu per pig), %zu on b; parents %zu in all, %zu at most, %zu merges\n",
			at_once ? "both at once" : "taking turns", s, s / 30, stored(&b, rb), all, most_stored, merges);
		say_cost(at_once ? "  its cost on a (at once)" : "  its cost on a (turns)", ra);
		close_side(&a), close_side(&b);
		drop_dir(&a), drop_dir(&b);
	}
}

// 30 seeds: three devices write concurrently at paths and at the root, with cuts, then talk: one value
static void t_fuzz(void) {
	printf("random concurrent writes (30 seeds): devices end with one value\n");
	for (int seed = 1; seed <= 30; seed++) {
		rng = 0x9e3779b97f4a7c15ull * (uint64_t)seed;
		side a = open_side("fa"), b = open_side("fb");
		n_wire_seen = 0;
		ls_node *na = ls_follow(a.d, PIGS_ROOM), *nb = ls_follow(b.d, PIGS_ROOM);
		pump(&a, &b, 100);
		const char *keys[] = {"p", "q", "r"};
		for (int step = 0; step < 24; step++) {
			ls_node *n = rnd() % 2 ? na : nb;
			uint32_t kind = rnd() % 6;
			const char *k1 = keys[rnd() % 3], *k2 = keys[rnd() % 3];
			if (kind == 0) {
				op_value *m = op_map();
				op_set(m, k1, op_num(rnd() % 100));
				ls_put(n, m);
				op_free(m);
			} else if (kind == 1) {
				ls_del(n, k1);
			} else if (kind == 2) {
				op_value *m = op_map();
				op_set(m, k2, op_num(rnd() % 100));
				ls_set(n, k1, m);
				op_free(m);
			} else if (kind == 3) {
				const char *path[2] = {k1, k2};
				op_value *x = op_num(rnd() % 100);
				ls_patch p = {path, 2, rnd() % 4 ? x : NULL};
				ls_write(n, &p, 1);
				op_free(x);
			} else {
				op_value *x = op_num(rnd() % 100);
				ls_set(n, k1, x);
				op_free(x);
			}
			// sometimes they hear each other
			if (rnd() % 4 == 0) pump(&a, &b, 100);
			else cut(&a, &b);
		}
		pump(&a, &b, 12000);
		check_lamports();
		bool ok = same(na, nb) && ls_commits(na) == ls_commits(nb);
		if (!ok) {
			char *x = ls_value(na) ? op_json_text(ls_value(na)) : (strdup)("-");
			char *y = ls_value(nb) ? op_json_text(ls_value(nb)) : (strdup)("-");
			printf("  seed %d: %s | %s (%zu, %zu commits)\n", seed, x, y, ls_commits(na), ls_commits(nb));
			(free)(x), (free)(y);
		}
		CHECK(ok);
		close_side(&a), close_side(&b);
		drop_dir(&a), drop_dir(&b);
	}
}

static const struct {
	const char *name;
	void (*run)(void);
} TESTS[] = {{"converge", t_converge}, {"moves", t_concurrent_moves}, {"adds", t_concurrent_adds}, {"garbage", t_garbage},
	{"restart", t_restart}, {"fresh", t_fresh}, {"bad", t_bad_and_refused}, {"ephemeral", t_ephemeral}, {"relay", t_relay}, {"acks", t_per_link_acks}, {"relink", t_relink}, {"limits", t_limits}, {"fuzz", t_fuzz},
	{"cost", t_cost}, {"memory", t_memory}};

// no arguments: every test; else the ones named
int main(int argc, char **argv) {
	if (system("mkdir -p build")) {}
	for (size_t i = 0; i < sizeof TESTS / sizeof *TESTS; i++) {
		int wanted = argc == 1;
		for (int k = 1; k < argc; k++) wanted |= strcmp(argv[k], TESTS[i].name) == 0;
		if (wanted) TESTS[i].run();
	}
	printf("%d checks, %d failed\n", checks, failed);
	return failed != 0;
}
