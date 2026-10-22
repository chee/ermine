// a log's store on disk (POSIX), as typescript/store_file.ts: records appended to dir/log as frames
// (4 bytes big-endian length, then the record), and the device's key in dir/key, written once. a
// frame cut short by a crash is cut off when loaded, so the next append starts clean. steps are
// read back from the file by where they are: in memory, only where each one starts and how long
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
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
	uint64_t end; // the file's length, every append so far
	size_t max;
	char *keyfile;
	size_t keyroom;
} file;

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
		uint64_t length = (uint64_t)head[0] << 24 | head[1] << 16 | head[2] << 8 | head[3];
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
		if (read(ctx, b.p, (size_t)length, &step) && (why = tp_index_hold(&f->index, &step, at + 4, length)))
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
	uint8_t head[4] = {(uint8_t)(length >> 24), (uint8_t)(length >> 16), (uint8_t)(length >> 8),
		(uint8_t)length};
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
	return at ? tp_index_hold(&f->index, at, offset, length) : 0;
}

static long get(void *self, const uint8_t device[32], uint64_t n, uint8_t *out, size_t cap) {
	file *f = self;
	uint64_t offset, length;
	if (tp_index_find(&f->index, device, n, &offset, &length)) return -1;
	if (length <= cap && readat(f->fd, out, (size_t)length, offset)) return -1;
	return (long)length;
}

static int key(void *self, const uint8_t seed[32], uint8_t out[32]) {
	file *f = self;
	int fd = open(f->keyfile, O_WRONLY | O_CREAT | O_EXCL, 0600);
	if (fd >= 0) {
		ssize_t wrote = write(fd, seed, 32);
		if (close(fd) || wrote != 32) return TP_STORE;
		memcpy(out, seed, 32);
		return 0;
	}
	if (errno != EEXIST || (fd = open(f->keyfile, O_RDONLY)) < 0) return TP_STORE;
	struct stat st;
	int bad = fstat(fd, &st) || st.st_size != 32 || readat(fd, out, 32, 0);
	close(fd);
	return bad ? TP_STORE : 0;
}

static void shut(void *self) {
	file *f = self;
	tp_mem mem = f->mem;
	if (f->fd >= 0) close(f->fd);
	tp_index_clear(&f->index);
	tp_free(&mem, f->keyfile, f->keyroom);
	tp_free(&mem, f, sizeof *f);
}

tp_store *tp_file_store(const tp_mem *mem, const char *dir, size_t max) {
	size_t n = strlen(dir);
	file *f = tp_alloc(mem, sizeof *f);
	if (!f) return NULL;
	memset(f, 0, sizeof *f);
	f->mem = *mem, f->index.mem = &f->mem, f->max = max, f->fd = -1;
	f->store = (tp_store){f, load, append, get, key, shut};
	f->keyroom = n + 5;
	if (!(f->keyfile = tp_alloc(mem, f->keyroom))) return shut(f), NULL;
	if (mkdir(dir, 0777) && errno != EEXIST) return shut(f), NULL;
	// dir/log, then dir/key in the same room
	memcpy(f->keyfile, dir, n), memcpy(f->keyfile + n, "/log", 5);
	f->fd = open(f->keyfile, O_RDWR | O_APPEND | O_CREAT, 0644);
	memcpy(f->keyfile + n, "/key", 5);
	if (f->fd < 0) return shut(f), NULL;
	return &f->store;
}
