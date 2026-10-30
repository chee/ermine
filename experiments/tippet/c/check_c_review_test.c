// Tries to break tippet's C; a FAIL line is a bug it found. ONLY=123456789rfl picks checks, NOA=1
// skips 6a, UNLINK=1 unlinks 7's link. Run ./tippet-review-test-check dir (build.sh builds it).
#define _POSIX_C_SOURCE 200809L
#include <dirent.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include "history.h"
#include "store.h"
#include "tippet.h"
#include "wire.h"

typedef struct {
	size_t now, peak;
} heap;

static void *counted(void *ctx, void *p, size_t old, size_t size) {
	heap *h = ctx;
	if (!size) return free(p), h->now -= old, NULL;
	void *q = realloc(p, size);
	if (q) h->now = h->now - old + size, h->peak = h->now > h->peak ? h->now : h->peak;
	return q;
}

static heap H;
static tp_mem mem = {counted, &H};
static int failed;
#define CHECK(x) \
	do { \
		if (!(x)) printf("  FAIL %s:%d: %s\n", __FILE__, __LINE__, #x), failed++; \
	} while (0)

static void wipe(const char *dir) {
	DIR *in = opendir(dir);
	struct dirent *e;
	char path[4096];
	while (in && (e = readdir(in))) {
		if (e->d_name[0] != '.') snprintf(path, sizeof path, "%s/%s", dir, e->d_name), unlink(path);
	}
	if (in) closedir(in);
	rmdir(dir);
}

static double now(void) {
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return t.tv_sec + t.tv_nsec / 1e9;
}


static uint8_t ps[64];
static tp_write put(int x) {
	uint8_t p[] = {0x81, 0xa2, 0x64, 'p', 'a', 't', 'h', 0x80, 0x65, 'v', 'a', 'l', 'u', 'e', (uint8_t)(x % 24)};
	memcpy(ps, p, sizeof p);
	tp_write w = {{(const uint8_t *)"pig", 3}, {(const uint8_t *)"value", 5}, {ps, sizeof p}, {NULL, 0}, 1760000000, {NULL, 0}};
	return w;
}

static tp_log *memlog(const uint8_t *seed, size_t max, tp_told told, void *ctx) {
	tp_log_options o = {mem, tp_memory_store(&mem, max), seed, 1, {0, 0, 0}, told, ctx};
	tp_log *log = tp_log_new(&o);
	if (tp_log_load(log)) return tp_log_free(log), NULL;
	return log;
}

typedef struct {
	uint8_t device[32], sig[64];
	uint8_t bytes[1 << 16];
	tp_span spans[256];
	size_t n;
} run;

static int run_of(tp_log *log, uint64_t from, run *r) {
	uint64_t to;
	memcpy(r->device, tp_log_device(log), 32);
	if (tp_log_run(log, r->device, from, &to, r->sig)) return -1;
	size_t at = 0;
	r->n = 0;
	for (uint64_t k = from; k <= to; k++) {
		long n = tp_log_step(log, r->device, k, r->bytes + at, sizeof r->bytes - at);
		r->spans[r->n++] = (tp_span){r->bytes + at, (size_t)n};
		at += (size_t)n;
	}
	return 0;
}

static tp_log *writer(uint8_t s, int k, run *r) {
	uint8_t seed[32];
	memset(seed, s, 32);
	tp_log *log = memlog(seed, 1 << 20, NULL, NULL);
	uint64_t n, l;
	for (int i = 0; i < k; i++) {
		tp_write w = put(i);
		tp_log_write(log, &w, &n, &l);
	}
	if (r) run_of(log, 1, r);
	return log;
}


static size_t ints(uint8_t *out, int n, ...) {
	tp_buf b = {out, 0, 4096, 4096, NULL, 0};
	va_list a;
	va_start(a, n);
	tp_put_head(&b, 4, (uint64_t)n);
	for (int i = 0; i < n; i++) {
		long long x = va_arg(a, long long);
		if (i % 2) tp_put_head(&b, 0, (uint64_t)x);
		else tp_put_int(&b, x);
	}
	va_end(a);
	return b.len;
}
static size_t texts(uint8_t *out, const char *s, uint64_t count) {
	tp_buf b = {out, 0, 256, 256, NULL, 0};
	tp_put_head(&b, 4, 2), tp_put_text(&b, s), tp_put_head(&b, 0, count);
	return b.len;
}
static size_t nulls(uint8_t *out, uint64_t count) {
	tp_buf b = {out, 0, 256, 256, NULL, 0};
	tp_put_head(&b, 4, 2), tp_put(&b, "\xf6", 1), tp_put_head(&b, 0, count);
	return b.len;
}

enum { LAM, WHEN, NODE, PART, WHO, COUNT, FROM, MOVE, PATH, SIZE, PATHS, SHAPE, VALUE, NCOL };
typedef struct {
	tp_span first;
	uint8_t col[NCOL][4096];
	size_t len[NCOL];
	int keys; // map entries written (7; 6 drops value; 8 repeats paths)
} pk;

static size_t pack_of(uint8_t *out, size_t cap, const pk *k) {
	static const char *names[] = {"from", "move", "path", "size", "paths", "shape", "value"};
	tp_buf b = {out, 0, cap, cap, NULL, 0};
	tp_put_head(&b, 4, 8), tp_put_head(&b, 2, k->first.n), tp_put(&b, k->first.p, k->first.n);
	for (int c = LAM; c <= COUNT; c++) tp_put(&b, k->col[c], k->len[c]);
	int keys = k->keys ? k->keys : 7;
	tp_put_head(&b, 5, (uint64_t)keys);
	for (int i = 0; i < 7 && i < keys; i++) {
		tp_put_text(&b, names[i]), tp_put(&b, k->col[FROM + i], k->len[FROM + i]);
		if (keys == 8 && i == 4) tp_put_text(&b, names[i]), tp_put(&b, k->col[FROM + i], k->len[FROM + i]);
	}
	return b.bad ? 0 : b.len;
}

static void baseline(pk *k, tp_span first) {
	memset(k, 0, sizeof *k);
	k->first = first;
	k->len[LAM] = ints(k->col[LAM], 2, 1LL, 2LL);
	k->len[WHEN] = ints(k->col[WHEN], 2, 0LL, 2LL);
	k->len[NODE] = texts(k->col[NODE], "pig", 2);
	k->len[PART] = texts(k->col[PART], "value", 2);
	k->len[WHO] = nulls(k->col[WHO], 2);
	k->len[COUNT] = ints(k->col[COUNT], 2, 1LL, 2LL);
	k->len[FROM] = ints(k->col[FROM], 0);
	k->len[MOVE] = ints(k->col[MOVE], 0);
	k->len[PATH] = ints(k->col[PATH], 2, 0LL, 2LL);
	k->len[SIZE] = ints(k->col[SIZE], 0);
	memcpy(k->col[PATHS], "\x81\x80", 2), k->len[PATHS] = 2;
	k->len[SHAPE] = ints(k->col[SHAPE], 2, 2LL, 2LL);
	memcpy(k->col[VALUE], "\x82\x05\x06", 3), k->len[VALUE] = 3;
}

static int unpacks(const pk *k, size_t max, size_t *count) {
	static uint8_t p[1 << 16];
	size_t n = pack_of(p, sizeof p, k);
	if (!n) return 99;
	tp_steps s;
	int why = tp_unpack(&mem, (tp_span){p, n}, max, &s);
	if (count) *count = why ? 0 : s.count;
	if (!why) tp_steps_free(&mem, &s);
	return why;
}

// ---- 1. a pack claiming more steps than its bytes hold

static void claims(void) {
	printf("1. a pack that claims more steps than its bytes hold\n");
	run r;
	tp_log *w = writer(1, 1, &r);
	pk k;
	size_t count;
	baseline(&k, r.spans[0]);
	CHECK(unpacks(&k, 1 << 20, &count) == 0 && count == 3);
	k.len[LAM] = ints(k.col[LAM], 2, 1LL, 4095LL);
	CHECK(unpacks(&k, 1 << 20, NULL) == TP_NOTSTEP);
	baseline(&k, r.spans[0]);
	k.len[LAM] = ints(k.col[LAM], 2, 1LL, 4095LL);
	k.len[WHEN] = ints(k.col[WHEN], 2, 0LL, 4095LL);
	k.len[NODE] = texts(k.col[NODE], "pig", 4095);
	k.len[PART] = texts(k.col[PART], "value", 4095);
	k.len[WHO] = nulls(k.col[WHO], 4095);
	k.len[COUNT] = ints(k.col[COUNT], 2, 0LL, 4095LL);
	k.len[PATH] = ints(k.col[PATH], 0), k.len[SHAPE] = ints(k.col[SHAPE], 0);
	k.len[PATHS] = ints(k.col[PATHS], 0), k.len[VALUE] = ints(k.col[VALUE], 0);
	static uint8_t p[1 << 16];
	size_t n = pack_of(p, sizeof p, &k);
	tp_steps s;
	H.peak = H.now;
	size_t base = H.now;
	int why = tp_unpack(&mem, (tp_span){p, n}, 1 << 24, &s);
	CHECK(why == 0 && s.count == 4096);
	printf("  a %zu-byte pack: %zu steps, %zu bytes of them; heap peak +%zu\n", n, why ? 0 : s.count,
		why ? 0 : s.at[s.count], H.peak - base);
	if (!why) tp_steps_free(&mem, &s);
	CHECK(tp_unpack(&mem, (tp_span){p, n}, 64 << 10, &s) == TP_BOUND);
	CHECK(H.now == base);
	k.len[LAM] = ints(k.col[LAM], 2, 1LL, 4096LL);
	k.len[WHEN] = ints(k.col[WHEN], 2, 0LL, 4096LL);
	k.len[NODE] = texts(k.col[NODE], "pig", 4096);
	k.len[PART] = texts(k.col[PART], "value", 4096);
	k.len[WHO] = nulls(k.col[WHO], 4096);
	k.len[COUNT] = ints(k.col[COUNT], 2, 0LL, 4096LL);
	CHECK(unpacks(&k, 1 << 24, NULL) == TP_NOTSTEP);
	k.len[LAM] = ints(k.col[LAM], 2, 1LL, (long long)TP_WHOLE);
	CHECK(unpacks(&k, 1 << 24, NULL) == TP_NOTSTEP);
	baseline(&k, r.spans[0]);
	size_t npaths = 1000000, big = npaths + 64;
	uint8_t *q = malloc(big + 4096);
	tp_buf b = {q, 0, big + 4096, big + 4096, NULL, 0};
	tp_put_head(&b, 4, 8), tp_put_head(&b, 2, k.first.n), tp_put(&b, k.first.p, k.first.n);
	for (int c = LAM; c <= COUNT; c++) tp_put(&b, k.col[c], k.len[c]);
	tp_put_head(&b, 5, 7);
	tp_put_text(&b, "from"), tp_put(&b, k.col[FROM], k.len[FROM]);
	tp_put_text(&b, "move"), tp_put(&b, k.col[MOVE], k.len[MOVE]);
	tp_put_text(&b, "path"), tp_put(&b, k.col[PATH], k.len[PATH]);
	tp_put_text(&b, "size"), tp_put(&b, k.col[SIZE], k.len[SIZE]);
	tp_put_text(&b, "paths"), tp_put_head(&b, 4, npaths);
	for (size_t i = 0; i < npaths; i++) tp_put(&b, "\x80", 1);
	tp_put_text(&b, "shape"), tp_put(&b, k.col[SHAPE], k.len[SHAPE]);
	tp_put_text(&b, "value"), tp_put(&b, k.col[VALUE], k.len[VALUE]);
	H.peak = H.now, base = H.now;
	why = tp_unpack(&mem, (tp_span){q, b.len}, 1 << 24, &s);
	printf("  a %zu-byte pack of %zu unused paths: unpack %s, heap peak +%zu (max 16 MB of steps)\n", b.len,
		npaths, tp_why(why), H.peak - base);
	CHECK(H.peak - base < 2 * b.len);
	if (!why) tp_steps_free(&mem, &s);
	free(q);
	tp_log_free(w);
}

// ---- 2. a 33-byte key

typedef struct {
	int sent;
} counter;
static int count_send(void *ctx, const uint8_t *b, size_t n) {
	(void)b, (void)n;
	((counter *)ctx)->sent++;
	return 0;
}

static void key33(void) {
	printf("2. a step array with a 33-byte key\n");
	uint8_t s[256], k33[33], h33[33];
	memset(k33, 7, 33), memset(h33, 9, 33);
	tp_step t;
	for (int size = 31; size <= 33; size++) {
		tp_buf b = {s, 0, sizeof s, sizeof s, NULL, 0};
		tp_put_head(&b, 4, 8), tp_put_head(&b, 2, (uint64_t)size), tp_put(&b, k33, (size_t)size);
		tp_put_head(&b, 0, 1), tp_put(&b, "\xf6", 1), tp_put_text(&b, "pig"), tp_put_text(&b, "value");
		tp_put(&b, ps, 15), tp_put_head(&b, 0, 1), tp_put_head(&b, 0, 0);
		put(1);
		int why = tp_step_decode(s, b.len, &t);
		CHECK(size == 32 ? why == 0 : why == TP_NOTSTEP);
		if (size == 33) {
			pk k;
			baseline(&k, (tp_span){s, b.len});
			CHECK(unpacks(&k, 1 << 20, NULL) == TP_NOTSTEP);
		}
	}
	{
		tp_buf b = {s, 0, sizeof s, sizeof s, NULL, 0};
		tp_put_head(&b, 4, 8), tp_put_head(&b, 2, 32), tp_put(&b, k33, 32);
		tp_put_head(&b, 0, 2), tp_put_head(&b, 2, 33), tp_put(&b, h33, 33);
		tp_put_text(&b, "pig"), tp_put_text(&b, "value");
		tp_put(&b, ps, 15), tp_put_head(&b, 0, 1), tp_put_head(&b, 0, 0);
		CHECK(tp_step_decode(s, b.len, &t) == TP_NOTSTEP);
	}
	tp_log *log = writer(2, 1, NULL);
	tp_sync_options so = {mem, log, 0, NULL, NULL, NULL, 0, 0};
	tp_sync *sync = tp_sync_new(&so);
	counter c = {0};
	tp_link *l = tp_sync_link(sync, count_send, &c, 0);
	int before = c.sent;
	uint8_t m[512], sig[64] = {0};
	tp_buf b = {m, 0, sizeof m, sizeof m, NULL, 0};
	tp_put_head(&b, 4, 2), tp_put_text(&b, "have"), tp_put_head(&b, 4, 1);
	tp_put_head(&b, 4, 2), tp_put_head(&b, 2, 33), tp_put(&b, k33, 33), tp_put_head(&b, 0, 1);
	tp_sync_receive(sync, l, m, b.len);
	b.len = 0;
	tp_put_head(&b, 4, 3), tp_put_text(&b, "refused"), tp_put_head(&b, 2, 33), tp_put(&b, k33, 33);
	tp_put_head(&b, 0, 1);
	tp_sync_receive(sync, l, m, b.len);
	b.len = 0;
	tp_put_head(&b, 4, 4), tp_put_text(&b, "run"), tp_put_head(&b, 2, 33), tp_put(&b, k33, 33);
	tp_put_head(&b, 2, 64), tp_put(&b, sig, 64), tp_put(&b, "\x80", 1);
	tp_sync_receive(sync, l, m, b.len);
	CHECK(c.sent == before && tp_log_devices(log) == 1);
	tp_sync_free(sync);
	tp_log_free(log);
}

// ---- 3. columns whose runs don't add up

static void columns(void) {
	printf("3. columns whose runs don't add up\n");
	run r;
	tp_log *w = writer(3, 1, &r);
	struct {
		const char *what;
		int col;
		int n;
		long long v[6];
	} bad[] = {
		{"when short", WHEN, 2, {0, 1}},
		{"count over", COUNT, 4, {1, 1, 2, 1}},
		{"count under", COUNT, 4, {1, 1, 0, 1}},
		{"path short", PATH, 2, {0, 1}},
		{"path past paths", PATH, 2, {1, 2}},
		{"ranged, no from", SHAPE, 2, {3, 2}},
		{"shape 8", SHAPE, 2, {8, 2}},
		{"shape short", SHAPE, 2, {2, 1}},
		{"a run of 0", LAM, 4, {1, 0, 1, 2}},
		{"odd runs", LAM, 3, {1, 2, 5}},
		{"from without range", FROM, 2, {0, 2}},
		{"negative count", COUNT, 2, {-1, 2}},
	};
	for (size_t i = 0; i < sizeof bad / sizeof *bad; i++) {
		pk k;
		baseline(&k, r.spans[0]);
		long long *v = bad[i].v;
		k.len[bad[i].col] = ints(k.col[bad[i].col], bad[i].n, v[0], v[1], v[2], v[3], v[4], v[5]);
		size_t base = H.now;
		int why = unpacks(&k, 1 << 20, NULL);
		if (why != TP_NOTSTEP) printf("  %s: %s\n", bad[i].what, tp_why(why));
		CHECK(why == TP_NOTSTEP && H.now == base);
	}
	pk k;
	baseline(&k, r.spans[0]);
	memcpy(k.col[VALUE], "\x81\x05", 2), k.len[VALUE] = 2;
	CHECK(unpacks(&k, 1 << 20, NULL) == TP_NOTSTEP);
	baseline(&k, r.spans[0]);
	k.keys = 6;
	CHECK(unpacks(&k, 1 << 20, NULL) == TP_NOTSTEP);
	baseline(&k, r.spans[0]);
	k.keys = 8;
	CHECK(unpacks(&k, 1 << 20, NULL) == TP_NOTSTEP);
	baseline(&k, r.spans[0]);
	memcpy(k.col[NODE], "\x82\x63pig\x02", 6), k.len[NODE] = 6;
	CHECK(unpacks(&k, 1 << 20, NULL) == 0);
	baseline(&k, r.spans[0]);
	k.len[NODE] = ints(k.col[NODE], 2, 1LL, 2LL);
	CHECK(unpacks(&k, 1 << 20, NULL) == TP_NOTSTEP);
	tp_log_free(w);
}

// ---- 4. a file store cut short mid-record

static size_t file_size(const char *path) {
	struct stat st;
	return stat(path, &st) ? 0 : (size_t)st.st_size;
}

static void cut(const char *dir) {
	printf("4. a file store cut short mid-record\n");
	char d[512], f[600];
	uint8_t seed[32];
	memset(seed, 4, 32);
	snprintf(d, sizeof d, "%s/whole", dir);
	tp_log_options o = {mem, tp_file_store(&mem, d, 1 << 20), seed, 1, {0, 0, 0}, NULL, NULL};
	tp_log *log = tp_log_new(&o);
	CHECK(!tp_log_load(log));
	uint64_t n, l, to;
	uint8_t sig[64];
	for (int i = 0; i < 10; i++) {
		tp_write w = put(i);
		tp_log_write(log, &w, &n, &l);
		if (i == 4) tp_log_run(log, tp_log_device(log), 1, &to, sig);
	}
	tp_log_run(log, tp_log_device(log), 6, &to, sig);
	tp_log_free(log);
	snprintf(f, sizeof f, "%s/log", d);
	size_t size = file_size(f);
	uint8_t *all = malloc(size);
	int fd = open(f, O_RDONLY);
	CHECK(read(fd, all, size) == (ssize_t)size);
	close(fd);
	size_t ends[64], steps[64], nends = 0, held = 0;
	for (size_t at = 0; at + 4 <= size;) {
		size_t len = (size_t)all[at] << 24 | (size_t)all[at + 1] << 16 | (size_t)all[at + 2] << 8 | all[at + 3];
		tp_steps t = {0};
		if (tp_is_run(all + at + 4, len) && !tp_record_unpack(&mem, all + at + 4, len, 1 << 20, &t))
			held += t.count;
		tp_steps_free(&mem, &t);
		at += 4 + len;
		ends[nends] = at, steps[nends++] = held;
	}
	int bad = 0;
	for (size_t cutat = 0; cutat <= size; cutat++) {
		snprintf(d, sizeof d, "%s/cut", dir);
		mkdir(d, 0777);
		snprintf(f, sizeof f, "%s/key", d);
		fd = open(f, O_WRONLY | O_CREAT | O_TRUNC, 0600);
		CHECK(write(fd, seed, 32) == 32);
		close(fd);
		snprintf(f, sizeof f, "%s/log", d);
		fd = open(f, O_WRONLY | O_CREAT | O_TRUNC, 0644);
		if (cutat) CHECK(write(fd, all, cutat) == (ssize_t)cutat);
		close(fd);
		size_t want = 0, wantsteps = 0;
		for (size_t i = 0; i < nends && ends[i] <= cutat; i++) want = ends[i], wantsteps = steps[i];
		o.store = tp_file_store(&mem, d, 1 << 20);
		log = tp_log_new(&o);
		int why = tp_log_load(log);
		const uint8_t *me = tp_log_device(log);
		uint64_t count = me ? tp_log_count(log, me) : 0, have = 0;
		if (tp_log_devices(log)) tp_log_have(log, 0, &have);
		size_t after = file_size(f);
		tp_write w = put(99);
		int wrote = tp_log_write(log, &w, &n, &l);
		tp_log_free(log);
		o.store = tp_file_store(&mem, d, 1 << 20);
		log = tp_log_new(&o);
		int again = tp_log_load(log);
		uint64_t count2 = tp_log_count(log, tp_log_device(log));
		tp_log_free(log);
		if (why || again || wrote || count != wantsteps || after != want || count2 != count + 1 || have != count) {
			if (bad++ < 5)
				printf("  cut at %zu: load %d, count %llu (want %zu), file %zu (want %zu), write %d, again %llu\n",
					cutat, why, (unsigned long long)count, wantsteps, after, want, wrote,
					(unsigned long long)count2);
		}
		wipe(d);
	}
	printf("  %zu cuts of a %zu-byte log (%zu frames): %d wrong\n", size + 1, size, nends, bad);
	CHECK(!bad);
	free(all);
	snprintf(d, sizeof d, "%s/whole", dir);
	wipe(d);
}

// ---- 5. 10,000 devices in one have

static void devices(void) {
	printf("5. many devices in one have\n");
	for (size_t many = 10000; many <= 40000; many *= 2) {
		tp_log *log = writer(5, 1, NULL);
		tp_sync_options so = {mem, log, 0, NULL, NULL, NULL, 0, 0};
		tp_sync *sync = tp_sync_new(&so);
		counter c = {0};
		tp_link *l = tp_sync_link(sync, count_send, &c, 0);
		size_t cap = 16 + many * 40;
		uint8_t *m = malloc(cap);
		tp_buf b = {m, 0, cap, cap, NULL, 0};
		tp_put_head(&b, 4, 2), tp_put_text(&b, "have"), tp_put_head(&b, 4, many);
		for (size_t i = 0; i < many; i++) {
			uint8_t d[32] = {0};
			memcpy(d, &i, sizeof i);
			d[31] = 1;
			tp_put_head(&b, 4, 2), tp_put_head(&b, 2, 32), tp_put(&b, d, 32), tp_put_head(&b, 0, 5);
		}
		size_t base = H.now;
		H.peak = H.now;
		double t = now();
		tp_sync_receive(sync, l, m, b.len);
		t = now() - t;
		printf("  %zu devices (%zu bytes): %.3f s, heap +%zu kept, sent %d\n", many, b.len, t, H.now - base, c.sent);
		free(m);
		tp_sync_free(sync);
		tp_log_free(log);
	}
}

// ---- 6. a take while a run is being closed

typedef struct {
	tp_log *log;
	run *runs;
	int nruns, armed;
	uint8_t seen[32];
} reenter;

static void told_take(void *ctx, const uint8_t device[32], uint64_t from, size_t count) {
	reenter *e = ctx;
	(void)from, (void)count;
	if (!e->armed) return;
	e->armed = 0;
	for (int i = 0; i < e->nruns; i++) tp_log_take(e->log, e->runs[i].device, e->runs[i].spans, e->runs[i].n, e->runs[i].sig, (tp_span){NULL, 0});
	memcpy(e->seen, device, 32);
}

typedef struct end {
	tp_sync *sync;
	tp_link *link;
	struct end *other;
	int fail_refused; // a "refused" sent here fails, once
} end;
static int deliver(void *ctx, const uint8_t *bytes, size_t n) {
	end *e = ctx;
	if (e->fail_refused && n > 9 && !memcmp(bytes + 2, "refused", 7)) return e->fail_refused = 0, e->link = NULL, -1;
	if (e->other && e->other->link) tp_sync_receive(e->other->sync, e->other->link, bytes, n);
	return 0;
}

static void closing(void) {
	printf("6. a take while a run is being closed\n");
	// a. The told of a write takes 4 new devices' runs, so the feeds grow under the device it was
	// told of.
	if (!getenv("NOA")) {
		static run runs[4];
		tp_log *ws[4];
		for (int i = 0; i < 4; i++) ws[i] = writer((uint8_t)(10 + i), 2, &runs[i]);
		reenter e = {NULL, runs, 4, 0, {0}};
		uint8_t seed[32];
		memset(seed, 6, 32);
		tp_log *log = memlog(seed, 1 << 20, told_take, &e);
		e.log = log;
		uint64_t n, l;
		tp_write w = put(1);
		e.armed = 1;
		tp_log_write(log, &w, &n, &l);
		CHECK(!memcmp(e.seen, tp_log_device(log), 32));
		CHECK(tp_log_devices(log) == 5);
		tp_log_free(log);
		for (int i = 0; i < 4; i++) tp_log_free(ws[i]);
	}
	{
		run r;
		tp_log *other = writer(20, 3, &r);
		uint8_t seed[32];
		memset(seed, 21, 32);
		tp_log *log = memlog(seed, 1 << 20, NULL, NULL);
		uint64_t n, l, to;
		uint8_t sig[64];
		for (int i = 0; i < 3; i++) {
			tp_write w = put(i);
			tp_log_write(log, &w, &n, &l);
		}
		CHECK(tp_log_take(log, r.device, r.spans, r.n, r.sig, (tp_span){NULL, 0}) == 3);
		CHECK(!tp_log_run(log, tp_log_device(log), 2, &to, sig) && to == 3);
		tp_write w = put(9);
		tp_log_write(log, &w, &n, &l);
		CHECK(!tp_log_run(log, tp_log_device(log), 2, &to, sig) && to == 3);
		CHECK(!tp_log_run(log, tp_log_device(log), 4, &to, sig) && to == 4);
		tp_log_free(other);
		tp_log_free(log);
	}
	{
		uint8_t seed[32];
		memset(seed, 22, 32);
		tp_log *probe = memlog(seed, 1 << 20, NULL, NULL);
		uint64_t n, l;
		tp_write w = put(1);
		tp_log_write(probe, &w, &n, &l);
		long len = tp_log_step(probe, tp_log_device(probe), 1, NULL, 0);
		tp_log_free(probe);
		size_t steps = 2048 / (size_t)len + 1;
		tp_log *log = memlog(seed, steps * (size_t)(len + 4) + 20, NULL, NULL);
		int why = 0;
		size_t i;
		for (i = 1; i <= steps && !why; i++) {
			w = put((int)i);
			why = tp_log_write(log, &w, &n, &l);
		}
		uint64_t count = tp_log_count(log, tp_log_device(log));
		printf("  run record full: write %zu says %s; steps held %llu\n", i - 1, tp_why(why),
			(unsigned long long)count);
		CHECK(!why || count == i - 2);
		tp_log_free(log);
	}
	{
		run r;
		tp_log *other = writer(23, 3, &r);
		uint8_t seed[32];
		memset(seed, 24, 32);
		tp_log *log = memlog(seed, r.spans[0].n + r.spans[1].n + 8 + 20, NULL, NULL);
		long got = tp_log_take(log, r.device, r.spans, r.n, r.sig, (tp_span){NULL, 0});
		uint64_t have = 0;
		const uint8_t *d = tp_log_devices(log) ? tp_log_have(log, 0, &have) : NULL;
		uint64_t count = tp_log_count(log, r.device);
		printf("  store full mid-take: take %s; have says %llu, %llu held\n", got < 0 ? tp_why((int)got) : "ok",
			(unsigned long long)have, (unsigned long long)count);
		CHECK(!d || have <= count);
		tp_log_free(other);
		tp_log_free(log);
	}
}

typedef struct {
	tp_sync *sync;
} box;
static void told_box(void *ctx, const uint8_t device[32], uint64_t from, size_t count) {
	box *b = ctx;
	if (b->sync) tp_sync_told(b->sync, device, from, count);
}

static void ring(int fail) {
	printf("6e. three syncs in a ring, delivering inside send%s\n", fail ? "; a refused that can't be sent" : "");
	box boxes[3] = {{0}};
	tp_log *logs[3];
	tp_sync *syncs[3];
	for (int i = 0; i < 3; i++) {
		uint8_t seed[32];
		memset(seed, (uint8_t)(30 + i), 32);
		logs[i] = memlog(seed, 1 << 20, told_box, &boxes[i]);
		tp_sync_options so = {mem, logs[i], 0, NULL, NULL, NULL, 0, 0};
		boxes[i].sync = syncs[i] = tp_sync_new(&so);
	}
	end e[6] = {{0}};
	int pair[3][2] = {{0, 1}, {1, 2}, {2, 0}};
	for (int k = 0; k < 3; k++) {
		end *x = &e[2 * k], *y = &e[2 * k + 1];
		x->sync = syncs[pair[k][0]], y->sync = syncs[pair[k][1]];
		x->other = y, y->other = x;
	}
	if (fail) e[5].fail_refused = 1;
	for (int k = 0; k < 6; k++) e[k].link = tp_sync_link(e[k].sync, deliver, &e[k], 0);
	uint64_t n, l;
	for (int i = 0; i < 20; i++) {
		tp_write w = put(i);
		tp_log_write(logs[i % 3], &w, &n, &l);
	}
	for (int i = 0; i < 3; i++) {
		for (int j = 0; j < 3; j++) {
			uint64_t c = tp_log_count(logs[i], tp_log_device(logs[j]));
			uint64_t want = (uint64_t)(20 / 3 + (j < 20 % 3));
			if (c != want) printf("  %c holds %llu of %c's, not %llu\n", 'a' + i, (unsigned long long)c, 'a' + j,
				(unsigned long long)want);
		}
	}
	printf("  links: a %zu, b %zu, c %zu\n", tp_sync_links(syncs[0]), tp_sync_links(syncs[1]),
		tp_sync_links(syncs[2]));
	for (int i = 0; i < 3; i++) tp_sync_free(syncs[i]), tp_log_free(logs[i]);
}

// ---- 7. a link whose send fails at once; a catch-up past the http outbox

static int fail_send(void *ctx, const uint8_t *b, size_t n) {
	(void)ctx, (void)b, (void)n;
	return -1;
}
static int http_send(void *ctx, const uint8_t *b, size_t n) { return tp_http_send(ctx, b, n); }

static void links(void) {
	printf("7. a link whose send fails at once\n");
	tp_log *log = writer(40, 1, NULL);
	tp_sync_options so = {mem, log, 0, NULL, NULL, NULL, 0, 0};
	tp_sync *sync = tp_sync_new(&so);
	tp_link *l = tp_sync_link(sync, fail_send, NULL, 0);
	printf("  tp_sync_link gave %s; links held %zu\n", l ? "a link" : "NULL", tp_sync_links(sync));
	if (l && getenv("UNLINK")) tp_sync_unlink(sync, l);
	CHECK(!l || tp_sync_links(sync) == 1);
	tp_sync_free(sync);
	tp_log_free(log);

	printf("7b. a catch-up of more than 1 MB over the http client\n");
	uint8_t seed[32];
	memset(seed, 41, 32);
	log = memlog(seed, 8 << 20, NULL, NULL);
	static uint8_t big[1100];
	size_t k = 0;
	memcpy(big, "\x81\xa2\x64path\x80\x65value\x59\x03\xe8", 17), k = 17;
	memset(big + k, 'x', 1000), k += 1000;
	uint64_t n, lam;
	for (int i = 0; i < 1500; i++) {
		big[17] = (uint8_t)('a' + i % 26);
		tp_write w = {{(const uint8_t *)"pig", 3}, {(const uint8_t *)"value", 5}, {big, k}, {NULL, 0}, 1, {NULL, 0}};
		CHECK(!tp_log_write(log, &w, &n, &lam));
	}
	so.log = log;
	sync = tp_sync_new(&so);
	tp_http h;
	tp_http_open(&h, &mem, "link-1", 0);
	l = tp_sync_link(sync, http_send, &h, 0);
	uint8_t m[] = {0x82, 0x64, 'h', 'a', 'v', 'e', 0x80};
	if (l) tp_sync_receive(sync, l, m, sizeof m);
	printf("  1500 steps of ~1 KB to a peer with none: links held %zu, http closed %d, %zu messages waiting\n",
		tp_sync_links(sync), h.closed, h.waiting);
	while (l && h.waiting) {
		const uint8_t *body;
		size_t count;
		tp_http_body(&h, &body, &count);
		tp_http_sent(&h, 200, count);
		if (h.bytes < TP_BODY / 2) tp_sync_go(sync, l);
	}
	printf("  answered: %llu messages sent, %zu waiting\n", (unsigned long long)h.sent, h.waiting);
	CHECK(l && h.sent == 1 + 750);
	tp_http_close(&h);
	tp_sync_free(sync);
	tp_log_free(log);
}

// ---- 8. where the C differed from the TypeScript

static int syncs;
static int count_sync(void *self) {
	(void)self;
	return syncs++ ? TP_STORE : 0;
}

typedef struct {
	int calls, runs;
} counting;
static int full_send(void *ctx, const uint8_t *b, size_t n) {
	counting *c = ctx;
	c->runs += n > 5 && !memcmp(b + 2, "run", 3);
	return c->calls++ ? 0 : 1;
}

typedef struct {
	tp_sync *sync;
	tp_link *link;
	int live;
} answering;
static int answer_send(void *ctx, const uint8_t *b, size_t n) {
	answering *a = ctx;
	if (n > 6 && !memcmp(b + 2, "live", 4)) tp_sync_receive(a->sync, a->link, (const uint8_t *)"\x82\x64have\x80", 7);
	return 0;
}
static int live_send(void *ctx, const uint8_t *b, size_t n) {
	answering *a = ctx;
	if (n > 6 && !memcmp(b + 2, "live", 4)) a->live = n == 18 && !memcmp(b + n - 2, "hi", 2);
	return 0;
}
static void ids(void *ctx, uint8_t *out, size_t n) {
	(void)ctx;
	for (size_t i = 0; i < n; i++) out[i] = (uint8_t)i;
}

typedef struct {
	pl *places;
	sc_scheduler *s;
	tb_table *table;
	pt_paths *paths;
	sc_scope *scope;
	sc_pair info;
	tp_log *log;
	tp_history *history;
	tp_sync *sync; // none, unless one is made
} dev;
static void dev_told(void *ctx, const uint8_t key[32], uint64_t from, size_t count) {
	dev *d = ctx;
	if (d->history) tp_history_told(d->history, key, from, count);
	if (d->sync) tp_sync_told(d->sync, key, from, count);
}
static int forgets;
static void inside(void *ctx, void (*f)(void *data), void *data) { sc_run_with_scope(((dev *)ctx)->scope, f, data); }
static void drop_value(void *value, void *data) {
	(void)data;
	op_free(value);
}
static int dev_make(dev *d, tp_store *store, uint8_t s) {
	memset(d, 0, sizeof *d);
	d->places = pl_new();
	d->s = sc_new((sc_options){.drop = drop_value});
	sc_on_tracking_end(d->s, pl_forget, d->places);
	d->table = tb_make(pl_event, d->places);
	d->paths = pt_new();
	pl_connect(d->places, &(pl_setup){.root = tb_string("R"), .table = d->table, .paths = d->paths, .scheduler = d->s});
	d->info = (sc_pair){"actor", op_str("test")};
	d->scope = sc_create_root_scope(d->s, &d->info, 1);
	uint8_t seed[32];
	memset(seed, s, 32);
	tp_log_options o = {mem, store, seed, 1, {0, 0, 0}, dev_told, d};
	d->log = tp_log_new(&o);
	tp_log_load(d->log);
	tp_history_options ho = {mem, d->log, d->table, d->places, NULL, inside, d, forgets, 0};
	d->history = tp_history_new(&ho);
	return tp_history_load(d->history);
}
static void dev_free(dev *d) {
	tp_sync_free(d->sync);
	tp_history_free(d->history), tp_log_free(d->log);
	sc_free(d->s), tb_free(d->table), pt_free(d->paths), pl_free(d->places);
	op_free((op_value *)d->info.value);
}
static int64_t field(dev *d, const char *k) {
	const nd_entry *e = tb_get(d->table, tb_string("value"), tb_string("doc"));
	int64_t n = -1;
	if (e && e->value && e->value->type == OP_MAP && op_get(e->value, k)) op_as_int64(op_get(e->value, k), &n);
	return n;
}
static size_t failures(dev *d) {
	tp_failed f;
	return tp_history_failed(d->history, 0, &f);
}

static const uint8_t x0[] = {0x81, 0xa2, 0x64, 'p', 'a', 't', 'h', 0x80, 0x65, 'v', 'a', 'l', 'u', 'e', 0xa1, 0x61, 'x', 0};
static const uint8_t x1[] = {0x81, 0xa2, 0x64, 'p', 'a', 't', 'h', 0x81, 0x61, 'x', 0x65, 'v', 'a', 'l', 'u', 'e', 1};
static const uint8_t y1[] = {0x81, 0xa2, 0x64, 'p', 'a', 't', 'h', 0x81, 0x61, 'y', 0x65, 'v', 'a', 'l', 'u', 'e', 1};
static void edit(tp_log *log, const uint8_t *p, size_t n) {
	tp_write w = {{(const uint8_t *)"doc", 3}, {(const uint8_t *)"value", 5}, {p, n}, {NULL, 0}, 1, {NULL, 0}};
	uint64_t s, l;
	tp_log_write(log, &w, &s, &l);
}

static uint64_t forget;
static long (*held)(void *self, const uint8_t device[32], uint64_t n, uint8_t *out, size_t cap);
static long forgetful(void *self, const uint8_t device[32], uint64_t n, uint8_t *out, size_t cap) {
	return n <= forget ? -1 : held(self, device, n, out, cap);
}
static void kept_open(void *self) { (void)self; }

static void typescript(const char *dir) {
	printf("8. where the C differed from the TypeScript\n");
	uint64_t to;
	uint8_t sig[64];
	{
		uint8_t seed[32];
		memset(seed, 50, 32);
		tp_store *st = tp_memory_store(&mem, 1 << 20);
		st->sync = count_sync;
		tp_log_options o = {mem, st, seed, 1, {0, 0, 0}, NULL, NULL};
		tp_log *log = tp_log_new(&o);
		tp_log_load(log);
		edit(log, x0, sizeof x0);
		syncs = 0;
		int first = tp_log_run(log, tp_log_device(log), 1, &to, sig);
		int second = tp_log_run(log, tp_log_device(log), 1, &to, sig);
		printf("  syncs %d; a run after a failed sync: %s\n", syncs, second ? "none" : "sent");
		CHECK(!first && syncs == 2 && second == 1);
		tp_log_free(log);
		char path[512];
		snprintf(path, sizeof path, "%s/synced", dir);
		log = tp_log_new(&(tp_log_options){mem, tp_file_store(&mem, path, 1 << 20), seed, 1, {0, 0, 0}, NULL, NULL});
		CHECK(!tp_log_load(log));
		edit(log, x0, sizeof x0);
		CHECK(!tp_log_run(log, tp_log_device(log), 1, &to, sig));
		tp_log_free(log);
		snprintf(path, sizeof path, "%s/synced", dir), wipe(path);
	}
	{
		run r1, r2;
		tp_log *d = writer(51, 3, &r1);
		uint64_t n, l;
		for (int i = 3; i < 5; i++) {
			tp_write w = put(i);
			tp_log_write(d, &w, &n, &l);
		}
		run_of(d, 4, &r2);
		uint8_t seed[32];
		memset(seed, 52, 32);
		tp_log *log = memlog(seed, 1 << 20, NULL, NULL);
		tp_log_take(log, r1.device, r1.spans, r1.n, r1.sig, (tp_span){NULL, 0}), tp_log_take(log, r2.device, r2.spans, r2.n, r2.sig, (tp_span){NULL, 0});
		tp_sync_options so = {mem, log, 0, NULL, NULL, NULL, 0, 0};
		tp_sync *sync = tp_sync_new(&so);
		counting c = {0, 0};
		tp_link *link = tp_sync_link(sync, full_send, &c, 0);
		tp_sync_receive(sync, link, (const uint8_t *)"\x82\x64have\x80", 7);
		tp_span pack;
		tp_pack(&mem, r1.spans, r1.n, 1 << 20, &pack);
		static uint8_t m[1 << 16];
		tp_buf b = {m, 0, sizeof m, sizeof m, NULL, 0};
		tp_put_head(&b, 4, 4), tp_put_text(&b, "run");
		tp_put_head(&b, 2, 32), tp_put(&b, r1.device, 32), tp_put_head(&b, 2, 64), tp_put(&b, r1.sig, 64);
		tp_put(&b, pack.p, pack.n);
		tp_span_free(&mem, &pack);
		tp_sync_receive(sync, link, m, b.len);
		tp_sync_go(sync, link);
		printf("  runs sent after they sent 1 to 3 of 5: %d\n", c.runs);
		CHECK(c.runs == 1);
		tp_sync_free(sync);
		tp_log_free(log), tp_log_free(d);
	}
	{
		tp_log *log = writer(53, 1, NULL);
		tp_sync_options so = {mem, log, 0, NULL, ids, NULL, 0, 0};
		tp_sync *sync = tp_sync_new(&so);
		answering a = {sync, NULL, 0}, b = {sync, NULL, 0};
		a.link = tp_sync_link(sync, answer_send, &a, 0);
		b.link = tp_sync_link(sync, live_send, &b, 0);
		CHECK(!tp_sync_live(sync, (const uint8_t *)"hi", 2));
		printf("  the second link got the live: %s\n", b.live ? "yes" : "no");
		CHECK(b.live);
		tp_sync_free(sync);
		tp_log_free(log);
	}
	{
		run ra, rb;
		tp_log *a = writer(54, 0, NULL), *b = writer(55, 0, NULL);
		edit(a, x0, sizeof x0), run_of(a, 1, &ra);
		tp_log_take(b, ra.device, ra.spans, ra.n, ra.sig, (tp_span){NULL, 0});
		edit(b, y1, sizeof y1), run_of(b, 1, &rb);
		dev r;
		dev_make(&r, tp_memory_store(&mem, 1 << 20), 56);
		tp_log_take(r.log, rb.device, rb.spans, rb.n, rb.sig, (tp_span){NULL, 0});
		size_t before = failures(&r);
		tp_log_take(r.log, ra.device, ra.spans, ra.n, ra.sig, (tp_span){NULL, 0});
		printf("  failed: %zu, then %zu after the redo; doc {x: %lld, y: %lld}\n", before, failures(&r),
			(long long)field(&r, "x"), (long long)field(&r, "y"));
		CHECK(before == 1 && failures(&r) == 0 && field(&r, "x") == 0 && field(&r, "y") == 1);
		dev_free(&r);
		tp_log_free(a), tp_log_free(b);
	}
	{
		run r1, r2;
		tp_log *w = writer(57, 0, NULL);
		edit(w, x0, sizeof x0), edit(w, x1, sizeof x1), run_of(w, 1, &r1);
		tp_store *st = tp_memory_store(&mem, 1 << 20);
		void (*shut)(void *self) = st->close;
		held = st->get, st->get = forgetful, st->close = kept_open;
		dev r;
		dev_make(&r, st, 58);
		tp_log_take(r.log, r1.device, r1.spans, r1.n, r1.sig, (tp_span){NULL, 0});
		CHECK(!tp_history_snapshot(r.history));
		edit(w, y1, sizeof y1), run_of(w, 3, &r2);
		tp_log_take(r.log, r2.device, r2.spans, r2.n, r2.sig, (tp_span){NULL, 0});
		dev_free(&r);
		forget = 2;
		int why = dev_make(&r, st, 58);
		printf("  loaded: %s; %zu failed; doc {x: %lld, y: %lld}\n", why ? tp_why(why) : "ok", failures(&r),
			(long long)field(&r, "x"), (long long)field(&r, "y"));
		CHECK(!why && failures(&r) == 0 && field(&r, "x") == 1 && field(&r, "y") == 1);
		dev_free(&r);
		forget = 0;
		shut(st->self);
		tp_log_free(w);
	}
}

// ---- 9. forgetting (history.h, a try-out)

static void join(end e[2], tp_sync *a, tp_sync *b) {
	e[0] = (end){a, NULL, &e[1], 0}, e[1] = (end){b, NULL, &e[0], 0};
	e[0].link = tp_sync_link(a, deliver, &e[0], 0);
	e[1].link = tp_sync_link(b, deliver, &e[1], 0);
}
static void part(end e[2]) {
	tp_sync_unlink(e[0].sync, e[0].link), tp_sync_unlink(e[1].sync, e[1].link);
}
static tp_sync *sync_of(tp_log *log) {
	tp_sync_options so = {mem, log, 0, NULL, NULL, NULL, 0, 0};
	return tp_sync_new(&so);
}

static void forgetting(const char *dir) {
	printf("9. forgetting (a try-out)\n");
	char d[512];
	snprintf(d, sizeof d, "%s/forgets", dir);
	uint64_t to, n, l;
	uint8_t sig[64];
	{
		box b = {NULL};
		uint8_t seed[32];
		memset(seed, 60, 32);
		tp_log *w = memlog(seed, 1 << 20, told_box, &b);
		b.sync = sync_of(w);
		dev r;
		forgets = 1;
		dev_make(&r, tp_file_store(&mem, d, 1 << 20), 61);
		r.sync = sync_of(r.log);
		end e[2];
		join(e, r.sync, b.sync);
		for (int i = 0; i < 40; i++) edit(w, i ? x1 : x0, i ? sizeof x1 : sizeof x0);
		const uint8_t *wd = tp_log_device(w);
		CHECK(tp_log_count(r.log, wd) == 40 && field(&r, "x") == 1);
		CHECK(!tp_history_forget(r.history, r.sync));
		uint64_t have;
		tp_log_have(r.log, 0, &have);
		int one = tp_log_run(r.log, wd, 1, &to, sig), forty = tp_log_run(r.log, wd, 40, &to, sig);
		printf("  40 steps taken, forgotten: have %llu, run 1 %s, run 40 %s\n", (unsigned long long)have,
			one ? "none" : "held", forty ? "none" : "held");
		CHECK(have == 40 && one && forty);
		part(e);
		dev_free(&r);
		dev_make(&r, tp_file_store(&mem, d, 1 << 20), 61);
		CHECK(tp_log_count(r.log, wd) == 40 && tp_log_run(r.log, wd, 1, &to, sig) && field(&r, "x") == 1);
		r.sync = sync_of(r.log);
		join(e, r.sync, b.sync);
		edit(w, y1, sizeof y1);
		printf("  loaded again: %llu held, doc {x: %lld, y: %lld}\n", (unsigned long long)tp_log_count(r.log, wd),
			(long long)field(&r, "x"), (long long)field(&r, "y"));
		CHECK(tp_log_count(r.log, wd) == 41 && field(&r, "y") == 1);
		part(e);
		dev_free(&r);
		tp_sync_free(b.sync), tp_log_free(w);
		wipe(d);
	}
	{
		box b = {NULL};
		uint8_t seed[32];
		memset(seed, 62, 32);
		tp_log *k = memlog(seed, 1 << 20, told_box, &b);
		b.sync = sync_of(k);
		dev r;
		dev_make(&r, tp_memory_store(&mem, 1 << 20), 63);
		r.sync = sync_of(r.log);
		end e[2];
		join(e, r.sync, b.sync);
		tp_sync_keeper(r.sync, e[0].link);
		for (int i = 0; i < 3; i++) {
			tp_write w = put(i);
			tp_log_write(r.log, &w, &n, &l);
		}
		const uint8_t *me = tp_log_device(r.log);
		CHECK(tp_log_count(k, me) == 3);
		tp_history_forget(r.history, r.sync);
		int before = tp_log_run(r.log, me, 1, &to, sig);
		part(e);
		join(e, r.sync, b.sync);
		tp_sync_keeper(r.sync, e[0].link);
		tp_history_forget(r.history, r.sync);
		int after = tp_log_run(r.log, me, 1, &to, sig);
		printf("  own steps: before the keeper said %s, after %s\n", before ? "gone" : "held", after ? "gone" : "held");
		CHECK(!before && after);
		part(e);
		dev_free(&r);
		tp_sync_free(b.sync), tp_log_free(k);
	}
	{
		run r1, r2, r3;
		tp_log *w1 = writer(64, 0, NULL), *w2 = writer(65, 0, NULL);
		edit(w1, x0, sizeof x0), run_of(w1, 1, &r1);
		tp_log_take(w2, r1.device, r1.spans, r1.n, r1.sig, (tp_span){NULL, 0});
		for (int i = 0; i < 3; i++) {
			tp_write w = put(i);
			tp_log_write(w2, &w, &n, &l);
		}
		edit(w2, y1, sizeof y1), run_of(w2, 1, &r2);
		edit(w1, x1, sizeof x1), run_of(w1, 2, &r3);
		dev v[2];
		for (int i = 0; i < 2; i++) {
			forgets = !i;
			dev_make(&v[i], tp_memory_store(&mem, 1 << 20), (uint8_t)(66 + i));
			tp_log_take(v[i].log, r1.device, r1.spans, r1.n, r1.sig, (tp_span){NULL, 0});
			tp_log_take(v[i].log, r2.device, r2.spans, r2.n, r2.sig, (tp_span){NULL, 0});
			tp_log_take(v[i].log, r3.device, r3.spans, r3.n, r3.sig, (tp_span){NULL, 0});
		}
		printf("  forgetting doc {x: %lld, y: %lld}, keeping {x: %lld, y: %lld}\n", (long long)field(&v[0], "x"),
			(long long)field(&v[0], "y"), (long long)field(&v[1], "x"), (long long)field(&v[1], "y"));
		CHECK(field(&v[0], "x") == 0 && field(&v[0], "y") == 1 && failures(&v[0]) == 0);
		CHECK(field(&v[1], "x") == 1 && field(&v[1], "y") == 1);
		dev_free(&v[0]), dev_free(&v[1]);
		tp_log_free(w1), tp_log_free(w2);
		forgets = 0;
	}
}

// ---- 10. a late step: each entry keeps its frontier, the rest walked back through the log

static void take_all(tp_log *to, tp_log *w) {
	static run r;
	const uint8_t *d = tp_log_device(w);
	while (tp_log_count(to, d) < tp_log_count(w, d)) {
		if (run_of(w, tp_log_count(to, d) + 1, &r)) break;
		if (tp_log_take(to, r.device, r.spans, r.n, r.sig, (tp_span){NULL, 0}) <= 0) break;
	}
}
static int failed_is(dev *d, size_t i, tp_log *device, uint64_t n) {
	tp_failed f;
	return tp_history_failed(d->history, 0, &f) > i && (tp_history_failed(d->history, i, &f), 1) && f.device &&
		!memcmp(f.device, tp_log_device(device), 32) && f.n == n;
}
static uint64_t listed(const uint8_t *b, size_t n, const char *node) {
	tp_in in = {b, b + n};
	tp_span t;
	uint64_t k, entries, four, steps;
	if (tp_map(&in, &k) || tp_text(&in, &t) || tp_skip(&in, NULL) || tp_text(&in, &t) || tp_array(&in, &entries))
		return 0;
	for (uint64_t i = 0; i < entries; i++) {
		tp_span part, name;
		if (tp_array(&in, &four) || tp_text(&in, &part) || tp_text(&in, &name) || tp_skip(&in, NULL) ||
			tp_array(&in, &steps))
			return 0;
		if (tp_is(part, "value") && tp_is(name, node)) return steps;
		for (uint64_t j = 0; j < steps; j++) tp_skip(&in, NULL);
	}
	return 0;
}

static void late(void) {
	printf("10. a late step, walked back through the log; an old snapshot\n");
	uint64_t n, l;
	{
		tp_log *a = writer(80, 0, NULL), *b = writer(81, 0, NULL);
		edit(a, x0, sizeof x0);
		take_all(b, a);
		edit(b, y1, sizeof y1);
		for (int i = 0; i < 20; i++) {
			tp_write w = put(i);
			tp_log_write(a, &w, &n, &l);
		}
		edit(a, x1, sizeof x1);
		dev r;
		dev_make(&r, tp_memory_store(&mem, 1 << 20), 82);
		take_all(r.log, a), take_all(r.log, b);
		printf("  a's 22 steps, then b's late one: doc {x: %lld, y: %lld}, %zu failed\n", (long long)field(&r, "x"),
			(long long)field(&r, "y"), failures(&r));
		CHECK(field(&r, "x") == 1 && field(&r, "y") == 1 && failures(&r) == 0);
		dev_free(&r);
		tp_log_free(a), tp_log_free(b);
	}
	{
		tp_log *a = writer(83, 1, NULL), *b = writer(84, 0, NULL);
		edit(a, x0, sizeof x0), edit(b, y1, sizeof y1);
		dev r;
		dev_make(&r, tp_memory_store(&mem, 1 << 20), 85);
		take_all(r.log, a), take_all(r.log, b);
		printf("  before the only whole put: doc {x: %lld, y: %lld}, %zu failed\n", (long long)field(&r, "x"),
			(long long)field(&r, "y"), failures(&r));
		CHECK(field(&r, "x") == 0 && field(&r, "y") == -1 && failures(&r) == 1 && failed_is(&r, 0, b, 1));
		dev_free(&r);
		tp_log_free(a), tp_log_free(b);
	}
	for (int old = 0; old < 2; old++) {
		tp_log *a = writer((uint8_t)(86 + 3 * old), 0, NULL), *b = writer((uint8_t)(87 + 3 * old), 0, NULL);
		edit(a, y1, sizeof y1), edit(a, x0, sizeof x0);
		take_all(b, a);
		tp_write w = put(0);
		tp_log_write(a, &w, &n, &l);
		edit(a, x1, sizeof x1), edit(b, y1, sizeof y1);
		tp_store *st = tp_memory_store(&mem, 1 << 20);
		void (*shut)(void *self) = st->close;
		st->close = kept_open;
		dev r;
		dev_make(&r, st, (uint8_t)(88 + 3 * old));
		take_all(r.log, a);
		size_t before = failures(&r);
		uint8_t snap[1024];
		size_t length = 0;
		if (!old) CHECK(!tp_history_snapshot(r.history));
		else {
			char hex[64];
			tp_hex(hex, tp_log_device(a), 32);
			tp_buf o = {snap, 0, sizeof snap, sizeof snap, NULL, 0};
			tp_put_head(&o, 5, 2), tp_put_text(&o, "count"), tp_put_head(&o, 5, 1);
			tp_put_head(&o, 3, 64), tp_put(&o, hex, 64), tp_put_head(&o, 0, 4);
			tp_put_text(&o, "entries"), tp_put_head(&o, 4, 2);
			tp_put_head(&o, 4, 4), tp_put_text(&o, "value"), tp_put_text(&o, "doc");
			tp_put(&o, "\xa1\x61x\x01", 4);
			tp_put_head(&o, 4, 3);
			for (uint64_t k = 1; k <= 4; k += 1 + (k == 2)) {
				tp_put_head(&o, 4, 3), tp_put_head(&o, 0, k), tp_put_head(&o, 3, 64), tp_put(&o, hex, 64);
				tp_put_head(&o, 0, k);
			}
			tp_put_head(&o, 4, 4), tp_put_text(&o, "value"), tp_put_text(&o, "pig"), tp_put_head(&o, 0, 0);
			tp_put_head(&o, 4, 1), tp_put_head(&o, 4, 3), tp_put_head(&o, 0, 3), tp_put_head(&o, 3, 64);
			tp_put(&o, hex, 64), tp_put_head(&o, 0, 3);
			length = o.len;
			CHECK(!tp_log_snapshot(r.log, snap, length));
		}
		dev_free(&r);
		int why = dev_make(&r, st, (uint8_t)(88 + 3 * old));
		size_t again = failures(&r);
		take_all(r.log, b);
		printf("  %s snapshot: loaded %s, failed %zu, %zu after the restart, %zu after b's late step; "
			"doc {x: %lld, y: %lld}\n", old ? "an old" : "a", why ? tp_why(why) : "ok", before, again, failures(&r), (long long)field(&r, "x"),
			(long long)field(&r, "y"));
		CHECK(!why && before == 1 && again == 0 && failures(&r) == 1 && failed_is(&r, 0, a, 1));
		CHECK(field(&r, "x") == 1 && field(&r, "y") == 1);
		CHECK(!tp_history_snapshot(r.history));
		long got = tp_log_snapped(r.log, NULL, 0);
		uint8_t *bytes = got > 0 ? malloc((size_t)got) : NULL;
		if (bytes) tp_log_snapped(r.log, bytes, (size_t)got);
		uint64_t steps = bytes ? listed(bytes, (size_t)got, "doc") : 0;
		printf("    snapshot again: doc's steps listed %llu (of 4)\n", (unsigned long long)steps);
		CHECK(steps == 2);
		free(bytes);
		dev_free(&r);
		shut(st->self);
		tp_log_free(a), tp_log_free(b);
	}
}

// ---- h. heads, through a snapshot (history.h)

static void apart(tp_log *log, uint8_t v) {
	uint8_t p[sizeof x0];
	memcpy(p, x0, sizeof p), p[sizeof p - 1] = v;
	tp_write w = {{(const uint8_t *)"doc", 3}, {(const uint8_t *)"value", 5}, {p, sizeof p}, {NULL, 0}, 1,
		{(const uint8_t *)"\x80", 1}};
	uint64_t s, l;
	tp_log_write(log, &w, &s, &l);
}
static size_t xs(dev *d, int64_t out[TP_VERSIONS]) {
	tp_version v[TP_VERSIONS];
	size_t n = tp_history_versions(d->history, "doc", "value", v);
	for (size_t i = 0; i < n; i++) {
		out[i] = -1;
		if (v[i].value && op_get(v[i].value, "x")) op_as_int64(op_get(v[i].value, "x"), &out[i]);
		op_free(v[i].value);
	}
	return n;
}

static void heads(void) {
	printf("h. heads through a snapshot\n");
	run ra, rb;
	tp_log *a = writer(60, 0, NULL), *b = writer(61, 0, NULL);
	apart(a, 1), run_of(a, 1, &ra);
	apart(b, 2), run_of(b, 1, &rb);
	tp_store *st = tp_memory_store(&mem, 1 << 20);
	void (*shut)(void *self) = st->close;
	st->close = kept_open;
	dev r;
	dev_make(&r, st, 62);
	tp_log_take(r.log, ra.device, ra.spans, ra.n, ra.sig, (tp_span){NULL, 0});
	tp_log_take(r.log, rb.device, rb.spans, rb.n, rb.sig, (tp_span){NULL, 0});
	int64_t was[TP_VERSIONS], now[TP_VERSIONS];
	size_t n = xs(&r, was);
	CHECK(!tp_history_snapshot(r.history));
	dev_free(&r);
	int why = dev_make(&r, st, 62);
	size_t m = xs(&r, now);
	printf("  versions %zu (x %lld, %lld), loaded again %zu (x %lld, %lld)\n", n, (long long)was[0],
		(long long)was[1], m, (long long)now[0], (long long)now[1]);
	CHECK(!why && n == 2 && m == 2 && was[0] == now[0] && was[1] == now[1] && was[0] != was[1]);
	dev_free(&r);
	shut(st->self);
	tp_log_free(a), tp_log_free(b);
}


static char actors[2][80];
static int acted;
static void actor_seen(const pl_fact *f, void *ctx) {
	(void)ctx;
	const op_value *a = f->change ? f->change->actor : NULL;
	if (acted < 2) snprintf(actors[acted++], sizeof actors[0], "%s", a && a->type == OP_STR ? a->str : "(not a string)");
}

static void actor(void) {
	printf("a. a landed step's actor\n");
	tp_log *a = writer(70, 0, NULL);
	uint8_t p[sizeof x0];
	memcpy(p, x0, sizeof p);
	tp_write w = {{(const uint8_t *)"doc", 3}, {(const uint8_t *)"value", 5}, {p, sizeof p}, {NULL, 0}, 1, {(const uint8_t *)"\x80", 1}};
	uint64_t n, l;
	tp_log_write(a, &w, &n, &l);
	w.who = (tp_span){(const uint8_t *)"juno", 4};
	tp_log_write(a, &w, &n, &l);
	run run_a;
	run_of(a, 1, &run_a);
	dev r;
	dev_make(&r, tp_memory_store(&mem, 1 << 20), 71);
	pl_watch *watch = pl_watch_all(r.places, actor_seen, NULL);
	acted = 0;
	tp_log_take(r.log, run_a.device, run_a.spans, run_a.n, run_a.sig, (tp_span){NULL, 0});
	char hex[65];
	tp_hex(hex, run_a.device, 32), hex[64] = 0;
	printf("  actors: %s, %s\n", actors[0], actors[1]);
	CHECK(acted == 2 && !strcmp(actors[0], hex) && !strcmp(actors[1], "juno"));
	pl_stop(watch);
	dev_free(&r);
	tp_log_free(a);
}


static void long_run(const char *dir) {
	printf("a run longer than one step's limit comes back after a restart\n");
	char d[512];
	uint8_t seed[32];
	memset(seed, 7, 32);
	snprintf(d, sizeof d, "%s/long", dir);
	tp_log_options o = {mem, tp_file_store(&mem, d, 1 << 20), seed, 1, {0, 0, 1000}, NULL, NULL};
	tp_log *log = tp_log_new(&o);
	CHECK(!tp_log_load(log));
	uint64_t n, l, to;
	uint8_t sig[64];
	for (int i = 0; i < 20; i++) {
		tp_write w = put(i);
		CHECK(!tp_log_write(log, &w, &n, &l));
	}
	CHECK(!tp_log_run(log, tp_log_device(log), 1, &to, sig) && to == 20);
	tp_log_free(log);
	o.store = tp_file_store(&mem, d, 1 << 20);
	log = tp_log_new(&o);
	CHECK(!tp_log_load(log));
	CHECK(tp_log_count(log, tp_log_device(log)) == 20);
	tp_log_free(log);
	wipe(d);
}

int main(int argc, char **argv) {
	if (argc != 2) return fprintf(stderr, "usage: check-c-review dir\n"), 2;
	setvbuf(stdout, NULL, _IONBF, 0);
	mkdir(argv[1], 0777);
	const char *only = getenv("ONLY");
	if (!only || strchr(only, '1')) claims(), printf("  heap now %zu\n", H.now);
	if (!only || strchr(only, '2')) key33(), printf("  heap now %zu\n", H.now);
	if (!only || strchr(only, '3')) columns(), printf("  heap now %zu\n", H.now);
	if (!only || strchr(only, '4')) cut(argv[1]), printf("  heap now %zu\n", H.now);
	if (!only || strchr(only, '5')) devices(), printf("  heap now %zu\n", H.now);
	if (!only || strchr(only, '6')) closing(), printf("  heap now %zu\n", H.now);
	if (!only || strchr(only, 'r')) ring(0), printf("  heap now %zu\n", H.now);
	if (!only || strchr(only, 'f')) ring(1), printf("  heap now %zu\n", H.now);
	if (!only || strchr(only, '7')) links(), printf("  heap now %zu\n", H.now);
	if (!only || strchr(only, '8')) typescript(argv[1]), printf("  heap now %zu\n", H.now);
	if (!only || strchr(only, '9')) forgetting(argv[1]), printf("  heap now %zu\n", H.now);
	if (!only || strchr(only, 'l')) late(), printf("  heap now %zu\n", H.now);
	if (!only || strchr(only, 'h')) heads(), printf("  heap now %zu\n", H.now);
	if (!only || strchr(only, 'a')) actor(), printf("  heap now %zu\n", H.now);
	if (!only || strchr(only, 'm')) long_run(argv[1]), printf("  heap now %zu\n", H.now);
	rmdir(argv[1]);
	CHECK(H.now == 0);
	printf("check-c-review: %s, %d failed\n", failed ? "FAIL" : "ok", failed);
	return failed ? 1 : 0;
}
