// store_files.c: store.h's store as a folder of files (POSIX), each record
// a file named by its 32-byte key in hex, fanned out git-style: a folder
// named by the key's first two hex digits, holding a file named by the
// other 62.
//
//   <root>/trees/ab/cdef…                   empty: a sedimentree it holds, by its id
//   <root>/commits/<tree hex>/ab/cdef…      a loose commit (Signed<LooseCommit>), by its commit id
//   <root>/fragments/<tree hex>/ab/cdef…    a fragment (Signed<Fragment>), by its head
//   <root>/blobs/ab/cdef…                   a blob, by its digest
//
// A write goes to a temporary file in the same folder (.tmp-…), is synced,
// then renamed over the name, and the folder synced: a record is there
// whole or not at all, and once put stays through a crash (on macOS fsync
// is not F_FULLFSYNC: a drive's own cache may still lose it).

#define _POSIX_C_SOURCE 200809L

#include "store.h"
#include "platform.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

typedef struct Files {
	char *root;
} Files;

static const char *const KINDS[] = { "trees", "commits", "fragments", "blobs" };

static void hex(const uint8_t *bytes, size_t n, char *out) {
	static const char digits[] = "0123456789abcdef";
	for (size_t i = 0; i < n; i++) out[2 * i] = digits[bytes[i] >> 4], out[2 * i + 1] = digits[bytes[i] & 15];
	out[2 * n] = 0;
}

static bool unhex(const char *text, size_t n, uint8_t *out) {
	for (size_t i = 0; i < 2 * n; i++) {
		char c = text[i];
		int d = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1;
		if (d < 0) return false;
		if (i % 2) out[i / 2] = (uint8_t)(out[i / 2] << 4 | d);
		else out[i / 2] = (uint8_t)d;
	}
	return text[2 * n] == 0;
}

/** the folder of a kind's records (in a tree): <root>/<kind>[/<tree hex>] */
static void folder(Files *f, int kind, const uint8_t *tree, char *out, size_t room) {
	char t[65];
	if (kind == ERM_STORE_COMMIT || kind == ERM_STORE_FRAGMENT) {
		hex(tree, 32, t);
		snprintf(out, room, "%s/%s/%s", f->root, KINDS[kind], t);
	} else {
		snprintf(out, room, "%s/%s", f->root, KINDS[kind]);
	}
}

/** a record's fan-out folder and file: <folder>/ab and <folder>/ab/cdef… */
static void paths(Files *f, int kind, const uint8_t *tree, const uint8_t id[32], char *dir, char *file, size_t room) {
	char base[1024], h[65];
	folder(f, kind, tree, base, sizeof base);
	hex(id, 32, h);
	snprintf(dir, room, "%s/%.2s", base, h);
	snprintf(file, room, "%s/%s", dir, h + 2);
}

/** syncs a folder, so the names in it last through a crash */
static bool synced(const char *path) {
	int fd = open(path, O_RDONLY);
	if (fd < 0) return false;
	bool ok = fsync(fd) == 0;
	close(fd);
	return ok;
}

/** mkdir -p, each folder it makes synced into its parent */
static bool made(const char *path) {
	char p[1024];
	snprintf(p, sizeof p, "%s", path);
	for (char *at = p + 1;; at++) {
		if (*at && *at != '/') continue;
		char end = *at;
		*at = 0;
		if (mkdir(p, 0755) == 0) {
			char *slash = strrchr(p, '/');
			bool ok;
			if (!slash) ok = synced(".");
			else if (slash == p) ok = synced("/");
			else *slash = 0, ok = synced(p), *slash = '/';
			if (!ok) return false;
		} else if (errno != EEXIST) {
			return false;
		}
		*at = end;
		if (!end) return true;
	}
}

static int put(void *self, int kind, const uint8_t *tree, const uint8_t id[32], const uint8_t *bytes, size_t length) {
	char dir[1024], file[1100], temporary[1100];
	paths(self, kind, tree, id, dir, file, sizeof dir);
	if (!made(dir)) return -1;
	uint8_t nonce[8];
	char n[17];
	erm_host_random(nonce, sizeof nonce);
	hex(nonce, sizeof nonce, n);
	snprintf(temporary, sizeof temporary, "%s/.tmp-%s", dir, n);
	int fd = open(temporary, O_WRONLY | O_CREAT | O_EXCL, 0644);
	if (fd < 0) return -1;
	size_t done = 0;
	while (done < length) {
		ssize_t w = write(fd, bytes + done, length - done);
		if (w < 0 && errno == EINTR) continue;
		if (w <= 0) break;
		done += (size_t)w;
	}
	bool ok = done == length && fsync(fd) == 0;
	ok = close(fd) == 0 && ok;
	if (!ok || rename(temporary, file) != 0) {
		unlink(temporary);
		return -1;
	}
	return synced(dir) ? 0 : -1;
}

static int get(void *self, int kind, const uint8_t *tree, const uint8_t id[32], uint8_t **bytes, size_t *length) {
	char dir[1024], file[1100];
	paths(self, kind, tree, id, dir, file, sizeof dir);
	int fd = open(file, O_RDONLY);
	if (fd < 0) return errno == ENOENT ? 0 : -1;
	struct stat about;
	if (fstat(fd, &about) != 0) return close(fd), -1;
	size_t size = (size_t)about.st_size, done = 0;
	uint8_t *out = size ? erm_host_malloc(size) : NULL;
	if (size && !out) return close(fd), -1;
	while (done < size) {
		ssize_t r = read(fd, out + done, size - done);
		if (r < 0 && errno == EINTR) continue;
		if (r <= 0) break;
		done += (size_t)r;
	}
	close(fd);
	if (done != size) return erm_host_free(out), -1;
	*bytes = out;
	*length = size;
	return 1;
}

/** each record file under a kind's folder: what(context, id, path) */
static int walk(Files *f, int kind, const uint8_t *tree, void (*what)(void *context, const uint8_t id[32], const char *path), void *context) {
	char base[1024];
	folder(f, kind, tree, base, sizeof base);
	DIR *top = opendir(base);
	if (!top) return errno == ENOENT ? 0 : -1;
	struct dirent *fan;
	while ((fan = readdir(top))) {
		if (strlen(fan->d_name) != 2 || fan->d_name[0] == '.') continue;
		char dir[1100];
		snprintf(dir, sizeof dir, "%s/%s", base, fan->d_name);
		DIR *inner = opendir(dir);
		if (!inner) continue;
		struct dirent *entry;
		while ((entry = readdir(inner))) {
			char name[65], path[1200];
			if (strlen(entry->d_name) != 62) continue;
			snprintf(name, sizeof name, "%s%s", fan->d_name, entry->d_name);
			uint8_t id[32];
			if (!unhex(name, 32, id)) continue;
			snprintf(path, sizeof path, "%s/%s", dir, entry->d_name);
			what(context, id, path);
		}
		closedir(inner);
	}
	closedir(top);
	return 0;
}

typedef struct Each {
	void (*each)(void *context, const uint8_t id[32]);
	void *context;
} Each;

static void listed(void *context, const uint8_t id[32], const char *path) {
	(void)path;
	Each *e = context;
	e->each(e->context, id);
}

static int list(void *self, int kind, const uint8_t *tree, void (*each)(void *context, const uint8_t id[32]), void *context) {
	Each e = { each, context };
	return walk(self, kind, tree, listed, &e);
}

static void unlinked(void *context, const uint8_t id[32], const char *path) {
	(void)id;
	if (unlink(path) != 0 && errno != ENOENT) *(int *)context = -1;
}

static int remove_(void *self, int kind, const uint8_t *tree, const uint8_t *id) {
	if (id) {
		char dir[1024], file[1100];
		paths(self, kind, tree, id, dir, file, sizeof dir);
		return unlink(file) == 0 || errno == ENOENT ? 0 : -1;
	}
	int result = 0;
	if (walk(self, kind, tree, unlinked, &result) != 0) return -1;
	return result;
}

int ermStoreFiles(const char *root, ErmStore *out, const char **error) {
	if (!made(root)) return *error = "the store's folder could not be made", -1;
	Files *f = erm_host_malloc(sizeof *f);
	char *copy = erm_host_malloc(strlen(root) + 1);
	if (!f || !copy) return *error = "out of memory", -1;
	strcpy(copy, root);
	size_t length = strlen(copy);
	while (length > 1 && copy[length - 1] == '/') copy[--length] = 0;
	f->root = copy;
	*out = (ErmStore){ f, put, get, list, remove_ };
	return 0;
}
