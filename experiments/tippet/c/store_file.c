// a log's store on disk (POSIX), as typescript/store_file.ts: records appended to dir/log as frames
// (4 bytes big-endian length, then the record), the snapshot in dir/snapshot, written whole beside
// it then renamed into place, and the device's key in dir/key, written once. a frame cut short by a
// crash is cut off when loaded, so the next append starts clean. records are read back from the
// file by where they are: in memory, only where each one holding steps starts and how long, and the
// last run read, unpacked. sync: fsync
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

typedef struct {
	tp_store store;
	tp_mem mem;
	tp_index index;
	int fd;
	uint64_t end, synced; // the file's length, every append so far; how much of it is synced
	size_t max;
	// two rooms, each dir and then a name: dir's length, and a room's
	char *path;
	size_t dir, room;
} file;

// dir/name, in room i (0 or 1)
static const char *named(file *f, int i, const char *name) {
	char *p = f->path + (size_t)i * f->room;
	memcpy(p + f->dir, name, strlen(name) + 1);
	return p;
}

// all of it read at offset; 0, or -1 short
static int readat(int fd, uint8_t *out, size_t n, uint64_t offset) {
	while (n) {
		ssize_t got = pread(fd, out, n, (off_t)offset);
		if (got < 0 && errno == EINTR) continue;
		if (got <= 0) return -1;
		out += got, n -= (size_t)got, offset += (uint64_t)got;
	}
	return 0;
}

static int load(void *self, tp_read read, void *ctx) {
	file *f = self;
	struct stat st;
	tp_index_clear(&f->index);
	if (fstat(f->fd, &st)) return TP_STORE;
	uint64_t size = (uint64_t)st.st_size, at = 0;
	tp_buf b = {NULL, 0, 0, f->max, &f->mem, 0};
	int why = 0;
	// a record is never empty: a zero length is a tail never written (a power cut), and ends it
	while (at + 4 <= size) {
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
			(why = tp_index_hold(&f->index, &step, at + 4, length, tp_is_run(b.p, (size_t)length))))
			break;
		at += 4 + length;
	}
	tp_buf_free(&b);
	if (why) return why;
	if (at < size && ftruncate(f->fd, (off_t)at)) return TP_STORE;
	f->end = at;
	return 0;
}

static int append(void *self, const uint8_t *record, size_t length, const tp_at *at) {
	file *f = self;
	if (!length || length > f->max || length > 0xffffffffu) return TP_BOUND;
	uint8_t head[4];
	tp_set32(head, (uint32_t)length);
	struct iovec v[2] = {{head, 4}, {(void *)(uintptr_t)record, length}};
	size_t want = 4 + length;
	ssize_t wrote;
	do wrote = writev(f->fd, v, 2);
	while (wrote < 0 && errno == EINTR);
	if (wrote != (ssize_t)want) {
		// a frame cut short is cut off: the file as it was
		if (ftruncate(f->fd, (off_t)f->end)) return TP_STORE;
		return TP_STORE;
	}
	uint64_t offset = f->end + 4;
	f->end += want;
	return at ? tp_index_hold(&f->index, at, offset, length, tp_is_run(record, length)) : 0;
}

// a step: alone, read as it is; in a run, out of the run last read, else the run read and unpacked
static long get(void *self, const uint8_t device[32], uint64_t n, uint8_t *out, size_t cap) {
	file *f = self;
	const tp_held *r = tp_index_find(&f->index, device, n);
	if (!r) return -1;
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
	const tp_held *r = tp_index_find(&f->index, device, n);
	if (!r || readat(f->fd, out, r->length < cap ? r->length : cap, r->offset)) return -1;
	*first = r->first, *last = r->last;
	return (long)r->length;
}

static int snapshot(void *self, const uint8_t *bytes, size_t length) {
	file *f = self;
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

static int flush(void *self) {
	file *f = self;
	if (f->synced == f->end) return 0;
	if (fsync(f->fd)) return TP_STORE;
	f->synced = f->end;
	return 0;
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

// forgetting: the bytes stay on disk
static long drop(void *self, const uint8_t device[32], uint64_t n) {
	return tp_index_drop(&((file *)self)->index, device, n);
}

static void shut(void *self) {
	file *f = self;
	tp_mem mem = f->mem;
	if (f->fd >= 0) close(f->fd);
	tp_index_clear(&f->index);
	tp_free(&mem, f->path, 2 * f->room);
	tp_free(&mem, f, sizeof *f);
}

tp_store *tp_file_store(const tp_mem *mem, const char *dir, size_t max) {
	size_t n = strlen(dir);
	file *f = tp_alloc(mem, sizeof *f);
	if (!f) return NULL;
	memset(f, 0, sizeof *f);
	f->mem = *mem, f->index.mem = &f->mem, f->index.max = max, f->max = max, f->fd = -1;
	f->store = (tp_store){f, load, append, get, run, snapshot, snapped, key, flush, shut, drop};
	// the longest name: /snapshot.new
	f->dir = n, f->room = n + 14;
	if (!(f->path = tp_alloc(mem, 2 * f->room))) return shut(f), NULL;
	memcpy(f->path, dir, n), memcpy(f->path + f->room, dir, n);
	if (mkdir(dir, 0777) && errno != EEXIST) return shut(f), NULL;
	f->fd = open(named(f, 0, "/log"), O_RDWR | O_APPEND | O_CREAT, 0644);
	if (f->fd < 0) return shut(f), NULL;
	return &f->store;
}
