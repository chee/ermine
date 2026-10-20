// littlesync's host tests: devices over in-memory pipes, a file store, and a count of heap bytes
#include "../littlesync.h"

#include "../frame.h"
#include "../../../../../playground/demos/pigs/littlesync/pigs.h"

#include "../../../../../ermine/encoding/c/cbor.h"
#include "../../../../../ermine/encoding/c/commit.h"
#include "../../../../../ermine/encoding/c/json.h"
#include "../../../../../ermine/encoding/c/pack.h"
#include "../../../../../core/op/c/json.h"
#include "../../../../../playground/together/c/ed25519/ed25519.h"
#include "../../../../../playground/together/c/seal.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

// LSWIRE=<file>: every ls_next's bytes and every blob saved, appended to it (two builds' runs compared byte for byte)
static FILE *wire_log;
// all the link has to send at once (ls_next hands out a frame a call), gathered here with the C
// library's own (uncounted) realloc
static size_t logged_next(struct ls_link *l, const uint8_t **out) {
	static uint8_t *all;
	static size_t room;
	const uint8_t *f;
	size_t n = 0, m;
	while ((m = ls_next(l, &f))) {
		if (n + m > room && (all = (realloc)(all, room = (n + m) * 2)) == NULL) abort();
		memcpy(all + n, f, m), n += m;
	}
	*out = all;
	if (wire_log != NULL && n) fwrite(*out, 1, n, wire_log);
	return n;
}
#define ls_next logged_next
static int (*file_save)(void *context, const char *name, const uint8_t *data, size_t length);
static int logged_save(void *context, const char *name, const uint8_t *data, size_t length) {
	if (wire_log != NULL) fputs(name, wire_log), fwrite(data, 1, length, wire_log);
	return file_save(context, name, data, length);
}

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
#define ROW_SIZE 2048
static int garbage; // text put between frames on the wire
static int tamper;  // flip a byte of each seal on the wire
static int tapped, tap_good, tap_bad;

static void logline(void *c, const char *l) { printf("    [%s %lld] %s\n", (char *)c, (long long)now, l); }

static side open_side(const char *tag) {
	side s = {0};
	snprintf(s.dir, sizeof s.dir, "build/state-%s-%d", tag, (int)getpid());
	s.store = ls_store_file(s.dir);
	file_save = s.store.save, s.store.save = logged_save;
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
static int merges_seen; // commits on the wire naming a merge rule
static int memcmp_names(const void *a, const void *b) { return memcmp(a, b, CM_NAME); }

// every commit seen on the wire since the last wire_bytes_clear: its bytes, once (for test/lists.ts)
#define BYTES_MAX 4096
static struct {
	uint8_t name[CM_NAME];
	uint8_t *bytes;
	size_t length;
} wire_bytes[BYTES_MAX];
static size_t n_wire_bytes;
static int capturing; // only while a test asks (wire_bytes_clear)
static void wire_bytes_clear(void) {
	for (size_t i = 0; i < n_wire_bytes; i++) free(wire_bytes[i].bytes);
	n_wire_bytes = 0;
	capturing = 1;
}
static void keep_bytes(const uint8_t *b, size_t n) {
	if (!capturing) return;
	uint8_t name[CM_NAME];
	cm_name(b, n, name);
	for (size_t i = 0; i < n_wire_bytes; i++)
		if (memcmp(wire_bytes[i].name, name, CM_NAME) == 0) return;
	if (n_wire_bytes == BYTES_MAX) return;
	memcpy(wire_bytes[n_wire_bytes].name, name, CM_NAME);
	wire_bytes[n_wire_bytes].bytes = malloc(n);
	memcpy(wire_bytes[n_wire_bytes].bytes, b, n);
	wire_bytes[n_wire_bytes++].length = n;
}

static void remember(const uint8_t *sealed, size_t length) {
	Json *x = cborDecode(sealed, length, NULL, NULL);
	const Json *c = x ? jsonGet(x, "commit") : NULL;
	cm_commit cm;
	if (c != NULL && c->type == JSON_BYTES && cm_decode(c->bytes.data, c->bytes.length, &cm, NULL) == CM_OK) {
		keep_bytes(c->bytes.data, c->bytes.length);
		if (cm.merge != NULL || cm.has_base) merges_seen++;
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

// ---- the lists, for test/lists.ts: the commits seen on the wire, and what each device holds at each
// path asked, one JSON line per case into build/lists.jsonl. exact: the TS lists must be the same; else
// a device may show more (a cover through commits it never held), never less

static FILE *lists_out;
static void hex_out(FILE *f, const uint8_t *b, size_t n) {
	fputc('"', f);
	for (size_t i = 0; i < n; i++) fprintf(f, "%02x", b[i]);
	fputc('"', f);
}
typedef struct {
	size_t n;
	const char *k[2];
} keys;
static void dump_lists(const char *label, int exact, ls_node *const *nodes, size_t count, const keys *paths, size_t n_paths) {
	if (lists_out == NULL) lists_out = fopen("build/lists.jsonl", "w");
	FILE *f = lists_out;
	fprintf(f, "{\"label\":\"%s\",\"exact\":%s,\"commits\":[", label, exact ? "true" : "false");
	for (size_t i = 0; i < n_wire_bytes; i++) {
		if (i) fputc(',', f);
		hex_out(f, wire_bytes[i].bytes, wire_bytes[i].length);
	}
	fprintf(f, "],\"devices\":[");
	for (size_t d = 0; d < count; d++) {
		fprintf(f, "%s[", d ? "," : "");
		for (size_t p = 0; p < n_paths; p++) {
			ls_item items[16];
			size_t k = ls_values(nodes[d], paths[p].k, paths[p].n, items, 16);
			fprintf(f, "%s{\"path\":[", p ? "," : "");
			for (size_t x = 0; x < paths[p].n; x++) fprintf(f, "%s\"%s\"", x ? "," : "", paths[p].k[x]);
			fprintf(f, "],\"items\":[");
			for (size_t i = 0; i < k && i < 16; i++) {
				fprintf(f, "%s{\"name\":", i ? "," : "");
				hex_out(f, items[i].name, CM_NAME);
				fprintf(f, ",\"gone\":%s,\"far\":%s,\"inside\":%s,\"at\":%zu", items[i].gone ? "true" : "false",
					items[i].far ? "true" : "false", items[i].inside ? "true" : "false", items[i].at);
				if (items[i].value != NULL) {
					char *t = op_json_text(items[i].value);
					fprintf(f, ",\"value\":%s", t);
					(free)(t);
				}
				fputc('}', f);
			}
			fprintf(f, "]}");
		}
		fputc(']', f);
	}
	fprintf(f, "]}\n");
	fflush(f);
}
static const keys ROOT[] = {{0, {NULL}}};
static const keys FUZZ_PATHS[] = {{0, {NULL}}, {1, {"p"}}, {1, {"q"}}, {1, {"r"}}, {2, {"p", "p"}}, {2, {"p", "q"}}, {2, {"p", "r"}},
	{2, {"q", "p"}}, {2, {"q", "q"}}, {2, {"q", "r"}}, {2, {"r", "p"}}, {2, {"r", "q"}}, {2, {"r", "r"}}};

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

// ---- presence

// a row as presence.ts sends it: the text made a value, its canonical CBOR
static uint8_t *row_bytes(const char *text, size_t *n) {
	op_value *v = op_json_read(text, NULL);
	CborOut o = {NULL, 0, 0, true};
	pk_put(&o, v);
	op_free(v);
	*n = o.length;
	return o.data;
}
// a peer of the tests' own: its seed (the first byte the one given, the rest 0) and its key (an Ed25519
// multikey), as littlesync makes one
typedef struct {
	uint8_t seed[32], key[LS_KEY_LEN];
} peer_key;
static peer_key peer_of(uint8_t tag) {
	peer_key p = {{tag, 0x5a}, {0xed, 0x01}};
	ermEd25519Public(p.seed, p.key + 2);
	return p;
}
// a message from a peer: its bytes on the topic, sealed as littlesync's say is (put_said)
static void feed_say(struct ls_link *l, const char *topic, const peer_key *who, const uint8_t *b, size_t n) {
	static const uint8_t header[8] = {0x34, 0x01, 0xed, 0x01, 0xed, 0x01, 0x13, 0x5f};
	size_t t = strlen(topic);
	uint8_t *said = malloc(57 + t), signature[72];
	memcpy(said, "ermine/v0/message", 17);
	cm_digest(b, n, said + 17);
	memcpy(said + 49, header, 8);
	memcpy(said + 57, topic, t);
	memcpy(signature, header, 8);
	ermEd25519Sign(who->seed, said, 57 + t, signature + 8);
	free(said);
	Json *s = jsonObject();
	jsonAdd(s, "bytes", jsonBytes(b, n));
	jsonAdd(s, "signer", jsonBytes(who->key, LS_KEY_LEN));
	jsonAdd(s, "signature", jsonBytes(signature, 72));
	size_t sn = 0;
	cborEncode(s, NULL, 0, &sn, NULL);
	uint8_t *sealed = malloc(sn);
	cborEncode(s, sealed, sn, &sn, NULL);
	jsonFree(s);
	Json *m = jsonObject();
	jsonAdd(m, "t", jsonString("say"));
	jsonAdd(m, "topic", jsonString(topic));
	jsonAdd(m, "bytes", jsonBytes(sealed, sn));
	free(sealed);
	feed_message(l, m);
}
// a presence row from a peer: its row (the text) on the topic (a node's id: its room)
static void feed_row(struct ls_link *l, const char *topic, const peer_key *who, const char *text) {
	size_t n;
	uint8_t *b = row_bytes(text, &n);
	feed_say(l, topic, who, b, n);
	free(b);
}
// the row of who's at the node (NULL: none)
static const ls_row *row_by(const ls_node *n, const uint8_t *who) {
	for (size_t i = 0; i < ls_rows(n); i++)
		if (memcmp(ls_row_at(n, i)->who, who, LS_KEY_LEN) == 0) return ls_row_at(n, i);
	return NULL;
}
static double pointer_x(const ls_row *r) {
	const op_value *p = r && r->value && r->value->type == OP_MAP ? op_get(r->value, "pointer") : NULL;
	const op_value *x = p && p->type == OP_MAP ? op_get(p, "x") : NULL;
	return x && x->type == OP_NUM ? x->num : -1;
}
// the messages (say) in bytes sent on a link: how many, the last one's bytes copied out, the last one's bytes copied out
static int rows_in(const uint8_t *b, size_t n, uint8_t *last, size_t *last_n, uint8_t *who) {
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
			Json *j = cborDecode(m, len, NULL, NULL), *s = NULL;
			const Json *t = jsonGet(j, "t"), *sealed = jsonGet(j, "bytes");
			if (t && strcmp(t->string, "say") == 0 && sealed && sealed->type == JSON_BYTES)
				s = cborDecode(sealed->bytes.data, sealed->bytes.length, NULL, NULL);
			const Json *r = s ? jsonGet(s, "bytes") : NULL, *w = s ? jsonGet(s, "signer") : NULL;
			if (r && r->type == JSON_BYTES && w && w->type == JSON_BYTES) {
				found++;
				memcpy(last, r->bytes.data, r->bytes.length), *last_n = r->bytes.length;
				memcpy(who, w->bytes.data, w->bytes.length < LS_KEY_LEN ? w->bytes.length : LS_KEY_LEN);
			}
			jsonFree(s), jsonFree(j);
		}
		k = 0;
	}
	return found;
}

static void t_presence(void) {
	printf("presence: rows as presence.ts sends them, renewed, relayed, gone on a gone or past their ttl\n");
	side a = open_side("pa"), b = open_side("pb");
	ls_node *pa = ls_follow(a.d, P1), *pb = ls_follow(b.d, P1);
	pump(&a, &b, 200);
	// my row: presence.ts's message, byte for byte, with my key
	const char *mine = "{\"name\":\"otter\",\"colour\":\"#d1495b\",\"pointer\":{\"x\":0.25,\"y\":0.5}}";
	op_value *v = op_json_read(mine, NULL);
	CHECK(ls_presence(pa, v) == LS_OK);
	op_free(v);
	CHECK(ls_rows(pa) == 1 && ls_row_at(pa, 0)->own && memcmp(ls_row_at(pa, 0)->who, ls_key(a.d), LS_KEY_LEN) == 0);
	const uint8_t *out;
	size_t n = ls_next(a.l, &out), got_n = 0, want_n;
	uint8_t got[ROW_SIZE], who[LS_KEY_LEN] = {0};
	CHECK(rows_in(out, n, got, &got_n, who) == 1);
	uint8_t *want = row_bytes("{\"ttl\":6000,\"value\":{\"name\":\"otter\",\"colour\":\"#d1495b\",\"pointer\":{\"x\":0.25,\"y\":0.5}}}", &want_n);
	CHECK(got_n == want_n && memcmp(got, want, want_n) == 0 && memcmp(who, ls_key(a.d), LS_KEY_LEN) == 0);
	free(want);
	ls_feed(b.l, out, n);
	const ls_row *r = row_by(pb, ls_key(a.d));
	CHECK(ls_rows(pb) == 1 && r != NULL && !r->own && pointer_x(r) == 0.25);
	// renewed: still there long past its ttl
	pump(&a, &b, 15000);
	CHECK(pointer_x(row_by(pb, ls_key(a.d))) == 0.25);
	// moved: the new value shows at once
	v = op_json_read("{\"name\":\"otter\",\"pointer\":{\"x\":0.75,\"y\":0.5}}", NULL);
	ls_presence(pa, v);
	op_free(v);
	pump(&a, &b, 100);
	CHECK(pointer_x(row_by(pb, ls_key(a.d))) == 0.75);
	// gone: at once
	ls_presence(pa, NULL);
	CHECK(ls_rows(pa) == 0);
	pump(&a, &b, 100);
	CHECK(ls_rows(pb) == 0);
	// a web pig's row (another key, as the gateway names it), its ttl as given
	peer_key juno = peer_of(7);
	const uint8_t *web = juno.key;
	feed_row(b.l, P1, &juno, "{\"ttl\":3000,\"value\":{\"name\":\"juno\",\"pointer\":{\"x\":0.5,\"y\":0.1}}}");
	CHECK(pointer_x(row_by(pb, web)) == 0.5);
	// it came on the link from a: never sent back on it. Lapses at its ttl
	pump(&a, &b, 2900);
	CHECK(row_by(pb, web) != NULL && row_by(pa, web) == NULL);
	pump(&a, &b, 200);
	CHECK(row_by(pb, web) == NULL);
	// a patch message is not taken (no whole row); gone takes a row out; my own key coming back is dropped
	feed_row(b.l, P1, &juno, "{\"ttl\":3000,\"value\":{\"name\":\"juno\"}}");
	feed_row(b.l, P1, &juno, "{\"ttl\":3000,\"patches\":[{\"path\":[\"name\"],\"value\":\"june\"}],\"n\":2}");
	r = row_by(pb, web);
	CHECK(r != NULL && r->value->type == OP_MAP && strcmp(op_get(r->value, "name")->str, "juno") == 0);
	feed_row(b.l, P1, &juno, "{\"gone\":true}");
	CHECK(row_by(pb, web) == NULL);
	// (my own row, as I sealed it, coming back to me)
	v = op_json_read("{}", NULL);
	ls_presence(pb, v);
	op_free(v);
	uint8_t echo[LS_FRAME_MAX + 2];
	size_t echo_n = 0;
	const uint8_t *f;
	for (size_t k; (k = ls_next(b.l, &f)) > 0;)
		if (echo_n == 0 && rows_in(f, k, got, &got_n, who) == 1) memcpy(echo, f, k), echo_n = k;
	ls_presence(pb, NULL);
	while (ls_next(b.l, &f) > 0) {}
	CHECK(echo_n > 0 && memcmp(who, ls_key(b.d), LS_KEY_LEN) == 0);
	ls_feed(b.l, echo, echo_n);
	CHECK(ls_rows(pb) == 0);
	// a row for a node not followed: nothing
	feed_row(b.l, P2, &juno, "{\"ttl\":3000,\"value\":{}}");
	CHECK(ls_find(b.d, P2) == NULL && ls_rows(pb) == 0);
	// a peer that goes quiet: its row lapses at its ttl
	v = op_json_read(mine, NULL);
	ls_presence(pa, v);
	op_free(v);
	pump(&a, &b, 100);
	CHECK(row_by(pb, ls_key(a.d)) != NULL);
	const uint8_t *drop;
	for (int i = 0; i < 560; i++) {
		now += 10;
		ls_tick(a.d, now), ls_tick(b.d, now);
		ls_next(a.l, &drop);
	}
	CHECK(row_by(pb, ls_key(a.d)) != NULL);
	for (int i = 0; i < 50; i++) now += 10, ls_tick(b.d, now);
	CHECK(row_by(pb, ls_key(a.d)) == NULL);
	// many rows: LS_ROWS kept, the soonest to lapse goes, never mine
	ls_presence(pb, v = op_json_read("{}", NULL));
	op_free(v);
	for (int i = 0; i < 24; i++) {
		peer_key k = peer_of((uint8_t)(100 + i));
		char text[64];
		snprintf(text, sizeof text, "{\"ttl\":%d,\"value\":{}}", 5000 + 100 * i);
		feed_row(b.l, P1, &k, text);
	}
	peer_key k_last = peer_of(123), k_first = peer_of(100);
	const uint8_t *last = k_last.key, *first = k_first.key;
	CHECK(ls_rows(pb) == LS_ROWS && row_by(pb, ls_key(b.d)) != NULL && row_by(pb, last) != NULL && row_by(pb, first) == NULL);
	// the test's own rows out at the end
	ls_presence(pb, NULL);
	CHECK(row_by(pb, ls_key(b.d)) == NULL);
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

// ---- messages: bytes on any topic, to the peers that want it

// what o.heard was told, the last of each side (context: its index)
static struct {
	int count;
	char topic[LS_TOPIC_MAX + 1];
	uint8_t who[LS_KEY_LEN];
	uint8_t bytes[16384];
	size_t length;
} heard_by[3];
static void heard(void *context, const char *topic, const uint8_t *who, size_t who_length, const uint8_t *bytes, size_t length) {
	int i = (int)(intptr_t)context;
	heard_by[i].count++;
	snprintf(heard_by[i].topic, sizeof heard_by[i].topic, "%s", topic);
	memcpy(heard_by[i].who, who, who_length < LS_KEY_LEN ? who_length : LS_KEY_LEN);
	memcpy(heard_by[i].bytes, bytes, length < sizeof heard_by[i].bytes ? length : sizeof heard_by[i].bytes);
	heard_by[i].length = length;
}
// a side with its own settings, heard told to heard_by[index]
static side open_with(const char *tag, int index, size_t message, size_t rows) {
	side s = {0};
	snprintf(s.dir, sizeof s.dir, "build/state-%s-%d", tag, (int)getpid());
	s.store = ls_store_file(s.dir);
	ls_options o = {.store = s.store, .random = random_bytes, .message = message, .rows = rows, .heard = heard,
		.heard_context = (void *)(intptr_t)index};
	if (getenv("LSLOG")) o.log = logline, o.log_context = (void *)strdup(tag);
	s.d = ls_open(&o);
	s.l = ls_link(s.d);
	return s;
}
// the says on the topic in bytes sent on a link
static int says_in(const uint8_t *b, size_t n, const char *topic) {
	static uint8_t frame[20000];
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
			const Json *t = jsonGet(j, "t"), *to = jsonGet(j, "topic");
			if (t && strcmp(t->string, "say") == 0 && to && to->type == JSON_STRING && strcmp(to->string, topic) == 0) found++;
			jsonFree(j);
		}
		k = 0;
	}
	return found;
}
// time passes for the devices, the wires carrying till quiet; says[i][0] counts the says on topic x sent
// on w[i], says[i][1] those y sent
static void pump_says(ls_dev *const *devs, size_t n, wire *w, size_t wires, int64_t ms, const char *topic, int (*says)[2]) {
	for (int64_t end = now + ms; now <= end; now += 10) {
		for (size_t i = 0; i < n; i++) ls_tick(devs[i], now);
		for (int round = 0; round < 50; round++) {
			size_t k = 0;
			for (size_t i = 0; i < wires; i++)
				for (int dir = 0; dir < 2; dir++) {
					struct ls_link *from = dir ? w[i].y : w[i].x, *to = dir ? w[i].x : w[i].y;
					const uint8_t *out;
					size_t m = ls_next(from, &out);
					if (m == 0) continue;
					if (says != NULL) says[i][dir] += says_in(out, m, topic);
					ls_feed(to, out, m);
					k += m;
				}
			if (k == 0) break;
		}
	}
}

// a den's row, about 3.3 KB of CBOR
static uint8_t *den_row(size_t length, uint8_t seed) {
	uint8_t *b = malloc(length);
	for (size_t i = 0; i < length; i++) b[i] = (uint8_t)(seed + i * 7);
	return b;
}

static void t_messages(void) {
	printf("messages: any topic, 3.3 KB, only to who listens, through a hub only where wanted, settings\n");
	memset(heard_by, 0, sizeof heard_by);
	char topic[64], other[64];
	snprintf(topic, sizeof topic, "dens:test-%08x", rnd());
	snprintf(other, sizeof other, "dens:test-%08x/ask/x", rnd());
	side a = open_with("sa", 0, 0, 0), b = open_with("sb", 1, 0, 0), c = open_with("sc", 2, 0, 0);
	struct ls_link *b2 = ls_link(b.d);
	wire w[2] = {{a.l, b.l, 0, {0, 0}}, {b2, c.l, 0, {0, 0}}};
	ls_dev *devs[3] = {a.d, b.d, c.d};
	int says[2][2] = {{0}};
	CHECK(ls_listen(c.d, topic) == LS_OK);
	CHECK(ls_listen(c.d, "") == LS_BAD && ls_send(a.d, "", NULL, 0) == LS_BAD);
	pump_says(devs, 3, w, 2, 300, topic, NULL);
	// a den's row from a to c, through b: byte for byte, a's key; b hears nothing (it does not listen)
	size_t length = 3300;
	uint8_t *row = den_row(length, 1);
	CHECK(ls_send(a.d, topic, row, length) == LS_OK);
	pump_says(devs, 3, w, 2, 100, topic, says);
	CHECK(heard_by[2].count == 1 && strcmp(heard_by[2].topic, topic) == 0 && heard_by[2].length == length);
	CHECK(memcmp(heard_by[2].bytes, row, length) == 0 && memcmp(heard_by[2].who, ls_key(a.d), LS_KEY_LEN) == 0);
	CHECK(heard_by[1].count == 0 && says[0][0] == 1 && says[1][0] == 1);
	// a topic nobody wants: not on any wire
	memset(says, 0, sizeof says);
	CHECK(ls_send(a.d, other, row, 10) == LS_OK);
	pump_says(devs, 3, w, 2, 100, other, says);
	CHECK(says[0][0] == 0 && says[1][0] == 0 && heard_by[2].count == 1);
	// c answers: to a once a listens; never back to c; b relays but does not hear
	CHECK(ls_listen(a.d, other) == LS_OK);
	pump_says(devs, 3, w, 2, 100, other, NULL);
	memset(says, 0, sizeof says);
	CHECK(ls_send(c.d, other, (const uint8_t *)"yes", 3) == LS_OK);
	pump_says(devs, 3, w, 2, 100, other, says);
	CHECK(heard_by[0].count == 1 && heard_by[0].length == 3 && memcmp(heard_by[0].bytes, "yes", 3) == 0);
	CHECK(memcmp(heard_by[0].who, ls_key(c.d), LS_KEY_LEN) == 0 && heard_by[1].count == 0);
	CHECK(says[1][1] == 1 && says[0][1] == 1 && says[0][0] == 0 && says[1][0] == 0);
	// many listens, then c lets go of the topic: a's next goes nowhere
	ls_unlisten(c.d, topic);
	pump_says(devs, 3, w, 2, 100, topic, NULL);
	memset(says, 0, sizeof says);
	ls_send(a.d, topic, row, length);
	pump_says(devs, 3, w, 2, 100, topic, says);
	CHECK(says[0][0] == 0 && heard_by[2].count == 1);
	// over the largest message: refused here
	uint8_t *big = den_row(LS_MESSAGE + 1, 2);
	CHECK(ls_send(a.d, topic, big, LS_MESSAGE + 1) == LS_BAD && ls_send(a.d, topic, big, LS_MESSAGE) == LS_OK);
	// a room on any topic: rows as on a node's, through b; cleared at the end
	char room[64];
	snprintf(room, sizeof room, "dens:test-%08x", rnd());
	op_value *v = op_json_read("{\"den\":\"a\"}", NULL);
	CHECK(ls_presence_on(a.d, room, v) == LS_OK && ls_presence_on(c.d, room, NULL) == LS_OK);
	op_free(v);
	pump_says(devs, 3, w, 2, 300, room, NULL);
	CHECK(ls_rows_on(c.d, room) == 1 && ls_rows_on(b.d, room) == 0 && ls_row_on(c.d, room, 0) != NULL &&
		memcmp(ls_row_on(c.d, room, 0)->who, ls_key(a.d), LS_KEY_LEN) == 0);
	CHECK(ls_rows_on(a.d, room) == 1 && ls_row_on(a.d, room, 0)->own);
	ls_unlisten(a.d, room);
	pump_says(devs, 3, w, 2, 100, room, NULL);
	CHECK(ls_rows_on(c.d, room) == 0 && ls_rows_on(a.d, room) == 0);
	ls_unlisten(c.d, room);
	free(row), free(big);
	close_side(&a), close_side(&b), close_side(&c);
	drop_dir(&a), drop_dir(&b), drop_dir(&c);

	// settings: a larger message both ends take; a peer with the default drops it; rows kept 4
	memset(heard_by, 0, sizeof heard_by);
	side x = open_with("sx", 0, 12000, 4), y = open_with("sy", 1, 12000, 0), z = open_with("sz", 2, 0, 0);
	struct ls_link *x2 = ls_link(x.d);
	wire v2[2] = {{x.l, y.l, 0, {0, 0}}, {x2, z.l, 0, {0, 0}}};
	ls_dev *devs2[3] = {x.d, y.d, z.d};
	ls_listen(y.d, topic), ls_listen(z.d, topic);
	pump_says(devs2, 3, v2, 2, 300, topic, NULL);
	size_t junk = ls_traffic_of(z.l)->junk;
	big = den_row(10000, 3);
	CHECK(ls_send(x.d, topic, big, 10000) == LS_OK);
	pump_says(devs2, 3, v2, 2, 100, topic, NULL);
	CHECK(heard_by[1].count == 1 && heard_by[1].length == 10000 && memcmp(heard_by[1].bytes, big, 10000) == 0);
	CHECK(heard_by[2].count == 0 && ls_traffic_of(z.l)->junk > junk);
	free(big);
	CHECK(ls_presence_on(x.d, room, NULL) == LS_OK);
	v = op_json_read("{}", NULL);
	ls_presence_on(x.d, room, v);
	op_free(v);
	for (int i = 0; i < 10; i++) {
		peer_key k = peer_of((uint8_t)(200 + i));
		char text[64];
		snprintf(text, sizeof text, "{\"ttl\":%d,\"value\":{}}", 3000 + 100 * i);
		feed_row(x.l, room, &k, text);
	}
	CHECK(ls_rows_on(x.d, room) == 4);
	// stale rows (a test run's, say) lapse at their ttl: then only mine
	pump_says(devs2, 3, v2, 2, 4000, room, NULL);
	CHECK(ls_rows_on(x.d, room) == 1 && ls_row_on(x.d, room, 0)->own);
	ls_presence_on(x.d, room, NULL);
	CHECK(ls_rows_on(x.d, room) == 0);
	close_side(&x), close_side(&y), close_side(&z);
	drop_dir(&x), drop_dir(&y), drop_dir(&z);
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
	// presence: a's row on c and c's on a, through b; a's gone too; a row past b on a late link
	v = op_json_read("{\"name\":\"otter\",\"pointer\":{\"x\":0.3,\"y\":0.3}}", NULL);
	CHECK(ls_presence(pa, v) == LS_OK);
	op_free(v);
	v = op_json_read("{\"name\":\"newt\",\"pointer\":{\"x\":0.6,\"y\":0.6}}", NULL);
	ls_presence(pc, v);
	op_free(v);
	pump3(devs, w, 2, 300);
	CHECK(ls_rows(pa) == 2 && ls_rows(pb) == 2 && ls_rows(pc) == 2);
	CHECK(pointer_x(row_by(pc, ls_key(a.d))) == 0.3 && pointer_x(row_by(pa, ls_key(c.d))) == 0.6);
	pump3(devs, w, 2, 10000);
	CHECK(ls_rows(pa) == 2 && ls_rows(pc) == 2);
	ls_presence(pa, NULL);
	pump3(devs, w, 2, 100);
	CHECK(ls_rows(pc) == 1 && row_by(pc, ls_key(a.d)) == NULL);
	ls_presence(pc, NULL);
	pump3(devs, w, 2, 100);
	CHECK(ls_rows(pa) == 0 && ls_rows(pb) == 0);
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

// the items at a node's root (or at one key), and whether two lists are the same names in the same order
static size_t items_at(const ls_node *n, const char *key, ls_item *out, size_t max) {
	const char *path[1] = {key};
	return ls_values(n, key ? path : NULL, key ? 1 : 0, out, max);
}
static bool same_items(const ls_item *a, size_t na, const ls_item *b, size_t nb) {
	if (na != nb) return false;
	for (size_t i = 0; i < na; i++)
		if (memcmp(a[i].name, b[i].name, CM_NAME) != 0 || a[i].gone != b[i].gone || a[i].inside != b[i].inside) return false;
	return true;
}

static void t_concurrent_moves(void) {
	printf("concurrent drops of one pig: both stand, the same two in the same order; a move replaces the shown one; a pick ends it\n");
	for (int round = 0; round < 12; round++) {
		side a = open_side("ca"), b = open_side("cb");
		n_wire_seen = 0;
		wire_bytes_clear();
		merges_seen = 0;
		ls_node *pa = ls_follow(a.d, P1), *pb = ls_follow(b.d, P1);
		ls_node *both[2] = {pa, pb};
		pump(&a, &b, 100);
		op_value *v = pig(0.1, 0.1, 1);
		ls_put(pa, v);
		op_free(v);
		pump(&a, &b, 100);
		// cut: each drops it while the other hears nothing
		v = pig(0.3, 0.3, 2);
		ls_put(pa, v);
		op_free(v);
		v = pig(0.6, 0.6, 3);
		ls_put(pb, v);
		op_free(v);
		CHECK(xof(pa) == 0.3 && xof(pb) == 0.6);
		cut(&a, &b);
		pump(&a, &b, 2000);
		ls_item ia[4], ib[4];
		size_t na = items_at(pa, NULL, ia, 4), nb = items_at(pb, NULL, ib, 4);
		CHECK(na == 2 && same_items(ia, na, ib, nb));
		CHECK(xof(pa) == xof(pb) && ls_commits(pa) == 2 && ls_commits(pb) == 2);
		// each item: its value, who and when
		pig_value p0, p1;
		pig_read(ia[0].value, P1, &p0), pig_read(ia[1].value, P1, &p1);
		CHECK(p0.x != p1.x && (p0.x == 0.3 || p0.x == 0.6) && (p1.x == 0.3 || p1.x == 0.6));
		CHECK(ia[0].lamport == ia[1].lamport && ia[0].signer != NULL && ia[0].signer_length == LS_KEY_LEN);
		CHECK(memcmp(ia[0].signer, ls_key(p0.x == 0.3 ? a.d : b.d), LS_KEY_LEN) == 0);
		CHECK(xof(pa) == p0.x);
		if (round == 0) dump_lists("concurrent drops", 1, both, 2, ROOT, 1);
		// an ordinary move by b: replaces only the item shown (the first), the other stays on both
		uint8_t other[CM_NAME];
		memcpy(other, ia[1].name, CM_NAME);
		v = pig(0.7, 0.7, 4);
		ls_put(pb, v);
		op_free(v);
		pump(&a, &b, 200);
		na = items_at(pa, NULL, ia, 4), nb = items_at(pb, NULL, ib, 4);
		CHECK(na == 2 && same_items(ia, na, ib, nb));
		CHECK(memcmp(ia[1].name, other, CM_NAME) == 0 && xof(pa) == 0.7);
		if (round == 0) dump_lists("an ordinary move in a clash", 1, both, 2, ROOT, 1);
		// a pick by a (the replace-all drop) ends it on both
		v = pig(0.2, 0.8, 5);
		CHECK(ls_pick(pa, v) == LS_OK);
		op_free(v);
		pump(&a, &b, 200);
		na = items_at(pa, NULL, ia, 4), nb = items_at(pb, NULL, ib, 4);
		CHECK(na == 1 && nb == 1 && same_items(ia, na, ib, nb) && xof(pb) == 0.2);
		CHECK(ls_commits(pa) == 1 && ls_commits(pb) == 1);
		if (round == 0) dump_lists("a pick ends it", 1, both, 2, ROOT, 1);
		// the writes after the clash had two parents, and no merge (key patches: neither base nor merge)
		CHECK(most_parents() == 2 && merges_seen == 0);
		check_lamports();
		capturing = 0;
		close_side(&a), close_side(&b);
		drop_dir(&a), drop_dir(&b);
	}
}

static void t_delete_and_set(void) {
	printf("a delete and a concurrent set: a gone item and a value item, the same on both\n");
	side a = open_side("da"), b = open_side("db");
	wire_bytes_clear();
	ls_node *ra = ls_follow(a.d, PIGS_ROOM), *rb = ls_follow(b.d, PIGS_ROOM);
	ls_node *both[2] = {ra, rb};
	pump(&a, &b, 100);
	ls_set(ra, P2, yes());
	pump(&a, &b, 100);
	ls_del(ra, P2);
	ls_set(rb, P2, op_bool(0));
	cut(&a, &b);
	pump(&a, &b, 2000);
	ls_item ia[4], ib[4];
	size_t na = items_at(ra, P2, ia, 4), nb = items_at(rb, P2, ib, 4);
	CHECK(na == 2 && same_items(ia, na, ib, nb));
	CHECK(ia[0].gone + ia[1].gone == 1);
	const ls_item *set = ia[0].gone ? &ia[1] : &ia[0];
	CHECK(set->value != NULL && set->value->type == OP_BOOL && !set->value->bool_);
	// the value shows the first: gone, or there
	CHECK((op_get(ls_value(ra), P2) == NULL) == (ia[0].gone != 0) && same(ra, rb));
	const keys at[] = {{0, {NULL}}, {1, {P2}}};
	dump_lists("a delete and a set", 1, both, 2, at, 2);
	capturing = 0;
	close_side(&a), close_side(&b);
	drop_dir(&a), drop_dir(&b);
}

static void t_made_parents(void) {
	printf("a deep write makes its missing parents as maps; under a value that is not a map it is left out\n");
	side a = open_side("ma"), b = open_side("mb");
	wire_bytes_clear();
	ls_node *na = ls_follow(a.d, P3), *nb = ls_follow(b.d, P3);
	ls_node *both[2] = {na, nb};
	pump(&a, &b, 100);
	const char *path[2] = {"p", "q"};
	op_value *x = op_num(5);
	ls_patch p = {path, 2, x, 0};
	CHECK(ls_write(na, &p, 1) == LS_OK);
	op_free(x);
	pump(&a, &b, 200);
	const op_value *v = ls_value(nb);
	const op_value *pv = v ? op_get(v, "p") : NULL, *q = pv ? op_get(pv, "q") : NULL;
	CHECK(pv != NULL && pv->type == OP_MAP && q != NULL && q->type == OP_NUM && q->num == 5);
	// the items: one at /p/q, none at /p (no write is there)
	ls_item it[4];
	CHECK(ls_values(nb, path, 2, it, 4) == 1 && ls_values(nb, path, 1, it, 4) == 0);
	// p becomes a number, concurrently with a write under it: the deep one is left out of the value, its
	// item stays (and the shallow one is marked inside)
	x = op_num(1);
	ls_set(na, "p", x);
	op_free(x);
	const char *deep[2] = {"p", "r"};
	x = op_num(9);
	ls_patch d = {deep, 2, x, 0};
	ls_write(nb, &d, 1);
	op_free(x);
	cut(&a, &b);
	pump(&a, &b, 2000);
	v = ls_value(na);
	CHECK(same(na, nb) && v != NULL && op_get(v, "p") != NULL && op_get(v, "p")->type == OP_NUM);
	CHECK(ls_values(na, deep, 2, it, 4) == 2 && it[0].value != NULL && it[0].value->num == 9 && it[1].at == 1 && it[1].gone);
	CHECK(ls_values(na, path, 1, it, 4) == 1 && it[0].inside);
	const keys at[] = {{0, {NULL}}, {1, {"p"}}, {2, {"p", "q"}}, {2, {"p", "r"}}};
	dump_lists("made parents", 1, both, 2, at, 4);
	capturing = 0;
	close_side(&a), close_side(&b);
	drop_dir(&a), drop_dir(&b);
}

// a commit sealed with a side's key, fed to another as a peer would send it; its name into name
static void feed_commit(side *signer, side *to, const char *id, Json *c, uint8_t name[CM_NAME]) {
	uint8_t *cb, *seed, *sealed, doc[32];
	size_t cl, sl, sn;
	CHECK(cm_encode_json(c, &cb, &cl, NULL) == CM_OK);
	jsonFree(c);
	cm_name(cb, cl, name);
	keep_bytes(cb, cl);
	CHECK(signer->store.load(signer->store.context, "key", &seed, &sl) && sl == 32);
	sl_seeded sd;
	sl_seeded_init(&sd, seed);
	free(seed);
	for (int i = 0; i < 32; i++) sscanf(id + 9 + 2 * i, "%2hhx", &doc[i]);
	CHECK(sl_seal(cb, cl, &sd.signer, doc, NULL, &sealed, &sn, NULL, NULL) == SL_OK);
	free(cb);
	Json *m = jsonObject(), *list = jsonArray();
	jsonAdd(m, "t", jsonString("commits"));
	jsonAdd(m, "node", jsonBytes(doc, 32));
	jsonPush(list, jsonBytes(sealed, sn));
	jsonAdd(m, "sealed", list);
	free(sealed);
	feed_message(to->l, m);
}
// an older commit (no replaces), of a pig at x, on the parents given
static Json *old_commit(side *signer, const uint8_t (*parents)[CM_NAME], size_t n, int64_t lamport, double x, int nonce) {
	Json *c = jsonObject(), *ps = jsonArray(), *patches = jsonArray(), *p = jsonObject();
	jsonAdd(c, "table", jsonString("value"));
	jsonAdd(c, "actor", jsonNull());
	jsonAdd(c, "time", jsonNumber(1));
	jsonAdd(c, "signer", jsonBytes(ls_key(signer->d), LS_KEY_LEN));
	jsonAdd(c, "nonce", jsonNumber(nonce));
	for (size_t i = 0; i < n; i++) jsonPush(ps, jsonBytes(parents[i], CM_NAME));
	jsonAdd(c, "parents", ps);
	jsonAdd(c, "lamport", jsonNumber((double)lamport));
	op_value *v = pig(x, 0.5, nonce);
	jsonAdd(p, "path", jsonArray()), jsonAdd(p, "value", pk_to_json(v));
	op_free(v);
	jsonPush(patches, p);
	jsonAdd(c, "patches", patches);
	return c;
}

static void t_older_commits(void) {
	printf("older commits (no replaces): a parent's write is replaced; one not known to be an ancestor stays\n");
	side a = open_side("oa"), b = open_side("ob");
	wire_bytes_clear();
	ls_node *pb = ls_follow(b.d, P1);
	ls_node *one[1] = {pb};
	ls_follow(a.d, P1);
	pump(&a, &b, 100);
	uint8_t c1[CM_NAME], c2[CM_NAME], c3[CM_NAME], c4[CM_NAME], none[1][CM_NAME] = {{0x1e, 0x20, 0x77}};
	feed_commit(&a, &b, P1, old_commit(&a, NULL, 0, 1, 0.1, 1), c1);
	// on c1: replaces it (its parent)
	feed_commit(&a, &b, P1, old_commit(&a, (const uint8_t(*)[CM_NAME])c1, 1, 2, 0.2, 2), c2);
	CHECK(ls_commits(pb) == 1 && xof(pb) == 0.2);
	// also on c1, concurrent with c2: both stand
	feed_commit(&a, &b, P1, old_commit(&a, (const uint8_t(*)[CM_NAME])c1, 1, 2, 0.3, 3), c3);
	ls_item it[4];
	CHECK(items_at(pb, NULL, it, 4) == 2);
	dump_lists("older commits", 1, one, 1, ROOT, 1);
	// on c3 and c2: replaces both (each a parent)
	uint8_t two[2][CM_NAME];
	memcpy(two[0], memcmp(c2, c3, CM_NAME) < 0 ? c2 : c3, CM_NAME);
	memcpy(two[1], memcmp(c2, c3, CM_NAME) < 0 ? c3 : c2, CM_NAME);
	feed_commit(&a, &b, P1, old_commit(&a, (const uint8_t(*)[CM_NAME])two, 2, 3, 0.4, 4), c4);
	CHECK(items_at(pb, NULL, it, 4) == 1 && xof(pb) == 0.4);
	dump_lists("older commits, both replaced", 1, one, 1, ROOT, 1);
	// on a parent never seen (the commits between left): unsure, so both stay, never hidden
	uint8_t c5[CM_NAME];
	feed_commit(&a, &b, P1, old_commit(&a, (const uint8_t(*)[CM_NAME])none, 1, 9, 0.9, 5), c5);
	CHECK(items_at(pb, NULL, it, 4) == 2 && xof(pb) == 0.9 && memcmp(it[1].name, c4, CM_NAME) == 0);
	CHECK(ls_stats_of(b.d)->refused == 0);
	capturing = 0;
	close_side(&a), close_side(&b);
	drop_dir(&a), drop_dir(&b);
}

static void t_far(void) {
	printf("past LS_ITEMS writes at a path: the rest kept by name only, never dropped; read again when they come up\n");
	side a = open_side("fa"), b = open_side("fb");
	ls_node *pb = ls_follow(b.d, P1);
	ls_follow(a.d, P1);
	pump(&a, &b, 100);
	uint8_t c1[CM_NAME], c[LS_ITEMS + 2][CM_NAME];
	feed_commit(&a, &b, P1, old_commit(&a, NULL, 0, 1, 0.1, 1), c1);
	// on c1, so c1 goes: one item
	feed_commit(&a, &b, P1, old_commit(&a, (const uint8_t(*)[CM_NAME])c1, 1, 2, 0.5, 100), c[0]);
	const uint8_t *drop;
	ls_next(b.l, &drop), ls_next(b.l, &drop);
	size_t before = heap();
	// a concurrent one: what an open clash costs
	feed_commit(&a, &b, P1, old_commit(&a, (const uint8_t(*)[CM_NAME])c1, 1, 2, 0.51, 101), c[1]);
	ls_next(b.l, &drop), ls_next(b.l, &drop);
	size_t one = heap();
	for (int i = 2; i < LS_ITEMS; i++) feed_commit(&a, &b, P1, old_commit(&a, (const uint8_t(*)[CM_NAME])c1, 1, 2, 0.2 + i / 100.0, 100 + i), c[i]);
	ls_next(b.l, &drop), ls_next(b.l, &drop);
	size_t full = heap();
	for (int i = LS_ITEMS; i < LS_ITEMS + 2; i++) feed_commit(&a, &b, P1, old_commit(&a, (const uint8_t(*)[CM_NAME])c1, 1, 2, 0.2 + i / 100.0, 100 + i), c[i]);
	ls_next(b.l, &drop), ls_next(b.l, &drop);
	size_t after = heap();
	printf("  heap: an open clash (a second pig drop standing) %zu B; one past LS_ITEMS (kept by name only) %zu B\n", one - before,
		(after - full) / 2);
	ls_item it[LS_ITEMS + 4];
	size_t k = items_at(pb, NULL, it, LS_ITEMS + 4);
	CHECK(k == LS_ITEMS + 2 && ls_commits(pb) == LS_ITEMS + 2);
	size_t far = 0;
	for (size_t i = 0; i < k; i++) far += it[i].far && it[i].value == NULL;
	CHECK(far == 2 && it[0].value != NULL && !it[0].far && it[k - 1].far);
	// a write that replaces the first LS_ITEMS by name: a far one comes up, read again from its seal
	uint8_t last[CM_NAME], names[LS_ITEMS + 2][CM_NAME];
	memcpy(last, it[k - 1].name, CM_NAME);
	for (size_t i = 0; i < k; i++) memcpy(names[i], it[i].name, CM_NAME);
	pig_value pl;
	// a write on all of them (lamport 3) that replaces all but the last: the far one comes up
	Json *w = jsonObject(), *ps = jsonArray(), *patches = jsonArray(), *p = jsonObject(), *r = jsonArray();
	jsonAdd(w, "table", jsonString("value"));
	jsonAdd(w, "actor", jsonNull());
	jsonAdd(w, "time", jsonNumber(1));
	jsonAdd(w, "signer", jsonBytes(ls_key(a.d), LS_KEY_LEN));
	jsonAdd(w, "nonce", jsonNumber(8));
	uint8_t sorted[LS_ITEMS + 2][CM_NAME];
	memcpy(sorted, names, sizeof sorted);
	qsort(sorted, k, CM_NAME, memcmp_names);
	for (size_t i = 0; i < k; i++) jsonPush(ps, jsonBytes(sorted[i], CM_NAME));
	jsonAdd(w, "parents", ps);
	jsonAdd(w, "lamport", jsonNumber(3));
	for (size_t i = 0; i < k; i++)
		if (memcmp(sorted[i], last, CM_NAME) != 0) jsonPush(r, jsonBytes(sorted[i], CM_NAME));
	op_value *v = pig(0.95, 0.5, 9);
	jsonAdd(p, "path", jsonArray()), jsonAdd(p, "value", pk_to_json(v)), jsonAdd(p, "replaces", r);
	op_free(v);
	jsonPush(patches, p);
	jsonAdd(w, "patches", patches);
	uint8_t top[CM_NAME];
	feed_commit(&a, &b, P1, w, top);
	k = items_at(pb, NULL, it, LS_ITEMS + 4);
	CHECK(k == 2 && memcmp(it[1].name, last, CM_NAME) == 0 && !it[1].far && it[1].value != NULL);
	pig_read(it[1].value, P1, &pl);
	CHECK(xof(pb) == 0.95 && pl.x > 0.2 && pl.x < 0.6);
	close_side(&a), close_side(&b);
	drop_dir(&a), drop_dir(&b);
}

static void t_offline(void) {
	printf("moves while no peer hears: each one never sent is folded into the next, so a peer sees one write, exact\n");
	side a = open_side("oa"), b = open_side("ob");
	n_wire_seen = 0;
	wire_bytes_clear();
	ls_node *pa = ls_follow(a.d, P1), *pb = ls_follow(b.d, P1);
	ls_node *both[2] = {pa, pb};
	pump(&a, &b, 100);
	op_value *v = pig(0.1, 0.1, 1);
	ls_put(pa, v);
	op_free(v);
	pump(&a, &b, 100);
	// a's line goes: three moves, none sent
	ls_unlink(a.l);
	a.l = NULL;
	for (int i = 2; i <= 4; i++) {
		v = pig(i / 10.0, 0.5, i);
		ls_put(pa, v);
		op_free(v);
	}
	CHECK(ls_commits(pa) == 1 && xof(pa) == 0.4);
	a.l = ls_link(a.d);
	pump(&a, &b, 3000);
	ls_item it[4];
	CHECK(items_at(pb, NULL, it, 4) == 1 && xof(pb) == 0.4 && ls_commits(pb) == 1);
	// two commits on the wire in all; the last's parent the first, its lamport 2
	CHECK(n_wire_bytes == 2 && it[0].lamport == 2);
	dump_lists("moves while no peer hears", 1, both, 2, ROOT, 1);
	check_lamports();
	capturing = 0;
	close_side(&a), close_side(&b);
	drop_dir(&a), drop_dir(&b);
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
	// per ls_hold and ls_put: the calls that took memory, and the most bytes held over those before it
	size_t holds = 0, puts = 0, hold_peak = 0, put_peak = 0, at;
	for (int i = 0; i < 10000; i++) {
		if (i == 500) m0 = heap();
		op_value *v = pig_make_held((i % 100) / 100.0, 0.5, "otter", "#d1495b", "abcd");
		at = lsc_calls, lsc_peak = lsc_bytes, m1 = lsc_bytes;
		ls_hold(pa, v);
		holds += lsc_calls - at;
		if (lsc_peak - m1 > hold_peak) hold_peak = lsc_peak - m1;
		op_free(v);
		// every few moves a drop: a stored commit, and everything pumped
		if (i % 5 == 4) {
			v = pig((i % 100) / 100.0, 0.5, i);
			at = lsc_calls, lsc_peak = lsc_bytes, m1 = lsc_bytes;
			ls_put(pa, v);
			puts += lsc_calls - at;
			if (lsc_peak - m1 > put_peak) put_peak = lsc_peak - m1;
			op_free(v);
		}
		pump(&a, &b, 10);
	}
	m1 = heap();
	printf("  heap after 500 moves %zu, after 10000 %zu (%+ld)\n", m0, m1, (long)m1 - (long)m0);
	printf("  a call: ls_hold %.1f allocations, at most %zu B more held; ls_put (a drop, sent) %.1f, %zu B\n",
		holds / 10000.0, hold_peak, puts / 2000.0, put_peak);
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
		wire_bytes_clear();
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
				ls_patch p = {path, 2, rnd() % 4 ? x : NULL, 0};
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
		char label[32];
		snprintf(label, sizeof label, "fuzz seed %d", seed);
		ls_node *both[2] = {na, nb};
		dump_lists(label, 0, both, 2, FUZZ_PATHS, sizeof FUZZ_PATHS / sizeof *FUZZ_PATHS);
		capturing = 0;
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

// ---- server-sized: many links on a hub, keep

// a device with room for links (0: the default), keeping (keep: 1) or not, and no link yet
static side open_hub(const char *tag, size_t links, int keep) {
	side s = {0};
	snprintf(s.dir, sizeof s.dir, "build/state-%s-%d", tag, (int)getpid());
	s.store = ls_store_file(s.dir);
	ls_options o = {.store = s.store, .random = random_bytes, .links = links, .keep = keep};
	if (getenv("LSLOG")) o.log = logline, o.log_context = (void *)strdup(tag);
	s.d = ls_open(&o);
	return s;
}

// time passes for every device, the wires carrying till quiet
static void pump_all(ls_dev *const *devs, size_t n, wire *w, size_t wires, int64_t ms) {
	for (int64_t end = now + ms; now <= end; now += 10) {
		for (size_t i = 0; i < n; i++)
			if (devs[i] != NULL) ls_tick(devs[i], now);
		for (int round = 0; round < 50; round++) {
			size_t k = 0;
			for (size_t i = 0; i < wires; i++) {
				k += carry_one(w[i].x, w[i].y, w[i].cut, &w[i].commits_out[0]);
				k += carry_one(w[i].y, w[i].x, w[i].cut, &w[i].commits_out[1]);
			}
			if (k == 0) break;
		}
	}
}

#define LEAVES 50
static void t_many_links(void) {
	printf("a hub with %d links: every leaf's writes on three nodes reach every leaf\n", LEAVES);
	side small = open_hub("ms", 0, 0);
	for (int i = 0; i < LS_LINKS; i++) CHECK(ls_link(small.d) != NULL);
	CHECK(ls_link(small.d) == NULL);
	close_side(&small), drop_dir(&small);
	side hub = open_hub("mh", LEAVES, 0), leaf[LEAVES];
	ls_dev *devs[LEAVES + 1] = {hub.d};
	wire w[LEAVES];
	const char *ids[3] = {P1, P2, P3};
	ls_node *hn[3], *ln[LEAVES][3];
	for (int k = 0; k < 3; k++) hn[k] = ls_follow(hub.d, ids[k]);
	for (int i = 0; i < LEAVES; i++) {
		char tag[16];
		snprintf(tag, sizeof tag, "m%d", i);
		leaf[i] = open_side(tag);
		devs[i + 1] = leaf[i].d;
		w[i] = (wire){ls_link(hub.d), leaf[i].l, 0, {0, 0}};
		CHECK(w[i].x != NULL);
		for (int k = 0; k < 3; k++) ln[i][k] = ls_follow(leaf[i].d, ids[k]);
	}
	CHECK(ls_link(hub.d) == NULL);
	pump_all(devs, LEAVES + 1, w, LEAVES, 300);
	int up = 0;
	for (int i = 0; i < LEAVES; i++) up += ls_up(w[i].x) && ls_up(leaf[i].l);
	CHECK(up == LEAVES);
	// each leaf a key of its own on one node; then again, on another
	for (int pass = 0; pass < 2; pass++) {
		for (int i = 0; i < LEAVES; i++) {
			char key[16];
			snprintf(key, sizeof key, "k%d", i);
			op_value *v = op_num(i + 100 * pass);
			CHECK(ls_set(ln[i][(i + pass) % 3], key, v) == LS_OK);
			op_free(v);
		}
		pump_all(devs, LEAVES + 1, w, LEAVES, 3000);
	}
	// what a full out queue dropped (a want's answer) comes with the next heads beat (10 s)
	pump_all(devs, LEAVES + 1, w, LEAVES, 11000);
	int good = 0, bad = 0;
	for (int k = 0; k < 3; k++) {
		const op_value *v = ls_value(hn[k]);
		size_t want = 0;
		for (int i = 0; i < LEAVES; i++) want += i % 3 == k || (i + 1) % 3 == k;
		CHECK(v != NULL && v->type == OP_MAP && v->count == want);
		for (int i = 0; i < LEAVES; i++) good += same(hn[k], ln[i][k]);
	}
	for (int i = 0; i < LEAVES + 1; i++) bad += ls_stats_of(devs[i])->bad_seals;
	CHECK(good == 3 * LEAVES && bad == 0);
	if (good != 3 * LEAVES) printf("  %d of %d leaf nodes the same as the hub's\n", good, 3 * LEAVES);
	// k3: written on P1 first, then on P2
	const op_value *k0 = op_get(ls_value(ln[7][0]), "k3"), *k1 = op_get(ls_value(ln[7][1]), "k3");
	CHECK(k0 != NULL && k0->num == 3 && k1 != NULL && k1->num == 103);
	close_side(&hub), drop_dir(&hub);
	for (int i = 0; i < LEAVES; i++) close_side(&leaf[i]), drop_dir(&leaf[i]);
}

// how many files in the side's store begin with prefix
static int files_like(const side *s, const char *prefix) {
	char cmd[256];
	snprintf(cmd, sizeof cmd, "ls %s | grep -c '^%s'", s->dir, prefix);
	FILE *p = popen(cmd, "r");
	int k = 0;
	if (p != NULL && fscanf(p, "%d", &k) != 1) k = 0;
	if (p != NULL) pclose(p);
	return k;
}

#define MOVES 40
static void t_keep(void) {
	printf("keep: a relay lets go of no commit; a link that comes later gets all %d, after a restart too\n", MOVES);
	for (int keep = 1; keep >= 0; keep--) {
		side hub = open_hub(keep ? "kh" : "nh", 8, keep), a = open_side("ka"), c = open_side("kc");
		ls_dev *devs[3] = {hub.d, a.d, c.d};
		wire w[2] = {{ls_link(hub.d), a.l, 0, {0, 0}}, {NULL, c.l, 0, {0, 0}}};
		ls_follow(hub.d, P1);
		ls_node *pa = ls_follow(a.d, P1), *pc = ls_follow(c.d, P1);
		pump_all(devs, 3, w, 1, 200);
		// a moves the pig MOVES times, each replacing the last: one commit makes the value
		for (int i = 0; i < MOVES; i++) {
			op_value *v = pig(0.01 * i, 0.5, i);
			ls_put(pa, v);
			op_free(v);
			pump_all(devs, 3, w, 1, 100);
		}
		CHECK(ls_commits(ls_find(hub.d, P1)) == 1);
		// c comes later
		w[1].x = ls_link(hub.d);
		pump_all(devs, 3, w, 2, 3000);
		CHECK(xof(pc) == xof(pa) && same(pa, pc));
		const ls_stats *st = ls_stats_of(c.d);
		if (keep) {
			CHECK(st->applied == MOVES && st->bad_seals == 0);
			CHECK(files_like(&hub, "seal_") == MOVES - 1);
			if (st->applied != MOVES) printf("  late link applied %u of %d\n", st->applied, MOVES);
			// the hub begins again from its store: a third, later still, gets all of it as well
			close_side(&hub);
			ls_options o = {.store = hub.store, .random = random_bytes, .links = 8, .keep = 1};
			hub.d = devs[0] = ls_open(&o);
			ls_follow(hub.d, P1);
			side e = open_side("ke");
			ls_node *pe = ls_follow(e.d, P1);
			ls_dev *devs2[2] = {hub.d, e.d};
			wire w2[1] = {{ls_link(hub.d), e.l, 0, {0, 0}}};
			pump_all(devs2, 2, w2, 1, 3000);
			CHECK(ls_stats_of(e.d)->applied == MOVES && xof(pe) == xof(pa));
			CHECK(ls_commits(ls_find(hub.d, P1)) == 1);
			close_side(&e), drop_dir(&e);
		} else CHECK(st->applied == 1);
		close_side(&hub), close_side(&a), close_side(&c);
		drop_dir(&hub), drop_dir(&a), drop_dir(&c);
	}
}

static const struct {
	const char *name;
	void (*run)(void);
} TESTS[] = {{"converge", t_converge}, {"moves", t_concurrent_moves}, {"deletes", t_delete_and_set}, {"made", t_made_parents},
	{"older", t_older_commits}, {"far", t_far}, {"offline", t_offline}, {"adds", t_concurrent_adds}, {"garbage", t_garbage},
	{"restart", t_restart}, {"fresh", t_fresh}, {"bad", t_bad_and_refused}, {"ephemeral", t_ephemeral}, {"presence", t_presence}, {"messages", t_messages}, {"relay", t_relay}, {"acks", t_per_link_acks}, {"relink", t_relink}, {"limits", t_limits}, {"fuzz", t_fuzz},
	{"cost", t_cost}, {"memory", t_memory}, {"links", t_many_links}, {"keep", t_keep}};

// no arguments: every test; else the ones named
int main(int argc, char **argv) {
	if (system("mkdir -p build")) {}
	if (getenv("LSWIRE")) wire_log = fopen(getenv("LSWIRE"), "wb");
	for (size_t i = 0; i < sizeof TESTS / sizeof *TESTS; i++) {
		int wanted = argc == 1;
		for (int k = 1; k < argc; k++) wanted |= strcmp(argv[k], TESTS[i].name) == 0;
		if (wanted) TESTS[i].run();
	}
	printf("%d checks, %d failed\n", checks, failed);
	return failed != 0;
}
