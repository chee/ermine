// The disk of the harnesses (disk_harness.h), disk_harness.ts's twin.
#ifdef __linux__
#define _GNU_SOURCE
#endif

#include "disk_harness.h"
#include "names.h"
#include "sys.h"
#include "../../../../ermine/encoding/c/cbor.h"
#include "../../../../ermine/encoding/c/json_text.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <ftw.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

// ---- the folder and its labels

Disk *disk_make(const char *prefix, DiskKind kind) {
	const char *tmp = getenv("TMPDIR");
	if (!tmp || !*tmp) tmp = "/tmp";
	char *template = formatString("%s/%sXXXXXX", tmp, prefix);
	if (!mkdtemp(template)) return free(template), NULL;
	char *real = realpath(template, NULL);
	free(template);
	if (!real) return NULL;
	Disk *d = allocate(sizeof *d);
	d->dir = real, d->kind = kind;
	d->store = formatString("%s/Store", real), d->trash = formatString("%s/Trash", real);
	d->home = formatString("%s/Home", real), d->outside = formatString("%s/Outside", real);
	d->scratch = formatString("%s/scratch", real);
	if (mkdir(d->scratch, 0777) != 0 || mkdir(d->home, 0777) != 0) return disk_free(d), NULL;
	return d;
}

static int remove_one(const char *path, const struct stat *st, int flag, struct FTW *ftw) {
	(void)st, (void)flag, (void)ftw;
	return remove(path);
}

static int remove_all(const char *path) {
	struct stat st;
	if (lstat(path, &st) != 0) return -1;
	if (!S_ISDIR(st.st_mode)) return unlink(path);
	return nftw(path, remove_one, 16, FTW_DEPTH | FTW_PHYS);
}

void disk_free(Disk *d) {
	if (!d) return;
	if (d->dir) remove_all(d->dir);
	for (size_t i = 0; i < d->count; i++) free(d->raws[i]), free(d->labels[i]);
	free(d->raws), free(d->labels);
	free(d->dir), free(d->store), free(d->trash), free(d->home), free(d->outside), free(d->scratch);
	free(d);
}

static const char *disk_label(Disk *d, const char *raw) {
	for (size_t i = 0; i < d->count; i++)
		if (strcmp(d->raws[i], raw) == 0) return d->labels[i];
	if (d->count == d->capacity) {
		d->capacity = d->capacity ? d->capacity * 2 : 8;
		d->raws = realloc(d->raws, d->capacity * sizeof *d->raws);
		d->labels = realloc(d->labels, d->capacity * sizeof *d->labels);
		if (!d->raws || !d->labels) abort();
	}
	size_t n = d->count;
	d->raws[n] = copyString(raw);
	if (d->kind == DISK_UUIDS) d->labels[n] = n == 0 ? copyString("uuid") : formatString("uuid%zu", n + 1);
	else d->labels[n] = formatString("id%zu", n + 1);
	d->count++;
	return d->labels[n];
}

const char *disk_raw(const Disk *d, const char *label) {
	for (size_t i = 0; i < d->count; i++)
		if (strcmp(d->labels[i], label) == 0) return d->raws[i];
	return label;
}

char *disk_path(const Disk *d, const char *p, const char *folder) {
	if (p[0] == '@') return formatString("%s/%s", d->dir, p + 1);
	if (p[0] == 0) return copyString(folder);
	return formatString("%s/%s", folder, p);
}

// ---- text

typedef struct {
	char *data;
	size_t length, capacity;
} Buf;

static void put(Buf *b, const char *s, size_t n) {
	if (b->length + n + 1 > b->capacity) {
		b->capacity = (b->length + n + 1) * 2;
		b->data = realloc(b->data, b->capacity);
		if (!b->data) abort();
	}
	memcpy(b->data + b->length, s, n);
	b->length += n;
	b->data[b->length] = 0;
}

static char *replace_all(const char *s, const char *from, const char *to) {
	Buf b = {0};
	size_t n = strlen(from);
	put(&b, "", 0);
	for (const char *p = s; *p;) {
		if (strncmp(p, from, n) == 0) put(&b, to, strlen(to)), p += n;
		else put(&b, p, 1), p++;
	}
	return b.data;
}

static bool lower_hex(char c) {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
}

static size_t uuid_at(const char *s) {
	static const char groups[] = {8, 4, 4, 4, 12};
	size_t at = 0;
	for (int g = 0; g < 5; g++) {
		if (g) {
			if (s[at] != '-') return 0;
			at++;
		}
		for (int i = 0; i < groups[g]; i++, at++)
			if (!lower_hex(s[at])) return 0;
	}
	return at;
}

static bool id_char(char c) {
	return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-';
}

// the length of the label-able text at s[i], or 0; s[i - 1] is looked at for ids
static size_t match(const Disk *d, const char *s, size_t i) {
	if (d->kind == DISK_UUIDS) return uuid_at(s + i);
	if (s[i] != 'i' || (i > 0 && id_char(s[i - 1]))) return 0;
	size_t j = i + 1;
	while (s[j] >= '0' && s[j] <= '9') j++;
	if (j == i + 1 || id_char(s[j])) return 0;
	return j - i;
}

static char *disk_text(Disk *d, const char *s) {
	char *with = formatString("%s/", d->dir);
	char *one = replace_all(s, with, "@");
	free(with);
	char *two = replace_all(one, d->dir, "@");
	free(one);
	Buf b = {0};
	put(&b, "", 0);
	for (size_t i = 0; two[i];) {
		size_t n = match(d, two, i);
		if (n) {
			char *raw = copyStringOfLength(two + i, n);
			const char *label = disk_label(d, raw);
			free(raw);
			put(&b, label, strlen(label));
			i += n;
		} else put(&b, two + i, 1), i++;
	}
	free(two);
	return b.data;
}

void disk_deep(Disk *d, Json *v) {
	if (!v) return;
	if (v->type == JSON_STRING) {
		char *t = disk_text(d, v->string);
		if (strcmp(t, v->string) == 0) free(t);
		else free(v->string), v->string = t, v->stringLength = strlen(t);
	} else if (v->type == JSON_ARRAY) {
		for (int i = 0; i < v->array.count; i++) disk_deep(d, v->array.items[i]);
	} else if (v->type == JSON_OBJECT) {
		for (int i = 0; i < v->object.count; i++) disk_deep(d, v->object.members[i].value);
	}
}

// ---- small helpers

static char *hex_of(const uint8_t *b, size_t n) {
	char *s = allocate(2 * n + 1);
	for (size_t i = 0; i < n; i++) snprintf(s + 2 * i, 3, "%02x", b[i]);
	return s;
}

static Json *hex_json(const uint8_t *b, size_t n) {
	char *s = hex_of(b, n);
	Json *j = jsonStringTaking(s, 2 * n);
	return j;
}

static int hex_digit(char c) {
	if (c >= '0' && c <= '9') return c - '0';
	if (c >= 'a' && c <= 'f') return c - 'a' + 10;
	if (c >= 'A' && c <= 'F') return c - 'A' + 10;
	return -1;
}

static uint8_t *unhex(const char *s, size_t *n) {
	size_t len = strlen(s) / 2;
	uint8_t *b = allocate(len + 1);
	for (size_t i = 0; i < len; i++) {
		int hi = hex_digit(s[2 * i]), lo = hex_digit(s[2 * i + 1]);
		b[i] = (uint8_t)((hi < 0 ? 0 : hi) * 16 + (lo < 0 ? 0 : lo));
	}
	*n = len;
	return b;
}

// a string's bytes: json.h holds U+0000 as C0 80, a file holds it as 00
static uint8_t *text_bytes(const char *s, size_t *n) {
	size_t len = strlen(s);
	uint8_t *b = allocate(len + 1);
	size_t k = 0;
	for (size_t i = 0; i < len; i++) {
		if ((uint8_t)s[i] == 0xC0 && (uint8_t)s[i + 1] == 0x80) b[k++] = 0, i++;
		else b[k++] = (uint8_t)s[i];
	}
	*n = k;
	return b;
}

// the bytes of an edit: its hex, else its text
static uint8_t *bytes_of(const Json *e, size_t *n) {
	const char *h = jsonText(jsonGet(e, "hex"));
	if (h) return unhex(h, n);
	const char *t = jsonText(jsonGet(e, "text"));
	return text_bytes(t ? t : "", n);
}

static int write_file(const char *path, const uint8_t *b, size_t n, int flags) {
	int fd = open(path, O_WRONLY | O_CREAT | flags, 0666);
	if (fd < 0) return -1;
	size_t at = 0;
	while (at < n) {
		ssize_t w = write(fd, b + at, n - at);
		if (w < 0) return close(fd), -1;
		at += (size_t)w;
	}
	return close(fd);
}

static uint8_t *read_file(const char *path, size_t *n) {
	FILE *f = fopen(path, "rb");
	if (!f) return NULL;
	size_t cap = 4096, len = 0;
	uint8_t *b = malloc(cap);
	if (!b) abort();
	for (;;) {
		size_t r = fread(b + len, 1, cap - len, f);
		len += r;
		if (len < cap) break;
		cap *= 2;
		b = realloc(b, cap);
		if (!b) abort();
	}
	fclose(f);
	*n = len;
	return b;
}

static int mkdir_all(const char *path) {
	char *p = copyString(path);
	for (char *c = p + 1; *c; c++) {
		if (*c != '/') continue;
		*c = 0;
		if (mkdir(p, 0777) != 0 && errno != EEXIST) return free(p), -1;
		*c = '/';
	}
	int r = mkdir(p, 0777);
	if (r != 0 && errno == EEXIST) {
		struct stat st;
		if (stat(p, &st) == 0 && S_ISDIR(st.st_mode)) r = 0, errno = 0;
	}
	free(p);
	return r;
}

static Json *cbor_json(const uint8_t *b, size_t n) {
	return cborDecode(b, n, NULL, NULL);
}

static uint8_t *cbor_bytes(const Json *v, size_t *n) {
	const char *why;
	if (!cborEncode(v, NULL, 0, n, &why)) return NULL;
	uint8_t *out = allocate(*n + 1);
	cborEncode(v, out, *n, n, &why);
	return out;
}

// ---- edits

// a plan in JSON form, each {"ino": path} the file id of what is at path, then as a value, CBOR-encoded
static uint8_t *plan_bytes(Disk *d, Json *steps, const char *folder, size_t *n) {
	for (int i = 0; i < steps->array.count; i++) {
		Json *s = steps->array.items[i];
		if (!jsonIsObject(s)) continue;
		static const char *const keys[] = {"before", "after"};
		for (int k = 0; k < 2; k++) {
			Json *f = jsonGet(s, keys[k]);
			Json *place = f ? jsonGet(f, "folder") : NULL;
			Json *p = place ? jsonGet(place, "ino") : NULL;
			if (!jsonIsObject(place) || !p) continue;
			char *abs = disk_path(d, jsonText(p), folder);
			struct stat st;
			int r = lstat(abs, &st);
			free(abs);
			if (r != 0) return NULL;
			Json *o = jsonObject();
			jsonAdd(o, "folder", jsonNumber((double)st.st_ino));
			jsonSet(s, keys[k], strlen(keys[k]), o);
		}
	}
	if (!jsonDecode(&steps)) return NULL;
	return cbor_bytes(steps, n);
}

// a frame: 4 bytes big-endian of its length, then the CBOR of its records
static uint8_t *frame_bytes(Disk *d, Json *records, const char *folder, size_t *n) {
	Json *map = jsonObject();
	for (int i = 0; i < records->object.count; i++) {
		const JsonMember *m = &records->object.members[i];
		Json *v = m->value;
		if (v->type == JSON_NULL) jsonAddOfLength(map, m->key, m->keyLength, jsonNull());
		else if (strcmp(m->key, "plan") == 0 && v->type == JSON_ARRAY) {
			size_t pn;
			uint8_t *p = plan_bytes(d, v, folder, &pn);
			if (!p) return jsonFree(map), NULL;
			jsonAddOfLength(map, m->key, m->keyLength, jsonBytes(p, pn));
			free(p);
		} else {
			size_t bn;
			uint8_t *b = unhex(jsonText(v) ? jsonText(v) : "", &bn);
			jsonAddOfLength(map, m->key, m->keyLength, jsonBytes(b, bn));
			free(b);
		}
	}
	size_t bn;
	uint8_t *body = cbor_bytes(map, &bn);
	jsonFree(map);
	if (!body) return NULL;
	uint8_t *out = allocate(4 + bn);
	out[0] = (uint8_t)(bn >> 24), out[1] = (uint8_t)(bn >> 16), out[2] = (uint8_t)(bn >> 8), out[3] = (uint8_t)bn;
	memcpy(out + 4, body, bn);
	free(body);
	*n = 4 + bn;
	return out;
}

static int copy_all(const char *from, const char *to) {
#ifdef __linux__
	// Linux's cp keeps attributes only when told to
	char *argv[] = {"cp", "-Rp", "--preserve=xattr", (char *)from, (char *)to, NULL};
#else
	char *argv[] = {"cp", "-Rp", (char *)from, (char *)to, NULL};
#endif
	pid_t pid;
	if (posix_spawnp(&pid, "cp", NULL, NULL, argv, environ) != 0) return -1;
	int status;
	if (waitpid(pid, &status, 0) < 0) return -1;
	return WIFEXITED(status) && WEXITSTATUS(status) == 0 ? 0 : -1;
}

// scenarios say party.chee.ermine.x, and com.apple.x for another app's; the platform's own names (Linux: user.ermine.x and
// user.com.apple.x) are swapped in and out. The result is fresh
static char *local_name(const char *name) {
	const char *own = "party.chee.ermine.";
	size_t n = strlen(own);
	if (strncmp(name, own, n) == 0) return formatString("%s%s", SYS_OWN, name + n);
#ifdef __linux__
	return formatString("user.%s", name);
#else
	return copyString(name);
#endif
}

static char *canon_name(const char *name) {
	size_t n = strlen(SYS_OWN);
	if (strncmp(name, SYS_OWN, n) == 0) return formatString("party.chee.ermine.%s", name + n);
#ifdef __linux__
	if (strncmp(name, "user.", 5) == 0) return copyString(name + 5);
#endif
	return copyString(name);
}

int disk_edit(Disk *d, const Json *e, const char *folder, char *why, size_t size) {
	const char *kind = jsonText(jsonGet(e, "edit"));
	if (!kind) return snprintf(why, size, "an edit with no kind"), -1;
	char *path = NULL, *from = NULL, *to = NULL;
	const char *p = jsonText(jsonGet(e, "path")), *f = jsonText(jsonGet(e, "from")), *t = jsonText(jsonGet(e, "to"));
	if (p) path = disk_path(d, p, folder);
	if (f) from = disk_path(d, f, folder);
	if (t) to = disk_path(d, t, folder);
	int r = 0;
	size_t n = 0;
	uint8_t *b = NULL;
	char *log = formatString("%s/.ermine/manifest", folder);
	const Json *keep = jsonGet(e, "keep");
	if (strcmp(kind, "write") == 0 && path) {
		b = bytes_of(e, &n);
		if (keep && keep->type == JSON_BOOLEAN && keep->boolean) {
			r = write_file(path, b, n, O_TRUNC);
			struct timeval tv[2] = {{978307200, 0}, {978307200, 0}};
			if (r == 0) r = utimes(path, tv);
		} else {
			char *tmp = formatString("%s/edit", d->scratch);
			r = write_file(tmp, b, n, O_TRUNC);
			if (r == 0) r = rename(tmp, path);
			free(tmp);
		}
	} else if (strcmp(kind, "mkdir") == 0 && path) r = mkdir_all(path);
	else if (strcmp(kind, "remove") == 0 && path) r = remove_all(path);
	else if (strcmp(kind, "rename") == 0 && from && to) r = rename(from, to);
	else if (strcmp(kind, "link") == 0 && path && jsonText(jsonGet(e, "target"))) r = symlink(jsonText(jsonGet(e, "target")), path);
	else if (strcmp(kind, "copy") == 0 && from && to) r = copy_all(from, to);
	else if (strcmp(kind, "attr") == 0 && path && jsonText(jsonGet(e, "name"))) {
		b = bytes_of(e, &n);
		char *name = local_name(jsonText(jsonGet(e, "name")));
		r = sys_set(path, name, b, n);
		free(name);
	} else if (strcmp(kind, "unattr") == 0 && path && jsonText(jsonGet(e, "name"))) {
		char *name = local_name(jsonText(jsonGet(e, "name")));
		r = sys_unset(path, name);
		free(name);
	} else if (strcmp(kind, "id") == 0 && path && jsonText(jsonGet(e, "of"))) {
		const char *raw = disk_raw(d, jsonText(jsonGet(e, "of")));
		r = sys_set(path, SYS_ID, (const uint8_t *)raw, strlen(raw));
	} else if (strcmp(kind, "cut") == 0 && path && jsonIsNumber(jsonGet(e, "by"))) {
		struct stat st;
		r = lstat(path, &st);
		if (r == 0) r = truncate(path, st.st_size - (off_t)jsonGet(e, "by")->number);
	} else if (strcmp(kind, "unframe") == 0 && jsonIsNumber(jsonGet(e, "count")) && jsonIsNumber(jsonGet(e, "leave"))) {
		uint8_t *bytes = read_file(log, &n);
		if (!bytes) r = -1;
		else {
			size_t *starts = allocate((n / 4 + 1) * sizeof *starts), count = 0;
			for (size_t i = 0; i + 4 <= n; i += 4 + (((size_t)bytes[i] << 24) | ((size_t)bytes[i + 1] << 16) | ((size_t)bytes[i + 2] << 8) | bytes[i + 3])) starts[count++] = i;
			size_t last = (size_t)jsonGet(e, "count")->number;
			if (last == 0 || last > count) r = -1, errno = EINVAL;
			else r = truncate(log, (off_t)(starts[count - last] + (size_t)jsonGet(e, "leave")->number));
			free(starts);
			free(bytes);
		}
	} else if (strcmp(kind, "append") == 0 && path && jsonText(jsonGet(e, "hex"))) {
		b = unhex(jsonText(jsonGet(e, "hex")), &n);
		r = write_file(path, b, n, O_APPEND);
	} else if (strcmp(kind, "frame") == 0 && jsonIsObject(jsonGet(e, "records"))) {
		b = frame_bytes(d, jsonGet(e, "records"), folder, &n);
		if (!b) r = -1, errno = EINVAL;
		else r = write_file(log, b, n, O_APPEND);
	} else r = -1, errno = EINVAL, snprintf(why, size, "unknown edit %s", kind), kind = NULL;
	if (r != 0 && kind) snprintf(why, size, "%s: %s", kind, strerror(errno));
	free(b), free(log), free(path), free(from), free(to);
	return r;
}

// ---- what is read of an entry

// strict UTF-8: no overlong forms, no surrogates, nothing past U+10FFFF
static bool utf8_valid(const uint8_t *s, size_t n) {
	for (size_t i = 0; i < n;) {
		uint8_t c = s[i];
		size_t len = c < 0x80 ? 1 : c >= 0xC2 && c <= 0xDF ? 2 : c >= 0xE0 && c <= 0xEF ? 3 : c >= 0xF0 && c <= 0xF4 ? 4 : 0;
		if (!len || i + len > n) return false;
		for (size_t k = 1; k < len; k++)
			if ((s[i + k] & 0xC0) != 0x80) return false;
		if (c == 0xE0 && s[i + 1] < 0xA0) return false;
		if (c == 0xED && s[i + 1] > 0x9F) return false;
		if (c == 0xF0 && s[i + 1] < 0x90) return false;
		if (c == 0xF4 && s[i + 1] > 0x8F) return false;
		i += len;
	}
	return true;
}

static bool is_uuid(const char *s) {
	return strlen(s) == 36 && uuid_at(s) == 36;
}

// an attribute's bytes as text, or {hex}; *text is set to the text (fresh) when it is one
static Json *attr_value(const uint8_t *b, size_t n, char **text) {
	*text = NULL;
	if (utf8_valid(b, n) && !memchr(b, 0, n)) {
		*text = copyStringOfLength((const char *)b, n);
		return jsonStringOfLength((const char *)b, n);
	}
	Json *o = jsonObject();
	jsonAdd(o, "hex", hex_json(b, n));
	return o;
}

static int by_name(const void *a, const void *b) {
	return names_bycodepoint(*(char *const *)a, *(char *const *)b);
}

// the names of the entry's own extended attributes, sorted (the array and its strings malloc'd)
static char **attr_names(const char *abs, size_t *count) {
	char *all = NULL;
	size_t length = 0;
	*count = 0;
	if (sys_names(abs, &all, &length) != 0) return NULL;
	size_t n = 0;
	for (size_t i = 0; i < length; i += strlen(all + i) + 1) n++;
	char **names = allocate((n + 1) * sizeof *names);
	size_t k = 0;
	for (size_t i = 0; i < length; i += strlen(all + i) + 1) names[k++] = copyString(all + i);
	free(all);
	qsort(names, n, sizeof *names, by_name);
	*count = n;
	return names;
}

static void names_free_all(char **names, size_t n) {
	for (size_t i = 0; i < n; i++) free(names[i]);
	free(names);
}

static bool in_list(const char *name, const char *const *list, size_t n) {
	for (size_t i = 0; i < n; i++)
		if (strcmp(list[i], name) == 0) return true;
	return false;
}

// ---- walks

typedef struct {
	Json *shown;
	char *abs;
	uint64_t ino;
	bool dir;
	size_t seq;
} Item;

typedef struct {
	Item *items;
	size_t count, capacity;
} Walk;

typedef struct {
	Disk *d;
	bool program; // the program's walk: paths as they are, only the program's attributes, hidden paths left out
	const char *const *extra;
	size_t extra_count;
	Walk walk;
} Walker;

static bool hidden(const char *p) {
	return strcmp(p, ".ermine/manifest") == 0 || strcmp(p, ".ermine/tmp") == 0 || strncmp(p, ".ermine/tmp/", 12) == 0 ||
		strcmp(p, ".ermine/values") == 0 || strncmp(p, ".ermine/values/", 15) == 0 || strcmp(p, ".ermine/external") == 0 ||
		strncmp(p, ".ermine/external/", 17) == 0;
}

static Json *entry_attrs(Walker *w, const char *abs) {
	Json *out = jsonObject();
	size_t count;
	char **names = attr_names(abs, &count);
	const char *const program[] = {SYS_ID, SYS_SLOT, SYS_SIDE};
	for (size_t i = 0; i < count; i++) {
		const char *n = names[i];
		bool kept = w->program ? in_list(n, program, 3) : strncmp(n, SYS_OWN, strlen(SYS_OWN)) == 0 || in_list(n, w->extra, w->extra_count);
		if (!kept) continue;
		uint8_t *b;
		size_t len;
		if (sys_get(abs, n, &b, &len) != 0) continue;
		Json *v = NULL;
		char *text = NULL;
		if (w->program && strcmp(n, SYS_SLOT) == 0) {
			v = cbor_json(b, len);
			if (!v) v = jsonObject(), jsonAdd(v, "hex", hex_json(b, len));
		} else v = attr_value(b, len, &text);
		if (!w->program && strcmp(n, SYS_STORE) == 0 && text && is_uuid(text)) {
			jsonFree(v);
			v = jsonString(disk_label(w->d, text));
		}
		free(text);
		free(b);
		char *shown = canon_name(n);
		jsonAdd(out, shown, v);
		free(shown);
	}
	names_free_all(names, count);
	return out;
}

static void one(Walker *w, const char *abs, const char *path) {
	struct stat st;
	if (lstat(abs, &st) != 0) return;
	Json *shown = jsonObject();
	bool link = S_ISLNK(st.st_mode), dir = S_ISDIR(st.st_mode), file = S_ISREG(st.st_mode);
	char *shown_path = w->program ? copyString(path) : disk_text(w->d, path);
	jsonAdd(shown, "path", jsonString(shown_path));
	free(shown_path);
	jsonAdd(shown, "kind", jsonString(link ? "link" : dir ? "folder" : file ? "file" : "other"));
	if (link) {
		char target[4096];
		ssize_t n = readlink(abs, target, sizeof target - 1);
		if (n < 0) n = 0;
		target[n] = 0;
		jsonAdd(shown, "target", jsonString(target));
	} else if (file) {
		size_t n;
		uint8_t *b = read_file(abs, &n);
		if (!b) b = malloc(1), n = 0;
		jsonAdd(shown, "hex", hex_json(b, n));
		free(b);
	}
	Json *a = entry_attrs(w, abs);
	if (a->object.count) jsonAdd(shown, "attrs", a);
	else jsonFree(a);
	if (!w->program || !hidden(path)) {
		Walk *l = &w->walk;
		if (l->count == l->capacity) {
			l->capacity = l->capacity ? l->capacity * 2 : 16;
			l->items = realloc(l->items, l->capacity * sizeof *l->items);
			if (!l->items) abort();
		}
		l->items[l->count] = (Item){jsonRef(shown), copyString(abs), st.st_ino, dir, l->count};
		l->count++;
	}
	jsonFree(shown);
	if (dir) {
		DIR *dp = opendir(abs);
		if (!dp) return;
		struct dirent *e;
		while ((e = readdir(dp))) {
			if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
			char *child = formatString("%s/%s", abs, e->d_name);
			char *cpath = path[0] ? formatString("%s/%s", path, e->d_name) : copyString(e->d_name);
			one(w, child, cpath);
			free(child), free(cpath);
		}
		closedir(dp);
	}
}

static int by_shown_path(const void *a, const void *b) {
	const Item *x = a, *y = b;
	int c = names_bycodepoint(jsonText(jsonGet(x->shown, "path")), jsonText(jsonGet(y->shown, "path")));
	return c ? c : x->seq < y->seq ? -1 : x->seq > y->seq;
}

// every entry under dir, dir itself as label if self, by path; false if dir is not there
static bool walk_dir(Walker *w, const char *dir, bool self, const char *label) {
	struct stat st;
	memset(&w->walk, 0, sizeof w->walk);
	if (lstat(dir, &st) != 0) return false;
	if (self) one(w, dir, label);
	else {
		DIR *dp = opendir(dir);
		if (dp) {
			struct dirent *e;
			while ((e = readdir(dp))) {
				if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
				char *child = formatString("%s/%s", dir, e->d_name);
				char *cpath = label[0] ? formatString("%s/%s", label, e->d_name) : copyString(e->d_name);
				one(w, child, cpath);
				free(child), free(cpath);
			}
			closedir(dp);
		}
	}
	if (w->walk.count) qsort(w->walk.items, w->walk.count, sizeof(Item), by_shown_path);
	return true;
}

static void walk_free(Walk *l) {
	for (size_t i = 0; i < l->count; i++) jsonFree(l->items[i].shown), free(l->items[i].abs);
	free(l->items);
	memset(l, 0, sizeof *l);
}

static Json *shown_list(const Walk *l) {
	Json *a = jsonArray();
	for (size_t i = 0; i < l->count; i++) jsonPush(a, jsonRef(l->items[i].shown));
	return a;
}

// ---- the store's snapshot

typedef struct {
	uint64_t ino;
	char *name;
} InoName;

typedef struct {
	InoName *known, *others;
	size_t known_count, others_count;
} Inos;

static void ino_set(Inos *t, uint64_t ino, const char *name) {
	for (size_t i = 0; i < t->known_count; i++)
		if (t->known[i].ino == ino) {
			free(t->known[i].name);
			t->known[i].name = copyString(name);
			return;
		}
	t->known = realloc(t->known, (t->known_count + 1) * sizeof *t->known);
	if (!t->known) abort();
	t->known[t->known_count++] = (InoName){ino, copyString(name)};
}

static const char *ino_name(Inos *t, uint64_t ino) {
	for (size_t i = 0; i < t->known_count; i++)
		if (t->known[i].ino == ino) return t->known[i].name;
	for (size_t i = 0; i < t->others_count; i++)
		if (t->others[i].ino == ino) return t->others[i].name;
	t->others = realloc(t->others, (t->others_count + 1) * sizeof *t->others);
	if (!t->others) abort();
	t->others[t->others_count] = (InoName){ino, formatString("#%zu", t->others_count + 1)};
	return t->others[t->others_count++].name;
}

static void inos_free(Inos *t) {
	for (size_t i = 0; i < t->known_count; i++) free(t->known[i].name);
	for (size_t i = 0; i < t->others_count; i++) free(t->others[i].name);
	free(t->known), free(t->others);
}

// a plan as the manifest holds it, decoded; each folder's file id as what has it. The steps are taken
static Json *plan_of(const uint8_t *b, size_t n, Inos *inos) {
	Json *steps = cbor_json(b, n);
	if (!steps || steps->type != JSON_ARRAY) {
		jsonFree(steps);
		return hex_json(b, n);
	}
	for (int i = 0; i < steps->array.count; i++) {
		Json *s = steps->array.items[i];
		if (!jsonIsObject(s)) continue;
		static const char *const keys[] = {"before", "after"};
		for (int k = 0; k < 2; k++) {
			Json *f = jsonGet(s, keys[k]);
			Json *folder = f ? jsonGet(f, "folder") : NULL;
			if (!jsonIsNumber(folder)) continue;
			Json *in = jsonObject(), *o = jsonObject();
			jsonAdd(in, "ino", jsonString(ino_name(inos, (uint64_t)folder->number)));
			jsonAdd(o, "folder", in);
			jsonSet(s, keys[k], strlen(keys[k]), o);
		}
	}
	return steps;
}

// the manifest's frames, the plan decoded, each folder's file id as what has it; into shown (rest too)
static void frames(Json *shown, const uint8_t *bytes, size_t n, Inos *inos) {
	Json *out = jsonArray();
	size_t at = 0;
	while (at + 4 <= n) {
		size_t end = at + 4 + (((size_t)bytes[at] << 24) | ((size_t)bytes[at + 1] << 16) | ((size_t)bytes[at + 2] << 8) | bytes[at + 3]);
		if (end > n) break;
		Json *f = cbor_json(bytes + at + 4, end - at - 4);
		if (!f) break;
		if (f->type != JSON_OBJECT) {
			jsonFree(f);
			break;
		}
		Json *records = jsonObject();
		for (int i = 0; i < f->object.count; i++) {
			const JsonMember *m = &f->object.members[i];
			Json *v = m->value;
			if (v->type != JSON_BYTES) jsonAddOfLength(records, m->key, m->keyLength, jsonRef(v));
			else if (strcmp(m->key, "plan") == 0) jsonAddOfLength(records, m->key, m->keyLength, plan_of(v->bytes.data, v->bytes.length, inos));
			else jsonAddOfLength(records, m->key, m->keyLength, hex_json(v->bytes.data, v->bytes.length));
		}
		jsonFree(f);
		Json *one_frame = jsonObject();
		jsonAdd(one_frame, "records", records);
		jsonPush(out, one_frame);
		at = end;
	}
	jsonAdd(shown, "frames", out);
	if (at < n) jsonAdd(shown, "rest", hex_json(bytes + at, n - at));
}

static int by_stores(const void *a, const void *b) {
	const Json *x = *(Json *const *)a, *y = *(Json *const *)b;
	int c = names_bycodepoint(jsonText(jsonGet(x, "path")), jsonText(jsonGet(y, "path")));
	return c ? c : names_bycodepoint(jsonText(jsonGet(x, "uuid")), jsonText(jsonGet(y, "uuid")));
}

// the list of stores, as shown: each uuid's last path, by path; into shown
static bool stores_of(Json *shown, const uint8_t *bytes, size_t n, Disk *d) {
	Json *v = cbor_json(bytes, n);
	if (!v || v->type != JSON_OBJECT) return jsonFree(v), false;
	int count = v->object.count;
	Json **list = allocate((count + 1) * sizeof *list);
	for (int i = 0; i < count; i++) {
		const JsonMember *m = &v->object.members[i];
		Json *o = jsonObject();
		jsonAdd(o, "uuid", jsonString(is_uuid(m->key) ? disk_label(d, m->key) : m->key));
		char *p = disk_text(d, jsonText(jsonGet(m->value, "path")) ? jsonText(jsonGet(m->value, "path")) : "");
		jsonAdd(o, "path", jsonString(p));
		free(p);
		list[i] = o;
	}
	qsort(list, (size_t)count, sizeof *list, by_stores);
	Json *a = jsonArray();
	for (int i = 0; i < count; i++) jsonPush(a, list[i]);
	free(list);
	jsonFree(v);
	jsonAdd(shown, "stores", a);
	return true;
}

static bool ends_with(const char *s, const char *tail) {
	size_t a = strlen(s), b = strlen(tail);
	return a >= b && strcmp(s + a - b, tail) == 0;
}

// /\/\.ermine\/external\/[^/]+\/manifest$/
static bool external_manifest(const char *p) {
	const char *key = "/.ermine/external/";
	const char *at = strstr(p, key);
	while (at) {
		const char *rest = at + strlen(key);
		const char *slash = strchr(rest, '/');
		if (slash && slash > rest && strcmp(slash, "/manifest") == 0) return true;
		at = strstr(at + 1, key);
	}
	return false;
}

// the entries as shown: a manifest as its frames, the list of stores as stores
static Json *shown_entries(const Walk *l, Inos *inos, Disk *d, bool *ok) {
	Json *a = jsonArray();
	for (size_t i = 0; i < l->count; i++) {
		Json *e = l->items[i].shown;
		const char *p = jsonText(jsonGet(e, "path"));
		const char *kind = jsonText(jsonGet(e, "kind"));
		bool manifest = strcmp(p, ".ermine/manifest") == 0 || ends_with(p, "/.ermine/manifest") || external_manifest(p);
		bool stores = ends_with(p, "/.ermine/external/stores");
		if (strcmp(kind, "file") != 0 || (!manifest && !stores)) {
			jsonPush(a, jsonRef(e));
			continue;
		}
		size_t n;
		uint8_t *b = unhex(jsonText(jsonGet(e, "hex")), &n);
		Json *copy = jsonShallow(e);
		jsonRemove(copy, "hex", 3);
		if (manifest) frames(copy, b, n, inos);
		else if (!stores_of(copy, b, n, d)) *ok = false;
		free(b);
		jsonPush(a, copy);
	}
	return a;
}

Json *disk_store_snapshot(Disk *d, const char *folder, Json *listed, const Json *look, char *why, size_t size) {
	const Json *attrs = jsonGet(look, "attrs"), *at = jsonGet(look, "at");
	size_t extra_count = jsonIsArray(attrs) ? (size_t)attrs->array.count : 0;
	const char **extra = allocate((extra_count + 1) * sizeof *extra);
	for (size_t i = 0; i < extra_count; i++) extra[i] = local_name(jsonText(attrs->array.items[i]));
	size_t more = jsonIsArray(at) ? (size_t)at->array.count : 0;
	const char **labels = allocate((more + 1) * sizeof *labels);
	char **abs = allocate((more + 1) * sizeof *abs);
	for (size_t i = 0; i < more; i++) {
		labels[i] = jsonText(at->array.items[i]);
		abs[i] = disk_path(d, labels[i], d->store);
	}
	// the uuids of the folders shown come first in the labels, in order
	for (size_t i = 0; i <= more; i++) {
		const char *path = i == 0 ? folder : abs[i - 1];
		uint8_t *b;
		size_t n;
		if (sys_get(path, SYS_STORE, &b, &n) == 0) {
			char *t;
			Json *v = attr_value(b, n, &t);
			jsonFree(v);
			if (t && is_uuid(t)) disk_label(d, t);
			free(t);
			free(b);
		}
	}
	Walker w = {.d = d, .extra = extra, .extra_count = extra_count};
	Walk inside = {0}, bin = {0}, *elsewhere = allocate((more + 1) * sizeof *elsewhere);
	bool has_inside = walk_dir(&w, folder, true, ""), has_bin;
	inside = w.walk;
	has_bin = walk_dir(&w, d->trash, false, "");
	bin = w.walk;
	bool *has = allocate((more + 1) * sizeof *has);
	for (size_t i = 0; i < more; i++) has[i] = walk_dir(&w, abs[i], true, labels[i]), elsewhere[i] = w.walk;
	Inos inos = {0};
	for (size_t i = 0; i < bin.count; i++)
		if (bin.items[i].dir) {
			char *name = formatString("trash/%s", jsonText(jsonGet(bin.items[i].shown, "path")));
			ino_set(&inos, bin.items[i].ino, name);
			free(name);
		}
	for (size_t k = 0; k < more; k++)
		for (size_t i = 0; i < elsewhere[k].count; i++)
			if (elsewhere[k].items[i].dir) ino_set(&inos, elsewhere[k].items[i].ino, jsonText(jsonGet(elsewhere[k].items[i].shown, "path")));
	for (size_t i = 0; i < inside.count; i++)
		if (inside.items[i].dir) ino_set(&inos, inside.items[i].ino, jsonText(jsonGet(inside.items[i].shown, "path")));
	bool ok = true;
	Json *out = jsonObject();
	jsonAdd(out, "folder", has_inside ? shown_entries(&inside, &inos, d, &ok) : jsonNull());
	jsonAdd(out, "trash", has_bin ? shown_list(&bin) : jsonArray());
	jsonAdd(out, "listed", listed);
	if (more) {
		Json *o = jsonObject();
		for (size_t i = 0; i < more; i++) jsonSet(o, labels[i], strlen(labels[i]), has[i] ? shown_entries(&elsewhere[i], &inos, d, &ok) : jsonNull());
		jsonAdd(out, "at", o);
	}
	if (!ok) {
		snprintf(why, size, "the list of stores is not what the store writes");
		jsonFree(out);
		out = NULL;
	}
	inos_free(&inos);
	walk_free(&inside), walk_free(&bin);
	for (size_t i = 0; i < more; i++) walk_free(&elsewhere[i]), free(abs[i]);
	free(elsewhere), free(has), free(abs), free(labels);
	for (size_t i = 0; i < extra_count; i++) free((char *)extra[i]);
	free(extra);
	return out;
}

// ---- the program's snapshot

Json *disk_program_snapshot(Disk *d, Json *listed) {
	Walker w = {.d = d, .program = true};
	bool has_inside = walk_dir(&w, d->store, true, "");
	Walk inside = w.walk;
	bool has_bin = walk_dir(&w, d->trash, false, "");
	Walk bin = w.walk;
	Json *out = jsonObject();
	Json *a = has_inside ? shown_list(&inside) : jsonNull();
	disk_deep(d, a);
	jsonAdd(out, "folder", a);
	a = has_bin ? shown_list(&bin) : jsonNull();
	disk_deep(d, a);
	jsonAdd(out, "trash", a);
	jsonAdd(out, "listed", listed);
	walk_free(&inside), walk_free(&bin);
	return out;
}
