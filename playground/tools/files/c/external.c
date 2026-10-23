// external.c: where a store's manifest is. See external.h; the rules are external.ts's.
#include "external.h"

#include "../../../../ermine/encoding/c/cbor.h"
#include "sys.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static char *dup_(const char *s) {
	char *r = strdup(s);
	if (!r) abort();
	return r;
}

static char *format(const char *f, const char *a, const char *b) {
	size_t n = strlen(f) + strlen(a) + (b ? strlen(b) : 0) + 1;
	char *r = malloc(n);
	if (!r) abort();
	snprintf(r, n, f, a, b ? b : "");
	return r;
}

static void ex_uuid(char out[37]) {
	uint8_t b[16];
	FILE *f = fopen("/dev/urandom", "rb");
	if (!f || fread(b, 1, sizeof b, f) != sizeof b) abort();
	fclose(f);
	b[6] = (uint8_t)((b[6] & 0x0F) | 0x40), b[8] = (uint8_t)((b[8] & 0x3F) | 0x80);
	snprintf(out, 37, "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x", b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9],
		b[10], b[11], b[12], b[13], b[14], b[15]);
}

static char *ex_outside(const char *home) {
	return format("%s/.ermine/external", home, NULL);
}

static const fd_foundation *found(const ex_where *w) {
	return w->foundation ? w->foundation : &fd_system;
}

// the home folder: the one given, or the person's; NULL if neither
static const char *home_of(const ex_where *w) {
	if (w->home) return w->home;
	const char *h = getenv("HOME");
	return h && h[0] ? h : NULL;
}

static bool under(const char *path, const char *place) {
	size_t n = strlen(place);
	return strncmp(path, place, n) == 0 && (path[n] == 0 || path[n] == '/');
}

// the path as the system names it; NULL if it is not there
static char *real_(const char *path) {
	char buffer[PATH_MAX];
	if (!realpath(path, buffer)) return NULL;
	return dup_(buffer);
}

// the nearest folder that is there: the path itself, or the first of its parents, as the system names it
static char *nearest(const char *path) {
	char *p = dup_(path);
	for (;;) {
		char *r = real_(p);
		if (r) return free(p), r;
		char *slash = strrchr(p, '/');
		if (!slash || slash == p) return free(p), NULL;
		*slash = 0;
	}
}

static bool isdir(const char *path) {
	struct stat st;
	return stat(path, &st) == 0 && S_ISDIR(st.st_mode);
}

static bool ex_synced(const char *folder, const ex_where *w) {
	const char *home = home_of(w);
	if (!home) return false;
	char *at = nearest(folder), *root = real_(home);
	bool yes = false;
	if (!at || !root) goto done;
	// swaps and clones need the manifest on the folder's volume
	{
		struct stat a, b;
		if (stat(at, &a) != 0 || stat(root, &b) != 0 || a.st_dev != b.st_dev) goto done;
	}
	if (found(w)->ubiquitous(at)) {
		yes = true;
		goto done;
	}
	{
		char *cloud = format("%s/Library/CloudStorage", root, NULL);
		yes = under(at, cloud);
		free(cloud);
		for (size_t i = 0; !yes && i < w->places_length; i++) {
			char *r = real_(w->places[i]);
			if (r) yes = under(at, r);
			free(r);
		}
	}
done:
	free(at), free(root);
	return yes;
}

// the list of stores -----------------------------------------------------------------------------------------------

void ex_stores_free(ex_stored *list, size_t count) {
	for (size_t i = 0; i < count; i++) free(list[i].uuid), free(list[i].path), free(list[i].bookmark);
	free(list);
}

// the whole file; -1 with errno
static int slurp(const char *path, uint8_t **data, size_t *length) {
	int fd = open(path, O_RDONLY);
	if (fd < 0) return -1;
	size_t capacity = 4096, n = 0;
	uint8_t *b = malloc(capacity);
	if (!b) abort();
	for (;;) {
		if (n == capacity) {
			b = realloc(b, capacity *= 2);
			if (!b) abort();
		}
		ssize_t r = read(fd, b + n, capacity - n);
		if (r < 0) {
			if (errno == EINTR) continue;
			int e = errno;
			close(fd), free(b);
			errno = e;
			return -1;
		}
		if (r == 0) break;
		n += (size_t)r;
	}
	close(fd);
	*data = b, *length = n;
	return 0;
}

int ex_stores(const ex_where *w, ex_stored **out, size_t *count) {
	*out = NULL, *count = 0;
	const char *home = home_of(w);
	if (!home) return 0;
	char *dir = ex_outside(home), *file = format("%s/stores", dir, NULL);
	free(dir);
	uint8_t *bytes;
	size_t length;
	int r = slurp(file, &bytes, &length);
	free(file);
	if (r < 0) return errno == ENOENT ? 0 : -1;
	Json *v = cborDecode(bytes, length, NULL, NULL);
	free(bytes);
	if (!v) return errno = EINVAL, -1;
	if (!jsonIsObject(v)) return jsonFree(v), 0;
	ex_stored *list = calloc((size_t)v->object.count + 1, sizeof *list);
	if (!list) abort();
	size_t n = 0;
	for (int i = 0; i < v->object.count; i++) {
		const JsonMember *m = &v->object.members[i];
		if (!jsonIsObject(m->value)) continue;
		const Json *path = jsonGet(m->value, "path"), *bookmark = jsonGet(m->value, "bookmark");
		if (!jsonIsString(path)) continue;
		ex_stored *s = &list[n++];
		s->uuid = malloc(m->keyLength + 1);
		if (!s->uuid) abort();
		memcpy(s->uuid, m->key, m->keyLength), s->uuid[m->keyLength] = 0;
		s->path = dup_(jsonText(path));
		if (bookmark && bookmark->type == JSON_BYTES) {
			s->bookmark = malloc(bookmark->bytes.length ? bookmark->bytes.length : 1);
			if (!s->bookmark) abort();
			memcpy(s->bookmark, bookmark->bytes.data, bookmark->bytes.length);
			s->bookmark_length = bookmark->bytes.length;
		}
	}
	jsonFree(v);
	*out = list, *count = n;
	return 0;
}

// makes a folder and the ones above it
static int mkdirs(const char *path) {
	char *p = dup_(path);
	for (char *at = p + 1;; at++) {
		char saved = *at;
		if (saved == '/' || saved == 0) {
			*at = 0;
			if (mkdir(p, 0777) == -1 && (errno != EEXIST || !isdir(p))) {
				int e = errno;
				free(p);
				errno = e;
				return -1;
			}
			*at = saved;
		}
		if (saved == 0) break;
	}
	free(p);
	return 0;
}

// writes the list whole, through a file of its own and a rename
static int write_list(const char *home, const ex_stored *list, size_t count) {
	char *dir = ex_outside(home);
	if (mkdirs(dir) == -1) return free(dir), -1;
	Json *all = jsonObject();
	for (size_t i = 0; i < count; i++) {
		Json *e = jsonObject();
		jsonAdd(e, "path", jsonString(list[i].path));
		if (list[i].bookmark) jsonAdd(e, "bookmark", jsonBytes(list[i].bookmark, list[i].bookmark_length));
		jsonAdd(all, list[i].uuid, e);
	}
	size_t length;
	const char *why;
	unsigned char *body = NULL;
	bool ok = cborEncode(all, NULL, 0, &length, &why);
	if (ok) {
		body = malloc(length ? length : 1);
		if (!body) abort();
		ok = cborEncode(all, body, length, &length, &why);
	}
	jsonFree(all);
	if (!ok) return free(body), free(dir), errno = EINVAL, -1;
	char u[37];
	ex_uuid(u);
	char *tmp = format("%s/stores.%s", dir, u), *file = format("%s/stores", dir, NULL);
	free(dir);
	int fd = open(tmp, O_WRONLY | O_CREAT | O_EXCL, 0666), r = fd < 0 ? -1 : 0;
	for (size_t at = 0; r == 0 && at < length;) {
		ssize_t w = write(fd, body + at, length - at);
		if (w < 0) {
			if (errno != EINTR) r = -1;
			continue;
		}
		at += (size_t)w;
	}
	if (fd >= 0 && close(fd) == -1) r = -1;
	if (r == 0) r = rename(tmp, file);
	int e = errno;
	free(body), free(tmp), free(file);
	errno = e;
	return r;
}

char *ex_find(const char *uuid, const ex_where *w) {
	const char *home = home_of(w);
	if (!home) return NULL;
	ex_stored *list;
	size_t n;
	if (ex_stores(w, &list, &n) != 0) return NULL;
	char *out = NULL;
	for (size_t i = 0; i < n && !out; i++) {
		if (strcmp(list[i].uuid, uuid) != 0) continue;
		char *led = list[i].bookmark ? found(w)->resolve(list[i].bookmark, list[i].bookmark_length) : NULL;
		char *trash_path = format("%s/.Trash", home, NULL);
		char *trash = real_(trash_path);
		for (int k = 0; k < 2 && !out; k++) {
			const char *p = k == 0 ? led : list[i].path;
			if (!p) continue;
			char *r = real_(p);
			if (r && !under(r, trash ? trash : trash_path) && isdir(r)) out = r;
			else free(r);
		}
		free(led), free(trash), free(trash_path);
	}
	ex_stores_free(list, n);
	return out;
}

int ex_note(const char *uuid, const char *folder, const ex_where *w) {
	const char *home = home_of(w);
	if (!home) return 0;
	char *at = real_(folder);
	if (!at) at = dup_(folder);
	ex_stored *list;
	size_t n;
	if (ex_stores(w, &list, &n) != 0) return free(at), -1;
	ex_stored *had = NULL;
	for (size_t i = 0; i < n; i++)
		if (strcmp(list[i].uuid, uuid) == 0) had = &list[i];
	if (had && strcmp(had->path, at) == 0 && had->bookmark) return free(at), ex_stores_free(list, n), 0;
	uint8_t *bookmark = NULL;
	size_t bookmark_length = 0;
	if (!found(w)->bookmark(at, &bookmark, &bookmark_length)) bookmark = NULL;
	if (!had) {
		list = realloc(list, (n + 1) * sizeof *list);
		if (!list) abort();
		had = &list[n++];
		*had = (ex_stored){dup_(uuid), NULL, NULL, 0};
	}
	free(had->path), free(had->bookmark);
	had->path = at, had->bookmark = bookmark, had->bookmark_length = bookmark_length;
	int r = write_list(home, list, n), e = errno;
	ex_stores_free(list, n);
	errno = e;
	return r;
}

// the store's uuid a folder carries, or NULL; -1 with errno for what is not that it has none (a missing folder)
static int carried(const char *folder, char **uuid) {
	*uuid = NULL;
	uint8_t *b;
	size_t n;
	int r = sys_get(folder, SYS_STORE, &b, &n);
	if (r < 0) return -1;
	if (r > 0) return 0;
	// a uuid names a folder in ~/.ermine/external: one that is no name there ("", "." or "..", or "/" or NUL in it) is
	// none, and the folder a store with no uuid
	bool name = n > 0 && !(n == 1 && b[0] == '.') && !(n == 2 && b[0] == '.' && b[1] == '.') && !memchr(b, '/', n) &&
		!memchr(b, 0, n);
	if (!name) return free(b), 0;
	*uuid = malloc(n + 1);
	if (!*uuid) abort();
	memcpy(*uuid, b, n), (*uuid)[n] = 0;
	free(b);
	return 0;
}

// whether a folder carrying a uuid is a copy: the list leads that uuid to another folder that is there
static bool copied(const char *uuid, const char *folder, const ex_where *w) {
	const char *home = home_of(w);
	if (!home) return false;
	ex_stored *list;
	size_t n;
	if (ex_stores(w, &list, &n) != 0) return false;
	const ex_stored *s = NULL;
	for (size_t i = 0; i < n; i++)
		if (strcmp(list[i].uuid, uuid) == 0) s = &list[i];
	bool yes = false;
	if (s) {
		char *led = s->bookmark ? found(w)->resolve(s->bookmark, s->bookmark_length) : NULL;
		char *r = real_(led ? led : s->path), *mine = real_(folder);
		if (r && !(mine && strcmp(r, mine) == 0)) {
			char *trash_path = format("%s/.Trash", home, NULL), *trash = real_(trash_path);
			if (!under(r, trash ? trash : trash_path) && isdir(r)) {
				yes = true;
				// a path alone is a store's only if the folder there carries the uuid still
				if (!led) {
					char *there;
					yes = carried(r, &there) == 0 && there && strcmp(there, uuid) == 0;
					free(there);
				}
			}
			free(trash), free(trash_path);
		}
		free(led), free(r), free(mine);
	}
	ex_stores_free(list, n);
	return yes;
}

// where a manifest is ------------------------------------------------------------------------------------------------

static bool has(const char *dir) {
	char *m = format("%s/manifest", dir, NULL);
	struct stat st;
	bool yes = lstat(m, &st) == 0 && S_ISREG(st.st_mode);
	free(m);
	return yes;
}

static int copy_tree(const char *from, const char *to) {
	if (mkdir(to, 0777) == -1) return -1;
	DIR *d = opendir(from);
	if (!d) return -1;
	int r = 0;
	for (struct dirent *e; r == 0 && (e = readdir(d));) {
		if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
		char *a = format("%s/%s", from, e->d_name), *b = format("%s/%s", to, e->d_name);
		struct stat st;
		if (lstat(a, &st) == -1) r = -1;
		else if (S_ISDIR(st.st_mode)) r = copy_tree(a, b);
		else if (S_ISLNK(st.st_mode)) {
			char target[PATH_MAX];
			ssize_t n = readlink(a, target, sizeof target - 1);
			if (n < 0) r = -1;
			else target[n] = 0, r = symlink(target, b);
		} else {
			int in = open(a, O_RDONLY), out = in < 0 ? -1 : open(b, O_WRONLY | O_CREAT | O_EXCL, st.st_mode & 0777);
			if (in < 0 || out < 0) r = -1;
			else {
				char buffer[65536];
				for (ssize_t k; r == 0 && (k = read(in, buffer, sizeof buffer)) != 0;) {
					if (k < 0) {
						if (errno != EINTR) r = -1;
						continue;
					}
					for (ssize_t at = 0; r == 0 && at < k;) {
						ssize_t w = write(out, buffer + at, (size_t)(k - at));
						if (w < 0 && errno != EINTR) r = -1;
						else if (w > 0) at += w;
					}
				}
			}
			if (in >= 0) close(in);
			if (out >= 0) close(out);
		}
		free(a), free(b);
	}
	int e = errno;
	closedir(d);
	errno = e;
	return r;
}

// removes an entry and all it holds; not being there is no error
static int remove_all(const char *path) {
	struct stat st;
	if (lstat(path, &st) == -1) return errno == ENOENT ? 0 : -1;
	if (!S_ISDIR(st.st_mode)) return unlink(path);
	DIR *d = opendir(path);
	if (!d) return -1;
	int r = 0;
	for (struct dirent *e; r == 0 && (e = readdir(d));) {
		if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
		char *p = format("%s/%s", path, e->d_name);
		r = remove_all(p);
		free(p);
	}
	closedir(d);
	return r == 0 ? rmdir(path) : r;
}

static void sync_parent(const char *path) {
	const char *slash = strrchr(path, '/');
	if (!slash) return;
	char *dir = slash == path ? dup_("/") : strndup(path, (size_t)(slash - path));
	// a folder that will not sync is not a store that will not load
	sys_sync(dir);
	free(dir);
}

// moves a folder, by a rename, or across volumes by a copy; a folder of ours already in the way, which holds no manifest,
// is removed
static int move_folder(const char *from, const char *to) {
	const char *slash = strrchr(to, '/');
	if (slash && slash != to) {
		char *up = strndup(to, (size_t)(slash - to));
		int r = mkdirs(up);
		free(up);
		if (r == -1) return -1;
	}
	if (remove_all(to) == -1) return -1;
	if (rename(from, to) == -1) {
		if (errno != EXDEV) return -1;
		if (copy_tree(from, to) == -1 || remove_all(from) == -1) return -1;
	}
	sync_parent(from), sync_parent(to);
	return 0;
}

static void ex_located_free(ex_located *l) {
	free(l->dir), free(l->uuid);
	*l = (ex_located){0};
}

int ex_locate(const char *folder, const ex_where *w, ex_located *out) {
	*out = (ex_located){0};
	char *inside = format("%s/.ermine", folder, NULL);
	const char *home = home_of(w);
	char *uuid;
	if (carried(folder, &uuid) != 0 && errno != ENOENT) return free(inside), -1;
	bool outer = home && ex_synced(folder, w);
	char *base = home ? ex_outside(home) : NULL;
	bool copy = false;
	int r = 0;
	if (uuid && copied(uuid, folder, w)) copy = true, free(uuid), uuid = NULL;
	if (!uuid) {
		// a store with a manifest in it and no uuid, as an app dropped it, keeps its manifest
		bool mine = !copy && has(inside);
		char u[37];
		ex_uuid(u);
		char *dir = outer ? format("%s/%s", base, u) : dup_(inside);
		if (mine && outer) r = move_folder(inside, dir);
		out->dir = dir, out->uuid = dup_(u), out->set = true, out->copy = copy;
		free(inside), free(base);
		if (r) ex_located_free(out);
		return r;
	}
	char *other = outer ? dup_(inside) : format("%s/%s", home ? base : "", uuid);
	char *here = outer ? format("%s/%s", base, uuid) : dup_(inside);
	if (!has(here) && home && has(other)) r = move_folder(other, here);
	free(other), free(inside), free(base);
	if (r) return free(here), free(uuid), -1;
	out->dir = here, out->uuid = uuid;
	return 0;
}
