// tippet-test: the file store, as a log uses it. a writer's steps and signatures saved and loaded
// again; a relay's; a frame cut short by a crash cut off; a store with another key refused.
//   ./tippet-test dir     dir: made, used, and removed again
#define _POSIX_C_SOURCE 200809L
#include <dirent.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "tippet.h"

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

static int failed;
#define CHECK(x) \
	do { \
		if (!(x)) fprintf(stderr, "tippet-test: %s:%d: %s\n", __FILE__, __LINE__, #x), failed++; \
	} while (0)

static tp_log *open_log(const tp_mem *mem, const char *dir, const uint8_t *seed) {
	tp_log_options o = {*mem, tp_file_store(mem, dir, 1 << 20), seed, 1, {0, 0, 0}, NULL, NULL};
	if (!o.store) return NULL;
	tp_log *log = tp_log_new(&o);
	if (!log) return o.store->close(o.store->self), NULL;
	return log;
}

// every file in dir, then dir
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

// steps as they were written: STEPS of them, back to back
#define STEPS 300
static uint8_t kept[STEPS][128];
static long lengths[STEPS];

// how many of device's steps 1 to count are not as kept
static int unlike(tp_log *log, const uint8_t device[32], uint64_t count) {
	int bad = 0;
	uint8_t b[128];
	for (uint64_t n = 1; n <= count; n++) {
		long l = tp_log_step(log, device, n, b, sizeof b);
		bad += l != lengths[n - 1] || memcmp(b, kept[n - 1], (size_t)l);
	}
	return bad;
}

static void cut(const char *dir, const char *name, off_t to) {
	char path[4096];
	snprintf(path, sizeof path, "%s/%s", dir, name);
	CHECK(!truncate(path, to));
}
static off_t size_of(const char *dir, const char *name) {
	char path[4096];
	struct stat st;
	snprintf(path, sizeof path, "%s/%s", dir, name);
	return stat(path, &st) ? -1 : st.st_size;
}

static long patches(uint8_t *out, int x) {
	// [{path: [], value: x}]
	uint8_t p[] = {0x81, 0xa2, 0x64, 'p', 'a', 't', 'h', 0x80, 0x65, 'v', 'a', 'l', 'u', 'e', (uint8_t)x};
	memcpy(out, p, sizeof p);
	return sizeof p;
}

int main(int argc, char **argv) {
	if (argc != 2) return fprintf(stderr, "usage: tippet-test dir\n"), 2;
	const char *dir = argv[1];
	heap h = {0, 0};
	tp_mem mem = {counted, &h};
	uint8_t seed[32], other[32], ps[16], to[64];
	memset(seed, 1, 32), memset(other, 2, 32);
	uint64_t n, lamport, end, end2;
	uint8_t sig[64], sig2[64];

	// a writer: 40 steps of 101 bytes, a run closed at 2048 bytes (21), the rest when asked for
	tp_log *a = open_log(&mem, dir, seed);
	CHECK(a && !tp_log_load(a));
	tp_write w = {{(const uint8_t *)"pig", 3}, {(const uint8_t *)"value", 5}, {ps, 0}, {NULL, 0}, 1760000000};
	for (int i = 1; i <= 40; i++) {
		w.patches.n = (size_t)patches(ps, i % 24);
		CHECK(!tp_log_write(a, &w, &n, &lamport) && n == (uint64_t)i && lamport == (uint64_t)i);
	}
	CHECK(!tp_log_run(a, tp_log_device(a), 1, &end, sig) && end == 21);
	CHECK(!tp_log_run(a, tp_log_device(a), 22, &end2, sig2) && end2 == 40);
	uint8_t device[32];
	memcpy(device, tp_log_device(a), 32);
	tp_log_free(a);

	// loaded again: every step, both signatures, lamport
	a = open_log(&mem, dir, seed);
	CHECK(a && !tp_log_load(a));
	CHECK(tp_log_count(a, device) == 40 && tp_log_lamport(a) == 40);
	CHECK(!tp_log_run(a, device, 2, &end, to) && end == 21 && !memcmp(to, sig, 64));
	CHECK(!tp_log_run(a, device, 40, &end, to) && end == 40 && !memcmp(to, sig2, 64));
	w.patches.n = (size_t)patches(ps, 7);
	CHECK(!tp_log_write(a, &w, &n, &lamport) && n == 41 && lamport == 41);
	tp_log_free(a);

	// a crash mid-frame: the frame cut off, the rest as it was
	char path[4096];
	snprintf(path, sizeof path, "%s/log", dir);
	int fd = open(path, O_WRONLY | O_APPEND);
	CHECK(fd >= 0 && write(fd, "\0\0\0\x64partial", 11) == 11);
	close(fd);
	a = open_log(&mem, dir, seed);
	CHECK(a && !tp_log_load(a) && tp_log_count(a, device) == 41);
	CHECK(!tp_log_write(a, &w, &n, &lamport) && n == 42);
	tp_log_free(a);
	a = open_log(&mem, dir, seed);
	CHECK(a && !tp_log_load(a) && tp_log_count(a, device) == 42);

	// a relay in a store of its own: a run taken, loaded again, vouched for
	char relaydir[4096];
	snprintf(relaydir, sizeof relaydir, "%s/relay", dir);
	tp_log *r = open_log(&mem, relaydir, NULL);
	CHECK(r && !tp_log_load(r) && !tp_log_device(r));
	tp_span steps[21];
	uint8_t bytes[21][128];
	CHECK(!tp_log_run(a, device, 1, &end, sig) && end == 21);
	for (int i = 0; i < 21; i++) {
		long length = tp_log_step(a, device, (uint64_t)i + 1, bytes[i], sizeof bytes[i]);
		CHECK(length > 0 && length <= 128);
		steps[i] = (tp_span){bytes[i], (size_t)length};
	}
	CHECK(tp_log_take(r, device, steps, 21, sig, (tp_span){NULL, 0}) == 21);
	CHECK(tp_log_take(r, device, steps, 21, sig, (tp_span){NULL, 0}) == 0);
	tp_log_free(r);
	r = open_log(&mem, relaydir, NULL);
	CHECK(r && !tp_log_load(r) && tp_log_count(r, device) == 21 && tp_log_devices(r) == 1);
	uint64_t have = 0;
	CHECK(tp_log_have(r, 0, &have) && have == 21);
	tp_log_free(r);
	tp_log_free(a);

	// another seed, strictly: refused
	a = open_log(&mem, dir, other);
	CHECK(a && tp_log_load(a) == TP_KEY);
	tp_log_free(a);

	// the index on disk: a run closed at each step (as each ask closes one), the heap no more at the
	// end than early on; then the index let go (an old store), cut short and wrong (a reset in the
	// middle of writing it), and longer than the log (the log's end cut off): each made right again
	// as the log loads, every step found as written
	char indexdir[4096];
	snprintf(indexdir, sizeof indexdir, "%s/indexed", dir);
	a = open_log(&mem, indexdir, other);
	CHECK(a && !tp_log_load(a));
	size_t early = 0;
	for (int i = 1; i <= STEPS; i++) {
		w.patches.n = (size_t)patches(ps, i % 24);
		CHECK(!tp_log_write(a, &w, &n, &lamport) && n == (uint64_t)i);
		CHECK(!tp_log_run(a, tp_log_device(a), n, &end, sig) && end == n);
		lengths[i - 1] = tp_log_step(a, tp_log_device(a), n, kept[i - 1], sizeof kept[i - 1]);
		if (i == 50) early = h.now;
	}
	printf("tippet-test: %d runs of a step each: heap %zu after 50, %zu after %d\n", STEPS, early, h.now, STEPS);
	CHECK(h.now <= early);
	memcpy(device, tp_log_device(a), 32);
	tp_log_free(a);
	CHECK(size_of(indexdir, "i0") == STEPS * 16 && size_of(indexdir, "index") == 32);
	snprintf(path, sizeof path, "%s/index", indexdir), unlink(path);
	snprintf(path, sizeof path, "%s/i0", indexdir), unlink(path);
	a = open_log(&mem, indexdir, other);
	CHECK(a && !tp_log_load(a) && tp_log_count(a, device) == STEPS && !unlike(a, device, STEPS));
	tp_log_free(a);
	CHECK(size_of(indexdir, "i0") == STEPS * 16 && size_of(indexdir, "index") == 32);
	// cut in the middle of an entry, one entry wrong, the devices' keys cut in the middle of one
	cut(indexdir, "i0", 150 * 16 + 7), cut(indexdir, "index", 20);
	snprintf(path, sizeof path, "%s/i0", indexdir);
	fd = open(path, O_WRONLY);
	uint8_t junk[16];
	memset(junk, 0xff, sizeof junk);
	CHECK(fd >= 0 && pwrite(fd, junk, 16, 9 * 16) == 16);
	close(fd);
	a = open_log(&mem, indexdir, other);
	CHECK(a && !tp_log_load(a) && tp_log_count(a, device) == STEPS && !unlike(a, device, STEPS));
	CHECK(!tp_log_run(a, device, 10, &end, sig) && end == 10);
	tp_log_free(a);
	// the log's last frame cut off: the index says more than the log holds
	cut(indexdir, "log", size_of(indexdir, "log") - 10);
	a = open_log(&mem, indexdir, other);
	CHECK(a && !tp_log_load(a) && tp_log_count(a, device) == STEPS - 1 && !unlike(a, device, STEPS - 1));
	CHECK(tp_log_step(a, device, STEPS, NULL, 0) < 0);
	w.patches.n = (size_t)patches(ps, 5);
	CHECK(!tp_log_write(a, &w, &n, &lamport) && n == STEPS && !tp_log_run(a, device, n, &end, sig));
	tp_log_free(a);
	a = open_log(&mem, indexdir, other);
	CHECK(a && !tp_log_load(a) && tp_log_count(a, device) == STEPS && !unlike(a, device, STEPS - 1));
	CHECK(tp_log_step(a, device, STEPS, NULL, 0) > 0);
	tp_log_free(a);
	printf("tippet-test: the index let go, cut short, wrong, past the log: made again, every step found\n");

	CHECK(h.now == 0);
	wipe(indexdir), wipe(relaydir), wipe(dir);
	printf("tippet-test: %s, peak heap %zu bytes\n", failed ? "FAILED" : "ok", h.peak);
	return failed ? 1 : 0;
}
