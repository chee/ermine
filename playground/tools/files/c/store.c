// store.c: a store. See store.h; the rules, and the order of every step, are store.ts's.
//
// An error is thrown as store.ts throws it: a call returns 0, or the kind it threw (T_FS, T_STORE, T_OTHER) with what
// it was in the store, and each place that catches in store.ts looks at the kind. What a Deno call would throw as the
// file system's is T_FS with errno; what sys.ts's calls throw is T_FS too, but only a code sys.ts names is a fault.
//
// What the store keeps between calls is in its own memory: the manifest's records, each node's shape, a bin value's
// first bytes, each file as the store laid it. The layout and the graph the layout library takes are made from those
// when a call needs them and held in layout.h's arena, so a call's answer, in the same arena, lives till st_release.
#ifdef __linux__
#define _GNU_SOURCE
#endif

#include "store.h"

#include "../../../../ermine/encoding/c/cbor.h"
#include "external.h"
#include "foundation.h"
#include "names.h"
#include "sys.h"
#include "../../../../ermine/encoding/c/json_text.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define own layout_own
#define grab layout_grab
#define fmt(...) own(formatString(__VA_ARGS__))

#define TMP ".ermine/tmp"
#define META "meta"
#define NODE "node:"
#define SHOWN "shown:"
#define STORE "store"
#define PLAN "plan"

enum { T_NONE, T_FS, T_STORE, T_OTHER };
typedef enum { R_DONE, R_KEPT, R_GONE, R_LEFT } Result;

#define TRY(x) \
	do { \
		int r_ = (x); \
		if (r_) return r_; \
	} while (0)

// the names passed over unless the host gives others (names.ts's PASS)
static const char *const PASS[] = {".DS_Store", ".localized", "._*", "Icon\r", "*~", "*.swp", "#*#", "4913"};

// keeping ---------------------------------------------------------------------------------------------------------

// an ordered map by string key that lasts, as a JS Map is: setting a key there keeps its place, deleting and setting
// again puts it last. Keys are copied; values are the caller's
typedef struct {
	char *key;
	void *value;
	int next;
	bool live;
} Cell;
typedef struct {
	Cell *items;
	int count, capacity;
	int *buckets;
	int spread, size;
} Map;

static unsigned hashof(const char *s) {
	unsigned h = 2166136261u;
	for (; *s; s++) h = (h ^ (unsigned char)*s) * 16777619u;
	return h;
}

static int where(const Map *m, const char *key) {
	if (!m->spread) return -1;
	for (int i = m->buckets[hashof(key) % (unsigned)m->spread]; i >= 0; i = m->items[i].next)
		if (m->items[i].live && strcmp(m->items[i].key, key) == 0) return i;
	return -1;
}

static void *map_get(const Map *m, const char *key) {
	int i = where(m, key);
	return i < 0 ? NULL : m->items[i].value;
}

// the items again, the dead gone, in an index of the size given
static void reindex(Map *m, int spread) {
	int n = 0;
	for (int i = 0; i < m->count; i++)
		if (m->items[i].live) m->items[n++] = m->items[i];
	m->count = n;
	free(m->buckets);
	m->buckets = malloc((size_t)spread * sizeof *m->buckets);
	if (!m->buckets) abort();
	m->spread = spread;
	for (int b = 0; b < spread; b++) m->buckets[b] = -1;
	for (int i = 0; i < n; i++) {
		unsigned b = hashof(m->items[i].key) % (unsigned)spread;
		m->items[i].next = m->buckets[b];
		m->buckets[b] = i;
	}
}

// sets a key; the value it had, or NULL
static void *map_set(Map *m, const char *key, void *value) {
	int i = where(m, key);
	if (i >= 0) {
		void *old = m->items[i].value;
		m->items[i].value = value;
		return old;
	}
	if (m->count == m->capacity) {
		if (m->size * 2 < m->count) reindex(m, m->spread);
		else {
			m->capacity = m->capacity ? m->capacity * 2 : 16;
			m->items = realloc(m->items, (size_t)m->capacity * sizeof *m->items);
			if (!m->items) abort();
		}
	}
	if (m->count >= m->spread) reindex(m, m->spread ? m->spread * 2 : 16);
	unsigned b = hashof(key) % (unsigned)m->spread;
	m->items[m->count] = (Cell){copyString(key), value, m->buckets[b], true};
	m->buckets[b] = m->count++;
	m->size++;
	return NULL;
}

// removes a key; the value it had, or NULL
static void *map_delete(Map *m, const char *key) {
	int i = where(m, key);
	if (i < 0) return NULL;
	void *old = m->items[i].value;
	m->items[i].live = false;
	free(m->items[i].key);
	m->items[i].key = NULL;
	m->size--;
	return old;
}

#define EACH(m, e) for (Cell *e = (m)->items; e < (m)->items + (m)->count; e++) if (e->live)

static void map_free(Map *m) {
	EACH(m, e) free(e->key);
	free(m->items);
	free(m->buckets);
	*m = (Map){0};
}

// bytes that last
typedef struct {
	size_t length;
	uint8_t data[];
} Bytes;

static Bytes *bytes_new(const uint8_t *data, size_t length) {
	Bytes *b = malloc(sizeof *b + (length ? length : 1));
	if (!b) abort();
	b->length = length;
	if (length) memcpy(b->data, data, length);
	return b;
}

// a file as the store laid it: its size, time and file id, and the value it holds
typedef struct {
	int64_t size, mtime;
	uint64_t ino;
	char hash[65];
} Stat;

// a list that grows, in the arena
typedef struct {
	void *items;
	size_t count, capacity, size;
} Vec;

static void *push(Vec *v) {
	if (v->count == v->capacity) {
		size_t capacity = v->capacity ? v->capacity * 2 : 8;
		void *items = grab(capacity * v->size);
		if (v->count) memcpy(items, v->items, v->count * v->size);
		v->items = items, v->capacity = capacity;
	}
	return (char *)v->items + v->count++ * v->size;
}

// a state: the store record
typedef struct {
	double done;
	char **pass;
	size_t pass_length;
} State;

struct st_store {
	char *folder, *ermine;
	mf_manifest *man;
	st_options options;
	// the manifest's records, each node's shape, a bin value's first bytes, each file as the store laid it
	Map recs, nodes, heads, stats;
	// each link as the store last laid it, by path, its target: the files program's changes to the layout move where a link
	// should lead before the store lays it again, and what the store laid is still its own
	Map pointed;
	// a mirror's values, by hash, as rendered in their form, from the graph the host last gave
	Map held;
	bool mirror;
	// where the manifest is, and the folder's uuid; the list of stores
	ex_where where;
	char *uuid, *home, **places;
	bool set, copy;
	const fd_foundation *native;
	bool coordinating;
	// the graph a mirror is given with its first call
	const st_saving *given;
	char *root;
	double time;
	State state;
	// opened: 0 not yet, 1 opened, 2 failed, as store.ts's rejected promise: every call then throws the same
	int opened;
	bool marked;
	int saved_kind;
	char saved_message[512];
	// the layout and the graph, made from the records when a call needs them; held in the arena
	Omap *layout;
	Graph *graph;
	// what loading found
	st_difference *missed;
	size_t missed_length;
	// values a call made and gave back, freed at release
	Vec scratch;
	// the error thrown last
	int kind, errn;
	bool sys;
	char message[512];
};

typedef st_store S;

// throwing ---------------------------------------------------------------------------------------------------------

// the file system's error, errno as the call just made left it; sys: a call of sys.h's
static int failed(S *s, bool sys) {
	s->kind = T_FS, s->errn = errno, s->sys = sys;
	snprintf(s->message, sizeof s->message, "%s (os error %d)", strerror(s->errn), s->errn);
	return T_FS;
}

static int refuse(S *s, const char *format, ...) __attribute__((format(printf, 2, 3)));
static int refuse(S *s, const char *format, ...) {
	va_list ap;
	va_start(ap, format);
	vsnprintf(s->message, sizeof s->message, format, ap);
	va_end(ap);
	s->kind = T_STORE;
	return T_STORE;
}

static int other(S *s, const char *format, ...) __attribute__((format(printf, 2, 3)));
static int other(S *s, const char *format, ...) {
	va_list ap;
	va_start(ap, format);
	vsnprintf(s->message, sizeof s->message, format, ap);
	va_end(ap);
	s->kind = T_OTHER;
	return T_OTHER;
}

// whether what was thrown is the file system's, which a step lists, rather than one that stops the batch
static bool fault(const S *s, int thrown) {
	return thrown == T_FS && (!s->sys || sys_known(s->errn));
}

// whether it is Deno's NotFound
static bool missing(const S *s, int thrown) {
	return thrown == T_FS && s->errn == ENOENT;
}

// a manifest call's answer, as manifest.ts would have thrown it
static int thrown(S *s, mf_code c, const char *what) {
	switch (c) {
	case MF_OK: return 0;
	case MF_STORE: return refuse(s, "%s", what);
	case MF_FORM: return other(s, "%s: a file that does not read as its form", what);
	case MF_WRONG: return other(s, "%s: a value that is not in its form", what);
	case MF_IO: return failed(s, false);
	}
	return 0;
}

// names ------------------------------------------------------------------------------------------------------------

static const char *keep(const char *text) {
	return own(copyString(text));
}

static const char *join(const char *dir, const char *name) {
	return dir[0] == 0 ? name : fmt("%s/%s", dir, name);
}

static const char *parent(const char *path) {
	const char *slash = strrchr(path, '/');
	return slash ? own(copyStringOfLength(path, (size_t)(slash - path))) : "";
}

static const char *base(const char *path) {
	const char *slash = strrchr(path, '/');
	return slash ? slash + 1 : path;
}

static int depth(const char *path) {
	if (path[0] == 0) return 0;
	int n = 1;
	for (; *path; path++) n += *path == '/';
	return n;
}

static bool within(const char *path, const char *prefix) {
	return strncmp(path, prefix, strlen(prefix)) == 0;
}

// a path from the store's folder, as the system has it: .ermine is the manifest's folder, wherever it is
static const char *abs_(const S *s, const char *path) {
	if (path[0] == 0) return s->folder;
	if (strcmp(path, ".ermine") == 0) return s->ermine;
	if (within(path, ".ermine/")) return fmt("%s%s", s->ermine, path + 7);
	return fmt("%s/%s", s->folder, path);
}

// a path to write at, as abs_ has it, with no link on the way: a folder made a link (by a person, or a plan) is not
// followed out of the store's folder; one is ENOTDIR, a fault, which a step lists
static int onto(S *s, const char *path, const char **out) {
	for (const char *slash = strchr(path, '/'); slash; slash = strchr(slash + 1, '/')) {
		const char *p = fmt("%.*s", (int)(slash - path), path);
		struct stat st;
		if (strcmp(p, ".ermine") != 0 && lstat(abs_(s, p), &st) == 0 && S_ISLNK(st.st_mode)) {
			errno = ENOTDIR;
			return failed(s, false);
		}
	}
	*out = abs_(s, path);
	return 0;
}

static const char *number(double n) {
	char text[32];
	jsonNumberText(n, text);
	return keep(text);
}

// a name's stem and trailing digits, as /^(.*)\.([0-9]+)$/ splits it; false if it has none
static bool dotted(const char *name, size_t *stem) {
	const char *dot = strrchr(name, '.');
	if (!dot || !dot[1]) return false;
	for (const char *p = dot + 1; *p; p++)
		if (*p < '0' || *p > '9') return false;
	*stem = (size_t)(dot - name);
	return true;
}

static int bycp(const void *a, const void *b) {
	return names_bycodepoint(*(const char *const *)a, *(const char *const *)b);
}

// the strings in code point order
static void sortcp(const char **items, size_t count) {
	if (count) qsort(items, count, sizeof *items, bycp);
}

// a text as an attribute holds it: UTF-8, U+0000 as NUL
static const uint8_t *wire(const char *text, size_t *length) {
	size_t n = strlen(text), m = 0;
	uint8_t *out = grab(n + 1);
	for (size_t i = 0; i < n; i++) {
		if ((uint8_t)text[i] == 0xC0 && i + 1 < n && (uint8_t)text[i + 1] == 0x80) out[m++] = 0, i++;
		else out[m++] = (uint8_t)text[i];
	}
	*length = m;
	return out;
}

// text from an attribute, as json.h holds it; NULL if it is not UTF-8
static const char *textof(const uint8_t *bytes, size_t length) {
	char *out = grab(length * 2 + 1);
	size_t m = 0;
	for (size_t i = 0; i < length;) {
		uint8_t c = bytes[i];
		size_t n = c < 0x80 ? 1 : c >= 0xC2 && c < 0xE0 ? 2 : c >= 0xE0 && c < 0xF0 ? 3 : c >= 0xF0 && c < 0xF5 ? 4 : 0;
		if (!n || i + n > length) return NULL;
		for (size_t k = 1; k < n; k++)
			if ((bytes[i + k] & 0xC0) != 0x80) return NULL;
		// no overlong form, no surrogate, nothing past U+10FFFF
		if (c == 0xE0 && bytes[i + 1] < 0xA0) return NULL;
		if (c == 0xED && bytes[i + 1] >= 0xA0) return NULL;
		if (c == 0xF0 && bytes[i + 1] < 0x90) return NULL;
		if (c == 0xF4 && bytes[i + 1] >= 0x90) return NULL;
		if (c == 0) out[m++] = (char)0xC0, out[m++] = (char)0x80;
		else memcpy(out + m, bytes + i, n), m += n;
		i += n;
	}
	out[m] = 0;
	return out;
}

// the entries of a folder, in the order the system gives them; NULL with T_FS if it cannot be read
static int names_of(S *s, const char *path, Strs **out) {
	DIR *d = opendir(abs_(s, path));
	if (!d) return failed(s, false);
	Strs *list = strs_new();
	for (struct dirent *e; (e = readdir(d));) {
		if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
		strs_push(list, keep(e->d_name));
	}
	closedir(d);
	*out = list;
	return 0;
}

// looking at entries -----------------------------------------------------------------------------------------------

// what is at a path, the entry itself and never a link's target
typedef struct {
	bool there, file, dir, link;
	uint64_t ino;
	int64_t size, mtime;
} Fi;

// Deno.lstat, a missing entry answered as not there
static int look(S *s, const char *path, Fi *out) {
	struct stat st;
	*out = (Fi){0};
	if (lstat(abs_(s, path), &st) == -1) {
		if (errno == ENOENT || errno == ENOTDIR) return 0;
		return failed(s, false);
	}
	out->there = true;
	out->file = S_ISREG(st.st_mode), out->dir = S_ISDIR(st.st_mode), out->link = S_ISLNK(st.st_mode);
	out->ino = (uint64_t)st.st_ino, out->size = (int64_t)st.st_size;
#ifdef __APPLE__
	out->mtime = (int64_t)st.st_mtimespec.tv_sec * 1000 + st.st_mtimespec.tv_nsec / 1000000;
#else
	out->mtime = (int64_t)st.st_mtim.tv_sec * 1000 + st.st_mtim.tv_nsec / 1000000;
#endif
	return 0;
}

static int empty(S *s, const char *path, bool *out) {
	Strs *list;
	TRY(names_of(s, path, &list));
	*out = list->count == 0;
	return 0;
}

// the whole file
static int readfile(S *s, const char *abspath, const uint8_t **data, size_t *length) {
	int fd = open(abspath, O_RDONLY);
	if (fd < 0) return failed(s, false);
	size_t capacity = 4096, n = 0;
	// the size it has, and a byte over, so the read that finds the end needs no room made
	struct stat st;
	if (fstat(fd, &st) == 0 && S_ISREG(st.st_mode) && (size_t)st.st_size >= capacity) capacity = (size_t)st.st_size + 1;
	uint8_t *b = grab(capacity);
	for (;;) {
		if (n == capacity) {
			uint8_t *bigger = grab(capacity * 2);
			memcpy(bigger, b, n);
			b = bigger, capacity *= 2;
		}
		ssize_t r = read(fd, b + n, capacity - n);
		if (r < 0) {
			if (errno == EINTR) continue;
			int thrown = failed(s, false);
			close(fd);
			return thrown;
		}
		if (r == 0) break;
		n += (size_t)r;
	}
	close(fd);
	*data = b, *length = n;
	return 0;
}

// Deno.writeFile with createNew: a new file, never through one there (a link there is not followed)
static int writefile(S *s, const char *abspath, const uint8_t *data, size_t length) {
	int fd = open(abspath, O_WRONLY | O_CREAT | O_EXCL, 0666);
	if (fd < 0) return failed(s, false);
	for (size_t at = 0; at < length;) {
		ssize_t w = write(fd, data + at, length - at);
		if (w < 0) {
			if (errno == EINTR) continue;
			int thrown = failed(s, false);
			close(fd);
			return thrown;
		}
		at += (size_t)w;
	}
	if (close(fd) == -1) return failed(s, false);
	return 0;
}

// Deno.remove: a file, a link or an empty folder
static int remove_(S *s, const char *path) {
	struct stat st;
	const char *a;
	TRY(onto(s, path, &a));
	if (lstat(a, &st) == -1) return failed(s, false);
	if (S_ISDIR(st.st_mode) ? rmdir(a) == -1 : unlink(a) == -1) return failed(s, false);
	return 0;
}

static int readlink_(S *s, const char *path, const char **target) {
	size_t capacity = 256;
	for (;;) {
		char *b = grab(capacity);
		ssize_t n = readlink(abs_(s, path), b, capacity);
		if (n < 0) return failed(s, false);
		if ((size_t)n < capacity) {
			b[n] = 0;
			*target = b;
			return 0;
		}
		capacity *= 2;
	}
}

// the sys.h calls, thrown as sys.ts throws them
static int get_(S *s, const char *path, const char *name, const uint8_t **value, size_t *length) {
	uint8_t *v;
	int r = sys_get(abs_(s, path), name, &v, length);
	if (r < 0) return failed(s, true);
	if (r > 0) return *value = NULL, 0;
	own((char *)v);
	*value = v;
	return 0;
}

static int set_(S *s, const char *path, const char *name, const uint8_t *value, size_t length) {
	const char *a;
	TRY(onto(s, path, &a));
	return sys_set(a, name, value, length) == -1 ? failed(s, true) : 0;
}

static int unset_(S *s, const char *path, const char *name) {
	const char *a;
	TRY(onto(s, path, &a));
	return sys_unset(a, name) == -1 ? failed(s, true) : 0;
}

// the names of an entry's attributes
static int attrs_of(S *s, const char *path, Strs **out) {
	char *names;
	size_t length;
	if (sys_names(abs_(s, path), &names, &length) == -1) return failed(s, true);
	own(names);
	Strs *list = strs_new();
	for (size_t at = 0; at < length; at += strlen(names + at) + 1) strs_push(list, names + at);
	*out = list;
	return 0;
}

static int sync_(S *s, const char *path) {
	return sys_sync(abs_(s, path)) == -1 ? failed(s, true) : 0;
}

// writes of entries a person sees go through NSFileCoordinator; those in tmp, id and values are no one's
static bool seen(const char *path) {
	if (!within(path, ".ermine/")) return true;
	static const char *const own_[] = {"tmp", "id", "values"};
	for (size_t i = 0; i < sizeof own_ / sizeof *own_; i++) {
		size_t n = strlen(own_[i]);
		if (strncmp(path + 8, own_[i], n) == 0 && (path[8 + n] == 0 || path[8 + n] == '/')) return false;
	}
	return true;
}

// runs fn(context) under the coordinator for the entry at path, if the store coordinates and a person sees the entry
static int guard(S *s, const char *path, unsigned how, int (*fn)(void *), void *context) {
	if (!s->coordinating || !seen(path)) return fn(context);
	return s->native->coordinate(abs_(s, path), true, how, fn, context);
}

typedef struct {
	S *s;
	const char *a, *b;
	bool *taken;
} Move;

static int swapping(void *context) {
	Move *m = context;
	const char *a, *b;
	TRY(onto(m->s, m->a, &a));
	TRY(onto(m->s, m->b, &b));
	return sys_swap(a, b) == -1 ? failed(m->s, true) : 0;
}

static int swap_(S *s, const char *a, const char *b) {
	Move m = {s, a, b, NULL};
	return guard(s, b, FD_REPLACING, swapping, &m);
}

static int renaming(void *context) {
	Move *m = context;
	const char *a, *b;
	TRY(onto(m->s, m->a, &a));
	TRY(onto(m->s, m->b, &b));
	int r = sys_rename(a, b);
	if (r < 0) return failed(m->s, true);
	*m->taken = r == SYS_TAKEN;
	return 0;
}

static int merging(void *context) {
	Move *m = context;
	return guard(m->s, m->b, FD_MERGING, renaming, m);
}

// renames only if nothing is there: 0 and *taken false, or *taken true
static int rename_(S *s, const char *from, const char *to, bool *taken) {
	Move m = {s, from, to, taken};
	return guard(s, from, FD_MOVING, merging, &m);
}

// the encoding of an attribute holding the holder and the name of a slot: CBOR of [holder, name]
static const uint8_t *slotof(const char *holder, const char *name, size_t *length) {
	Json *a = jsonArray();
	jsonPush(a, jsonString(holder)), jsonPush(a, jsonString(name));
	cborEncode(a, NULL, 0, length, NULL);
	uint8_t *out = grab(*length);
	cborEncode(a, out, *length, length, NULL);
	jsonFree(a);
	return out;
}

// the notification of what a store lists
static void list(S *s, const char *path, const char *why) {
	if (s->options.list) s->options.list(s->options.list_context, path, why);
}

// records and the layout's shapes -----------------------------------------------------------------------------------

static const char *text(const Json *j) {
	const char *t = jsonText(j);
	return t ? keep(t) : "";
}

static const char *get(const Json *o, const char *key) {
	return text(jsonGet(o, key));
}

// an object's members in the order JavaScript's Object.entries gives: array indexes ascending, then the rest as given
static const JsonMember **members(const Json *o, int *count) {
	*count = jsonIsObject(o) ? o->object.count : 0;
	const JsonMember **out = grab((size_t)(*count + 1) * sizeof *out);
	int n = 0;
	// an array index: a canonical decimal below 2^32 - 1
	int *index = grab((size_t)(*count + 1) * sizeof *index);
	for (int i = 0; i < *count; i++) {
		const char *k = o->object.members[i].key;
		size_t length = strlen(k);
		bool digits = length > 0 && length <= 10 && (k[0] != '0' || length == 1);
		for (size_t j = 0; digits && j < length; j++) digits = k[j] >= '0' && k[j] <= '9';
		index[i] = digits && strtoull(k, NULL, 10) < 4294967295ull;
	}
	for (int i = 0; i < *count; i++)
		if (index[i]) {
			int at = n++;
			while (at > 0 && strtoull(out[at - 1]->key, NULL, 10) > strtoull(o->object.members[i].key, NULL, 10)) out[at] = out[at - 1], at--;
			out[at] = &o->object.members[i];
		}
	for (int i = 0; i < *count; i++)
		if (!index[i]) out[n++] = &o->object.members[i];
	return out;
}

static Strs *strings(const Json *list) {
	Strs *out = strs_new();
	for (int i = 0; jsonIsArray(list) && i < list->array.count; i++) strs_push(out, text(list->array.items[i]));
	return out;
}

static Info infoin(const Json *list) {
	Info info = {0};
	if (!jsonIsArray(list)) return info;
	info.count = list->array.count;
	info.items = grab((size_t)(info.count + 1) * sizeof *info.items);
	for (int i = 0; i < info.count; i++) {
		const Json *t = list->array.items[i];
		info.items[i] = (Item){text(t->array.items[0]), text(t->array.items[1]), text(t->array.items[2])};
	}
	return info;
}

// a layout record from its Json, as manifest.c reads it
static Layout *recin(const Json *t) {
	Layout *r = grab(sizeof *r);
	const Json *home = jsonGet(t, "home");
	if (jsonIsArray(home)) {
		Home *h = grab(sizeof *h);
		*h = (Home){text(home->array.items[0]), text(home->array.items[1]), (int)home->array.items[2]->number};
		r->home = h;
	}
	if (jsonIsString(jsonGet(t, "file"))) r->file = get(t, "file");
	if (jsonIsString(jsonGet(t, "laid"))) r->laid = get(t, "laid");
	if (jsonIsString(jsonGet(t, "was"))) r->was = get(t, "was");
	if (jsonIsArray(jsonGet(t, "sides"))) r->sides = strings(jsonGet(t, "sides"));
	if (jsonIsArray(jsonGet(t, "left"))) r->left = strings(jsonGet(t, "left"));
	const Json *f = jsonGet(t, "folder"), *a = jsonGet(t, "away");
	r->folder = f && f->type == JSON_BOOLEAN && f->boolean;
	r->away = a && a->type == JSON_BOOLEAN && a->boolean;
	const Json *entries = jsonGet(t, "entries");
	if (jsonIsObject(entries)) {
		int n;
		const JsonMember **es = members(entries, &n);
		r->entries = omap_new();
		for (int e = 0; e < n; e++) {
			Entry *entry = grab(sizeof *entry);
			if (jsonIsArray(es[e]->value)) entry->stems = strings(es[e]->value);
			else entry->stem = text(es[e]->value);
			omap_set(r->entries, keep(es[e]->key), entry);
		}
	}
	return r;
}

static Json *list_json(const Strs *s) {
	Json *a = jsonArray();
	for (int i = 0; i < s->count; i++) jsonPush(a, jsonString(s->items[i]));
	return a;
}

static Json *info_json(Info info) {
	Json *a = jsonArray();
	for (int i = 0; i < info.count; i++) {
		Json *t = jsonArray();
		jsonPush(t, jsonString(info.items[i].name)), jsonPush(t, jsonString(info.items[i].hash)), jsonPush(t, jsonString(info.items[i].form));
		jsonPush(a, t);
	}
	return a;
}

static Json *recout(const Layout *r) {
	Json *o = jsonObject();
	if (r->home) {
		Json *a = jsonArray();
		jsonPush(a, jsonString(r->home->holder)), jsonPush(a, jsonString(r->home->name)), jsonPush(a, jsonInteger(r->home->position));
		jsonAdd(o, "home", a);
	}
	if (r->file) jsonAdd(o, "file", jsonString(r->file));
	if (r->laid) jsonAdd(o, "laid", jsonString(r->laid));
	if (r->was) jsonAdd(o, "was", jsonString(r->was));
	if (r->sides) jsonAdd(o, "sides", list_json(r->sides));
	if (r->folder) jsonAdd(o, "folder", jsonBoolean(true));
	if (r->entries) {
		Json *e = jsonObject();
		for (int i = 0; i < r->entries->count; i++) {
			if (!r->entries->entries[i].live) continue;
			const Entry *x = r->entries->entries[i].value;
			jsonAdd(e, r->entries->entries[i].key, x->stems ? list_json(x->stems) : jsonString(x->stem));
		}
		jsonAdd(o, "entries", e);
	}
	if (r->left) jsonAdd(o, "left", list_json(r->left));
	if (r->away) jsonAdd(o, "away", jsonBoolean(true));
	return o;
}

static Json *found_json(Found f) {
	Json *o = jsonObject();
	switch (f.kind) {
	case FOUND_NONE: jsonFree(o); return jsonNull();
	case FOUND_FILE: jsonAdd(o, "file", jsonString(f.text)); break;
	case FOUND_LINK: jsonAdd(o, "link", jsonString(f.text)); break;
	case FOUND_FOLDER: jsonAdd(o, "folder", f.known ? jsonNumber(f.ino) : jsonNull()); break;
	}
	return o;
}

static Json *plan_json(const Step *steps, int count) {
	Json *plan = jsonArray();
	for (int i = 0; i < count; i++) {
		const Step *s = &steps[i];
		Json *o = jsonObject();
		jsonAdd(o, "number", jsonInteger(s->number));
		jsonAdd(o, "what", jsonString(s->what));
		if (s->from) jsonAdd(o, "from", jsonString(s->from));
		if (s->to) jsonAdd(o, "to", jsonString(s->to));
		jsonAdd(o, "before", found_json(s->before));
		jsonAdd(o, "after", found_json(s->after));
		if (s->id) jsonAdd(o, "id", jsonString(s->id));
		if (s->slot) {
			Json *a = jsonArray();
			jsonPush(a, jsonString(s->holder)), jsonPush(a, jsonString(s->name));
			jsonAdd(o, "slot", a);
		}
		if (s->form) jsonAdd(o, "form", jsonString(s->form));
		if (s->hasinfo) jsonAdd(o, "info", info_json(s->info));
		if (s->side) jsonAdd(o, "side", jsonInteger(s->side));
		jsonPush(plan, o);
	}
	return plan;
}

static Found found_in(const Json *j) {
	Found f = {0};
	if (!jsonIsObject(j)) return f;
	const Json *v;
	if ((v = jsonGet(j, "file"))) f.kind = FOUND_FILE, f.text = text(v);
	else if ((v = jsonGet(j, "link"))) f.kind = FOUND_LINK, f.text = text(v);
	else if ((v = jsonGet(j, "folder"))) {
		f.kind = FOUND_FOLDER;
		if (jsonIsNumber(v)) f.known = true, f.ino = v->number;
	}
	return f;
}

static Step *plan_in(const Json *list, int *count) {
	*count = jsonIsArray(list) ? list->array.count : 0;
	Step *steps = grab((size_t)(*count + 1) * sizeof *steps);
	for (int i = 0; i < *count; i++) {
		const Json *j = list->array.items[i], *v;
		Step *s = &steps[i];
		s->number = (int)jsonGet(j, "number")->number;
		s->what = get(j, "what");
		if (jsonIsString(jsonGet(j, "from"))) s->from = get(j, "from");
		if (jsonIsString(jsonGet(j, "to"))) s->to = get(j, "to");
		s->before = found_in(jsonGet(j, "before"));
		s->after = found_in(jsonGet(j, "after"));
		if (jsonIsString(jsonGet(j, "id"))) s->id = get(j, "id");
		if ((v = jsonGet(j, "slot")) && jsonIsArray(v)) s->slot = true, s->holder = text(v->array.items[0]), s->name = text(v->array.items[1]);
		if (jsonIsString(jsonGet(j, "form"))) s->form = get(j, "form");
		if ((v = jsonGet(j, "info")) && jsonIsArray(v)) s->hasinfo = true, s->info = infoin(v);
		if ((v = jsonGet(j, "side")) && jsonIsNumber(v)) s->side = (int)v->number;
	}
	return steps;
}

// holds a value made for a call's answer until release
static void hold(S *s, Json *value) {
	Json **at = push(&s->scratch);
	*at = value;
}

// a record's bytes, deterministic CBOR; the Json is the caller's to free
static int encode(S *s, mf_codec codec, const Json *record, const uint8_t **data, size_t *length) {
	sp_bytes b = {0};
	mf_code c = mf_encode(codec, record, &b);
	if (c != MF_OK) return free(b.data), refuse(s, "a record that is not one");
	own((char *)b.data);
	*data = b.data;
	*length = b.length;
	return 0;
}

static int decode(S *s, mf_codec codec, const Bytes *bytes, Json **out) {
	if (mf_decode(codec, bytes->data, bytes->length, out) != MF_OK) return refuse(s, "a record that is not valid");
	return 0;
}

static int encode_layout(S *s, const Layout *r, const uint8_t **data, size_t *length) {
	Json *j = recout(r);
	int thrown = encode(s, MF_SHOWN, j, data, length);
	jsonFree(j);
	return thrown;
}

static int encode_plan(S *s, const Step *steps, int count, const uint8_t **data, size_t *length) {
	Json *j = plan_json(steps, count);
	int thrown = encode(s, MF_PLAN, j, data, length);
	jsonFree(j);
	return thrown;
}

static int encode_state(S *s, double done, const uint8_t **data, size_t *length) {
	Json *j = jsonObject(), *pass = jsonArray();
	for (size_t i = 0; i < s->state.pass_length; i++) jsonPush(pass, jsonString(s->state.pass[i]));
	jsonAdd(j, "format", jsonInteger(1)), jsonAdd(j, "done", jsonNumber(done)), jsonAdd(j, "pass", pass);
	int thrown = encode(s, MF_STATE, j, data, length);
	jsonFree(j);
	return thrown;
}

static int encode_meta(S *s, const char *root, double time, const uint8_t **data, size_t *length) {
	Json *j = jsonObject();
	jsonAdd(j, "root", jsonString(root)), jsonAdd(j, "time", jsonNumber(time));
	int thrown = encode(s, MF_META, j, data, length);
	jsonFree(j);
	return thrown;
}

// the state a record holds
static int state_in(S *s, const Bytes *bytes) {
	Json *j;
	TRY(decode(s, MF_STATE, bytes, &j));
	const Json *pass = jsonGet(j, "pass");
	for (size_t i = 0; i < s->state.pass_length; i++) free(s->state.pass[i]);
	free(s->state.pass);
	s->state.done = jsonGet(j, "done")->number;
	s->state.pass_length = (size_t)pass->array.count;
	s->state.pass = malloc((s->state.pass_length + 1) * sizeof *s->state.pass);
	if (!s->state.pass) abort();
	for (int i = 0; i < pass->array.count; i++) s->state.pass[i] = copyString(jsonText(pass->array.items[i]));
	jsonFree(j);
	return 0;
}

// a frame being made: key -> the mf_record, in the order set
typedef Omap Frame;

static void frame_set(Frame *f, const char *key, const uint8_t *data, size_t length) {
	mf_record *r = grab(sizeof *r);
	key = keep(key);
	*r = (mf_record){key, data, length};
	omap_set(f, key, r);
}

static void frame_null(Frame *f, const char *key) {
	frame_set(f, key, NULL, 0);
}

static const Bytes *rec(const S *s, const char *key) {
	return map_get(&s->recs, key);
}

static bool has(const S *s, const char *key) {
	return where(&s->recs, key) >= 0;
}

static bool same(const Bytes *a, const uint8_t *b, size_t length) {
	return a && a->length == length && (length == 0 || memcmp(a->data, b, length) == 0);
}

// what a batch changes in the records
static void apply(S *s, const Frame *f) {
	for (int i = 0; i < f->count; i++) {
		if (!f->entries[i].live) continue;
		const mf_record *r = f->entries[i].value;
		if (r->data) free(map_set(&s->recs, r->key, bytes_new(r->data, r->length)));
		else free(map_delete(&s->recs, r->key));
	}
}

// appends the frame to the manifest
static int append(S *s, const Frame *f) {
	mf_record *rs = grab((size_t)(f->count + 1) * sizeof *rs);
	size_t n = 0;
	for (int i = 0; i < f->count; i++)
		if (f->entries[i].live) rs[n++] = *(const mf_record *)f->entries[i].value;
	return thrown(s, mf_append(s->man, rs, n), "the manifest could not be appended to");
}

// the records as a frame of their own, for a fold
static int fold(S *s) {
	mf_record *rs = grab((size_t)(s->recs.size + 1) * sizeof *rs);
	size_t n = 0;
	EACH(&s->recs, c) {
		const Bytes *b = c->value;
		rs[n++] = (mf_record){c->key, b->data, b->length};
	}
	return thrown(s, mf_fold(s->man, rs, n), "the manifest could not be folded");
}

static const char *keyed(const char *prefix, const char *id) {
	return fmt("%s%s", prefix, id);
}

// a node's shape as the layout takes it
static Node *shapein(const mf_node *m) {
	Node *n = grab(sizeof *n);
	n->hash = keep(m->kept.hash), n->form = m->kept.form;
	if (m->kept.has_head) {
		uint8_t *h = grab(m->kept.head_length ? m->kept.head_length : 1);
		if (m->kept.head_length) memcpy(h, m->kept.head, m->kept.head_length);
		n->head = h, n->length = m->kept.head_length;
	}
	n->nsides = (int)m->sides_length;
	n->sides = grab((m->sides_length + 1) * sizeof *n->sides);
	for (size_t i = 0; i < m->sides_length; i++) {
		const mf_kept *k = &m->sides[i];
		n->sides[i].hash = keep(k->hash), n->sides[i].form = k->form;
		if (k->has_head) {
			uint8_t *h = grab(k->head_length ? k->head_length : 1);
			if (k->head_length) memcpy(h, k->head, k->head_length);
			n->sides[i].head = h, n->sides[i].length = k->head_length;
		}
	}
	n->info.count = (int)m->info_length;
	n->info.items = grab((m->info_length + 1) * sizeof *n->info.items);
	for (size_t i = 0; i < m->info_length; i++) n->info.items[i] = (Item){keep(m->info[i].name), keep(m->info[i].hash), m->info[i].form};
	n->directory = omap_new();
	for (size_t i = 0; i < m->directory_length; i++) {
		Strs *ids = strs_new();
		for (size_t j = 0; j < m->directory[i].length; j++) strs_push(ids, keep(m->directory[i].ids[j]));
		omap_set(n->directory, keep(m->directory[i].name), ids);
	}
	return n;
}

// the graph of a root and the nodes' shapes, those in over taking the place of, or following, the kept ones
static Graph *mkgraph(const S *s, const char *root, const Map *over) {
	Graph *g = grab(sizeof *g);
	g->root = keep(root);
	g->nodes = omap_new();
	EACH(&s->nodes, c) {
		const mf_node *m = over ? map_get(over, c->key) : NULL;
		omap_set(g->nodes, keep(c->key), shapein(m ? m : c->value));
	}
	if (over)
		EACH(over, c) if (where(&s->nodes, c->key) < 0) omap_set(g->nodes, keep(c->key), shapein(c->value));
	return g;
}

static Graph *graph(S *s) {
	if (!s->graph) s->graph = mkgraph(s, s->root, NULL);
	return s->graph;
}

// the layout, from the records
static int layout_of(S *s) {
	if (s->layout) return 0;
	Omap *out = omap_new();
	EACH(&s->recs, c) {
		if (!within(c->key, SHOWN)) continue;
		Json *j;
		TRY(decode(s, MF_SHOWN, c->value, &j));
		omap_set(out, keep(c->key + strlen(SHOWN)), recin(j));
		jsonFree(j);
	}
	s->layout = out;
	return 0;
}

static const char *const *passed(const S *s) {
	return (const char *const *)s->state.pass;
}

static Omap *disk(S *s) {
	return layout_disk(graph(s), s->layout, passed(s), (int)s->state.pass_length);
}

// the entries of a folder, as the probe the layout takes
static const Strs *probe(void *context, const char *folder) {
	S *s = context;
	Strs *names;
	if (names_of(s, folder, &names) != 0) return strs_new();
	return names;
}

static bool ino(void *context, const char *path, double *id) {
	Fi fi;
	if (look(context, path, &fi) != 0 || !fi.there) return false;
	*id = (double)fi.ino;
	return true;
}

// whether an entry the layout does not put at a path is still the store's own: a link it laid there, leading where it
// last pointed
static bool stands(void *context, const char *path) {
	S *s = context;
	const char *to = map_get(&s->pointed, path);
	if (!to) return false;
	char buffer[4096];
	ssize_t n = readlink(abs_(s, path), buffer, sizeof buffer - 1);
	if (n < 0) return false;
	buffer[n] = 0;
	return strcmp(buffer, to) == 0;
}

// the layout of the graph as laid out from the old, the nodes before it being the graph before
static Laying lay(S *s, const Graph *g, const Omap *old, double time, const Graph *before) {
	return layout_lay_owned(g, old, probe, s, time, passed(s), (int)s->state.pass_length, before, ino, s, stands, s);
}

static void point_set(S *s, const char *path, const char *target) {
	free(map_set(&s->pointed, path, copyString(target)));
}

static void point_unset(S *s, const char *path) {
	free(map_delete(&s->pointed, path));
}

// the links a layout lays, as the store laid them: on loading, the folder is taken to be as it says
static void point(S *s, const Omap *want) {
	EACH(&s->pointed, c) free(c->value);
	map_free(&s->pointed);
	for (int i = 0; i < want->count; i++) {
		if (!want->entries[i].live) continue;
		const Laid *l = want->entries[i].value;
		if (l->kind == LAID_LINK) point_set(s, want->entries[i].key, l->target);
	}
}

// keeps where a step done leaves the store's links: a link laid, or one removed or laid over
static void pointing(S *s, const Step *st) {
	if (strcmp(st->what, "link") == 0 && st->after.kind == FOUND_LINK) point_set(s, st->to, st->after.text);
	else if (strcmp(st->what, "remove") == 0 || strcmp(st->what, "rename") == 0) point_unset(s, st->from);
	if (strcmp(st->what, "link") != 0 && strcmp(st->what, "info") != 0 && st->to) point_unset(s, st->to);
}

// a path that is a difference, as a part of a name
static bool passes(const S *s, const char *name) {
	return names_passes(name, passed(s), s->state.pass_length);
}

// looking at what is laid ---------------------------------------------------------------------------------------------

// the hash of the value a file holds, read in its form; false if it does not read
static int hashed(S *s, const char *path, const char *form, char out[65], bool *read) {
	const uint8_t *bytes;
	size_t length;
	*read = false;
	int r = readfile(s, abs_(s, path), &bytes, &length);
	if (r) return fault(s, r) ? 0 : r;
	Json *v;
	if (mf_parse(bytes, length, form, &v) != MF_OK) return 0;
	*read = mf_hash(v, out);
	jsonFree(v);
	return 0;
}

// whether an entry carries the id or the slot a step sets
static int carries(S *s, const char *path, const Step *st, bool *out) {
	const uint8_t *b;
	size_t n;
	*out = false;
	if (st->slot) {
		TRY(get_(s, path, SYS_SLOT, &b, &n));
		if (!b) return 0;
		Json *v = cborDecode(b, n, NULL, NULL);
		*out = v && jsonIsArray(v) && v->array.count >= 2 && jsonIsString(v->array.items[0]) && jsonIsString(v->array.items[1]) &&
			strcmp(jsonText(v->array.items[0]), st->holder) == 0 && strcmp(jsonText(v->array.items[1]), st->name) == 0;
		jsonFree(v);
		return 0;
	}
	if (!st->id) return 0;
	TRY(get_(s, path, SYS_ID, &b, &n));
	const char *id = b ? textof(b, n) : NULL;
	*out = id && strcmp(id, st->id) == 0;
	return 0;
}

// whether what is at a path is what a step expects there: nothing, a file's value, a link's target, a folder
static int fits(S *s, const char *path, const Fi *fi, Found f, const Step *st, bool *out) {
	*out = false;
	if (f.kind == FOUND_NONE) return *out = !fi->there, 0;
	if (!fi->there) return 0;
	if (f.kind == FOUND_FILE) {
		char h[65];
		bool read;
		if (!fi->file) return 0;
		TRY(hashed(s, path, st->form ? st->form : "bin", h, &read));
		*out = read && strcmp(h, f.text) == 0;
		return 0;
	}
	if (f.kind == FOUND_LINK) {
		const char *target;
		if (!fi->link) return 0;
		TRY(readlink_(s, path, &target));
		*out = strcmp(target, f.text) == 0;
		return 0;
	}
	if (!fi->dir) return 0;
	if (f.known) return *out = (double)fi->ino == f.ino, 0;
	return carries(s, path, st, out);
}

// writing entries --------------------------------------------------------------------------------------------------

static int mark(S *s, const char *path, const char *id) {
	size_t n;
	const uint8_t *v = wire(id, &n);
	int r = set_(s, path, SYS_ID, v, n);
	// Linux allows no attribute on a link
	if (r && s->errn == ENOTSUP) return 0;
	return r;
}

// a value as its file shows it: its kept file's, read and rendered, or, for a mirror, the graph's the host gave
static int shows(S *s, const char *hash, const char *form, const uint8_t **data, size_t *length) {
	char none[65];
	mf_null(none);
	if (s->mirror && strcmp(hash, none) != 0) {
		const Bytes *b = map_get(&s->held, hash);
		if (!b) return errno = ENOENT, failed(s, false);
		*data = b->data, *length = b->length;
		return 0;
	}
	Json *v = NULL;
	sp_bytes b = {0};
	int r = 0;
	if (s->mirror) v = jsonNull();
	else r = thrown(s, mf_get(s->man, hash, form, &v), "a kept file is missing or wrong");
	if (!r) r = thrown(s, mf_render(v, form, &b), "info that cannot be shown");
	jsonFree(v);
	if (r) return free(b.data), r;
	own((char *)b.data);
	*data = b.data, *length = b.length;
	return 0;
}

// sets a node's info on an entry, and removes what it no longer has; one that does not fit is listed at the path it is shown at
static int inform(S *s, const char *path, Info info, const char *at) {
	Strs *had;
	int r = attrs_of(s, path, &had);
	if (r) return s->errn == ENOTSUP ? 0 : r;
	for (int i = 0; i < had->count; i++) {
		if (!within(had->items[i], SYS_INFO)) continue;
		bool now = false;
		for (int k = 0; k < info.count && !now; k++) now = strcmp(fmt(SYS_INFO "%s", info.items[k].name), had->items[i]) == 0;
		if (!now) TRY(unset_(s, path, had->items[i]));
	}
	for (int i = 0; i < info.count; i++) {
		const Item *x = &info.items[i];
		const uint8_t *shown;
		size_t shown_length;
		r = shows(s, x->hash, x->form, &shown, &shown_length);
		if (!r) r = set_(s, path, fmt(SYS_INFO "%s", x->name), shown, shown_length);
		if (r) {
			if (!fault(s, r)) return r;
			char *name = jsonPrint(&(Json){.type = JSON_STRING, .string = (char *)x->name, .stringLength = strlen(x->name)});
			list(s, at, fmt("the info %s does not fit an extended attribute: %s", name, s->message));
			free(name);
		}
	}
	return 0;
}

// copies the attributes that are not ermine's, as Finder's tags, from the entry a new one replaces
static int carry(S *s, const char *from, const char *to) {
	Strs *names;
	int r = attrs_of(s, from, &names);
	for (int i = 0; !r && i < names->count; i++) {
		if (within(names->items[i], SYS_OWN)) continue;
		const uint8_t *v;
		size_t n;
		r = get_(s, from, names->items[i], &v, &n);
		if (!r && v) r = set_(s, to, names->items[i], v, n);
	}
	return r && !fault(s, r) ? r : 0;
}

// a value's file: a clone of its kept file, or, for cbor, its diagnostic notation; null, which a node with no value
// shows, is kept nowhere
static int render(S *s, const char *path, const char *hash, const char *form) {
	char none[65];
	mf_null(none);
	const char *at;
	TRY(onto(s, path, &at));
	if (s->mirror && strcmp(hash, none) != 0) {
		const uint8_t *data;
		size_t length;
		TRY(shows(s, hash, form, &data, &length));
		return writefile(s, at, data, length);
	}
	if (strcmp(hash, none) == 0 || strcmp(form, "cbor") == 0) {
		Json *v;
		sp_bytes b = {0};
		if (strcmp(hash, none) == 0) v = jsonNull();
		else TRY(thrown(s, mf_get(s->man, hash, form, &v), "a kept file is missing or wrong"));
		int r = thrown(s, mf_render(v, "cbor", &b), "a value that has no notation");
		jsonFree(v);
		if (r) return free(b.data), r;
		own((char *)b.data);
		return writefile(s, at, b.data, b.length);
	}
	if (sys_clone(fmt("%s/values/%s", s->ermine, hash), at) == -1) return failed(s, true);
	return 0;
}

// sends an entry to the Trash
static int bin(S *s, const char *path) {
	const char *a;
	TRY(onto(s, path, &a));
	if (s->options.trash) {
		if (s->options.trash(s->options.trash_context, a) == -1) return failed(s, false);
		return 0;
	}
	if (sys_trash_in(s->options.home, a) == -1) return failed(s, true);
	return 0;
}

// sends an entry to the Trash, listed under the path it was shown at; from there, so Put Back returns it there,
// unless that place is taken
static int toss(S *s, const char *path, const char *shown, const char *why) {
	const char *from = path;
	if (strcmp(path, shown) != 0) {
		bool taken = true;
		int r = rename_(s, path, shown, &taken);
		if (r && !fault(s, r)) return r;
		if (!r && !taken) from = shown;
	}
	TRY(bin(s, from));
	list(s, shown, why);
	return 0;
}

// empties a place in tmp: the store's own is removed, a folder holding more goes to the Trash
static int clear_(S *s, const char *path, const char *shown) {
	Fi fi;
	TRY(look(s, path, &fi));
	if (!fi.there) return 0;
	bool none = true;
	if (fi.dir) TRY(empty(s, path, &none));
	if (fi.dir && !none) return toss(s, path, shown, "left in the store's tmp holding entries");
	return remove_(s, path);
}

// keeps a file's size, time and id as the store laid it, so a pass need not read it
static int note(S *s, const char *path, const char *hash) {
	Fi fi;
	TRY(look(s, path, &fi));
	if (!fi.file) {
		free(map_delete(&s->stats, path));
		return 0;
	}
	Stat *k = malloc(sizeof *k);
	if (!k) abort();
	*k = (Stat){fi.size, fi.mtime, fi.ino, {0}};
	memcpy(k->hash, hash, 65);
	free(map_set(&s->stats, path, k));
	return 0;
}

// carrying out a plan ----------------------------------------------------------------------------------------------

static const char *place(double t, const Step *st) {
	return fmt(TMP "/%s.%d", number(t), st->number);
}

static int run(S *s, const Step *st, double t, Result *out);
static int settle(S *s, const Step *st, const char *tp, Result *out);
static int exchange(S *s, const Step *st, const char *tp, Result *out);

// an entry a rename could not place waits in tmp; there it goes to the Trash if it is not all the store's
static int park(S *s, const Step *st, const char *tp) {
	const char *at = st->from;
	if (!within(at, TMP "/")) {
		bool taken;
		TRY(clear_(s, tp, at));
		TRY(rename_(s, at, tp, &taken));
		if (!taken) at = tp;
	}
	Fi fi;
	TRY(look(s, at, &fi));
	if (!fi.there) return 0;
	bool ours;
	if (fi.dir) TRY(empty(s, at, &ours));
	else TRY(fits(s, at, &fi, st->before, st, &ours));
	if (!ours) return toss(s, at, st->from, "an entry the store could not lay out held others' work");
	return 0;
}

// renames a new entry into a place that should be empty; if something is there, ours waits in tmp
static int settle(S *s, const Step *st, const char *tp, Result *out) {
	bool taken;
	TRY(rename_(s, tp, st->to, &taken));
	if (!taken) {
		if (st->after.kind == FOUND_FILE) TRY(note(s, st->to, st->after.text));
		return *out = R_DONE, 0;
	}
	Fi fi;
	bool there;
	TRY(look(s, st->to, &fi));
	TRY(fits(s, st->to, &fi, st->after, st, &there));
	if (there) return *out = R_DONE, 0;
	list(s, st->to, "another entry is where the store lays one");
	return *out = R_LEFT, 0;
}

// looks at what came out of a swap or a rename away, now at out, from back: the store's stays for tmp to be cleared,
// or a folder holding more goes to the Trash; what is already what the store lays is swapped back; a person's file is
// put back; anything else goes to the Trash
static int judge(S *s, const Step *st, const char *out, const char *back, Result *result) {
	Fi fi;
	bool ok;
	TRY(look(s, out, &fi));
	if (!fi.there) return *result = R_DONE, 0;
	TRY(fits(s, out, &fi, st->before, st, &ok));
	// a link the store laid, leading where it last pointed, is its own too
	if (!ok && fi.link && map_get(&s->pointed, back)) {
		const char *target;
		TRY(readlink_(s, out, &target));
		ok = strcmp(target, (const char *)map_get(&s->pointed, back)) == 0;
	}
	if (ok) {
		bool none = true;
		if (fi.dir) TRY(empty(s, out, &none));
		if (fi.dir && !none) TRY(toss(s, out, back, "a folder the store removed held others' entries"));
		return *result = R_DONE, 0;
	}
	if (strcmp(st->what, "remove") != 0) {
		TRY(fits(s, out, &fi, st->after, st, &ok));
		if (ok) {
			TRY(swap_(s, out, back));
			return *result = R_DONE, 0;
		}
	}
	if (fi.file && st->before.kind != FOUND_NONE && st->before.kind != FOUND_FOLDER) {
		// a person's edit, or a file an editor saved through a link: for the files program
		if (strcmp(st->what, "remove") != 0) TRY(swap_(s, out, back));
		else {
			bool taken;
			TRY(rename_(s, out, back, &taken));
			if (taken) TRY(toss(s, out, back, "an edit whose place was taken"));
		}
		return *result = R_KEPT, 0;
	}
	TRY(toss(s, out, back, "not what the store laid"));
	return *result = R_DONE, 0;
}

// swaps a new entry in over the one there, then looks at what came out
static int exchange(S *s, const Step *st, const char *tp, Result *out) {
	int r = swap_(s, tp, st->to);
	if (r) {
		// a person removed it: the store lays nothing there, for the files program to take in
		if (missing(s, r)) {
			Fi fi;
			TRY(look(s, st->to, &fi));
			if (!fi.there) return *out = R_GONE, 0;
		}
		return r;
	}
	TRY(judge(s, st, tp, st->to, out));
	if (*out == R_DONE && st->after.kind == FOUND_FILE) TRY(note(s, st->to, st->after.text));
	return 0;
}

// carries a step out, as laying out does: what it expects before is taken to be there
static int run(S *s, const Step *st, double t, Result *out) {
	const char *tp = place(t, st);
	if (strcmp(st->what, "file") == 0 || strcmp(st->what, "link") == 0) {
		TRY(clear_(s, tp, st->to));
		bool file = st->after.kind == FOUND_FILE;
		if (file) TRY(render(s, tp, st->after.text, st->form));
		else {
			const char *at;
			TRY(onto(s, tp, &at));
			if (symlink(st->after.text, at) == -1) return failed(s, false);
		}
		if (st->id) TRY(mark(s, tp, st->id));
		if (st->side) {
			const char *n = fmt("%d", st->side);
			TRY(set_(s, tp, SYS_SIDE, (const uint8_t *)n, strlen(n)));
		}
		if (st->hasinfo) TRY(inform(s, tp, st->info, st->to));
		if (file) {
			if (st->before.kind != FOUND_NONE) TRY(carry(s, st->to, tp));
			TRY(sync_(s, tp));
		}
		return st->before.kind == FOUND_NONE ? settle(s, st, tp, out) : exchange(s, st, tp, out);
	}
	if (strcmp(st->what, "folder") == 0) {
		TRY(clear_(s, tp, st->to));
		const char *at;
		TRY(onto(s, tp, &at));
		if (mkdir(at, 0777) == -1) return failed(s, false);
		if (st->id) TRY(mark(s, tp, st->id));
		if (st->slot) {
			size_t n;
			const uint8_t *v = slotof(st->holder, st->name, &n);
			TRY(set_(s, tp, SYS_SLOT, v, n));
		}
		if (st->hasinfo) TRY(inform(s, tp, st->info, st->to));
		return settle(s, st, tp, out);
	}
	if (strcmp(st->what, "info") == 0) {
		Fi fi;
		bool ok;
		TRY(look(s, st->to, &fi));
		if (!fi.there) return *out = R_GONE, 0;
		TRY(fits(s, st->to, &fi, st->before, st, &ok));
		if (!ok) return *out = R_KEPT, 0;
		TRY(inform(s, st->to, st->hasinfo ? st->info : (Info){0}, st->to));
		return *out = R_DONE, 0;
	}
	if (strcmp(st->what, "rename") == 0) {
		bool taken;
		int r = rename_(s, st->from, st->to, &taken);
		if (r) {
			// a person moved it away: the files program takes that in
			if (missing(s, r)) {
				Fi fi;
				TRY(look(s, st->from, &fi));
				if (!fi.there) return *out = R_GONE, 0;
			}
			return r;
		}
		if (!taken) {
			// a file that became another node's, as an edit that met a change does, takes its id
			bool into = !within(st->to, TMP "/"), ok = true;
			if (into && st->id) TRY(carries(s, st->to, st, &ok));
			if (into && st->id && !ok) TRY(mark(s, st->to, st->id));
			if (st->before.kind == FOUND_FILE) TRY(note(s, st->to, st->before.text));
			return *out = R_DONE, 0;
		}
		Fi fi;
		bool there;
		TRY(look(s, st->to, &fi));
		TRY(fits(s, st->to, &fi, st->after, st, &there));
		TRY(park(s, st, tp));
		if (there) return *out = R_DONE, 0;
		list(s, st->to, "another entry is where the store lays one");
		return *out = R_LEFT, 0;
	}
	// remove
	{
		TRY(clear_(s, tp, st->from));
		bool taken;
		int r = rename_(s, st->from, tp, &taken);
		if (r) return missing(s, r) ? (*out = R_DONE, 0) : r;
		return judge(s, st, tp, st->from, out);
	}
}

// carries a step out again, as loading does: judged by what is found before and after. then is a later step that
// writes the entry a rename moves, whose after found there means the rename was done
static int redo(S *s, const Step *st, double t, const Step *then, Result *out) {
	const char *tp = place(t, st);
	Fi fi, w;
	bool ok;
	if (strcmp(st->what, "remove") == 0) {
		TRY(look(s, tp, &w));
		if (w.there) return judge(s, st, tp, st->from, out);
		TRY(look(s, st->from, &fi));
		if (fi.there) {
			TRY(fits(s, st->from, &fi, st->before, st, &ok));
			if (ok) return run(s, st, t, out);
		}
		return *out = R_DONE, 0;
	}
	if (strcmp(st->what, "rename") == 0) {
		TRY(look(s, st->to, &fi));
		TRY(fits(s, st->to, &fi, st->after, st, &ok));
		if (ok) return *out = R_DONE, 0;
		if (then) {
			TRY(fits(s, st->to, &fi, then->after, then, &ok));
			if (ok) return *out = R_DONE, 0;
		}
		Fi from;
		TRY(look(s, st->from, &from));
		if (from.there) {
			TRY(fits(s, st->from, &from, st->before, st, &ok));
			if (ok) return run(s, st, t, out);
		}
		if (strcmp(st->to, tp) != 0) {
			TRY(look(s, tp, &w));
			if (w.there) {
				TRY(fits(s, tp, &w, st->before, st, &ok));
				if (ok) return settle(s, st, tp, out);
				Step moved = *st;
				moved.from = tp;
				TRY(park(s, &moved, tp));
			}
		}
		if (within(st->to, TMP "/")) return *out = R_DONE, 0;
		list(s, st->to, "what the store was moving here is not where it was");
		return *out = R_LEFT, 0;
	}
	if (strcmp(st->what, "file") == 0 || strcmp(st->what, "link") == 0) {
		TRY(look(s, st->to, &fi));
		TRY(look(s, tp, &w));
		bool stray = false;
		// what is at tp is neither what the step expects before nor after
		if (w.there) {
			bool b = false, a = false;
			TRY(fits(s, tp, &w, st->before, st, &b));
			if (!b) TRY(fits(s, tp, &w, st->after, st, &a));
			stray = !b && !a;
		}
		TRY(fits(s, st->to, &fi, st->after, st, &ok));
		if (ok) {
			// what came out of a swap and was never looked at
			if (st->before.kind != FOUND_NONE && stray) return judge(s, st, tp, st->to, out);
			if (st->hasinfo) TRY(inform(s, st->to, st->info, st->to));
			return *out = R_DONE, 0;
		}
		TRY(fits(s, st->to, &fi, st->before, st, &ok));
		if (ok) return run(s, st, t, out);
		if (stray) TRY(toss(s, tp, st->to, "not what the store laid"));
		if (!fi.there) return *out = R_GONE, 0;
		if (fi.file && st->before.kind != FOUND_NONE) return *out = R_KEPT, 0;
		list(s, st->to, "another entry is where the store lays one");
		return *out = R_LEFT, 0;
	}
	if (strcmp(st->what, "folder") == 0) {
		TRY(look(s, st->to, &fi));
		TRY(fits(s, st->to, &fi, st->after, st, &ok));
		if (ok) {
			if (st->hasinfo) TRY(inform(s, st->to, st->info, st->to));
			return *out = R_DONE, 0;
		}
		if (!fi.there) return run(s, st, t, out);
		list(s, st->to, "another entry is where the store lays one");
		return *out = R_LEFT, 0;
	}
	// info
	return run(s, st, t, out);
}

// clears tmp: every entry, or a batch's, <time>.<number>
static int sweep(S *s, bool all, double t) {
	Strs *names;
	int r = names_of(s, TMP, &names);
	if (r) return missing(s, r) ? 0 : r;
	const char *batch = all ? "" : number(t);
	for (int i = 0; i < names->count; i++) {
		const char *name = names->items[i];
		size_t stem;
		if (!all && !(dotted(name, &stem) && strlen(batch) == stem && strncmp(name, batch, stem) == 0)) continue;
		const char *path = fmt(TMP "/%s", name);
		TRY(clear_(s, path, path));
	}
	return 0;
}

// lays a batch out and then writes it done: each file left as a person had it keeps was as its laid, each entry not
// laid is in its holder's left, and tmp is cleared of the batch's
static int finish(S *s, const Step *plan, int count, double t, bool again) {
	Result *results = grab((size_t)(count + 1) * sizeof *results);
	Omap *folders = omap_new(), *writes = omap_new();
	// the last step writing each entry, for a rename before it carried out again
	for (int i = 0; i < count; i++)
		if (strcmp(plan[i].what, "file") == 0 || strcmp(plan[i].what, "link") == 0) omap_set(writes, plan[i].to, (void *)&plan[i]);
	for (int i = 0; i < count; i++) {
		const Step *st = &plan[i];
		const Step *then = strcmp(st->what, "rename") == 0 ? omap_get(writes, st->to) : NULL;
		Result r;
		int thrown = again ? redo(s, st, t, then && then->number > st->number ? then : NULL, &r)
				   : run(s, st, t, &r);
		if (thrown) {
			if (!fault(s, thrown)) return thrown;
			list(s, st->to ? st->to : st->from, keep(s->message));
			r = R_LEFT;
		}
		results[i] = r;
		if (r == R_DONE) pointing(s, st);
		if (st->from) omap_set(folders, parent(st->from), folders);
		if (st->to) omap_set(folders, parent(st->to), folders);
	}
	Vec sorted = {0, 0, 0, sizeof(const char *)};
	for (int i = 0; i < folders->count; i++)
		if (folders->entries[i].live) *(const char **)push(&sorted) = folders->entries[i].key;
	sortcp(sorted.items, sorted.count);
	for (size_t i = 0; i < sorted.count; i++) {
		int r = sync_(s, ((const char **)sorted.items)[i]);
		if (r && !fault(s, r)) return r;
	}
	Omap *want = disk(s), *changed = omap_new();
	for (int i = 0; i < count; i++) {
		const Step *st = &plan[i];
		Result r = results[i];
		if (r == R_DONE || strcmp(st->what, "info") == 0) continue;
		if (strcmp(st->what, "file") == 0 && st->id && !st->side) {
			Layout *rec = omap_get(s->layout, st->id);
			if (rec && rec->was) {
				rec->laid = rec->was;
				omap_set(changed, st->id, changed);
			}
			free(map_delete(&s->stats, st->to));
		}
		if (r != R_LEFT || strcmp(st->what, "remove") == 0 || !st->to || within(st->to, TMP "/")) continue;
		const Laid *l = omap_get(want, st->to);
		const char *owner = !l ? NULL : l->kind == LAID_UNION ? l->holder : l->home ? l->home->holder : s->root;
		Layout *rec = owner ? omap_get(s->layout, owner) : NULL;
		bool had = false;
		for (int k = 0; rec && rec->left && k < rec->left->count && !had; k++) had = strcmp(rec->left->items[k], st->to) == 0;
		if (rec && !had) {
			Strs *left = strs_new();
			for (int k = 0; rec->left && k < rec->left->count; k++) strs_push(left, rec->left->items[k]);
			strs_push(left, st->to);
			rec->left = left;
			omap_set(changed, owner, changed);
		}
	}
	for (int i = 0; i < s->layout->count; i++) {
		if (!s->layout->entries[i].live) continue;
		Layout *rec = s->layout->entries[i].value;
		if (!rec->was) continue;
		rec->was = NULL;
		omap_set(changed, s->layout->entries[i].key, changed);
	}
	s->state.done = t;
	if (s->mirror) s->time = t;
	Frame *frame = omap_new();
	const uint8_t *data;
	size_t length;
	TRY(encode_state(s, t, &data, &length));
	frame_set(frame, STORE, data, length);
	for (int i = 0; i < changed->count; i++) {
		if (!changed->entries[i].live) continue;
		const char *id = changed->entries[i].key;
		TRY(encode_layout(s, omap_get(s->layout, id), &data, &length));
		frame_set(frame, keyed(SHOWN, id), data, length);
	}
	if (has(s, PLAN)) frame_null(frame, PLAN);
	TRY(append(s, frame));
	apply(s, frame);
	TRY(sweep(s, false, t));
	if (mf_grown(s->man)) TRY(fold(s));
	return 0;
}

// writing a batch -------------------------------------------------------------------------------------------------

typedef const sd_node *(*Get)(void *context, const char *id);

typedef struct {
	const sd_node **nodes;
	size_t count;
	const char **missing;
	size_t missing_length;
} Reach;

static bool skipping(void *context, const char *id) {
	const st_saving *g = context;
	return g->ephemeral && g->ephemeral(g->context, id);
}

// the nodes reachable from root, by any version of any list, less the ephemeral; and the ids reached with no node
static int reach(S *s, const char *root, Get get, void *context, const st_saving *given, Reach *out) {
	const sd_node *first = get(context, root);
	if (!first) return refuse(s, "the root %s is not loaded", root);
	Vec nodes = {0, 0, 0, sizeof(const sd_node *)}, missed = {0, 0, 0, sizeof(const char *)};
	Omap *seen = omap_new();
	*(const sd_node **)push(&nodes) = first;
	omap_set(seen, root, seen);
	for (size_t i = 0; i < nodes.count; i++) {
		const sd_node *n = ((const sd_node **)nodes.items)[i];
		for (size_t c = 0; c < n->children_length; c++) {
			const sd_object *vs = &n->children[c].object;
			for (size_t v = 0; v < vs->length; v++) {
				const sd_list *l = vs->versions[v].content;
				for (size_t k = 0; l && k < l->length; k++) {
					const char *id = l->items[k].id;
					if (!id || omap_has(seen, id) || (given && skipping((void *)given, id))) continue;
					omap_set(seen, id, seen);
					const sd_node *x = get(context, id);
					if (!x) *(const char **)push(&missed) = id;
					else *(const sd_node **)push(&nodes) = x;
				}
			}
		}
	}
	*out = (Reach){nodes.items, nodes.count, missed.items, missed.count};
	return 0;
}

// sets the root's id in the folder, once, unless it is there
static int marking(S *s) {
	if (s->marked) return 0;
	const uint8_t *id;
	size_t n;
	TRY(get_(s, "", SYS_ID, &id, &n));
	const char *t = id ? textof(id, n) : NULL;
	if (!t || strcmp(t, s->root) != 0) TRY(mark(s, "", s->root));
	s->marked = true;
	return 0;
}

// the layout records a batch changes, with those the files program set since the last, which lay sees as the old
// layout
static int relaid(S *s, const Laying *laying, Omap **out) {
	Omap *changed = omap_copy(laying->changed);
	for (int i = 0; i < laying->layout->count; i++) {
		if (!laying->layout->entries[i].live) continue;
		const char *id = laying->layout->entries[i].key;
		if (omap_has(changed, id)) continue;
		const uint8_t *data;
		size_t length;
		TRY(encode_layout(s, laying->layout->entries[i].value, &data, &length));
		if (!same(rec(s, keyed(SHOWN, id)), data, length)) omap_set(changed, id, laying->layout->entries[i].value);
	}
	*out = changed;
	return 0;
}

static bool ours(const char *key) {
	return strcmp(key, META) == 0 || strcmp(key, STORE) == 0 || strcmp(key, PLAN) == 0 || within(key, NODE) || within(key, SHOWN);
}

// a bin value's first bytes, by its hash
static void head(S *s, const char *hash, const Json *v) {
	if (v->type != JSON_BYTES) return;
	size_t n = v->bytes.length < MF_HEAD ? v->bytes.length : MF_HEAD;
	free(map_set(&s->heads, hash, bytes_new(v->bytes.data, n)));
}

static void free_node(mf_node *m) {
	if (!m) return;
	mf_shape_free(m);
	free(m);
}

static int batch(S *s, const st_saving *given) {
	Reach reached;
	TRY(reach(s, given->root, given->get, given->context, given, &reached));
	Frame *frame = omap_new();
	// the new shapes, by id, that last if the batch is kept
	Map after = {0};
	for (size_t i = 0; i < reached.count; i++) {
		const sd_node *n = reached.nodes[i];
		mf_saving saving;
		int r = thrown(s, mf_save_record(n, skipping, (void *)given, &saving), "a node that cannot be saved");
		if (r) {
			EACH(&after, c) free_node(c->value);
			map_free(&after);
			return r;
		}
		const char *key = keyed(NODE, n->id);
		if (same(rec(s, key), saving.record.data, saving.record.length)) {
			mf_saving_free(&saving);
			continue;
		}
		for (size_t v = 0; !r && v < saving.values_length; v++) {
			mf_kept k;
			r = thrown(s, mf_put(s->man, saving.values[v].value, saving.values[v].hash, &k), "a value that cannot be kept");
			if (!r) head(s, saving.values[v].hash, saving.values[v].value);
		}
		// the shape of a record that is kept
		if (!r) r = thrown(s, mf_saving_shape(&saving), "a node that cannot be saved");
		if (!r) {
			own((char *)saving.record.data);
			frame_set(frame, key, saving.record.data, saving.record.length);
			saving.record.data = NULL;
			mf_node *shape = malloc(sizeof *shape);
			if (!shape) abort();
			*shape = saving.shape;
			saving.shape = (mf_node){0};
			free_node(map_set(&after, n->id, shape));
		}
		mf_saving_free(&saving);
		if (r) {
			EACH(&after, c) free_node(c->value);
			map_free(&after);
			return r;
		}
	}
	int r = 0;
	for (size_t i = 0; !r && i < given->records_length; i++) {
		const mf_record *x = &given->records[i];
		if (ours(x->key)) r = refuse(s, "a host's record \"%s\" is the store's own", x->key);
		else if (x->data) frame_set(frame, x->key, x->data, x->length);
		else frame_null(frame, x->key);
	}
	const uint8_t *data;
	size_t length;
	if (!r && (strcmp(given->root, s->root) != 0 || given->time != s->time)) {
		r = encode_meta(s, given->root, given->time, &data, &length);
		if (!r) frame_set(frame, META, data, length);
	}
	if (r || !frame->size) {
		EACH(&after, c) free_node(c->value);
		map_free(&after);
		return r;
	}
	// the batch is laid out from the graph with the new shapes, as it was before
	const char *root = keep(given->root);
	double t = given->time;
	TRY(layout_of(s));
	Graph *before = mkgraph(s, root, NULL), *now = mkgraph(s, root, &after);
	Laying laying = lay(s, now, s->layout, t, before);
	Omap *changed;
	r = relaid(s, &laying, &changed);
	for (int i = 0; !r && i < changed->count; i++) {
		if (!changed->entries[i].live) continue;
		r = encode_layout(s, changed->entries[i].value, &data, &length);
		if (!r) frame_set(frame, keyed(SHOWN, changed->entries[i].key), data, length);
	}
	const uint8_t *plan = NULL;
	size_t plan_length = 0, state_length = 0;
	const uint8_t *state = NULL;
	if (!r && laying.count) r = encode_plan(s, laying.plan, laying.count, &plan, &plan_length);
	else if (!r) r = encode_state(s, t, &state, &state_length);
	if (!r) {
		if (laying.count) frame_set(frame, PLAN, plan, plan_length);
		else frame_set(frame, STORE, state, state_length);
		r = append(s, frame);
	}
	if (r) {
		EACH(&after, c) free_node(c->value);
		map_free(&after);
		return r;
	}
	// the batch is kept
	apply(s, frame);
	EACH(&after, c) free_node(map_set(&s->nodes, c->key, c->value));
	map_free(&after);
	free(s->root);
	s->root = copyString(root);
	s->time = t;
	s->layout = laying.layout;
	s->graph = NULL;
	TRY(marking(s));
	if (!laying.count) {
		s->state.done = t;
		if (mf_grown(s->man)) TRY(fold(s));
		return 0;
	}
	return finish(s, laying.plan, laying.count, t, false);
}

// a mirror ----------------------------------------------------------------------------------------------------------

// the graph of a root and the shapes of a map, and no others
static Graph *mkgraph_of(const char *root, const Map *shapes) {
	Graph *g = grab(sizeof *g);
	g->root = keep(root);
	g->nodes = omap_new();
	EACH(shapes, c) omap_set(g->nodes, keep(c->key), shapein(c->value));
	return g;
}

static void drop_shapes(Map *shapes) {
	EACH(shapes, c) free_node(c->value);
	map_free(shapes);
}

static void drop_bytes(Map *held) {
	EACH(held, c) free(c->value);
	map_free(held);
}

// the graph a mirror's host gives: each node's shape, and each value rendered in its form, by its hash
static int snapshot(S *s, const st_saving *given, Map *after, Map *known) {
	Reach reached;
	TRY(reach(s, given->root, given->get, given->context, given, &reached));
	for (size_t i = 0; i < reached.count; i++) {
		const sd_node *n = reached.nodes[i];
		mf_saving saving;
		int r = thrown(s, mf_save(n, skipping, (void *)given, &saving), "a node that cannot be saved");
		for (size_t v = 0; !r && v < saving.values_length; v++) {
			const char *hash = saving.values[v].hash;
			if (where(known, hash) >= 0) continue;
			sp_bytes b = {0};
			r = thrown(s, mf_render(saving.values[v].value, mf_form(saving.values[v].value), &b), "a value that has no notation");
			if (!r) map_set(known, hash, bytes_new(b.data, b.length));
			free(b.data);
		}
		if (r) {
			if (r) mf_saving_free(&saving);
			drop_shapes(after), drop_bytes(known);
			return r;
		}
		mf_node *shape = malloc(sizeof *shape);
		if (!shape) abort();
		*shape = saving.shape;
		saving.shape = (mf_node){0};
		free_node(map_set(after, n->id, shape));
		mf_saving_free(&saving);
	}
	return 0;
}

// the graph the host gave is the store's now: its shapes and values
static void install(S *s, Map *after, Map *known, const char *root) {
	drop_shapes(&s->nodes);
	s->nodes = *after;
	drop_bytes(&s->held);
	s->held = *known;
	free(s->root);
	s->root = copyString(root);
	s->graph = NULL;
}

// a mirror's batch: the graph is the host's, so the frame holds only the layout records and the plan, and its time is the
// one after the last done. Each value is read from the graph
static int mirrored(S *s, const st_saving *given) {
	if (given->records_length) return refuse(s, "a mirror keeps no records of the host's");
	Map after = {0}, known = {0};
	TRY(layout_of(s));
	TRY(snapshot(s, given, &after, &known));
	const char *root = keep(given->root);
	double t = s->time + 1;
	Graph *before = mkgraph(s, s->root, NULL), *now = mkgraph_of(root, &after);
	Laying laying = lay(s, now, s->layout, t, before);
	Omap *changed;
	int r = relaid(s, &laying, &changed);
	Frame *frame = omap_new();
	const uint8_t *data;
	size_t length;
	for (int i = 0; !r && i < changed->count; i++) {
		if (!changed->entries[i].live) continue;
		r = encode_layout(s, changed->entries[i].value, &data, &length);
		if (!r) frame_set(frame, keyed(SHOWN, changed->entries[i].key), data, length);
	}
	if (r) return drop_shapes(&after), drop_bytes(&known), r;
	// each value is read from the graph the host gave
	drop_bytes(&s->held);
	s->held = known;
	if (!frame->size && !laying.count) {
		drop_shapes(&s->nodes);
		s->nodes = after;
		free(s->root);
		s->root = copyString(root);
		s->graph = NULL;
		return 0;
	}
	if (laying.count) r = encode_plan(s, laying.plan, laying.count, &data, &length);
	else r = encode_state(s, t, &data, &length);
	if (!r) {
		frame_set(frame, laying.count ? PLAN : STORE, data, length);
		r = append(s, frame);
	}
	if (r) return drop_shapes(&after), r;
	// the batch is kept
	apply(s, frame);
	drop_shapes(&s->nodes);
	s->nodes = after;
	free(s->root);
	s->root = copyString(root);
	s->layout = laying.layout;
	s->graph = NULL;
	TRY(marking(s));
	if (!laying.count) {
		s->state.done = t;
		s->time = t;
		if (mf_grown(s->man)) TRY(fold(s));
		return 0;
	}
	return finish(s, laying.plan, laying.count, t, false);
}

// comparing -------------------------------------------------------------------------------------------------------

// what is at a path, read in the form the layout has for it, or its name gives
typedef struct {
	st_entry entry;
	Fi fi;
	bool there;
} Inspected;

static int inspect(S *s, const char *path, const Laid *was, const Graph *g, Inspected *out) {
	Fi fi;
	*out = (Inspected){0};
	TRY(look(s, path, &fi));
	if (!fi.there) return 0;
	const uint8_t *raw;
	size_t n;
	TRY(get_(s, path, SYS_ID, &raw, &n));
	const char *id = raw ? textof(raw, n) : NULL;
	out->fi = fi, out->there = true;
	st_entry *e = &out->entry;
	*e = (st_entry){0};
	e->id = id, e->ino = fi.ino;
	if (fi.link) {
		e->kind = ST_LINK;
		return readlink_(s, path, &e->target);
	}
	if (fi.dir) {
		e->kind = ST_FOLDER;
		const uint8_t *b;
		TRY(get_(s, path, SYS_SLOT, &b, &n));
		Json *v = b ? cborDecode(b, n, NULL, NULL) : NULL;
		if (v && jsonIsArray(v) && v->array.count == 2 && jsonIsString(v->array.items[0]) && jsonIsString(v->array.items[1])) {
			e->holder = keep(jsonText(v->array.items[0])), e->name = keep(jsonText(v->array.items[1]));
		}
		jsonFree(v);
		return 0;
	}
	// a pipe, a socket or a device is no one's value
	if (!fi.file) return out->there = false, 0;
	e->kind = ST_FILE;
	const char *form = NULL;
	if (was && (was->kind == LAID_FILE || was->kind == LAID_SIDE)) form = was->form;
	else if (was && was->kind == LAID_LINK && strcmp(was->half, "file") == 0) {
		const Node *x = omap_get(g->nodes, was->id);
		form = x ? x->form : NULL;
	} else {
		names_take_result t = names_take(base(path));
		own(t.slot), own(t.form);
		form = t.form;
	}
	if (was && (was->kind == LAID_FILE || was->kind == LAID_SIDE)) {
		const Stat *c = map_get(&s->stats, path);
		if (c && strcmp(c->hash, was->hash) == 0 && c->size == fi.size && c->ino == fi.ino && c->mtime == fi.mtime) {
			e->form = was->form, e->hash = was->hash;
			return 0;
		}
	}
	const uint8_t *bytes;
	size_t length;
	TRY(readfile(s, abs_(s, path), &bytes, &length));
	const char *f = form ? form : "txt";
	Json *value;
	mf_code c = mf_parse(bytes, length, f, &value);
	char h[65];
	if (c == MF_OK) {
		hold(s, value);
		e->form = f, e->value = value;
		e->hash = mf_hash(value, h) ? keep(h) : "";
		return 0;
	}
	if (c != MF_FORM) return thrown(s, c, "a file that cannot be read");
	if (strcmp(f, "txt") == 0) {
		value = jsonBytes(bytes, length);
		hold(s, value);
		e->form = "bin", e->value = value;
		e->hash = mf_hash(value, h) ? keep(h) : "";
		return 0;
	}
	e->form = f, e->why = true;
	return 0;
}

// whether what is found is what the layout has there; a missing id or slot does not count
static bool alike(const Laid *was, const st_entry *now) {
	if (now->id && (was->kind == LAID_UNION || strcmp(now->id, was->id) != 0)) return false;
	switch (was->kind) {
	case LAID_FILE:
	case LAID_SIDE: return now->kind == ST_FILE && now->hash && strcmp(now->hash, was->hash) == 0;
	case LAID_FOLDER: return now->kind == ST_FOLDER;
	case LAID_UNION: return now->kind == ST_FOLDER && (!now->holder || (strcmp(now->holder, was->holder) == 0 && strcmp(now->name, was->name) == 0));
	case LAID_LINK: return now->kind == ST_LINK && strcmp(now->target, was->target) == 0;
	}
	return false;
}

// an entry found as laid: its id or slot set again if an app dropped it, its stat kept
static int settled(S *s, const char *path, const Laid *was, const st_entry *now, const Fi *fi) {
	if (was->kind == LAID_UNION) {
		if (now->kind == ST_FOLDER && !now->holder) {
			size_t n;
			const uint8_t *v = slotof(was->holder, was->name, &n);
			TRY(set_(s, path, SYS_SLOT, v, n));
		}
	} else if (!now->id) TRY(mark(s, path, was->id));
	if (was->kind == LAID_FILE || was->kind == LAID_SIDE) {
		Stat *k = malloc(sizeof *k);
		if (!k) abort();
		*k = (Stat){fi->size, fi->mtime, fi->ino, {0}};
		memcpy(k->hash, was->hash, 65);
		free(map_set(&s->stats, path, k));
	}
	return 0;
}

typedef struct {
	S *s;
	const Graph *g;
	Omap *want, *kids, *seen;
	Strs *left;
	Vec found;
} Compare;

static bool leftof(const Compare *c, const char *path) {
	for (int i = 0; i < c->left->count; i++)
		if (strcmp(c->left->items[i], path) == 0) return true;
	return false;
}

static void found(Compare *c, const char *path, const Laid *was, const st_entry *now) {
	st_difference *d = push(&c->found);
	*d = (st_difference){path, was, now};
}

static int compare(Compare *c, const char *f, bool deep) {
	S *s = c->s;
	if (omap_has(c->seen, f)) return 0;
	omap_set(c->seen, f, c);
	// nothing in .ermine is an edit, but the root's file, compared below
	if (strcmp(f, ".ermine") == 0 || within(f, ".ermine/")) return 0;
	Fi fi;
	if (f[0]) {
		TRY(look(s, f, &fi));
		if (!fi.dir) return 0;
	}
	Strs *here;
	int r = names_of(s, f, &here);
	if (r) return s->errn == ENOENT || s->errn == ENOTDIR ? 0 : r;
	sortcp(here->items, (size_t)here->count);
	const Omap *expect = omap_get(c->kids, f);
	for (int i = 0; i < here->count; i++) {
		const char *name = here->items[i], *p = join(f, name);
		if ((f[0] == 0 && strcmp(name, ".ermine") == 0) || passes(s, name) || leftof(c, p)) continue;
		const Laid *was = expect ? omap_get(expect, name) : NULL;
		Inspected *it = grab(sizeof *it);
		TRY(inspect(s, p, was, c->g, it));
		if (!it->there) continue;
		if (was && alike(was, &it->entry)) {
			TRY(settled(s, p, was, &it->entry, &it->fi));
			if (deep && it->entry.kind == ST_FOLDER) TRY(compare(c, p, true));
			continue;
		}
		found(c, p, was, &it->entry);
	}
	Omap *on = omap_new();
	for (int i = 0; i < here->count; i++) omap_set(on, here->items[i], on);
	for (int i = 0; expect && i < expect->count; i++) {
		if (!expect->entries[i].live) continue;
		const char *name = expect->entries[i].key;
		if (!omap_has(on, name) && !leftof(c, join(f, name))) found(c, join(f, name), expect->entries[i].value, NULL);
	}
	return 0;
}

static int differences(S *s, const char *const *touched, size_t count, bool each, st_difference **out, size_t *length) {
	TRY(layout_of(s));
	Graph *g = graph(s);
	Compare c = {.s = s, .g = g, .want = disk(s), .kids = omap_new(), .seen = omap_new(), .left = strs_new(), .found = {0, 0, 0, sizeof(st_difference)}};
	for (int i = 0; i < s->layout->count; i++) {
		if (!s->layout->entries[i].live) continue;
		const Layout *r = s->layout->entries[i].value;
		for (int k = 0; r->left && k < r->left->count; k++) strs_push(c.left, r->left->items[k]);
	}
	for (int i = 0; i < c.want->count; i++) {
		if (!c.want->entries[i].live) continue;
		const char *p = c.want->entries[i].key;
		if (within(p, ".ermine/")) continue;
		const char *dir = parent(p);
		Omap *m = omap_get(c.kids, dir);
		if (!m) omap_set(c.kids, dir, m = omap_new());
		omap_set(m, base(p), c.want->entries[i].value);
	}
	if (each) {
		for (size_t i = 0; i < count; i++) TRY(compare(&c, touched[i], false));
	} else TRY(compare(&c, "", true));
	// the root's file and its sides, in .ermine
	Strs *inside = strs_new();
	Strs *all;
	int r = names_of(s, ".ermine", &all);
	if (r && s->errn != ENOENT) return r;
	for (int i = 0; !r && i < all->count; i++)
		if (within(all->items[i], "root.")) strs_push(inside, all->items[i]);
	for (int i = 0; i < inside->count; i++) {
		const char *p = fmt(".ermine/%s", inside->items[i]);
		const Laid *was = omap_get(c.want, p);
		Inspected *it = grab(sizeof *it);
		TRY(inspect(s, p, was, g, it));
		if (!it->there) continue;
		if (was && alike(was, &it->entry)) TRY(settled(s, p, was, &it->entry, &it->fi));
		else found(&c, p, was, &it->entry);
	}
	for (int i = 0; i < c.want->count; i++) {
		if (!c.want->entries[i].live) continue;
		const char *p = c.want->entries[i].key;
		if (!within(p, ".ermine/")) continue;
		bool on = false;
		for (int k = 0; k < inside->count && !on; k++) on = strcmp(inside->items[k], base(p)) == 0;
		if (!on) found(&c, p, c.want->entries[i].value, NULL);
	}
	*out = c.found.items, *length = c.found.count;
	return 0;
}

// mending ----------------------------------------------------------------------------------------------------------

typedef struct {
	const char *path;
	int at;
} Todo;

static int bydepth(const void *a, const void *b) {
	const Todo *x = a, *y = b;
	int d = depth(x->path) - depth(y->path);
	if (d) return d;
	int c = names_bycodepoint(x->path, y->path);
	return c ? c : x->at - y->at;
}

typedef struct {
	S *s;
	const Graph *g;
	Omap *want, *changed;
	int n;
} Mend;

static int fix(Mend *m, const char *p) {
	S *s = m->s;
	const Laid *found = omap_get(m->want, p);
	Laid *w = NULL;
	// a file is laid with the graph's value, whatever its laid says
	if (found) {
		w = grab(sizeof *w);
		*w = *found;
		if (w->kind == LAID_FILE) {
			const Node *x = omap_get(m->g->nodes, w->id);
			if (x) w->hash = x->hash, w->form = x->form;
		}
	}
	Inspected *it = grab(sizeof *it);
	TRY(inspect(s, p, w, m->g, it));
	if (it->there && w && alike(w, &it->entry)) return settled(s, p, w, &it->entry, &it->fi);
	// the store's own link, leading where it last pointed, is removed; anything else is trashed
	if (it->there && stands(s, p)) TRY(remove_(s, p));
	else if (it->there) TRY(toss(s, p, p, w ? "not what the store laid" : "not in the graph"));
	if (!w) return 0;
	const char *tp = fmt(TMP "/mend.%d", ++m->n);
	TRY(clear_(s, tp, p));
	if (w->kind == LAID_FILE || w->kind == LAID_SIDE) {
		TRY(render(s, tp, w->hash, w->form));
		TRY(mark(s, tp, w->id));
		if (w->kind == LAID_SIDE) {
			const char *n = fmt("%d", w->side);
			TRY(set_(s, tp, SYS_SIDE, (const uint8_t *)n, strlen(n)));
		} else TRY(inform(s, tp, w->info, p));
		TRY(sync_(s, tp));
	} else if (w->kind == LAID_LINK) {
		const char *at;
		TRY(onto(s, tp, &at));
		if (symlink(w->target, at) == -1) return failed(s, false);
		TRY(mark(s, tp, w->id));
	} else {
		const char *at;
		TRY(onto(s, tp, &at));
		if (mkdir(at, 0777) == -1) return failed(s, false);
		if (w->kind == LAID_FOLDER) {
			TRY(mark(s, tp, w->id));
			TRY(inform(s, tp, w->info, p));
		} else {
			size_t n;
			const uint8_t *v = slotof(w->holder, w->name, &n);
			TRY(set_(s, tp, SYS_SLOT, v, n));
		}
	}
	bool taken;
	TRY(rename_(s, tp, p, &taken));
	if (taken) {
		TRY(clear_(s, tp, p));
		list(s, p, "another entry is where the store lays one");
		return 0;
	}
	TRY(sync_(s, parent(p)));
	if (w->kind == LAID_LINK) point_set(s, p, w->target);
	else point_unset(s, p);
	if (w->kind == LAID_FILE || w->kind == LAID_SIDE) {
		TRY(note(s, p, w->hash));
		Layout *rec = omap_get(s->layout, w->id);
		if (w->kind == LAID_FILE && rec && (!rec->laid || strcmp(rec->laid, w->hash) != 0)) {
			rec->laid = w->hash;
			omap_set(m->changed, w->id, m);
		}
	} else if (w->kind != LAID_LINK) {
		Vec below = {0, 0, 0, sizeof(const char *)};
		for (int i = 0; i < m->want->count; i++)
			if (m->want->entries[i].live && strcmp(parent(m->want->entries[i].key), p) == 0) *(const char **)push(&below) = m->want->entries[i].key;
		sortcp(below.items, below.count);
		for (size_t i = 0; i < below.count; i++) TRY(fix(m, ((const char **)below.items)[i]));
	}
	return 0;
}

static int mend(S *s, const char *const *paths, size_t count, bool each) {
	TRY(layout_of(s));
	Mend m = {.s = s, .g = graph(s), .want = disk(s), .changed = omap_new()};
	Todo *todo;
	size_t n = 0;
	if (each) {
		todo = grab((count + 1) * sizeof *todo);
		for (size_t i = 0; i < count; i++) todo[n++] = (Todo){paths[i], (int)i};
	} else {
		st_difference *d;
		size_t length;
		TRY(differences(s, NULL, 0, false, &d, &length));
		todo = grab((length + 1) * sizeof *todo);
		for (size_t i = 0; i < length; i++) todo[n++] = (Todo){d[i].path, (int)i};
	}
	qsort(todo, n, sizeof *todo, bydepth);
	for (size_t i = 0; i < n; i++) TRY(fix(&m, todo[i].path));
	if (!m.changed->size) return 0;
	Frame *frame = omap_new();
	for (int i = 0; i < m.changed->count; i++) {
		if (!m.changed->entries[i].live) continue;
		const uint8_t *data;
		size_t length;
		const char *id = m.changed->entries[i].key;
		TRY(encode_layout(s, omap_get(s->layout, id), &data, &length));
		frame_set(frame, keyed(SHOWN, id), data, length);
	}
	TRY(append(s, frame));
	apply(s, frame);
	return 0;
}

// loading ----------------------------------------------------------------------------------------------------------

static bool headed(void *context, const char *hash, const uint8_t **head_, size_t *length) {
	const Bytes *b = map_get(&((S *)context)->heads, hash);
	if (!b) return false;
	*head_ = b->data, *length = b->length;
	return true;
}

// the values of a record's hashes, by hash: a map of arena Json
static const Json *valued(void *context, const char *hash) {
	return omap_get(context, hash);
}

static const sd_node *byid(void *context, const char *id) {
	return omap_get(context, id);
}

// whether a time is later than meta's
static bool late(const Json *change, double t) {
	const Json *time = jsonGet(change, "time");
	return jsonIsNumber(time) && time->number > t;
}

static bool lateobject(sd_object o, double t) {
	for (size_t i = 0; i < o.length; i++)
		if (o.versions[i].change && late(o.versions[i].change, t)) return true;
	return false;
}

// what the manifest's codec decoded for an object's versions (each new, the caller's: pack.h): lists are pack's own
static void free_decoded(const sd_object *o, bool lists) {
	for (size_t i = 0; i < o->length; i++) {
		if (!lists) jsonFree((Json *)o->versions[i].content);
		jsonFree((Json *)o->versions[i].change);
		jsonFree((Json *)o->versions[i].because);
	}
}

// the graphs a read restored, with every value decoded into their nodes
static void free_graphs(sp_graph *graphs, size_t count) {
	for (size_t i = 0; i < count; i++) {
		for (size_t k = 0; k < graphs[i].length; k++) {
			const sd_node *n = graphs[i].nodes[k];
			free_decoded(&n->value, false);
			for (size_t e = 0; e < n->info_length; e++) free_decoded(&n->info[e].object, false);
			for (size_t e = 0; e < n->children_length; e++) free_decoded(&n->children[e].object, true);
			jsonFree((Json *)n->header.actor);
			jsonFree((Json *)n->header.cause);
		}
		sp_free(&graphs[i]);
	}
	free(graphs);
}

// the kept files' values a read decoded: each node took its own copy
static void free_values(Omap *values) {
	for (int i = 0; i < values->count; i++)
		if (values->entries[i].live) jsonFree(values->entries[i].value);
}

// the graph the records keep, each value read from its kept file; a StoreError if it is not one
static int restored(S *s, const Map *all, st_restored *out) {
	const Bytes *m = map_get(all, META);
	if (!m) return refuse(s, "the store holds nodes and no meta");
	Json *meta;
	TRY(decode(s, MF_META, m, &meta));
	const char *root = keep(jsonText(jsonGet(meta, "root")));
	double t = jsonGet(meta, "time")->number;
	jsonFree(meta);
	Omap *values = omap_new(), *byId = omap_new();
	sp_graph *graphs = NULL;
	size_t made = 0, capacity = 0;
	int r = 0;
	EACH(all, c) {
		if (!within(c->key, NODE)) continue;
		const Bytes *v = c->value;
		mf_kept *ks;
		size_t kn;
		mf_opened opened;
		if ((r = thrown(s, mf_open_record(v->data, v->length, &opened, &ks, &kn), "a node record that is not one"))) break;
		for (size_t k = 0; !r && k < kn; k++) {
			if (omap_has(values, keep(ks[k].hash))) continue;
			Json *value;
			r = thrown(s, mf_get(s->man, ks[k].hash, ks[k].form, &value), "a kept file is missing or does not hash to its name");
			if (!r) omap_set(values, keep(ks[k].hash), value);
		}
		free(ks);
		if (r) {
			jsonFree(opened.record);
			break;
		}
		if (made == capacity) graphs = realloc(graphs, (capacity = capacity ? capacity * 2 : 8) * sizeof *graphs);
		if (!graphs) abort();
		if ((r = thrown(s, mf_restore_opened(&opened, valued, values, &graphs[made]), "a node record that does not restore"))) break;
		const sd_node *n = graphs[made++].nodes[0];
		if (strcmp(n->id, c->key + strlen(NODE)) != 0) {
			r = refuse(s, "the record %s holds %s", c->key, n->id);
			break;
		}
		bool later = n->header.has_time && (double)n->header.time > t;
		later = later || lateobject(n->value, t);
		for (size_t k = 0; k < n->info_length; k++) later = later || lateobject(n->info[k].object, t);
		for (size_t k = 0; k < n->children_length; k++) later = later || lateobject(n->children[k].object, t);
		if (later) {
			r = refuse(s, "the node %s holds a change later than meta's time", n->id);
			break;
		}
		omap_set(byId, keep(n->id), (void *)n);
	}
	if (!r && !omap_has(byId, root)) r = refuse(s, "the store has no root: %s", root);
	if (r) return free_values(values), free_graphs(graphs, made), r;
	for (int i = 0; i < values->count; i++) {
		if (values->entries[i].live) head(s, values->entries[i].key, values->entries[i].value);
	}
	free_values(values);
	Reach reached;
	if ((r = reach(s, root, byid, byId, NULL, &reached))) return free_graphs(graphs, made), r;
	Omap *shown = omap_new();
	for (size_t i = 0; i < reached.count; i++) omap_set(shown, reached.nodes[i]->id, shown);
	Vec others = {0, 0, 0, sizeof(const sd_node *)};
	for (int i = 0; i < byId->count; i++)
		if (byId->entries[i].live && !omap_has(shown, byId->entries[i].key)) *(const sd_node **)push(&others) = byId->entries[i].value;
	*out = (st_restored){.root = copyString(root), .time = t, .nodes = reached.nodes, .nodes_length = reached.count, .others = others.items,
		.others_length = others.count, .missing = reached.missing, .missing_length = reached.missing_length, .graphs = graphs, .graphs_length = made};
	return 0;
}

void st_restored_free(st_restored *r) {
	free(r->root);
	free_graphs(r->graphs, r->graphs_length);
	*r = (st_restored){.none = true};
}

// a folder with no manifest: a new store, if it holds nothing a host could lose
static int fresh(S *s) {
	Strs *found;
	int r = names_of(s, "", &found);
	if (r) {
		if (s->errn != ENOENT) return r;
		found = strs_new();
	}
	int others = 0;
	for (int i = 0; i < found->count; i++)
		if (strcmp(found->items[i], ".ermine") != 0 && !passes(s, found->items[i])) others++;
	if (others && !s->options.files) {
		return refuse(s, "%s holds %d entries and no store: only a host running the files program takes them in", s->folder, others);
	}
	// the folder and the ones above it
	{
		char *p = copyString(s->folder);
		for (char *at = p + 1;; at++) {
			char saved = *at;
			if (saved == '/' || saved == 0) {
				*at = 0;
				struct stat st;
				if (mkdir(p, 0777) == -1 && (errno != EEXIST || stat(p, &st) == -1 || !S_ISDIR(st.st_mode))) {
					int thrown_ = failed(s, false);
					free(p);
					return thrown_;
				}
				*at = saved;
			}
			if (saved == 0) break;
		}
		free(p);
	}
	// a copy's manifest is another store's: it goes to the Trash, and the copy is a store of its own
	if (s->copy) {
		Fi fi;
		TRY(look(s, ".ermine", &fi));
		if (fi.there) {
			TRY(bin(s, ".ermine"));
			list(s, ".ermine", "the manifest of the store this folder is a copy of");
		}
	}
	TRY(thrown(s, mf_make_kept(s->man, !s->mirror), "the manifest's folder could not be made"));
	const uint8_t *v = NULL;
	size_t n;
	if (!s->set) TRY(get_(s, "", SYS_STORE, &v, &n));
	if (s->set || !v) TRY(set_(s, "", SYS_STORE, (const uint8_t *)s->uuid, strlen(s->uuid)));
	s->missed = NULL, s->missed_length = 0;
	if (others) {
		st_difference *d;
		size_t length;
		TRY(layout_of(s));
		TRY(differences(s, NULL, 0, false, &d, &length));
		s->missed = d, s->missed_length = length;
	}
	return 0;
}

// drops the layout records that do not fit the graph, lays it out again, and sends to the Trash what they laid
static int refit(S *s) {
	Graph *g = graph(s);
	Omap *fit = layout_prune(g, s->layout);
	Vec dropped = {0, 0, 0, sizeof(const char *)};
	for (int i = 0; i < s->layout->count; i++)
		if (s->layout->entries[i].live && !omap_has(fit, s->layout->entries[i].key)) *(const char **)push(&dropped) = s->layout->entries[i].key;
	Omap *was = dropped.count ? disk(s) : NULL;
	double tick = s->mirror ? s->time + 1 : s->time;
	Laying laying = lay(s, g, fit, tick, g);
	if (!dropped.count && !laying.changed->size && !laying.count) return 0;
	Frame *frame = omap_new();
	const uint8_t *data;
	size_t length;
	for (size_t i = 0; i < dropped.count; i++) frame_null(frame, keyed(SHOWN, ((const char **)dropped.items)[i]));
	for (int i = 0; i < laying.changed->count; i++) {
		if (!laying.changed->entries[i].live) continue;
		TRY(encode_layout(s, laying.changed->entries[i].value, &data, &length));
		frame_set(frame, keyed(SHOWN, laying.changed->entries[i].key), data, length);
	}
	if (laying.count) {
		TRY(encode_plan(s, laying.plan, laying.count, &data, &length));
		frame_set(frame, PLAN, data, length);
	}
	TRY(append(s, frame));
	apply(s, frame);
	s->layout = laying.layout;
	TRY(finish(s, laying.plan, laying.count, tick, false));
	if (!was) return 0;
	Omap *now = disk(s);
	Vec old = {0, 0, 0, sizeof(Todo)};
	for (int i = 0; i < was->count; i++) {
		if (!was->entries[i].live || omap_has(now, was->entries[i].key)) continue;
		Todo *t = push(&old);
		*t = (Todo){was->entries[i].key, (int)old.count};
	}
	// by depth alone; the order they were in otherwise
	Todo *items = old.items;
	for (size_t i = 0; i < old.count; i++) items[i].at = (int)i;
	for (size_t i = 1; i < old.count; i++) {
		Todo x = items[i];
		size_t k = i;
		while (k > 0 && depth(items[k - 1].path) > depth(x.path)) items[k] = items[k - 1], k--;
		items[k] = x;
	}
	for (size_t i = 0; i < old.count; i++) {
		Fi fi;
		TRY(look(s, items[i].path, &fi));
		if (fi.there) TRY(toss(s, items[i].path, items[i].path, "laid out by a layout record that did not fit the graph"));
	}
	return 0;
}

static int mended(S *s);

// loads a mirror: the layout records, and the graph the host gives to carry out again the last batch's plan if it was not
// done, its time the one after done, as it had no meta
static int load_mirror(S *s) {
	mf_record *rs;
	size_t n;
	TRY(thrown(s, mf_read(s->man, &rs, &n), "the manifest is not valid"));
	Map all = {0};
	for (size_t i = 0; i < n; i++) free(map_set(&all, rs[i].key, bytes_new(rs[i].data, rs[i].length)));
	mf_records_free(rs, n);
	const Bytes *state = map_get(&all, STORE), *p = map_get(&all, PLAN);
	int r = 0, steps = 0;
	Step *plan = NULL;
	if (state) r = state_in(s, state);
	if (!r && p) {
		Json *j;
		if (!(r = decode(s, MF_PLAN, p, &j))) plan = plan_in(j, &steps), jsonFree(j);
	}
	if (r) {
		EACH(&all, c) free(c->value);
		map_free(&all);
		return r;
	}
	EACH(&s->recs, c) free(c->value);
	map_free(&s->recs);
	s->recs = all;
	s->layout = NULL;
	TRY(layout_of(s));
	Map after = {0}, known = {0};
	TRY(snapshot(s, s->given, &after, &known));
	install(s, &after, &known, s->given->root);
	s->time = s->state.done;
	if (p) TRY(finish(s, plan, steps, s->state.done + 1, true));
	TRY(sweep(s, true, 0));
	TRY(layout_of(s));
	point(s, disk(s));
	TRY(refit(s));
	return mended(s);
}

static int load_(S *s, st_restored *out) {
	out->none = true;
	bool exists;
	TRY(thrown(s, mf_exists(s->man, &exists), "the manifest could not be looked for"));
	if (s->copy || !exists) return fresh(s);
	if (s->set) TRY(set_(s, "", SYS_STORE, (const uint8_t *)s->uuid, strlen(s->uuid)));
	if (s->mirror) return load_mirror(s);
	// the store is checked before anything changes
	mf_record *rs;
	size_t n;
	TRY(thrown(s, mf_read(s->man, &rs, &n), "the manifest is not valid"));
	Map all = {0};
	for (size_t i = 0; i < n; i++) free(map_set(&all, rs[i].key, bytes_new(rs[i].data, rs[i].length)));
	mf_records_free(rs, n);
	const Bytes *state = map_get(&all, STORE), *p = map_get(&all, PLAN);
	int r = 0, steps = 0;
	Step *plan = NULL;
	bool nodes = false;
	if (p) {
		Json *j;
		if (!(r = decode(s, MF_PLAN, p, &j))) plan = plan_in(j, &steps), jsonFree(j);
	}
	EACH(&all, c) {
		if (within(c->key, SHOWN) && !r) {
			Json *j;
			if (!(r = decode(s, MF_SHOWN, c->value, &j))) jsonFree(j);
		}
		if (within(c->key, NODE)) nodes = true;
	}
	if (!r && state) r = state_in(s, state);
	if (!r && (nodes || map_get(&all, META))) {
		r = restored(s, &all, out);
		if (!r) {
			free(s->root);
			s->root = copyString(out->root);
			s->time = out->time;
			out->none = false;
		}
	}
	if (r) {
		EACH(&all, c) free(c->value);
		map_free(&all);
		return r;
	}
	EACH(&s->recs, c) free(c->value);
	map_free(&s->recs);
	s->recs = all;
	s->layout = NULL;
	TRY(layout_of(s));
	EACH(&s->nodes, c) free_node(c->value);
	map_free(&s->nodes);
	EACH(&s->recs, c) {
		if (!within(c->key, NODE)) continue;
		const Bytes *v = c->value;
		mf_node *shape = malloc(sizeof *shape);
		if (!shape) abort();
		if ((r = thrown(s, mf_shape(v->data, v->length, headed, s, shape), "a node record that is not one"))) return free(shape), r;
		map_set(&s->nodes, c->key + strlen(NODE), shape);
	}
	s->graph = NULL;
	// the last batch, if it was not laid out; then what no plan names in tmp
	if (p || s->state.done < s->time) TRY(finish(s, plan, steps, s->time, true));
	TRY(sweep(s, true, 0));
	if (s->root[0]) {
		TRY(layout_of(s));
		point(s, disk(s));
		TRY(refit(s));
	}
	return mended(s);
}

// what loading found: edits made while nothing watched; a host not running the files program has them mended
static int mended(S *s) {
	st_difference *d;
	size_t length;
	TRY(differences(s, NULL, 0, false, &d, &length));
	s->missed = d, s->missed_length = length;
	if (!s->options.files && length) {
		const char **paths = grab(length * sizeof *paths);
		for (size_t i = 0; i < length; i++) paths[i] = d[i].path;
		TRY(mend(s, paths, length, true));
		s->missed = NULL, s->missed_length = 0;
	}
	return 0;
}

// the manifest is where its folder says, found and loaded; the store is then in the list of the host's stores
static int open_(S *s, st_restored *out) {
	out->none = true;
	ex_located l;
	if (ex_locate(s->folder, &s->where, &l) != 0) return failed(s, false);
	free(s->ermine), free(s->uuid);
	s->ermine = l.dir, s->uuid = l.uuid, s->set = l.set, s->copy = l.copy;
	mf_close(s->man);
	s->man = mf_open(s->ermine, NULL, NULL, s->options.has_slack ? s->options.slack : MF_SLACK);
	TRY(load_(s, out));
	// a list that cannot be written is no reason for a store not to load
	ex_note(s->uuid, s->folder, &s->where);
	return 0;
}

// what a store gives -----------------------------------------------------------------------------------------------

static st_code code(const S *s, int r) {
	(void)s;
	return r == 0 ? ST_OK : r == T_STORE ? ST_STORE : ST_ERROR;
}

static st_store *make(const char *folder, const st_options *options, bool mirror) {
	S *s = calloc(1, sizeof *s);
	if (!s) abort();
	s->mirror = mirror;
	s->folder = copyString(folder);
	// what the host gave, kept: the host may free it once the store is open
	s->options = *options;
	s->options.home = options->home ? (s->home = copyString(options->home)) : NULL;
	if (options->outside_length) {
		s->places = malloc(options->outside_length * sizeof *s->places);
		if (!s->places) abort();
		for (size_t i = 0; i < options->outside_length; i++) s->places[i] = copyString(options->outside[i]);
	}
	s->where = (ex_where){s->options.home, options->foundation, (const char *const *)s->places, options->outside_length};
	s->native = options->foundation ? options->foundation : &fd_system;
	s->coordinating = !options->uncoordinated;
	s->ermine = formatString("%s/.ermine", folder);
	s->man = mf_open(s->ermine, NULL, NULL, options->has_slack ? options->slack : MF_SLACK);
	s->root = copyString("");
	const char *const *pass = options->pass ? options->pass : PASS;
	s->state.pass_length = options->pass ? options->pass_length : sizeof PASS / sizeof *PASS;
	s->state.pass = malloc((s->state.pass_length + 1) * sizeof *s->state.pass);
	if (!s->state.pass) abort();
	for (size_t i = 0; i < s->state.pass_length; i++) s->state.pass[i] = copyString(pass[i]);
	s->scratch.size = sizeof(Json *);
	return s;
}

st_store *st_open(const char *folder, const st_options *options) {
	return make(folder, options, false);
}

st_store *st_open_mirror(const char *folder, const st_options *options) {
	return make(folder, options, true);
}

void st_release(st_store *s) {
	for (size_t i = 0; i < s->scratch.count; i++) jsonFree(((Json **)s->scratch.items)[i]);
	s->scratch = (Vec){0, 0, 0, sizeof(Json *)};
	s->layout = NULL, s->graph = NULL;
	s->missed = NULL, s->missed_length = 0;
	layout_release();
}

void st_close(st_store *s) {
	if (!s) return;
	st_release(s);
	mf_close(s->man);
	EACH(&s->recs, c) free(c->value);
	map_free(&s->recs);
	EACH(&s->nodes, c) free_node(c->value);
	map_free(&s->nodes);
	EACH(&s->heads, c) free(c->value);
	map_free(&s->heads);
	EACH(&s->stats, c) free(c->value);
	map_free(&s->stats);
	EACH(&s->pointed, c) free(c->value);
	map_free(&s->pointed);
	drop_bytes(&s->held);
	for (size_t i = 0; i < s->where.places_length; i++) free(s->places[i]);
	free(s->places), free(s->home), free(s->uuid);
	for (size_t i = 0; i < s->state.pass_length; i++) free(s->state.pass[i]);
	free(s->state.pass);
	free(s->folder), free(s->ermine), free(s->root);
	free(s);
}

const char *st_message(const st_store *s) {
	return s->message;
}

// opens the store once; one that failed fails again, as store.ts's rejected promise does
static int opened(S *s, st_restored *out) {
	out->none = true;
	if (s->opened == 2) {
		s->kind = s->saved_kind;
		memcpy(s->message, s->saved_message, sizeof s->message);
		return s->kind;
	}
	if (s->opened == 1) return 0;
	int r = open_(s, out);
	if (r) {
		s->opened = 2;
		s->saved_kind = r;
		memcpy(s->saved_message, s->message, sizeof s->message);
		if (!out->none) st_restored_free(out);
		out->none = true;
		return r;
	}
	s->opened = 1;
	return 0;
}

st_code st_mirror_read(st_store *s, const st_saving *saving) {
	if (!s->mirror) return code(s, refuse(s, "only a mirror is read with the graph the host gives"));
	st_restored out = {.none = true};
	s->given = saving;
	int r = opened(s, &out);
	if (!out.none) st_restored_free(&out);
	return code(s, r);
}

st_code st_read(st_store *s, st_restored *out) {
	if (s->mirror) return *out = (st_restored){.none = true}, code(s, refuse(s, "a mirror is read with the graph the host gives"));
	int was = s->opened;
	int r = opened(s, out);
	if (r) return code(s, r);
	if (was == 0) return ST_OK;
	*out = (st_restored){.none = true};
	if (!s->root[0]) return ST_OK;
	return code(s, restored(s, &s->recs, out));
}

st_code st_write(st_store *s, const st_saving *saving) {
	st_restored out = {.none = true};
	s->given = saving;
	int r = opened(s, &out);
	if (!out.none) st_restored_free(&out);
	if (r) return code(s, r);
	return code(s, s->mirror ? mirrored(s, saving) : batch(s, saving));
}

const char *st_root(const st_store *s) {
	return s->root;
}

size_t st_count(const st_store *s) {
	return (size_t)s->nodes.size;
}

static const Cell *nth(const st_store *s, size_t index) {
	for (int i = 0; i < s->nodes.count; i++)
		if (s->nodes.items[i].live && index-- == 0) return &s->nodes.items[i];
	return NULL;
}

const char *st_id(const st_store *s, size_t index) {
	return nth(s, index)->key;
}

const mf_node *st_node(const st_store *s, size_t index) {
	return nth(s, index)->value;
}

size_t st_others(st_store *s, const mf_record **records) {
	Vec out = {0, 0, 0, sizeof(mf_record)};
	EACH(&s->recs, c) {
		const Bytes *b = c->value;
		if (ours(c->key)) continue;
		mf_record *r = push(&out);
		*r = (mf_record){c->key, b->data, b->length};
	}
	*records = out.items;
	return out.count;
}

// a path given that could reach out of the store's folder (absolute, or ".." in it) is refused, as store.ts's abs does
static int given(S *s, const char *const *paths, size_t count) {
	for (size_t i = 0; paths && i < count; i++)
		if (!names_ispath(paths[i], strlen(paths[i]))) return refuse(s, "\"%s\" is not a path in the store's folder", paths[i]);
	return 0;
}

st_code st_differences(st_store *s, const char *const *touched, size_t count, const st_difference **out, size_t *length) {
	st_difference *d = NULL;
	*length = 0;
	*out = NULL;
	if (given(s, touched, count)) return code(s, T_STORE);
	int r = differences(s, touched, count, touched != NULL, &d, length);
	*out = d;
	return code(s, r);
}

st_code st_mend(st_store *s, const char *const *paths, size_t count) {
	if (given(s, paths, count)) return code(s, T_STORE);
	return code(s, mend(s, paths, count, paths != NULL));
}

st_code st_trash(st_store *s, const char *path, const char *why) {
	if (given(s, &path, 1)) return code(s, T_STORE);
	return code(s, toss(s, path, path, why));
}

const char *st_folder(const st_store *s) {
	return s->folder;
}

Omap *st_layout(st_store *s) {
	if (layout_of(s) != 0) return NULL;
	return s->layout;
}

const Graph *st_graph(st_store *s) {
	return graph(s);
}

const char *const *st_pass(const st_store *s, size_t *count) {
	*count = s->state.pass_length;
	return passed(s);
}
