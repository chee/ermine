// Names on disk, in C: see names.h. Mirrors names.ts function for function; key's case folding and normalization
// come from unicode_tables.h (gen_unicode.ts), which asks JavaScript itself.
#include "names.h"

#include "unicode_tables.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX 255
static const char FINAL[] = ".FINAL";
static const char *const KINDS[] = {"int8", "int16", "uint16", "int32", "uint32", "int64", "uint64", "float32", "float64"};

static void *take_memory(size_t size) {
	void *p = malloc(size ? size : 1);
	if (p == NULL) abort();
	return p;
}

static char *copy(const char *s, size_t n) {
	char *out = take_memory(n + 1);
	memcpy(out, s, n);
	out[n] = 0;
	return out;
}

static bool is_kind(const char *ext) {
	for (size_t i = 0; i < sizeof KINDS / sizeof *KINDS; i++)
		if (strcmp(ext, KINDS[i]) == 0) return true;
	return false;
}

// code points -----------------------------------------------------------------------------------

typedef struct {
	uint32_t *v;
	size_t n, cap;
} points;

static void push(points *p, uint32_t c) {
	if (p->n == p->cap) {
		p->cap = p->cap ? p->cap * 2 : 16;
		p->v = realloc(p->v, p->cap * sizeof *p->v);
		if (p->v == NULL) abort();
	}
	p->v[p->n++] = c;
}

/** the code point at s (valid UTF-8, C0 80 for U+0000, WTF-8 surrogates), its length in *size */
static uint32_t next(const unsigned char *s, size_t *size) {
	unsigned char b = s[0];
	if (b < 0x80) return *size = 1, b;
	if (b < 0xe0) return *size = 2, (uint32_t)(b & 0x1f) << 6 | (s[1] & 0x3f);
	if (b < 0xf0) return *size = 3, (uint32_t)(b & 0x0f) << 12 | (uint32_t)(s[1] & 0x3f) << 6 | (s[2] & 0x3f);
	return *size = 4, (uint32_t)(b & 0x07) << 18 | (uint32_t)(s[1] & 0x3f) << 12 | (uint32_t)(s[2] & 0x3f) << 6 | (s[3] & 0x3f);
}

/** a string's code points, a high surrogate and a low one together as the one they make */
static points decode(const char *s, size_t length) {
	points p = {0};
	for (size_t i = 0; i < length;) {
		size_t size;
		uint32_t c = next((const unsigned char *)s + i, &size);
		i += size;
		if (c >= 0xd800 && c < 0xdc00 && i < length) {
			size_t more;
			uint32_t d = next((const unsigned char *)s + i, &more);
			if (d >= 0xdc00 && d < 0xe000) c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00), i += more;
		}
		push(&p, c);
	}
	return p;
}

static size_t encode(uint32_t c, unsigned char *out) {
	if (c == 0) return out[0] = 0xc0, out[1] = 0x80, 2;
	if (c < 0x80) return out[0] = (unsigned char)c, 1;
	if (c < 0x800) return out[0] = 0xc0 | c >> 6, out[1] = 0x80 | (c & 0x3f), 2;
	if (c < 0x10000) return out[0] = 0xe0 | c >> 12, out[1] = 0x80 | (c >> 6 & 0x3f), out[2] = 0x80 | (c & 0x3f), 3;
	out[0] = 0xf0 | c >> 18, out[1] = 0x80 | (c >> 12 & 0x3f), out[2] = 0x80 | (c >> 6 & 0x3f), out[3] = 0x80 | (c & 0x3f);
	return 4;
}

static char *string(const points *p) {
	char *out = take_memory(p->n * 4 + 1);
	size_t n = 0;
	for (size_t i = 0; i < p->n; i++) n += encode(p->v[i], (unsigned char *)out + n);
	out[n] = 0;
	return out;
}

/** bytes of UTF-8 a scalar value takes (U+0000 one; a lone surrogate three) */
static size_t utf8(uint32_t c) {
	return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
}

static size_t size_of(const char *s) {
	points p = decode(s, strlen(s));
	size_t n = 0;
	for (size_t i = 0; i < p.n; i++) n += utf8(p.v[i]);
	free(p.v);
	return n;
}

// names -----------------------------------------------------------------------------------------

char *names_extension(const char *name) {
	const char *dot = strrchr(name, '.');
	if (dot == NULL || dot == name) return NULL;
	size_t n = strlen(dot + 1);
	if (n < 1 || n > 8) return NULL;
	for (size_t i = 1; i <= n; i++) {
		char c = dot[i];
		if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'))) return NULL;
	}
	// .FINAL comes before an extension, never is one
	if (strcmp(dot, ".FINAL") == 0) return NULL;
	return copy(dot + 1, n);
}

bool names_fits(const char *ext, const char *form) {
	if (strcmp(form, "cbor") == 0) return strcmp(ext, "text") == 0;
	if (strcmp(form, "txt") == 0 || strcmp(form, "bin") == 0) return strcmp(ext, "text") != 0 && !is_kind(ext);
	return strcmp(ext, form) == 0;
}

static bool at(const uint8_t *head, size_t length, size_t offset, const char *bytes, size_t n) {
	if (offset + n > length) return false;
	return memcmp(head + offset, bytes, n) == 0;
}

const char *names_sniff(const uint8_t *head, size_t length) {
	if (at(head, length, 0, "\x89PNG\r\n\x1a\n", 8)) return "png";
	if (at(head, length, 0, "\xff\xd8\xff", 3)) return "jpg";
	if (at(head, length, 0, "GIF87a", 6) || at(head, length, 0, "GIF89a", 6)) return "gif";
	if (at(head, length, 0, "%PDF-", 5)) return "pdf";
	if (at(head, length, 0, "RIFF", 4) && at(head, length, 8, "WEBP", 4)) return "webp";
	return "bin";
}

const char *names_suffix(const char *form, const uint8_t *head, size_t length) {
	if (strcmp(form, "txt") == 0) return "txt";
	if (strcmp(form, "bin") == 0) return names_sniff(head, length);
	if (strcmp(form, "cbor") == 0) return "text";
	return form;
}

names_split_result names_split(const char *name, const char *form, const uint8_t *head, size_t length, const char *const *pass, size_t count) {
	char *ext = names_extension(name);
	if (ext != NULL && names_fits(ext, form) && !(pass && names_passes(name, pass, count))) {
		names_split_result r = {copy(name, strlen(name) - strlen(ext) - 1), ext, false};
		return r;
	}
	free(ext);
	const char *suffix = names_suffix(form, head, length);
	char *added = copy(suffix, strlen(suffix));
	names_split_result r = {copy(name, strlen(name)), added, true};
	return r;
}

char *names_write(const char *name, const char *const *pass, size_t count) {
	char *stem = take_memory(strlen(name) * 3 + 16);
	if (*name == 0) strcpy(stem, "untitled");
	else {
		size_t n = 0;
		for (const char *c = name; *c; c++) {
			const unsigned char u = (unsigned char)*c;
			if (u == '/') stem[n++] = ':';
			else if (u == ':') memcpy(stem + n, "\xef\xbc\x9a", 3), n += 3; // U+FF1A
			else if (u == 0xc0 && (unsigned char)c[1] == 0x80) memcpy(stem + n, "\xef\xbf\xbd", 3), n += 3, c++; // NUL as U+FFFD
			else stem[n++] = *c;
		}
		stem[n] = 0;
	}
	if (!names_passes(stem, pass, count)) return stem;
	size_t n = strlen(stem);
	char *wrapped = take_memory(n + 3);
	wrapped[0] = '_';
	memcpy(wrapped + 1, stem, n);
	wrapped[n + 1] = '_';
	wrapped[n + 2] = 0;
	free(stem);
	return wrapped;
}

char *names_cut(const char *stem, const char *ext) {
	size_t dot = *ext == 0 ? 0 : 1 + size_of(ext);
	if (size_of(stem) + dot <= MAX) return copy(stem, strlen(stem));
	long room = MAX - (long)dot - 5 * (long)(sizeof FINAL - 1);
	size_t end = 0, length = strlen(stem);
	while (end < length) {
		size_t size;
		uint32_t c = next((const unsigned char *)stem + end, &size);
		room -= (long)utf8(c);
		if (room < 0) break;
		end += size;
	}
	return copy(stem, end);
}

char *names_free(const char *stem, bool (*taken)(const char *stem, void *context), void *context) {
	size_t n = strlen(stem), cap = n + 64;
	char *s = take_memory(cap);
	memcpy(s, stem, n + 1);
	while (strcmp(s, ".") == 0 || strcmp(s, "..") == 0 || taken(s, context)) {
		if (n + sizeof FINAL > cap) s = realloc(s, cap *= 2);
		if (s == NULL) abort();
		memcpy(s + n, FINAL, sizeof FINAL);
		n += sizeof FINAL - 1;
	}
	return s;
}

char *names_read(const char *name) {
	size_t length = strlen(name);
	char *out = take_memory(length + 1);
	size_t n = 0;
	for (size_t i = 0; i < length; i++) {
		if (name[i] == ':') out[n++] = '/';
		else if (i + 3 <= length && memcmp(name + i, "\xef\xbc\x9a", 3) == 0) out[n++] = ':', i += 2;
		else out[n++] = name[i];
	}
	out[n] = 0;
	return out;
}

// key -------------------------------------------------------------------------------------------

static const unicode_row *find(const unicode_row *table, size_t count, uint32_t c) {
	size_t lo = 0, hi = count;
	while (lo < hi) {
		size_t mid = (lo + hi) / 2;
		if (table[mid].cp < c) lo = mid + 1;
		else hi = mid;
	}
	return lo < count && table[lo].cp == c ? &table[lo] : NULL;
}

static unsigned among(const unicode_span *table, size_t count, uint32_t c) {
	size_t lo = 0, hi = count;
	while (lo < hi) {
		size_t mid = (lo + hi) / 2;
		if (table[mid].hi < c) lo = mid + 1;
		else hi = mid;
	}
	return lo < count && table[lo].lo <= c ? table[lo].value : 0;
}

#define COUNT(t) (sizeof t / sizeof *t)
#define CASED(c) among(unicode_cased, COUNT(unicode_cased), c)
#define IGNORABLE(c) among(unicode_ignorable, COUNT(unicode_ignorable), c)

static void put(points *out, const unicode_row *row, const uint32_t *pool) {
	for (uint8_t i = 0; i < row->len; i++) push(out, pool[row->off + i]);
}

/** NFD: each value decomposed (Hangul by arithmetic), then marks put in combining class order */
static points nfd(const points *in) {
	points out = {0};
	for (size_t i = 0; i < in->n; i++) {
		uint32_t c = in->v[i];
		if (c >= 0xac00 && c <= 0xd7a3) {
			uint32_t s = c - 0xac00;
			push(&out, 0x1100 + s / 588);
			push(&out, 0x1161 + (s % 588) / 28);
			if (s % 28) push(&out, 0x11a7 + s % 28);
			continue;
		}
		const unicode_row *row = find(unicode_decomp, COUNT(unicode_decomp), c);
		if (row) put(&out, row, unicode_decomp_pool);
		else push(&out, c);
	}
	for (size_t i = 0; i < out.n; i++) {
		unsigned rank = among(unicode_ccc, COUNT(unicode_ccc), out.v[i]);
		if (rank == 0) continue;
		// a run of marks: insertion sort, stable
		size_t j = i;
		while (j > 0 && among(unicode_ccc, COUNT(unicode_ccc), out.v[j - 1]) > rank) {
			uint32_t t = out.v[j - 1];
			out.v[j - 1] = out.v[j], out.v[j] = t, j--;
		}
	}
	return out;
}

/** lower case, with Σ as ς at the end of a word: after a cased letter and not before one, case-ignorables between */
static points lower(const points *in) {
	points out = {0};
	for (size_t i = 0; i < in->n; i++) {
		uint32_t c = in->v[i];
		if (c == 0x3a3) {
			bool before = false, after = false;
			for (size_t j = i; j > 0; j--) {
				if (IGNORABLE(in->v[j - 1])) continue;
				before = CASED(in->v[j - 1]);
				break;
			}
			for (size_t j = i + 1; j < in->n; j++) {
				if (IGNORABLE(in->v[j])) continue;
				after = CASED(in->v[j]);
				break;
			}
			push(&out, before && !after ? 0x3c2 : 0x3c3);
			continue;
		}
		const unicode_row *row = find(unicode_lower, COUNT(unicode_lower), c);
		if (row) put(&out, row, unicode_lower_pool);
		else push(&out, c);
	}
	return out;
}

static points upper(const points *in) {
	points out = {0};
	for (size_t i = 0; i < in->n; i++) {
		const unicode_row *row = find(unicode_upper, COUNT(unicode_upper), in->v[i]);
		if (row) put(&out, row, unicode_upper_pool);
		else push(&out, in->v[i]);
	}
	return out;
}

char *names_key(const char *stem) {
	points in = decode(stem, strlen(stem));
	points d = nfd(&in);
	free(in.v);
	points joined = {0};
	// the pieces between dotless ı, each folded alone: lower, upper, lower
	for (size_t start = 0; start <= d.n;) {
		size_t end = start;
		while (end < d.n && d.v[end] != 0x131) end++;
		points piece = {d.v + start, end - start, end - start};
		points a = lower(&piece);
		points b = upper(&a);
		points c = lower(&b);
		for (size_t i = 0; i < c.n; i++) push(&joined, c.v[i]);
		free(a.v), free(b.v), free(c.v);
		if (end < d.n) push(&joined, 0x131);
		start = end + 1;
	}
	free(d.v);
	points out = nfd(&joined);
	free(joined.v);
	char *s = string(&out);
	free(out.v);
	return s;
}

// patterns --------------------------------------------------------------------------------------

static bool matches(const char *name, const char *pattern) {
	if (strchr(pattern, '*') == NULL) return strcmp(name, pattern) == 0;
	size_t length = strlen(name);
	const char *star = strchr(pattern, '*'), *last = strrchr(pattern, '*') + 1;
	size_t first = (size_t)(star - pattern), tail = strlen(last);
	if (length < first + tail || strncmp(name, pattern, first) != 0 || strcmp(name + length - tail, last) != 0) return false;
	size_t end = length - tail, i = first;
	// the parts between the first star and the last, each found after the one before it
	const char *part = star + 1;
	while (part < last) {
		const char *next_star = strchr(part, '*');
		size_t n = (size_t)(next_star - part);
		bool found = false;
		for (size_t j = i; j + n <= end; j++)
			if (memcmp(name + j, part, n) == 0) {
				i = j + n, found = true;
				break;
			}
		if (!found) return false;
		part = next_star + 1;
	}
	return true;
}

bool names_passes(const char *name, const char *const *pass, size_t count) {
	for (size_t i = 0; i < count; i++)
		if (matches(name, pass[i])) return true;
	return false;
}

// members ---------------------------------------------------------------------------------------

char *names_member(double n, const char *words) {
	char digits[400];
	if (n == 0) strcpy(digits, "0");
	else if (n == (double)(long long)n && n > -1e18 && n < 1e18) snprintf(digits, sizeof digits, "%lld", (long long)n);
	else snprintf(digits, sizeof digits, "%.17g", n);
	char *out = take_memory(strlen(digits) + strlen(words) + 1);
	strcpy(out, digits);
	strcat(out, words);
	return out;
}

bool names_number(const char *stem, double *n, char **words) {
	size_t digits = 0;
	while (stem[digits] >= '0' && stem[digits] <= '9') digits++;
	if (digits == 0) return false;
	char *text = copy(stem, digits);
	*n = strtod(text, NULL);
	free(text);
	*words = copy(stem + digits, strlen(stem + digits));
	return true;
}

// renames ---------------------------------------------------------------------------------------

names_take_result names_take(const char *entry) {
	char *slot = names_read(entry);
	char *ext = names_extension(slot);
	names_take_result r = {slot, NULL};
	if (ext != NULL && (strcmp(ext, "text") == 0 || is_kind(ext))) {
		slot[strlen(slot) - strlen(ext) - 1] = 0;
		r.form = strcmp(ext, "text") == 0 ? copy("cbor", 4) : copy(ext, strlen(ext));
	}
	free(ext);
	return r;
}

char *names_renamed(const char *entry, const char *ext, bool folder) {
	char *name = names_read(entry);
	if (ext == NULL || *ext == 0) return name;
	if (folder) {
		char *out = take_memory(strlen(name) + strlen(ext) + 2);
		snprintf(out, strlen(name) + strlen(ext) + 2, "%s.%s", name, ext);
		free(name);
		return out;
	}
	char *have = names_extension(name);
	if (have != NULL && strcmp(have, ext) == 0) name[strlen(name) - strlen(ext) - 1] = 0;
	free(have);
	return name;
}

// percent ---------------------------------------------------------------------------------------

char *names_percent(const char *id) {
	points p = decode(id, strlen(id));
	char *out = take_memory(p.n * 12 + 1);
	size_t n = 0;
	for (size_t i = 0; i < p.n; i++) {
		uint32_t c = p.v[i];
		if (c >= 0xd800 && c < 0xe000) return free(p.v), free(out), NULL;
		if (c == '.') n += (size_t)snprintf(out + n, 4, "%%2E");
		else if (c < 0x80 && (c == '-' || c == '_' || c == '!' || c == '~' || c == '*' || c == '\'' || c == '(' || c == ')' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))) out[n++] = (char)c;
		else {
			unsigned char bytes[4];
			size_t k;
			if (c == 0) bytes[0] = 0, k = 1;
			else k = encode(c, bytes);
			for (size_t j = 0; j < k; j++) n += (size_t)snprintf(out + n, 4, "%%%02X", bytes[j]);
		}
	}
	out[n] = 0;
	free(p.v);
	return out;
}

static int hexval(char c) {
	return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
}

/** the byte a %XX at s names, or -1 */
static int escaped(const char *s) {
	if (s[0] != '%') return -1;
	int a = hexval(s[1]);
	if (a < 0) return -1;
	int b = hexval(s[2]);
	return b < 0 ? -1 : a * 16 + b;
}

char *names_unpercent(const char *segment) {
	size_t length = strlen(segment);
	char *out = take_memory(length * 2 + 1);
	size_t n = 0;
	for (size_t i = 0; i < length;) {
		if (segment[i] != '%') {
			out[n++] = segment[i++];
			continue;
		}
		int b = escaped(segment + i);
		if (b < 0) goto bad;
		i += 3;
		if (b < 0x80) {
			n += encode((uint32_t)b, (unsigned char *)out + n);
			continue;
		}
		int k = b >= 0xf8 ? 5 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
		if (k == 1 || k > 4) goto bad;
		uint32_t c = (uint32_t)b & (0xff >> (k + 1));
		for (int j = 1; j < k; j++) {
			int more = i < length ? escaped(segment + i) : -1;
			if (more < 0 || (more & 0xc0) != 0x80) goto bad;
			c = c << 6 | (uint32_t)(more & 0x3f), i += 3;
		}
		static const uint32_t least[] = {0, 0, 0x80, 0x800, 0x10000};
		if (c < least[k] || c > 0x10ffff || (c >= 0xd800 && c < 0xe000)) goto bad;
		n += encode(c, (unsigned char *)out + n);
	}
	out[n] = 0;
	return out;
bad:
	free(out);
	return copy(segment, length);
}

// order -----------------------------------------------------------------------------------------

/** the UTF-16 units of a string, as the ordering sees them: U+E000 to U+FFFF below the surrogates */
static uint32_t point(uint32_t u) {
	return u >= 0xe000 ? u - 0x800 : u >= 0xd800 ? u + 0x2000 : u;
}

static points units(const char *s) {
	points p = decode(s, strlen(s)), out = {0};
	for (size_t i = 0; i < p.n; i++) {
		uint32_t c = p.v[i];
		if (c >= 0x10000) push(&out, 0xd800 + ((c - 0x10000) >> 10)), push(&out, 0xdc00 + ((c - 0x10000) & 0x3ff));
		else push(&out, c);
	}
	free(p.v);
	return out;
}

int names_bycodepoint(const char *a, const char *b) {
	points x = units(a), y = units(b);
	size_t n = x.n < y.n ? x.n : y.n;
	int r = 0;
	for (size_t i = 0; i < n && r == 0; i++)
		if (x.v[i] != y.v[i]) r = point(x.v[i]) < point(y.v[i]) ? -1 : 1;
	if (r == 0) r = x.n < y.n ? -1 : x.n > y.n ? 1 : 0;
	free(x.v), free(y.v);
	return r;
}
