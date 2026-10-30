// A log's store on disk (POSIX), as typescript/store_file.ts, but records are found through an
// index
// on disk, so only the last run read, unpacked, is kept in memory.
// The index: dir/index lists each device's key (32 bytes). For the k-th, dir/i<k in hex> holds an
// ENTRY-byte entry per step (step n's at (n - 1) * ENTRY): the record's offset (5) and length (4),
// how far back it starts and on it goes from n (2 each), whether it is a run (1), a check (2). A
// load rewrites entries that are missing or wrong. Open steps are kept in memory, written to
// dir/open at a sync.
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/uio.h>
#include <unistd.h>

#include "store.h"
#include "wire.h"

#define ENTRY 16
#define WAIT 16

typedef struct {
	uint8_t key[32];
	uint64_t dropped;
} indexed;

typedef struct {
	size_t k;
	tp_held at;
} waiting;

typedef struct {
	size_t k;
	uint64_t n;
	tp_held at;
} later;

typedef struct {
	tp_store store;
	tp_mem mem;
	tp_index index;
	indexed *keys;
	size_t nkeys, roomkeys;
	size_t xk;
	int xfd;
	waiting wait[WAIT];
	size_t nwait;
	later *laters;
	size_t nlaters, roomlaters;
	uint64_t size;
	int fd;
	uint64_t end, synced; // the file's length, every append so far; how much of it is synced
	int ofd;
	uint64_t oend, ffirst;
	size_t fcount;
	int dirty;
	size_t max;
	char *path;
	size_t dir, room;
} file;

static const char *named(file *f, int i, const char *name) {
	char *p = f->path + (size_t)i * f->room;
	memcpy(p + f->dir, name, strlen(name) + 1);
	return p;
}

static int readat(int fd, uint8_t *out, size_t n, uint64_t offset) {
	while (n) {
		ssize_t got = pread(fd, out, n, (off_t)offset);
		if (got < 0 && errno == EINTR) continue;
		if (got <= 0) return -1;
		out += got, n -= (size_t)got, offset += (uint64_t)got;
	}
	return 0;
}

static int writeat(int fd, const uint8_t *in, size_t n, uint64_t offset) {
	while (n) {
		ssize_t put = pwrite(fd, in, n, (off_t)offset);
		if (put < 0 && errno == EINTR) continue;
		if (put <= 0) return -1;
		in += put, n -= (size_t)put, offset += (uint64_t)put;
	}
	return 0;
}

static void readsome(int fd, uint8_t *out, size_t n, uint64_t offset) {
	while (n) {
		ssize_t got = pread(fd, out, n, (off_t)offset);
		if (got < 0 && errno == EINTR) continue;
		if (got <= 0) return;
		out += got, n -= (size_t)got, offset += (uint64_t)got;
	}
}


static uint16_t check(const uint8_t *e, uint64_t n) {
	uint32_t h = 2166136261u;
	for (int i = 0; i < ENTRY - 2; i++) h = (h ^ e[i]) * 16777619u;
	for (int i = 0; i < 8; i++) h = (h ^ (uint8_t)(n >> 8 * i)) * 16777619u;
	return (uint16_t)(h ^ h >> 16);
}

static void put_entry(uint8_t *e, uint64_t n, const tp_held *r) {
	uint64_t back = n - r->first, on = r->last - n;
	for (int i = 0; i < 5; i++) e[i] = (uint8_t)(r->offset >> (32 - 8 * i));
	tp_set32(e + 5, r->length);
	e[9] = (uint8_t)(back >> 8), e[10] = (uint8_t)back, e[11] = (uint8_t)(on >> 8), e[12] = (uint8_t)on;
	e[13] = (uint8_t)r->run;
	uint16_t c = check(e, n);
	e[14] = (uint8_t)(c >> 8), e[15] = (uint8_t)c;
}

static int get_entry(const uint8_t *e, uint64_t n, tp_held *r) {
	if ((uint16_t)(e[14] << 8 | e[15]) != check(e, n)) return -1;
	uint64_t offset = 0, back = (uint64_t)(e[9] << 8 | e[10]), on = (uint64_t)(e[11] << 8 | e[12]);
	for (int i = 0; i < 5; i++) offset = offset << 8 | e[i];
	uint32_t length = tp_get32(e + 5);
	if (!length || offset < 4 || back >= n || e[13] > 1) return -1;
	*r = (tp_held){n - back, n + on, offset, length, e[13]};
	return 0;
}

static int same(const tp_held *a, const tp_held *b) {
	return a->first == b->first && a->last == b->last && a->offset == b->offset && a->length == b->length &&
		a->run == b->run;
}

static int keys_load(file *f) {
	f->nkeys = 0;
	int fd = open(named(f, 0, "/index"), O_RDWR);
	if (fd < 0) return errno == ENOENT ? 0 : TP_STORE;
	struct stat st;
	int why = fstat(fd, &st) ? TP_STORE : 0;
	size_t n = why ? 0 : (size_t)st.st_size / 32;
	if (!why && (size_t)st.st_size % 32 && ftruncate(fd, (off_t)(n * 32))) why = TP_STORE;
	if (!why && n > f->roomkeys) {
		indexed *keys = tp_grow(&f->mem, f->keys, f->roomkeys * sizeof *keys, n * sizeof *keys);
		if (keys) f->keys = keys, f->roomkeys = n;
		else why = TP_NOMEM;
	}
	for (size_t k = 0; k < n && !why; k++) {
		if (readat(fd, f->keys[k].key, 32, 32 * (uint64_t)k)) why = TP_STORE;
		f->keys[k].dropped = 0, f->nkeys++;
	}
	close(fd);
	return why;
}

static void unindex(file *f) {
	if (f->xfd >= 0) close(f->xfd);
	f->xfd = -1;
}

static long key_of(file *f, const uint8_t device[32], int make) {
	for (size_t k = 0; k < f->nkeys; k++) {
		if (!memcmp(f->keys[k].key, device, 32)) return (long)k;
	}
	if (!make) return -1;
	if (f->nkeys == f->roomkeys) {
		size_t room = f->roomkeys ? 2 * f->roomkeys : 4;
		indexed *keys = tp_grow(&f->mem, f->keys, f->roomkeys * sizeof *keys, room * sizeof *keys);
		if (!keys) return TP_NOMEM;
		f->keys = keys, f->roomkeys = room;
	}
	unindex(f);
	int fd = open(named(f, 0, "/index"), O_WRONLY | O_APPEND | O_CREAT, 0644);
	if (fd < 0) return TP_STORE;
	off_t was = lseek(fd, 0, SEEK_END);
	ssize_t wrote = was < 0 ? -1 : write(fd, device, 32);
	if (wrote != 32 && was >= 0 && ftruncate(fd, was)) wrote = -1;
	if (close(fd) || wrote != 32) return TP_STORE;
	memcpy(f->keys[f->nkeys].key, device, 32), f->keys[f->nkeys].dropped = 0;
	return (long)f->nkeys++;
}

// Only one entries file is open at a time.
static int entries(file *f, size_t k, int make) {
	if (f->xfd >= 0 && f->xk == k) return f->xfd;
	unindex(f);
	char name[24];
	snprintf(name, sizeof name, "/i%zx", k);
	f->xfd = open(named(f, 0, name), make ? O_RDWR | O_CREAT : O_RDWR, 0644);
	f->xk = k;
	return f->xfd;
}

static int find(file *f, size_t k, uint64_t n, tp_held *r, int any) {
	int got = 0;
	for (size_t i = f->nwait; i-- && !got;) {
		const waiting *w = &f->wait[i];
		if (w->k == k && w->at.first <= n && n <= w->at.last) *r = w->at, got = 1;
	}
	if (!got) {
		uint8_t e[ENTRY];
		int fd = n ? entries(f, k, 0) : -1;
		if (fd < 0 || readat(fd, e, ENTRY, (n - 1) * ENTRY) || get_entry(e, n, r)) return -1;
	}
	return r->offset + r->length > f->end || (!any && r->last <= f->keys[k].dropped) ? -1 : 0;
}

static int found(file *f, const uint8_t device[32], uint64_t n, tp_held *r) {
	long k = key_of(f, device, 0);
	return k < 0 ? -1 : find(f, (size_t)k, n, r, 0);
}

static int put_entries(file *f, size_t k, const tp_held *r) {
	int fd = entries(f, k, 1);
	if (fd < 0) return TP_STORE;
	uint8_t b[32 * ENTRY];
	for (uint64_t n = r->first; n <= r->last;) {
		uint64_t from = n;
		size_t c = 0;
		for (; n <= r->last && c < 32; n++, c++) put_entry(b + ENTRY * c, n, r);
		if (writeat(fd, b, c * ENTRY, (from - 1) * ENTRY)) return TP_STORE;
	}
	return 0;
}

static int written(file *f) {
	int why = 0;
	for (size_t i = 0; i < f->nwait && !why; i++) {
		size_t k = f->wait[i].k, j = 0;
		while (j < i && f->wait[j].k != k) j++;
		if (j < i) continue;
		for (j = i; j < f->nwait && !why; j++) {
			if (f->wait[j].k == k) why = put_entries(f, k, &f->wait[j].at);
		}
	}
	unindex(f);
	if (!why) f->nwait = 0;
	return why;
}

static void settled(file *f, size_t k, uint64_t n) {
	for (size_t i = 0; i < f->nlaters; i++) {
		if (f->laters[i].k == k && f->laters[i].n == n) f->laters[i--] = f->laters[--f->nlaters];
	}
}

static int indexed_again(file *f, const tp_at *at, uint64_t offset, uint64_t length, int run) {
	if (at->last < at->first || at->last - at->first > 0xffff) return TP_BOUND;
	long k = key_of(f, at->device, 1);
	if (k < 0) return (int)k;
	int fd = entries(f, (size_t)k, 1);
	if (fd < 0) return TP_STORE;
	tp_held r = {at->first, at->last, offset, (uint32_t)length, (uint32_t)!!run}, was;
	uint8_t b[32 * ENTRY];
	for (uint64_t n = at->first; n <= at->last;) {
		uint64_t from = n;
		size_t c = 0;
		while (n + c <= at->last && c < 32) c++;
		memset(b, 0, c * ENTRY);
		readsome(fd, b, c * ENTRY, (from - 1) * ENTRY);
		int dirty = 0;
		for (size_t i = 0; i < c; i++, n++) {
			uint8_t *e = b + ENTRY * i;
			int valid = !get_entry(e, n, &was);
			if (valid && same(&was, &r)) {
				if (f->nlaters) settled(f, (size_t)k, n);
				continue;
			}
			if (valid && was.run && !run && was.offset > offset && was.offset + was.length <= f->size) {
				if (f->nlaters == f->roomlaters) {
					size_t room = f->roomlaters ? 2 * f->roomlaters : 8;
					later *l = tp_grow(&f->mem, f->laters, f->roomlaters * sizeof *l, room * sizeof *l);
					if (!l) return TP_NOMEM;
					f->laters = l, f->roomlaters = room;
				}
				f->laters[f->nlaters++] = (later){(size_t)k, n, r};
				continue;
			}
			put_entry(e, n, &r), dirty = 1;
			if (f->nlaters) settled(f, (size_t)k, n);
		}
		if (dirty && writeat(fd, b, c * ENTRY, (from - 1) * ENTRY)) return TP_STORE;
	}
	return 0;
}

static int laters_done(file *f) {
	int why = 0;
	for (size_t i = 0; i < f->nlaters && !why; i++) {
		tp_held one = f->laters[i].at;
		uint64_t n = f->laters[i].n;
		uint8_t e[ENTRY];
		int fd = entries(f, f->laters[i].k, 1);
		put_entry(e, n, &one);
		if (fd < 0 || writeat(fd, e, ENTRY, (n - 1) * ENTRY)) why = TP_STORE;
	}
	tp_free(&f->mem, f->laters, f->roomlaters * sizeof *f->laters);
	f->laters = NULL, f->nlaters = f->roomlaters = 0;
	return why;
}

static int load_open(file *f, tp_read read, void *ctx, tp_buf *b) {
	struct stat st;
	f->ffirst = 0, f->fcount = 0, f->dirty = 0, f->oend = 0;
	if (f->ofd < 0 && (f->ofd = open(named(f, 0, "/open"), O_RDWR | O_APPEND)) < 0) return errno == ENOENT ? 0 : TP_STORE;
	if (fstat(f->ofd, &st)) return TP_STORE;
	uint64_t size = (uint64_t)st.st_size, at = 0;
	while (at + 4 <= size) {
		uint8_t head[4];
		if (readat(f->ofd, head, 4, at)) break;
		uint64_t length = tp_get32(head);
		if (!length || length > size - at - 4) break;
		if (length > f->max) return TP_BOUND;
		b->len = 0;
		if (!tp_reserve(b, (size_t)length)) return tp_buf_why(b);
		if (readat(f->ofd, b->p, (size_t)length, at + 4)) break;
		tp_at step;
		if (!read(ctx, b->p, (size_t)length, &step)) f->dirty = 1;
		else {
			int why = tp_index_open(&f->index, b->p, (size_t)length, &step);
			if (why) return why;
			if (!f->fcount) f->ffirst = step.first;
			f->fcount++;
		}
		at += 4 + length;
	}
	if (at < size && (ftruncate(f->ofd, (off_t)at) || fsync(f->ofd))) return TP_STORE;
	f->oend = at;
	return 0;
}

static int load(void *self, tp_read read, void *ctx) {
	file *f = self;
	struct stat st;
	tp_index_clear(&f->index);
	unindex(f), f->nwait = 0;
	int why = keys_load(f);
	if (why) return why;
	if (fstat(f->fd, &st)) return TP_STORE;
	uint64_t size = (uint64_t)st.st_size, at = 0;
	tp_buf b = {NULL, 0, 0, f->max, &f->mem, 0};
	f->size = size;
	// A zero length is a tail that was never written (a power cut) and ends the log.
	while (at + 4 <= size) {
		f->end = at;
		uint8_t head[4];
		if (readat(f->fd, head, 4, at)) break;
		uint64_t length = tp_get32(head);
		if (!length || length > size - at - 4) break;
		if (length > f->max) {
			why = TP_BOUND;
			break;
		}
		b.len = 0;
		if (!tp_reserve(&b, (size_t)length)) {
			why = tp_buf_why(&b);
			break;
		}
		if (readat(f->fd, b.p, (size_t)length, at + 4)) break;
		tp_at step;
		if (read(ctx, b.p, (size_t)length, &step) &&
			(why = indexed_again(f, &step, at + 4, length, tp_is_run(b.p, (size_t)length))))
			break;
		at += 4 + length;
	}
	if (!why && at < size && ftruncate(f->fd, (off_t)at)) why = TP_STORE;
	f->end = at;
	int left = laters_done(f);
	if (!why) why = left;
	unindex(f);
	if (!why) why = load_open(f, read, ctx, &b);
	tp_buf_free(&b);
	return why;
}

static int append(void *self, const uint8_t *record, size_t length, const tp_at *at) {
	file *f = self;
	if (!length || length > f->max || length > 0xffffffffu) return TP_BOUND;
	long k = 0;
	if (at && (at->last < at->first || at->last - at->first > 0xffff)) return TP_BOUND;
	if (at && (k = key_of(f, at->device, 1)) < 0) return (int)k;
	if (at && f->nwait == WAIT && written(f)) return TP_STORE;
	uint8_t head[4];
	tp_set32(head, (uint32_t)length);
	struct iovec v[2] = {{head, 4}, {(void *)(uintptr_t)record, length}};
	size_t want = 4 + length;
	ssize_t wrote;
	do wrote = writev(f->fd, v, 2);
	while (wrote < 0 && errno == EINTR);
	if (wrote != (ssize_t)want) {
		if (ftruncate(f->fd, (off_t)f->end)) return TP_STORE;
		return TP_STORE;
	}
	uint64_t offset = f->end + 4;
	f->end += want;
	if (!at) return 0;
	tp_index_ran(&f->index, at);
	tp_held held = {at->first, at->last, offset, (uint32_t)length, (uint32_t)tp_is_run(record, length)};
	f->wait[f->nwait++] = (waiting){(size_t)k, held};
	return 0;
}

static long get(void *self, const uint8_t device[32], uint64_t n, uint8_t *out, size_t cap) {
	file *f = self;
	size_t length;
	const uint8_t *p = tp_index_opened(&f->index, device, n, &length);
	if (p) {
		if (out && length <= cap) memcpy(out, p, length);
		return (long)length;
	}
	tp_held held, *r = &held;
	if (found(f, device, n, r)) return -1;
	if (!r->run) return r->length <= cap && readat(f->fd, out, r->length, r->offset) ? -1 : (long)r->length;
	if (tp_index_read(&f->index, device, n)) return tp_index_step(&f->index, device, n, r, NULL, out, cap);
	uint8_t *record = tp_alloc(&f->mem, r->length);
	long got = record && !readat(f->fd, record, r->length, r->offset)
		? tp_index_step(&f->index, device, n, r, record, out, cap) : -1;
	tp_free(&f->mem, record, r->length);
	return got;
}

static long run(void *self, const uint8_t device[32], uint64_t n, uint8_t *out, size_t cap,
	uint64_t *first, uint64_t *last) {
	file *f = self;
	size_t length;
	const uint8_t *p = tp_index_opened(&f->index, device, n, &length);
	if (p) {
		if (out) memcpy(out, p, length < cap ? length : cap);
		*first = *last = n;
		return (long)length;
	}
	tp_held r;
	if (found(f, device, n, &r) || readat(f->fd, out, r.length < cap ? r.length : cap, r.offset)) return -1;
	*first = r.first, *last = r.last;
	return (long)r.length;
}

static int snapshot(void *self, const uint8_t *bytes, size_t length) {
	file *f = self;
	unindex(f);
	int fd = open(named(f, 0, "/snapshot.new"), O_WRONLY | O_CREAT | O_TRUNC, 0644);
	if (fd < 0) return TP_STORE;
	size_t done = 0;
	while (done < length) {
		ssize_t wrote = write(fd, bytes + done, length - done);
		if (wrote < 0 && errno == EINTR) continue;
		if (wrote <= 0) break;
		done += (size_t)wrote;
	}
	if (close(fd) || done < length) return TP_STORE;
	return rename(f->path, named(f, 1, "/snapshot")) ? TP_STORE : 0;
}

static long snapped(void *self, uint8_t *out, size_t cap) {
	file *f = self;
	int fd = open(named(f, 0, "/snapshot"), O_RDONLY);
	struct stat st;
	if (fd < 0) return -1;
	long n = fstat(fd, &st) || st.st_size > 0x7fffffff ? -1 : (long)st.st_size;
	if (n > 0 && (size_t)n <= cap && readat(fd, out, (size_t)n, 0)) n = -1;
	close(fd);
	return n;
}

static int write_open(file *f) {
	const tp_index *x = &f->index;
	uint64_t first = x->ocount ? x->ofirst : UINT64_MAX;
	int stale = f->dirty || (f->fcount && f->ffirst < first);
	int empty = stale && !(f->fcount && f->ffirst + f->fcount > first);
	size_t skip = f->fcount && !empty ? (size_t)(f->ffirst + f->fcount - first) : 0, from = 0;
	if (skip >= x->ocount && !empty) return 0;
	for (size_t i = 0; i < skip; i++) from += 4 + tp_get32(x->open.p + from);
	if (f->ofd < 0 && (f->ofd = open(named(f, 0, "/open"), O_RDWR | O_APPEND | O_CREAT, 0644)) < 0) return TP_STORE;
	if (empty) {
		if (ftruncate(f->ofd, 0)) return TP_STORE;
		f->oend = 0, f->dirty = 0, f->fcount = 0;
	}
	if (!f->fcount) f->ffirst = first;
	for (size_t done = from; done < x->open.len;) {
		ssize_t wrote = write(f->ofd, x->open.p + done, x->open.len - done);
		if (wrote < 0 && errno == EINTR) continue;
		if (wrote <= 0) {
			if (ftruncate(f->ofd, (off_t)f->oend)) return TP_STORE;
			return TP_STORE;
		}
		done += (size_t)wrote;
	}
	if (fsync(f->ofd)) return TP_STORE;
	f->oend += x->open.len - from, f->fcount += x->ocount - skip;
	return 0;
}

static int flush(void *self) {
	file *f = self;
	if (f->synced != f->end) {
		if (fsync(f->fd)) return TP_STORE;
		f->synced = f->end;
	}
	written(f);
	return write_open(f);
}

static int open_(void *self, const uint8_t *step, size_t length, const tp_at *at) {
	return tp_index_open(&((file *)self)->index, step, length, at);
}

static int key(void *self, const uint8_t seed[32], uint8_t out[32]) {
	file *f = self;
	const char *keyfile = named(f, 0, "/key");
	int fd = open(keyfile, O_WRONLY | O_CREAT | O_EXCL, 0600);
	if (fd >= 0) {
		ssize_t wrote = write(fd, seed, 32);
		if (close(fd) || wrote != 32) return TP_STORE;
		memcpy(out, seed, 32);
		return 0;
	}
	if (errno != EEXIST || (fd = open(keyfile, O_RDONLY)) < 0) return TP_STORE;
	struct stat st;
	int bad = fstat(fd, &st) || st.st_size != 32 || readat(fd, out, 32, 0);
	close(fd);
	return bad ? TP_STORE : 0;
}

// Forgetting: the bytes stay on disk; the records are just no longer returned.
static long drop(void *self, const uint8_t device[32], uint64_t n) {
	file *f = self;
	long k = key_of(f, device, 0);
	tp_held r;
	if (k < 0) return 0;
	uint64_t through = !find(f, (size_t)k, n, &r, 1) && r.last > n ? r.first - 1 : n;
	if (through <= f->keys[k].dropped) return 0;
	f->keys[k].dropped = through;
	return 1;
}

static void shut(void *self) {
	file *f = self;
	tp_mem mem = f->mem;
	if (f->fd >= 0 && f->nwait) written(f);
	unindex(f);
	if (f->fd >= 0) close(f->fd);
	if (f->ofd >= 0) close(f->ofd);
	tp_free(&mem, f->keys, f->roomkeys * sizeof *f->keys);
	tp_free(&mem, f->laters, f->roomlaters * sizeof *f->laters);
	tp_index_clear(&f->index);
	tp_free(&mem, f->path, 2 * f->room);
	tp_free(&mem, f, sizeof *f);
}

tp_store *tp_file_store(const tp_mem *mem, const char *dir, size_t max) {
	size_t n = strlen(dir);
	file *f = tp_alloc(mem, sizeof *f);
	if (!f) return NULL;
	memset(f, 0, sizeof *f);
	f->mem = *mem, f->index.mem = &f->mem, f->index.max = max, f->max = max, f->fd = f->ofd = f->xfd = -1;
	f->store = (tp_store){f, load, append, get, run, snapshot, snapped, key, flush, shut, drop, open_};
	f->dir = n, f->room = n + 2 + 2 * sizeof(size_t) + 1;
	if (f->room < n + 14) f->room = n + 14;
	if (!(f->path = tp_alloc(mem, 2 * f->room))) return shut(f), NULL;
	memcpy(f->path, dir, n), memcpy(f->path + f->room, dir, n);
	if (mkdir(dir, 0777) && errno != EEXIST) return shut(f), NULL;
	f->fd = open(named(f, 0, "/log"), O_RDWR | O_APPEND | O_CREAT, 0644);
	if (f->fd < 0) return shut(f), NULL;
	return &f->store;
}
