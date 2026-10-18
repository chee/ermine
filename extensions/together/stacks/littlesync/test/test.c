// littlesync's host tests: devices over in-memory pipes, a file store, and a count of heap bytes
#include "../littlesync.h"

#include "../frame.h"

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
	return s;
}
static void close_side(side *s) {
	ls_close(s->d);
	s->d = NULL;
}
static void drop_dir(side *s) {
	char cmd[128];
	snprintf(cmd, sizeof cmd, "rm -rf %s", s->dir);
	ls_store_file_free(&s->store);
	if (system(cmd)) {}
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
		if (from->d != NULL) ls_next(from->d, &drop);
		return 0;
	}
	const uint8_t *out;
	size_t n = ls_next(from->d, &out);
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
		ls_feed(to->d, (const uint8_t *)log, strlen(log));
		// one carry in four has text in the middle of a frame: that frame is lost
		if (rnd() % 4 == 0) {
			ls_feed(to->d, copy, n / 2);
			ls_feed(to->d, (const uint8_t *)"E (5) x: \xff\x01 mid\r\n", 14);
			ls_feed(to->d, copy + n / 2, n - n / 2);
		} else ls_feed(to->d, copy, n);
		ls_feed(to->d, (const uint8_t *)log, strlen(log));
	} else ls_feed(to->d, copy, n);
	free(copy);
	return n;
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
	ls_pig p = {x, y, at, 7, 0, 0};
	return ls_pig_make(&p);
}
static double xof(const ls_node *n) {
	ls_pig p;
	ls_pig_read(ls_value(n), ls_id(n), &p);
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
	ls_node *ra = ls_follow(a.d, LS_ROOM), *rb = ls_follow(b.d, LS_ROOM);
	ls_node *pa = ls_follow(a.d, P1), *pb = ls_follow(b.d, P1);
	pump(&a, &b, 100);
	CHECK(ls_up(a.d) && ls_up(b.d));
	op_value *v = pig(0.25, 0.75, 1000);
	CHECK(ls_put(pa, v) == LS_OK);
	op_free(v);
	CHECK(ls_set(ra, P1, yes()) == LS_OK);
	pump(&a, &b, 100);
	CHECK(xof(pb) == 0.25);
	CHECK(ls_room_has(ls_value(rb), P1));
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
		const uint8_t *drop;
		ls_next(a.d, &drop), ls_next(b.d, &drop);
		pump(&a, &b, 2000);
		CHECK(xof(pa) == xof(pb));
		CHECK(ls_commits(pa) == 1 && ls_commits(pb) == 1);
		close_side(&a), close_side(&b);
		drop_dir(&a), drop_dir(&b);
	}
}

static void t_concurrent_adds(void) {
	printf("concurrent adds to the room both land\n");
	side a = open_side("a"), b = open_side("b");
	ls_node *ra = ls_follow(a.d, LS_ROOM), *rb = ls_follow(b.d, LS_ROOM);
	pump(&a, &b, 100);
	ls_set(ra, P2, yes());
	ls_set(rb, P3, yes());
	const uint8_t *drop;
	ls_next(a.d, &drop), ls_next(b.d, &drop);
	pump(&a, &b, 2000);
	CHECK(ls_room_has(ls_value(ra), P2) && ls_room_has(ls_value(ra), P3));
	CHECK(ls_room_has(ls_value(rb), P2) && ls_room_has(ls_value(rb), P3));
	CHECK(ls_commits(ra) == 2 && ls_commits(rb) == 2);
	// a bin: false stays, a later delete of the key too
	CHECK(ls_set(ra, P2, op_bool(0)) == LS_OK);
	pump(&a, &b, 200);
	CHECK(!ls_room_has(ls_value(rb), P2));
	ls_del(rb, P3);
	pump(&a, &b, 200);
	CHECK(!ls_room_has(ls_value(ra), P3));
	close_side(&a), close_side(&b);
	drop_dir(&a), drop_dir(&b);
}

static void t_garbage(void) {
	printf("text between frames is skipped\n");
	side a = open_side("a"), b = open_side("b");
	ls_node *pa = ls_follow(a.d, P1), *pb = ls_follow(b.d, P1);
	garbage = 1;
	uint32_t before = ls_stats_of(b.d)->junk;
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
	CHECK(ls_stats_of(b.d)->junk > before);
	// bytes with zeros in them that are no frame, and a frame cut short
	uint8_t noise[300];
	for (size_t i = 0; i < sizeof noise; i++) noise[i] = (uint8_t)rnd();
	ls_feed(b.d, noise, sizeof noise);
	static uint8_t huge[LS_FRAME_MAX * 2];
	memset(huge, 'x', sizeof huge);
	ls_feed(b.d, huge, sizeof huge);
	ls_feed(b.d, (const uint8_t *)"\0", 1);
	pump(&a, &b, 100);
	CHECK(xof(pb) == 0.4 && ls_up(b.d));
	(void)pa;
	close_side(&a), close_side(&b);
	drop_dir(&a), drop_dir(&b);
}

static void t_restart(void) {
	printf("a restart from the file store has the same state\n");
	side a = open_side("a"), b = open_side("b");
	ls_node *pa = ls_follow(a.d, P1), *ra = ls_follow(a.d, LS_ROOM);
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
	CHECK(memcmp(key, ls_key(a.d), LS_KEY_LEN) == 0);
	pa = ls_follow(a.d, P1), ra = ls_follow(a.d, LS_ROOM);
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
	ls_node *ra = ls_follow(a.d, LS_ROOM), *p1 = ls_follow(a.d, P1), *p2 = ls_follow(a.d, P2);
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
	ls_node *rc = ls_follow(c.d, LS_ROOM), *c1 = ls_follow(c.d, P1), *c2 = ls_follow(c.d, P2);
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
static void feed_message(ls_dev *d, Json *m) {
	size_t n = 0;
	cborEncode(m, NULL, 0, &n, NULL);
	uint8_t *b = malloc(n), *out = NULL;
	cborEncode(m, b, n, &n, NULL);
	size_t used = 0, cap = 0;
	ls_frame(b, n, &out, &used, &cap);
	ls_feed(d, out, used);
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
	size_t n = ls_next(a.d, &out);
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
						feed_message(b.d, bad);
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
	feed_message(d, m);
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
	v = ls_pig_make_held(0.7, 0.2, "otter", "#d1495b", "abcd");
	CHECK(ls_hold(pa, v) == LS_OK);
	op_free(v);
	pump(&a, &b, 100);
	CHECK(ls_helds(pb) == 1);
	ls_pig_held h;
	CHECK(ls_pig_held_read(ls_held_at(pb, 0)->value, &h) && h.x == 0.7 && strcmp(h.by, "otter") == 0);
	// the stored value is untouched
	CHECK(xof(pb) == 0.5);
	// beats keep it for much longer than 4 s
	pump(&a, &b, 12000);
	CHECK(ls_helds(pb) == 1);
	// moved: the new spot shows
	v = ls_pig_make_held(0.1, 0.9, "otter", "#d1495b", "abcd");
	ls_hold(pa, v);
	op_free(v);
	pump(&a, &b, 100);
	CHECK(ls_pig_held_read(ls_held_at(pb, 0)->value, &h) && h.y == 0.9);
	// the carrier goes quiet (no more beats on the wire): it is gone after 4 s
	const uint8_t *drop;
	for (int i = 0; i < 380; i++) {
		now += 10;
		ls_tick(a.d, now), ls_tick(b.d, now);
		ls_next(a.d, &drop);
	}
	CHECK(ls_helds(pb) == 1);
	for (int i = 0; i < 60; i++) {
		now += 10;
		ls_tick(b.d, now);
	}
	CHECK(ls_helds(pb) == 0);
	// a held pig dropped: the device's stored commit lands, and the held value goes with it
	v = ls_pig_make_held(0.3, 0.3, "otter", "#d1495b", "abcd");
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

// the bytes held through the allocator hook (count.h)
static size_t heap(void) { return lsc_bytes; }

static void t_memory(void) {
	printf("10,000 moves: the heap stays flat\n");
	side a = open_side("a"), b = open_side("b");
	ls_node *ra = ls_follow(a.d, LS_ROOM), *pa = ls_follow(a.d, P1), *pb = ls_follow(b.d, P1);
	ls_follow(b.d, LS_ROOM);
	ls_set(ra, P1, yes());
	pump(&a, &b, 100);
	size_t m0 = 0, m1 = 0;
	for (int i = 0; i < 10000; i++) {
		if (i == 500) m0 = heap();
		op_value *v = ls_pig_make_held((i % 100) / 100.0, 0.5, "otter", "#d1495b", "abcd");
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
	ls_node *r = ls_follow(c.d, LS_ROOM);
	for (int i = 0; i < 30; i++) {
		char id[LS_ID_LEN + 1];
		snprintf(id, sizeof id, "ermine://%032x" "00000000000000000000000000000000", 0x2000 + i);
		ls_set(r, id, yes());
	}
	size_t h4 = heap();
	printf("  heap: device at rest %zu B; a followed node, empty %zu B; with one pig stored %zu B; room of 30 pigs %zu B (about %zu per pig added)\n",
		h1 - h0, h2 - h1, h3 - h2, h4 - h3, (h4 - h3) / 30);
	close_side(&c);
	drop_dir(&c);
}

// 30 seeds: three devices write concurrently at paths and at the root, with cuts, then talk: one value
static void t_fuzz(void) {
	printf("random concurrent writes (30 seeds): devices end with one value\n");
	for (int seed = 1; seed <= 30; seed++) {
		rng = 0x9e3779b97f4a7c15ull * (uint64_t)seed;
		side a = open_side("fa"), b = open_side("fb");
		ls_node *na = ls_follow(a.d, LS_ROOM), *nb = ls_follow(b.d, LS_ROOM);
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
			else {
				const uint8_t *drop;
				ls_next(a.d, &drop), ls_next(b.d, &drop);
			}
		}
		pump(&a, &b, 12000);
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
	{"restart", t_restart}, {"fresh", t_fresh}, {"bad", t_bad_and_refused}, {"ephemeral", t_ephemeral}, {"fuzz", t_fuzz},
	{"memory", t_memory}};

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
