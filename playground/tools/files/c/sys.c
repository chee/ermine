// sys.c: the platform calls. See sys.h; the rules are sys.ts's.
#ifdef __linux__
#define _GNU_SOURCE
#endif

#include "sys.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/xattr.h>
#include <time.h>
#include <unistd.h>
#include "foundation.h"
#ifdef __APPLE__
#include <copyfile.h>
#include <spawn.h>
#include <sys/wait.h>
#include <sys/clonefile.h>
#endif

#ifdef __APPLE__
extern char **environ;
#define NOFOLLOW XATTR_NOFOLLOW
#endif

// an attribute of the entry itself, never a link's target; the calls differ in their arguments
static ssize_t xget(const char *path, const char *name, void *buffer, size_t size) {
#ifdef __APPLE__
	return getxattr(path, name, buffer, size, 0, NOFOLLOW);
#else
	return lgetxattr(path, name, buffer, size);
#endif
}

static int xset(const char *path, const char *name, const void *value, size_t size) {
#ifdef __APPLE__
	return setxattr(path, name, value, size, 0, NOFOLLOW);
#else
	return lsetxattr(path, name, value, size, 0);
#endif
}

static int xremove(const char *path, const char *name) {
#ifdef __APPLE__
	return removexattr(path, name, NOFOLLOW);
#else
	return lremovexattr(path, name);
#endif
}

static ssize_t xlist(const char *path, char *buffer, size_t size) {
#ifdef __APPLE__
	return listxattr(path, buffer, size, NOFOLLOW);
#else
	return llistxattr(path, buffer, size);
#endif
}

// the errors sys.ts gives a code to: the rest are not the file system's to list
bool sys_known(int e) {
	switch (e) {
	case EPERM: case ENOENT: case EACCES: case EBUSY: case EEXIST: case EXDEV: case ENOTDIR: case EISDIR:
	case EINVAL: case ENOSPC: case EROFS: case ENOTSUP: case ELOOP: case ENAMETOOLONG: case ENOTEMPTY: case ERANGE:
		return true;
	default:
		return false;
	}
}

#ifdef __APPLE__
#define NOATTR ENOATTR
#else
#define NOATTR ENODATA
#endif

int sys_get(const char *path, const char *name, uint8_t **value, size_t *length) {
	*value = NULL, *length = 0;
	for (;;) {
		ssize_t size = xget(path, name, NULL, 0);
		if (size >= 0) {
			uint8_t *out = malloc((size_t)size ? (size_t)size : 1);
			if (!out) abort();
			ssize_t got = xget(path, name, out, (size_t)size);
			if (got >= 0) {
				*value = out, *length = (size_t)got;
				return 0;
			}
			free(out);
		}
		if (errno == NOATTR) return 1;
		// it grew between the two calls
		if (errno == ERANGE) continue;
		return -1;
	}
}

int sys_set(const char *path, const char *name, const uint8_t *value, size_t length) {
	int r = xset(path, name, value, length);
#ifdef __linux__
	// Linux allows no user attribute on a link
	if (r == -1 && errno == EPERM) {
		struct stat st;
		if (lstat(path, &st) == 0 && S_ISLNK(st.st_mode)) errno = ENOTSUP;
	}
#endif
	return r;
}

int sys_unset(const char *path, const char *name) {
	if (xremove(path, name) == 0) return 0;
	return errno == NOATTR ? 0 : -1;
}

int sys_names(const char *path, char **names, size_t *length) {
	*names = NULL, *length = 0;
	for (;;) {
		ssize_t size = xlist(path, NULL, 0);
		if (size >= 0) {
			char *out = malloc((size_t)size ? (size_t)size : 1);
			if (!out) abort();
			ssize_t got = xlist(path, out, (size_t)size);
			if (got >= 0) {
				*names = out, *length = (size_t)got;
				return 0;
			}
			free(out);
		}
		if (errno == ERANGE) continue;
		return -1;
	}
}

#ifdef __linux__
#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1 << 0)
#endif
#ifndef RENAME_EXCHANGE
#define RENAME_EXCHANGE (1 << 1)
#endif
#endif

int sys_swap(const char *a, const char *b) {
#ifdef __APPLE__
	return renamex_np(a, b, RENAME_SWAP);
#else
	return renameat2(AT_FDCWD, a, AT_FDCWD, b, RENAME_EXCHANGE);
#endif
}

int sys_rename(const char *from, const char *to) {
#ifdef __APPLE__
	int r = renamex_np(from, to, RENAME_EXCL);
#else
	int r = renameat2(AT_FDCWD, from, AT_FDCWD, to, RENAME_NOREPLACE);
#endif
	if (r == 0) return SYS_DONE;
	return errno == EEXIST ? SYS_TAKEN : -1;
}

#ifdef __APPLE__
int sys_clone(const char *from, const char *to) {
	if (clonefile(from, to, 0) == 0) return 0;
	if (errno != ENOTSUP && errno != EXDEV) return -1;
	// a volume that cannot clone: a copy, attributes and all, only if to is free
	if (copyfile(from, to, NULL, COPYFILE_ALL | COPYFILE_EXCL) == 0) return 0;
	int e = errno;
	if (e != EEXIST) unlink(to);
	errno = e;
	return -1;
}
#else
// to is made only if free, then copied into
int sys_clone(const char *from, const char *to) {
	int in = open(from, O_RDONLY);
	if (in < 0) return -1;
	int out = open(to, O_WRONLY | O_CREAT | O_EXCL, 0666);
	if (out < 0) {
		int e = errno;
		close(in);
		errno = e;
		return -1;
	}
	char buffer[65536];
	int e = 0;
	for (;;) {
		ssize_t n = read(in, buffer, sizeof buffer);
		if (n < 0 && errno == EINTR) continue;
		if (n <= 0) {
			e = n < 0 ? errno : 0;
			break;
		}
		for (ssize_t at = 0; at < n;) {
			ssize_t w = write(out, buffer + at, (size_t)(n - at));
			if (w < 0 && errno == EINTR) continue;
			if (w < 0) {
				e = errno;
				break;
			}
			at += w;
		}
		if (e) break;
	}
	close(in);
	if (close(out) != 0 && !e) e = errno;
	if (e) {
		unlink(to);
		errno = e;
		return -1;
	}
	return 0;
}
#endif

int sys_sync(const char *path) {
	int fd = open(path, O_RDONLY);
	if (fd == -1) return -1;
	// a volume with no F_FULLFSYNC gets fsync
	int ok = -1;
#ifdef F_FULLFSYNC
	ok = fcntl(fd, F_FULLFSYNC);
#endif
	if (ok == -1) ok = fsync(fd);
	int e = errno;
	close(fd);
	errno = e;
	return ok;
}

int sys_id(const char *path, uint64_t *id) {
	struct stat st;
	if (lstat(path, &st) == -1) return -1;
	*id = (uint64_t)st.st_ino;
	return 0;
}

// the fake Trash --------------------------------------------------------------------------------------------------

// makes a folder and the ones above it, as mkdir -p
static int mkdirs(const char *path) {
	char *p = strdup(path);
	if (!p) abort();
	int result = 0;
	for (char *at = p + 1; !result; at++) {
		char saved = *at;
		if (saved == '/' || saved == 0) {
			*at = 0;
			struct stat st;
			if (mkdir(p, 0777) == -1 && (errno != EEXIST || stat(p, &st) == -1 || !S_ISDIR(st.st_mode))) result = -1;
			*at = saved;
		}
		if (saved == 0) break;
	}
	int e = errno;
	free(p);
	errno = e;
	return result;
}

// renames only if nothing is at to, by plain calls: it looks, then renames
static int exclusive(const char *from, const char *to) {
	struct stat st;
	if (lstat(to, &st) == 0) return SYS_TAKEN;
	if (errno != ENOENT) return -1;
	return rename(from, to) == 0 ? SYS_DONE : -1;
}

// moves path into dir under its own name, or "stem 2.ext", "stem 3.ext" and on, by move: SYS_DONE when it moved the entry to
// the name it was given, SYS_TAKEN when the name was not free, -1 with errno. *chosen (malloc'd, if not NULL) is the path
typedef int (*Move)(void *context, const char *from, const char *to);

static int into(const char *dir, const char *path, Move move, void *context, char **chosen) {
	const char *name = strrchr(path, '/') ? strrchr(path, '/') + 1 : path;
	const char *dot = strrchr(name, '.');
	size_t stem = dot && dot > name ? (size_t)(dot - name) : strlen(name);
	const char *ext = dot && dot > name ? dot : "";
	size_t room = strlen(dir) + strlen(name) + 32;
	char *to = malloc(room);
	if (!to) abort();
	for (int n = 1;; n++) {
		if (n == 1) snprintf(to, room, "%s/%s", dir, name);
		else snprintf(to, room, "%s/%.*s %d%s", dir, (int)stem, name, n, ext);
		int r = move(context, path, to);
		if (r != SYS_TAKEN) {
			int e = errno;
			if (r == SYS_DONE && chosen) *chosen = to;
			else free(to);
			errno = e;
			return r;
		}
	}
}

static int plain_move(void *context, const char *from, const char *to) {
	(void)context;
	return exclusive(from, to);
}

int sys_fake(const char *dir, const char *path) {
	if (mkdirs(dir) == -1) return -1;
	return into(dir, path, plain_move, NULL, NULL) == SYS_DONE ? 0 : -1;
}

// the real Trash --------------------------------------------------------------------------------------------------
//
// sys.ts's. macOS: Finder is asked to delete the item over Apple Events (osascript), so Put Back works; a link never goes
// by Finder, which would trash its target. If Finder cannot, NSFileManager's trashItemAtURL (foundation.c); if that
// cannot, the item is moved into <home>/.Trash under a free name. A home that was given has its .Trash alone, and Finder,
// which knows only the person's own, is never asked. Linux: the freedesktop.org trash.

// the person's home folder
static const char *person(void) {
	const char *home = getenv("HOME");
	if (!home || !*home) {
		errno = ENOENT;
		return NULL;
	}
	return home;
}

#ifdef __APPLE__
// asks Finder to trash an entry: true if it is gone from where it was
static bool finder(const char *path) {
	char *const argv[] = {"osascript", "-e", "on run argv", "-e", "set f to (POSIX file (item 1 of argv)) as alias", "-e",
		"tell application \"Finder\" to delete f", "-e", "end run", (char *)path, NULL};
	posix_spawn_file_actions_t actions;
	if (posix_spawn_file_actions_init(&actions) != 0) return false;
	posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0);
	posix_spawn_file_actions_addopen(&actions, 1, "/dev/null", O_WRONLY, 0);
	posix_spawn_file_actions_addopen(&actions, 2, "/dev/null", O_WRONLY, 0);
	pid_t pid;
	int made = posix_spawnp(&pid, "osascript", &actions, NULL, argv, environ);
	posix_spawn_file_actions_destroy(&actions);
	if (made != 0) return false;
	int status;
	while (waitpid(pid, &status, 0) == -1)
		if (errno != EINTR) return false;
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) return false;
	struct stat st;
	return lstat(path, &st) == -1 && errno == ENOENT;
}
#endif

static int bin_move(void *context, const char *from, const char *to) {
	(void)context;
	// rename moves the entry, links and attributes with it, and takes a free name only by looking
	return exclusive(from, to);
}

// the xdg trash's: the info file, made only if free, claims the name
typedef struct {
	const char *info, *text;
} Claim;

static int claim_move(void *context, const char *from, const char *to) {
	const Claim *c = context;
	const char *name = strrchr(to, '/') + 1;
	size_t room = strlen(c->info) + strlen(name) + 16;
	char *file = malloc(room);
	if (!file) abort();
	snprintf(file, room, "%s/%s.trashinfo", c->info, name);
	int fd = open(file, O_WRONLY | O_CREAT | O_EXCL, 0666);
	if (fd == -1) {
		int e = errno;
		free(file);
		errno = e;
		return e == EEXIST ? SYS_TAKEN : -1;
	}
	size_t length = strlen(c->text);
	bool ok = write(fd, c->text, length) == (ssize_t)length;
	int e = errno;
	if (close(fd) != 0 && ok) ok = false, e = errno;
	int r = ok ? exclusive(from, to) : -1;
	if (r != SYS_DONE) {
		// no entry is held by this info file
		if (r == -1 && ok) e = errno;
		unlink(file);
		errno = e;
	}
	free(file);
	return r;
}

// the text of an info file: where the entry was, each part of the path percent-encoded as encodeURIComponent does, and when
static char *trashinfo(const char *path) {
	size_t room = strlen(path) * 3 + 96;
	char *out = malloc(room), *at = out;
	if (!out) abort();
	at += snprintf(at, 20, "[Trash Info]\nPath=");
	for (const unsigned char *p = (const unsigned char *)path; *p; p++) {
		if ((*p >= '0' && *p <= '9') || (*p >= 'A' && *p <= 'Z') || (*p >= 'a' && *p <= 'z') || *p == '/' || strchr("-_.!~*'()", *p))
			*at++ = (char)*p;
		else at += snprintf(at, 4, "%%%02X", *p);
	}
	time_t now = time(NULL);
	struct tm tm;
	localtime_r(&now, &tm);
	at += strftime(at, 40, "\nDeletionDate=%Y-%m-%dT%H:%M:%S\n", &tm);
	return out;
}

int sys_trash_xdg(const char *data, const char *path) {
	size_t room = strlen(data) + 16;
	char *dir = malloc(room), *files = malloc(room + 8), *info = malloc(room + 8);
	if (!dir || !files || !info) abort();
	snprintf(dir, room, "%s/Trash", data);
	snprintf(files, room + 8, "%s/files", dir);
	snprintf(info, room + 8, "%s/info", dir);
	int r = -1;
	if (mkdirs(files) == 0 && mkdirs(info) == 0) {
		char *text = trashinfo(path);
		Claim claim = {info, text};
		r = into(files, path, claim_move, &claim, NULL) == SYS_DONE ? 0 : -1;
		int e = errno;
		free(text);
		errno = e;
	}
	int e = errno;
	free(dir), free(files), free(info);
	errno = e;
	return r;
}

int sys_trash_in(const char *home, const char *path) {
#ifdef __linux__
	if (home) {
		size_t room = strlen(home) + 32;
		char *data = malloc(room);
		if (!data) abort();
		snprintf(data, room, "%s/.local/share", home);
		int r = sys_trash_xdg(data, path), e = errno;
		free(data);
		errno = e;
		return r;
	}
	const char *xdg = getenv("XDG_DATA_HOME");
	if (xdg && *xdg == '/') return sys_trash_xdg(xdg, path);
	const char *me = person();
	if (!me) return -1;
	return sys_trash_in(me, path);
#else
	struct stat st;
	if (lstat(path, &st) == -1) return -1;
	if (!home) {
#ifdef __APPLE__
		if (!S_ISLNK(st.st_mode) && finder(path)) return 0;
		if (fd_trash(path)) return 0;
#endif
		home = person();
		if (!home) return -1;
	}
	size_t room = strlen(home) + 16;
	char *dir = malloc(room);
	if (!dir) abort();
	snprintf(dir, room, "%s/.Trash", home);
	int r = mkdirs(dir) == 0 && into(dir, path, bin_move, NULL, NULL) == SYS_DONE ? 0 : -1;
	int e = errno;
	free(dir);
	errno = e;
	return r;
#endif
}

int sys_trash(const char *path) {
	return sys_trash_in(NULL, path);
}
