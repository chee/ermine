// manifest.c: the manifest's folder. See manifest.h; the rules are manifest.ts's.

#include "manifest.h"

#include "../../../../ermine/encoding/c/blake3/blake3.h"
#include "../../../../ermine/encoding/c/cbor.h"
#include "diag.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#if defined(__BYTE_ORDER__) && __BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__
#error "a typed array's bytes are its elements as the machine holds them: little-endian only"
#endif

// bytes ----------------------------------------------------------------------------------------

static void *grab(size_t size) {
	void *p = malloc(size ? size : 1);
	if (!p) abort();
	return p;
}

static void put(sp_bytes *b, const void *data, size_t n) {
	sp_put(b, data, n);
	if (b->failed) abort();
}

static void head(sp_bytes *b, unsigned major, uint64_t n) {
	uint8_t h[9];
	size_t k;
	if (n < 24) h[0] = (uint8_t)(major << 5 | n), k = 1;
	else if (n <= 0xff) h[0] = (uint8_t)(major << 5 | 24), h[1] = (uint8_t)n, k = 2;
	else if (n <= 0xffff) h[0] = (uint8_t)(major << 5 | 25), h[1] = (uint8_t)(n >> 8), h[2] = (uint8_t)n, k = 3;
	else if (n <= 0xffffffffu) {
		h[0] = (uint8_t)(major << 5 | 26);
		for (int i = 0; i < 4; i++) h[1 + i] = (uint8_t)(n >> (24 - 8 * i));
		k = 5;
	} else {
		h[0] = (uint8_t)(major << 5 | 27);
		for (int i = 0; i < 8; i++) h[1 + i] = (uint8_t)(n >> (56 - 8 * i));
		k = 9;
	}
	put(b, h, k);
}

// the value's CBOR appended; false when it has none
static bool putv(sp_bytes *b, const Json *value) {
	size_t n;
	if (!cborEncode(value, NULL, 0, &n, NULL)) return false;
	unsigned char *tmp = grab(n);
	cborEncode(value, tmp, n, &n, NULL);
	put(b, tmp, n);
	free(tmp);
	return true;
}

static bool putn(sp_bytes *b, double number) {
	Json j = {.type = JSON_NUMBER, .number = number};
	return putv(b, &j);
}

// text as a CBOR string; false for one that is not UTF-8 (a lone surrogate)
static bool putt(sp_bytes *b, const char *s, size_t n) {
	Json j = {.type = JSON_STRING, .string = (char *)s, .stringLength = n};
	return putv(b, &j);
}

static void puts_(sp_bytes *b, const char *s) {
	putt(b, s, strlen(s));
}

static void putb(sp_bytes *b, const void *data, size_t n) {
	head(b, 2, n);
	put(b, data, n);
}

static void hexof(const uint8_t *bytes, size_t n, char *out) {
	static const char digits[] = "0123456789abcdef";
	for (size_t i = 0; i < n; i++) out[2 * i] = digits[bytes[i] >> 4], out[2 * i + 1] = digits[bytes[i] & 15];
	out[2 * n] = 0;
}

// 64 lowercase hex digits as 32 bytes; false for anything else
static bool unhex(const char *s, size_t n, uint8_t out[32]) {
	if (n != 64) return false;
	for (size_t i = 0; i < 64; i++) {
		int d = s[i] >= '0' && s[i] <= '9' ? s[i] - '0' : s[i] >= 'a' && s[i] <= 'f' ? s[i] - 'a' + 10 : -1;
		if (d < 0) return false;
		if (i % 2 == 0) out[i / 2] = (uint8_t)(d << 4);
		else out[i / 2] |= (uint8_t)d;
	}
	return true;
}

// a text, as a hash
static bool ishash(const char *s) {
	uint8_t b[32];
	return unhex(s, strlen(s), b);
}

// a deep copy, by way of its CBOR; NULL for a value with none
static Json *own(const Json *value) {
	sp_bytes b = {0};
	if (!putv(&b, value)) return free(b.data), NULL;
	Json *copy = cborDecode(b.data, b.length, NULL, NULL);
	free(b.data);
	return copy;
}

// forms ----------------------------------------------------------------------------------------

static const char *const kinds[JSON_KINDS] = {"int8", "int16", "uint16", "int32", "uint32", "int64", "uint64", "float32", "float64"};
static const char *const forms[] = {"txt", "bin", "cbor", "int8", "int16", "uint16", "int32", "uint32", "int64", "uint64", "float32", "float64"};

// the form a name is, as a static name; NULL for none
static const char *known(const char *name, size_t length) {
	for (size_t i = 0; i < sizeof forms / sizeof *forms; i++)
		if (strlen(forms[i]) == length && memcmp(forms[i], name, length) == 0) return forms[i];
	return NULL;
}

static const char *knownjson(const Json *x) {
	return jsonIsString(x) ? known(x->string, x->stringLength) : NULL;
}

// a form that is a typed array's kind: its index, or -1
static int kindof(const char *form) {
	for (int i = 0; i < JSON_KINDS; i++)
		if (strcmp(kinds[i], form) == 0) return i;
	return -1;
}

const char *mf_form(const Json *value) {
	switch (value->type) {
	case JSON_STRING: return "txt";
	case JSON_BYTES: return "bin";
	case JSON_TYPED: return kinds[value->typed.kind];
	default: return "cbor";
	}
}

// UTF-8 as a platform writes it: U+0000 as 00, a lone surrogate as U+FFFD (as TextEncoder does)
static void utf8(sp_bytes *out, const char *s, size_t n) {
	for (size_t i = 0; i < n; i++) {
		unsigned char c = (unsigned char)s[i];
		if (c == 0xC0 && i + 1 < n && (unsigned char)s[i + 1] == 0x80) put(out, "", 1), i++;
		else if (c == 0xED && i + 2 < n && (unsigned char)s[i + 1] >= 0xA0) put(out, "\xEF\xBF\xBD", 3), i += 2;
		else put(out, s + i, 1);
	}
}

mf_code mf_render(const Json *value, const char *form, sp_bytes *out) {
	if (strcmp(form, "txt") == 0) {
		if (value->type != JSON_STRING) return MF_WRONG;
		utf8(out, value->string, value->stringLength);
		return MF_OK;
	}
	if (strcmp(form, "bin") == 0) {
		if (value->type != JSON_BYTES) return MF_WRONG;
		put(out, value->bytes.data, value->bytes.length);
		return MF_OK;
	}
	if (strcmp(form, "cbor") == 0) {
		if (value->type == JSON_STRING || value->type == JSON_BYTES || value->type == JSON_TYPED) return MF_WRONG;
		char *text = diag_write(value, NULL);
		if (!text) return MF_WRONG;
		utf8(out, text, strlen(text));
		free(text);
		return MF_OK;
	}
	if (value->type != JSON_TYPED || strcmp(kinds[value->typed.kind], form) != 0) return MF_WRONG;
	// the elements end its CBOR, after its tag and its bytes' head; each NaN is the one NaN
	sp_bytes b = {0};
	putv(&b, value);
	put(out, b.data + b.length - value->typed.count * jsonKindSize(value->typed.kind), value->typed.count * jsonKindSize(value->typed.kind));
	free(b.data);
	return MF_OK;
}

// whether the bytes are UTF-8, strictly: no overlong form, no surrogate, nothing past U+10FFFF
static bool valid(const uint8_t *s, size_t n) {
	for (size_t i = 0; i < n;) {
		uint8_t c = s[i];
		if (c < 0x80) {
			i++;
			continue;
		}
		size_t k;
		uint32_t cp, min;
		if (c >= 0xC2 && c <= 0xDF) k = 1, cp = c & 0x1F, min = 0x80;
		else if (c >= 0xE0 && c <= 0xEF) k = 2, cp = c & 0x0F, min = 0x800;
		else if (c >= 0xF0 && c <= 0xF4) k = 3, cp = c & 0x07, min = 0x10000;
		else return false;
		if (i + k >= n) return false;
		for (size_t j = 1; j <= k; j++) {
			if ((s[i + j] & 0xC0) != 0x80) return false;
			cp = cp << 6 | (s[i + j] & 0x3F);
		}
		if (cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return false;
		i += k + 1;
	}
	return true;
}

mf_code mf_parse(const uint8_t *bytes, size_t length, const char *form, Json **out) {
	static const uint8_t none = 0;
	if (!bytes) bytes = &none;
	if (strcmp(form, "bin") == 0) return *out = jsonBytes(bytes, length), MF_OK;
	if (strcmp(form, "txt") == 0 || strcmp(form, "cbor") == 0) {
		if (!valid(bytes, length)) return MF_FORM;
		if (strcmp(form, "cbor") == 0) {
			diag_error e;
			*out = diag_read((const char *)bytes, length, &e);
			return *out ? MF_OK : MF_FORM;
		}
		// json.h holds U+0000 as C0 80
		size_t zeros = 0;
		for (size_t i = 0; i < length; i++) zeros += bytes[i] == 0;
		char *s = grab(length + zeros + 1);
		size_t n = 0;
		for (size_t i = 0; i < length; i++) {
			if (bytes[i] == 0) s[n++] = (char)0xC0, s[n++] = (char)0x80;
			else s[n++] = (char)bytes[i];
		}
		*out = jsonStringOfLength(s, n);
		free(s);
		return MF_OK;
	}
	int kind = kindof(form);
	if (kind < 0) return MF_WRONG;
	size_t size = jsonKindSize((JsonKind)kind);
	if (length % size) return MF_FORM;
	*out = jsonTyped((JsonKind)kind, bytes, length / size);
	return MF_OK;
}

void mf_digest(const uint8_t *bytes, size_t length, char out[65]) {
	blake3_hasher h;
	blake3_hasher_init(&h);
	blake3_hasher_update(&h, bytes, length);
	uint8_t sum[32];
	blake3_hasher_finalize(&h, sum, 32);
	hexof(sum, 32, out);
}

bool mf_hash(const Json *value, char out[65]) {
	// text and bytes are a head, then themselves: hashed in pieces, never copied into one encoding
	unsigned major = 0;
	const void *body = NULL;
	size_t n = 0;
	if (value && value->type == JSON_BYTES) major = 2, body = value->bytes.data, n = value->bytes.length;
	else if (value && value->type == JSON_STRING && !memchr(value->string, 0xc0, value->stringLength) && cborText(value->string, value->stringLength))
		major = 3, body = value->string, n = value->stringLength;
	if (major) {
		sp_bytes h = {0};
		head(&h, major, n);
		blake3_hasher hasher;
		blake3_hasher_init(&hasher);
		blake3_hasher_update(&hasher, h.data, h.length);
		if (n) blake3_hasher_update(&hasher, body, n);
		uint8_t sum[32];
		blake3_hasher_finalize(&hasher, sum, 32);
		hexof(sum, 32, out);
		free(h.data);
		return true;
	}
	sp_bytes b = {0};
	bool ok = putv(&b, value);
	if (ok) mf_digest(b.data, b.length, out);
	free(b.data);
	return ok;
}

void mf_null(char out[65]) {
	mf_digest((const uint8_t *)"\xf6", 1, out);
}

bool mf_keptof(const Json *content, mf_kept *out) {
	if (!content || !mf_hash(content, out->hash)) return false;
	out->form = mf_form(content);
	out->has_head = false;
	out->head = NULL;
	out->head_length = 0;
	return true;
}

// records ---------------------------------------------------------------------------------------

// the record's CBOR as a map; NULL for what is not one
static Json *mapof(const uint8_t *bytes, size_t length) {
	Json *r = cborDecode(bytes, length, NULL, NULL);
	if (r && r->type != JSON_OBJECT) jsonFree(r), r = NULL;
	return r;
}

static bool istrue(const Json *x) {
	return x && x->type == JSON_BOOLEAN && x->boolean;
}

static bool isbytes32(const Json *x) {
	return x && x->type == JSON_BYTES && x->bytes.length == 32;
}

// a hash from a record's 32 bytes, in hex; false when it is not that
static bool unbytes(const Json *x, char out[65]) {
	if (!isbytes32(x)) return false;
	hexof(x->bytes.data, 32, out);
	return true;
}

// a hash as a record holds it: a hex text as 32 bytes; NULL when it is not one
static Json *bytes32(const Json *hash) {
	uint8_t b[32];
	if (!jsonIsString(hash) || !unhex(hash->string, hash->stringLength, b)) return NULL;
	return jsonBytes(b, 32);
}

// each [hash, form] the versions keep, appended to *out; false when they do not
static bool eachkept(const Json *vs, mf_kept **out, size_t *count, size_t *capacity) {
	if (!jsonIsArray(vs)) return false;
	for (int i = 0; i < vs->array.count; i++) {
		const Json *v = vs->array.items[i], *k = jsonGet(v, "kept");
		if (!jsonIsObject(v) || !jsonIsArray(k) || k->array.count != 2) return false;
		const char *form = knownjson(k->array.items[1]);
		mf_kept one = {0};
		if (!form || !unbytes(k->array.items[0], one.hash)) return false;
		one.form = form;
		if (*count == *capacity) *out = realloc(*out, (*capacity = *capacity ? *capacity * 2 : 8) * sizeof **out);
		(*out)[(*count)++] = one;
	}
	return true;
}

// each [hash, form] a record keeps, in order; false for one that is not a node's
static bool keptsof(const Json *r, mf_kept **out, size_t *count) {
	size_t capacity = 0;
	*out = NULL, *count = 0;
	const Json *info = jsonGet(r, "info");
	bool ok = eachkept(jsonGet(r, "value"), out, count, &capacity) && jsonIsArray(info);
	for (int i = 0; ok && i < info->array.count; i++) {
		const Json *e = info->array.items[i];
		ok = jsonIsArray(e) && e->array.count == 2 && eachkept(e->array.items[1], out, count, &capacity);
	}
	if (!ok) free(*out), *out = NULL, *count = 0;
	return ok;
}

mf_code mf_kepts(const uint8_t *record, size_t length, mf_kept **out, size_t *count) {
	Json *r = mapof(record, length);
	if (!r) return MF_STORE;
	bool ok = keptsof(r, out, count);
	jsonFree(r);
	return ok ? MF_OK : MF_STORE;
}

void mf_shape_free(mf_node *s) {
	free(s->kept.head);
	for (size_t i = 0; i < s->sides_length; i++) free(s->sides[i].head);
	free(s->sides);
	for (size_t i = 0; i < s->info_length; i++) free(s->info[i].name);
	free(s->info);
	for (size_t i = 0; i < s->directory_length; i++) {
		for (size_t j = 0; j < s->directory[i].length; j++) free(s->directory[i].ids[j]);
		free(s->directory[i].ids);
		free(s->directory[i].name);
	}
	free(s->directory);
	*s = (mf_node){0};
}

// a kept as the shape has it: a bin value's head, when there is one
static void headed(mf_kept *k, mf_heads heads, void *context) {
	const uint8_t *h;
	size_t n;
	if (strcmp(k->form, "bin") != 0 || !heads || !heads(context, k->hash, &h, &n)) return;
	k->has_head = true;
	k->head = memcpy(grab(n), h, n);
	k->head_length = n;
}

static char *copy(const char *s, size_t n) {
	char *c = memcpy(grab(n + 1), s, n);
	c[n] = 0;
	return c;
}

static mf_code shapeof(const Json *r, mf_heads heads, void *context, mf_node *out) {
	*out = (mf_node){0};
	mf_kept *all;
	size_t n;
	if (!keptsof(r, &all, &n)) return MF_STORE;
	const Json *value = jsonGet(r, "value"), *info = jsonGet(r, "info"), *children = jsonGet(r, "children");
	size_t nv = (size_t)value->array.count;
	if (!jsonIsArray(children)) return free(all), MF_STORE;
	if (nv) out->kept = all[0];
	else mf_null(out->kept.hash), out->kept.form = "cbor";
	headed(&out->kept, heads, context);
	out->sides = grab(nv * sizeof *out->sides);
	for (size_t i = 1; i < nv; i++) {
		out->sides[out->sides_length] = all[i];
		headed(&out->sides[out->sides_length++], heads, context);
	}
	out->info = grab((size_t)info->array.count * sizeof *out->info);
	size_t at = nv;
	for (int i = 0; i < info->array.count; i++) {
		const Json *e = info->array.items[i], *name = e->array.items[0], *vs = e->array.items[1];
		if (vs->array.count) {
			if (!jsonIsString(name)) goto bad;
			mf_info *x = &out->info[out->info_length++];
			x->name = copy(name->string, name->stringLength);
			memcpy(x->hash, all[at].hash, 65);
			x->form = all[at].form;
		}
		at += (size_t)vs->array.count;
	}
	out->directory = grab((size_t)children->array.count * sizeof *out->directory);
	for (int i = 0; i < children->array.count; i++) {
		const Json *e = children->array.items[i];
		if (!jsonIsArray(e) || e->array.count != 2 || !jsonIsString(e->array.items[0]) || !jsonIsArray(e->array.items[1])) goto bad;
		const Json *first = e->array.items[1]->array.count ? e->array.items[1]->array.items[0] : NULL;
		if (!first) continue;
		const Json *ids = jsonGet(first, "content");
		if (!jsonIsObject(first) || !jsonIsArray(ids)) goto bad;
		for (int j = 0; j < ids->array.count; j++)
			if (!jsonIsString(ids->array.items[j])) goto bad;
		if (!ids->array.count) continue;
		const Json *name = e->array.items[0];
		// a name twice keeps its first place and the last list
		mf_slot *s = NULL;
		for (size_t k = 0; k < out->directory_length && !s; k++)
			if (strlen(out->directory[k].name) == name->stringLength && memcmp(out->directory[k].name, name->string, name->stringLength) == 0) s = &out->directory[k];
		if (s) {
			for (size_t j = 0; j < s->length; j++) free(s->ids[j]);
			free(s->ids);
		} else {
			s = &out->directory[out->directory_length++];
			s->name = copy(name->string, name->stringLength);
		}
		s->length = (size_t)ids->array.count;
		s->ids = grab(s->length * sizeof *s->ids);
		for (size_t j = 0; j < s->length; j++) s->ids[j] = copy(ids->array.items[j]->string, ids->array.items[j]->stringLength);
	}
	free(all);
	return MF_OK;
bad:
	free(all);
	mf_shape_free(out);
	return MF_STORE;
}

mf_code mf_shape(const uint8_t *record, size_t length, mf_heads heads, void *context, mf_node *out) {
	*out = (mf_node){0};
	Json *r = mapof(record, length);
	if (!r) return MF_STORE;
	mf_code c = shapeof(r, heads, context, out);
	jsonFree(r);
	return c;
}

// saving ----------------------------------------------------------------------------------------

typedef struct {
	mf_value *items;
	size_t length, capacity;
} Values;

// each version of a content with an encoding, as [kept, change, because]; false for a change
// or because with none
static bool keeping(sd_object o, sp_bytes *out, Values *values) {
	mf_kept *k = grab(o.length * sizeof *k);
	size_t *at = grab(o.length * sizeof *at), n = 0;
	for (size_t i = 0; i < o.length; i++)
		if (mf_keptof(o.versions[i].content, &k[n])) at[n++] = i;
	head(out, 4, n);
	bool ok = true;
	for (size_t i = 0; ok && i < n; i++) {
		const sd_version *v = &o.versions[at[i]];
		head(out, 5, 1 + !!v->change + !!v->because);
		puts_(out, "kept");
		head(out, 4, 2);
		uint8_t b[32];
		unhex(k[i].hash, 64, b);
		putb(out, b, 32);
		puts_(out, k[i].form);
		if (v->change) puts_(out, "change"), ok = putv(out, v->change);
		if (ok && v->because) puts_(out, "because"), ok = putv(out, v->because);
		if (values->length == values->capacity) values->items = realloc(values->items, (values->capacity = values->capacity ? values->capacity * 2 : 8) * sizeof *values->items);
		mf_value *x = &values->items[values->length++];
		memcpy(x->hash, k[i].hash, 65);
		x->value = v->content;
	}
	free(k);
	free(at);
	return ok;
}

static bool header(sp_bytes *out, const sd_header *h) {
	bool ok = true;
	head(out, 5, !!h->has_time + !!h->actor + !!h->reader + !!h->has_site + !!h->cause);
	if (h->has_site) {
		const sd_site *s = &h->site;
		puts_(out, "site");
		head(out, 5, 2 + !!s->has_column + !!s->function);
		puts_(out, "file"), ok &= putt(out, s->file ? s->file : "", s->file ? strlen(s->file) : 0);
		puts_(out, "line"), putn(out, (double)s->line);
		if (s->has_column) puts_(out, "column"), putn(out, (double)s->column);
		if (s->function) puts_(out, "function"), ok &= putt(out, s->function, strlen(s->function));
	}
	if (h->has_time) puts_(out, "time"), putn(out, (double)h->time);
	if (h->actor) puts_(out, "actor"), ok &= putv(out, h->actor);
	if (h->cause) puts_(out, "cause"), ok &= putv(out, h->cause);
	if (h->reader) puts_(out, "reader"), ok &= putt(out, h->reader, strlen(h->reader));
	return ok;
}

static int byhash(const void *a, const void *b) {
	return strcmp(((const mf_value *)a)->hash, ((const mf_value *)b)->hash);
}

static bool headof(void *context, const char *hash, const uint8_t **head, size_t *length) {
	const Values *v = context;
	for (size_t i = 0; i < v->length; i++) {
		if (strcmp(v->items[i].hash, hash) != 0) continue;
		if (v->items[i].value->type != JSON_BYTES) return false;
		*head = v->items[i].value->bytes.data;
		*length = v->items[i].value->bytes.length < MF_HEAD ? v->items[i].value->bytes.length : MF_HEAD;
		return true;
	}
	return false;
}

// the record and its values; the shape too when asked
static mf_code saved(const sd_node *n, mf_skip skip, void *context, mf_saving *out, bool shaped) {
	*out = (mf_saving){0};
	Values values = {0};
	sp_bytes *b = &out->record;
	bool ok = true;
	head(b, 5, 5);
	puts_(b, "id");
	ok &= putt(b, n->id, strlen(n->id));
	puts_(b, "info");
	head(b, 4, n->info_length);
	for (size_t i = 0; ok && i < n->info_length; i++) {
		head(b, 4, 2);
		ok = putt(b, n->info[i].name, strlen(n->info[i].name)) && keeping(n->info[i].object, b, &values);
	}
	puts_(b, "value");
	if (ok) ok = keeping(n->value, b, &values);
	puts_(b, "header");
	if (ok) ok = header(b, &n->header);
	puts_(b, "children");
	head(b, 4, n->children_length);
	for (size_t i = 0; ok && i < n->children_length; i++) {
		const sd_entry *e = &n->children[i];
		head(b, 4, 2);
		ok = putt(b, e->name, strlen(e->name));
		head(b, 4, e->object.length);
		for (size_t j = 0; ok && j < e->object.length; j++) {
			const sd_version *v = &e->object.versions[j];
			const sd_list *l = v->content;
			size_t ids = 0;
			for (size_t k = 0; l && k < l->length; k++) ids += l->items[k].id && !(skip && skip(context, l->items[k].id));
			head(b, 5, 1 + !!v->change + !!v->because);
			if (v->change) puts_(b, "change"), ok &= putv(b, v->change);
			if (v->because) puts_(b, "because"), ok &= putv(b, v->because);
			puts_(b, "content");
			head(b, 4, ids);
			for (size_t k = 0; l && k < l->length; k++)
				if (l->items[k].id && !(skip && skip(context, l->items[k].id))) ok &= putt(b, l->items[k].id, strlen(l->items[k].id));
		}
	}
	if (!ok) {
		free(b->data), free(values.items);
		*out = (mf_saving){0};
		return MF_STORE;
	}
	// each value once, by hash
	qsort(values.items, values.length, sizeof *values.items, byhash);
	size_t m = 0;
	for (size_t i = 0; i < values.length; i++)
		if (!m || strcmp(values.items[m - 1].hash, values.items[i].hash) != 0) values.items[m++] = values.items[i];
	values.length = m;
	out->values = values.items;
	out->values_length = values.length;
	if (shaped) {
		mf_code c = mf_saving_shape(out);
		if (c != MF_OK) return free(b->data), free(values.items), *out = (mf_saving){0}, c;
	}
	return MF_OK;
}

mf_code mf_save(const sd_node *n, mf_skip skip, void *context, mf_saving *out) {
	return saved(n, skip, context, out, true);
}

mf_code mf_save_record(const sd_node *n, mf_skip skip, void *context, mf_saving *out) {
	return saved(n, skip, context, out, false);
}

mf_code mf_saving_shape(mf_saving *s) {
	mf_shape_free(&s->shape);
	Values values = {s->values, s->values_length, s->values_length};
	Json *r = mapof(s->record.data, s->record.length);
	mf_code c = r ? shapeof(r, headof, &values, &s->shape) : MF_STORE;
	jsonFree(r);
	return c;
}

void mf_saving_free(mf_saving *s) {
	free(s->record.data);
	free(s->values);
	mf_shape_free(&s->shape);
	*s = (mf_saving){0};
}

// restoring -------------------------------------------------------------------------------------

// a value as the pack codec writes it and reads it
static int packencode(void *context, sp_field field, const void *value, sp_bytes *out) {
	(void)context, (void)field;
	return !value || !putv(out, value);
}

static int packdecode(void *context, sp_field field, const uint8_t *item, size_t length,
	const void **value) {
	(void)context, (void)field;
	*value = cborDecode(item, length, NULL, NULL);
	return *value == NULL;
}

static const sp_codec packed = {packencode, packdecode, NULL};

// each version's kept replaced by its content, from values
static bool fill(Json *vs, mf_values values, void *context) {
	for (int i = 0; i < vs->array.count; i++) {
		Json *v = vs->array.items[i], *k = jsonGet(v, "kept");
		char hash[65];
		unbytes(k->array.items[0], hash);
		const Json *content = values(context, hash);
		Json *c = content ? own(content) : NULL;
		if (!c) return false;
		jsonRemove(v, "kept", 4);
		jsonAdd(v, "content", c);
	}
	return true;
}

mf_code mf_open_record(const uint8_t *record, size_t length, mf_opened *out, mf_kept **kepts, size_t *count) {
	*out = (mf_opened){0};
	Json *r = mapof(record, length);
	if (!r) return MF_STORE;
	if (!keptsof(r, kepts, count)) return jsonFree(r), MF_STORE;
	out->record = r;
	return MF_OK;
}

mf_code mf_restore(const uint8_t *record, size_t length, mf_values values, void *context, sp_graph *out) {
	mf_opened o;
	mf_kept *all;
	size_t n;
	mf_code c = mf_open_record(record, length, &o, &all, &n);
	if (c != MF_OK) return c;
	free(all);
	return mf_restore_opened(&o, values, context, out);
}

mf_code mf_restore_opened(mf_opened *opened, mf_values values, void *context, sp_graph *out) {
	Json *r = opened->record;
	opened->record = NULL;
	// every kept was checked: value and info are lists of versions that have a kept
	Json *info = jsonGet(r, "info");
	bool ok = fill(jsonGet(r, "value"), values, context);
	for (int i = 0; ok && i < info->array.count; i++) ok = fill(info->array.items[i]->array.items[1], values, context);
	sp_bytes b = {0};
	mf_code c = ok && putv(&b, r) ? MF_OK : MF_STORE;
	jsonFree(r);
	if (c == MF_OK && sp_decode(b.data, b.length, &packed, out) != SP_OK) c = MF_STORE;
	free(b.data);
	return c;
}

// the other records -----------------------------------------------------------------------------

// a copy of x as a member of m; false when x has none
static bool add(Json *m, const char *key, const Json *x) {
	Json *c = x ? own(x) : NULL;
	if (!c) return false;
	jsonAdd(m, key, c);
	return true;
}

// a member of m, copied, when the record has one
static bool maybe(Json *m, const Json *r, const char *key) {
	const Json *x = jsonGet(r, key);
	return !x || add(m, key, x);
}

// a member that is a hash, as its 32 bytes, when the record has one
static bool hashed(Json *m, const Json *r, const char *key) {
	const Json *x = jsonGet(r, key);
	if (!x) return true;
	Json *b = bytes32(x);
	if (!b) return false;
	jsonAdd(m, key, b);
	return true;
}

// a list of at least this many
static bool listof(const Json *x, int least) {
	return jsonIsArray(x) && x->array.count >= least;
}

// a list of texts
static bool texts(const Json *x) {
	if (!jsonIsArray(x)) return false;
	for (int i = 0; i < x->array.count; i++)
		if (!jsonIsString(x->array.items[i])) return false;
	return true;
}

static bool oneof(const Json *key, const char *const *set, size_t n) {
	for (size_t i = 0; i < n; i++)
		if (strlen(set[i]) == key->stringLength && memcmp(set[i], key->string, key->stringLength) == 0) return true;
	return false;
}

// a map's keys all among those given
static bool only(const Json *r, const char *const *set, size_t n) {
	for (int i = 0; i < r->object.count; i++) {
		Json key = {.type = JSON_STRING, .string = r->object.members[i].key, .stringLength = r->object.members[i].keyLength};
		if (!oneof(&key, set, n)) return false;
	}
	return true;
}

// the record's own copy of a text, number or list; NULL when it is not what is asked
static Json *copyof(const Json *x) {
	return own(x);
}

static const char *const layout[] = {"home", "file", "laid", "was", "sides", "folder", "entries", "left", "away"};

static Json *shownencode(const Json *x) {
	Json *m = jsonObject();
	const Json *v;
	if ((v = jsonGet(x, "home"))) {
		Json *h = jsonArray();
		jsonAdd(m, "home", h);
		if (!listof(v, 3)) goto bad;
		for (int i = 0; i < 3; i++) {
			Json *c = copyof(v->array.items[i]);
			if (!c) goto bad;
			jsonPush(h, c);
		}
	}
	if (!maybe(m, x, "file") || !hashed(m, x, "laid") || !hashed(m, x, "was")) goto bad;
	if ((v = jsonGet(x, "sides")) && jsonIsArray(v) && v->array.count && !add(m, "sides", v)) goto bad;
	if (istrue(jsonGet(x, "folder"))) jsonAdd(m, "folder", jsonBoolean(true));
	if ((v = jsonGet(x, "entries"))) {
		if (!jsonIsObject(v)) goto bad;
		Json *e = jsonObject();
		jsonAdd(m, "entries", e);
		for (int i = 0; i < v->object.count; i++) {
			const JsonMember *k = &v->object.members[i];
			if (k->value->type != JSON_STRING && k->value->type != JSON_ARRAY) goto bad;
			Json *c = copyof(k->value);
			if (!c) goto bad;
			jsonAddOfLength(e, k->key, k->keyLength, c);
		}
	}
	if (!maybe(m, x, "left")) goto bad;
	if (istrue(jsonGet(x, "away"))) jsonAdd(m, "away", jsonBoolean(true));
	return m;
bad:
	jsonFree(m);
	return NULL;
}

static Json *shownread(const Json *r) {
	Json *x = jsonObject();
	const Json *v;
	if (!only(r, layout, sizeof layout / sizeof *layout)) goto bad;
	if ((v = jsonGet(r, "home"))) {
		if (!jsonIsArray(v) || v->array.count != 3 || !jsonIsString(v->array.items[0]) || !jsonIsString(v->array.items[1]) || !jsonIsNumber(v->array.items[2]) || !add(x, "home", v)) goto bad;
	}
	if ((v = jsonGet(r, "file")) && (!jsonIsString(v) || !add(x, "file", v))) goto bad;
	for (int i = 0; i < 2; i++) {
		const char *key = i ? "was" : "laid";
		char hash[65];
		if ((v = jsonGet(r, key))) {
			if (!unbytes(v, hash)) goto bad;
			jsonAdd(x, key, jsonString(hash));
		}
	}
	if ((v = jsonGet(r, "sides")) && (!texts(v) || !add(x, "sides", v))) goto bad;
	if ((v = jsonGet(r, "folder")) && (!istrue(v) || !add(x, "folder", v))) goto bad;
	if ((v = jsonGet(r, "entries"))) {
		if (!jsonIsObject(v)) goto bad;
		Json *e = jsonObject();
		jsonAdd(x, "entries", e);
		for (int i = 0; i < v->object.count; i++) {
			const JsonMember *k = &v->object.members[i];
			// a stem, or a list of them, one at least
			if (!jsonIsString(k->value) && !(texts(k->value) && k->value->array.count)) goto bad;
			Json *c = copyof(k->value);
			if (!c) goto bad;
			jsonAddOfLength(e, k->key, k->keyLength, c);
		}
	}
	if ((v = jsonGet(r, "left")) && (!texts(v) || !add(x, "left", v))) goto bad;
	if ((v = jsonGet(r, "away")) && (!istrue(v) || !add(x, "away", v))) goto bad;
	return x;
bad:
	jsonFree(x);
	return NULL;
}

// what a step expects at a place, as a record holds it
static Json *whereencode(const Json *x) {
	if (!x) return NULL;
	if (x->type == JSON_NULL) return jsonNull();
	if (!jsonIsObject(x)) return NULL;
	Json *m = jsonObject();
	const Json *v;
	if ((v = jsonGet(x, "file"))) {
		Json *b = bytes32(v);
		if (b) jsonAdd(m, "file", b);
		else jsonFree(m), m = NULL;
	} else if ((v = jsonGet(x, "link"))) {
		if (!add(m, "link", v)) jsonFree(m), m = NULL;
	} else if (!add(m, "folder", jsonGet(x, "folder") ? jsonGet(x, "folder") : &(Json){.type = JSON_NULL})) jsonFree(m), m = NULL;
	return m;
}

static Json *whereread(const Json *x) {
	if (!x) return NULL;
	if (x->type == JSON_NULL) return jsonNull();
	if (!jsonIsObject(x) || x->object.count != 1) return NULL;
	const Json *v;
	Json *m = jsonObject();
	char hash[65];
	if ((v = jsonGet(x, "file"))) {
		if (unbytes(v, hash)) return jsonAdd(m, "file", jsonString(hash)), m;
	} else if ((v = jsonGet(x, "link"))) {
		if (jsonIsString(v) && add(m, "link", v)) return m;
	} else if ((v = jsonGet(x, "folder"))) {
		if ((v->type == JSON_NULL || jsonIsNumber(v)) && add(m, "folder", v)) return m;
	}
	jsonFree(m);
	return NULL;
}

// a node's info as a record holds it
static Json *infoencode(const Json *x) {
	if (!jsonIsArray(x)) return NULL;
	Json *l = jsonArray();
	for (int i = 0; i < x->array.count; i++) {
		const Json *e = x->array.items[i];
		if (!listof(e, 3)) goto bad;
		Json *entry = jsonArray(), *b = bytes32(e->array.items[1]);
		jsonPush(l, entry);
		Json *name = copyof(e->array.items[0]), *form = copyof(e->array.items[2]);
		if (!b || !name || !form) goto bad;
		jsonPush(entry, name), jsonPush(entry, b), jsonPush(entry, form);
	}
	return l;
bad:
	jsonFree(l);
	return NULL;
}

static Json *inforead(const Json *x) {
	if (!jsonIsArray(x)) return NULL;
	Json *l = jsonArray();
	char hash[65];
	for (int i = 0; i < x->array.count; i++) {
		const Json *e = x->array.items[i];
		if (!jsonIsArray(e) || e->array.count != 3 || !jsonIsString(e->array.items[0]) || !knownjson(e->array.items[2]) || !unbytes(e->array.items[1], hash)) goto bad;
		Json *entry = jsonArray();
		jsonPush(l, entry);
		Json *name = copyof(e->array.items[0]), *form = copyof(e->array.items[2]);
		if (!name || !form) goto bad;
		jsonPush(entry, name), jsonPush(entry, jsonString(hash)), jsonPush(entry, form);
	}
	return l;
bad:
	jsonFree(l);
	return NULL;
}

static const char *const stepkeys[] = {"number", "what", "from", "to", "before", "after", "id", "slot", "form", "info", "side"};
static const char *const whats[] = {"file", "link", "folder", "rename", "remove", "info"};

static Json *planencode(const Json *steps) {
	if (!jsonIsArray(steps)) return NULL;
	Json *l = jsonArray();
	for (int i = 0; i < steps->array.count; i++) {
		const Json *s = steps->array.items[i], *v;
		Json *m = jsonObject();
		jsonPush(l, m);
		if (!jsonIsObject(s) || !add(m, "number", jsonGet(s, "number")) || !add(m, "what", jsonGet(s, "what"))) goto bad;
		Json *before = whereencode(jsonGet(s, "before")), *after = whereencode(jsonGet(s, "after"));
		if (before) jsonAdd(m, "before", before);
		if (after) jsonAdd(m, "after", after);
		if (!before || !after) goto bad;
		if (!maybe(m, s, "from") || !maybe(m, s, "to") || !maybe(m, s, "id") || !maybe(m, s, "form") || !maybe(m, s, "side")) goto bad;
		if ((v = jsonGet(s, "slot"))) {
			if (!listof(v, 2)) goto bad;
			Json *slot = jsonArray();
			jsonAdd(m, "slot", slot);
			for (int k = 0; k < 2; k++) {
				Json *c = copyof(v->array.items[k]);
				if (!c) goto bad;
				jsonPush(slot, c);
			}
		}
		if ((v = jsonGet(s, "info"))) {
			Json *info = infoencode(v);
			if (!info) goto bad;
			jsonAdd(m, "info", info);
		}
	}
	return l;
bad:
	jsonFree(l);
	return NULL;
}

static Json *planread(const Json *list) {
	if (!jsonIsArray(list)) return NULL;
	Json *l = jsonArray();
	for (int i = 0; i < list->array.count; i++) {
		const Json *r = list->array.items[i], *v;
		Json *m = jsonObject();
		jsonPush(l, m);
		if (!jsonIsObject(r) || !only(r, stepkeys, sizeof stepkeys / sizeof *stepkeys)) goto bad;
		const Json *what = jsonGet(r, "what"), *number = jsonGet(r, "number");
		if (!jsonIsString(what) || !oneof(what, whats, sizeof whats / sizeof *whats) || !jsonIsNumber(number)) goto bad;
		Json *before = whereread(jsonGet(r, "before")), *after = whereread(jsonGet(r, "after"));
		if (before) jsonAdd(m, "before", before);
		if (after) jsonAdd(m, "after", after);
		if (!before || !after || !add(m, "number", number) || !add(m, "what", what)) goto bad;
		for (int k = 0; k < 3; k++) {
			const char *key = k == 0 ? "from" : k == 1 ? "to" : "id";
			if ((v = jsonGet(r, key)) && (!jsonIsString(v) || !add(m, key, v))) goto bad;
		}
		if ((v = jsonGet(r, "slot")) && (!texts(v) || v->array.count != 2 || !add(m, "slot", v))) goto bad;
		if ((v = jsonGet(r, "form")) && (!knownjson(v) || !add(m, "form", v))) goto bad;
		if ((v = jsonGet(r, "info"))) {
			Json *info = inforead(v);
			if (!info) goto bad;
			jsonAdd(m, "info", info);
		}
		if ((v = jsonGet(r, "side")) && (!jsonIsNumber(v) || !add(m, "side", v))) goto bad;
	}
	return l;
bad:
	jsonFree(l);
	return NULL;
}

static const char *const statekeys[] = {"format", "done", "pass"};

mf_code mf_encode(mf_codec codec, const Json *x, sp_bytes *out) {
	Json *m = NULL;
	switch (codec) {
	case MF_META:
		m = jsonObject();
		if (!add(m, "root", jsonGet(x, "root")) || !add(m, "time", jsonGet(x, "time"))) jsonFree(m), m = NULL;
		break;
	case MF_SHOWN: m = shownencode(x); break;
	case MF_PLAN: m = planencode(x); break;
	case MF_STATE:
		m = jsonObject();
		if (!add(m, "format", jsonGet(x, "format")) || !add(m, "done", jsonGet(x, "done")) || !jsonIsArray(jsonGet(x, "pass")) || !add(m, "pass", jsonGet(x, "pass"))) jsonFree(m), m = NULL;
		break;
	}
	if (!m) return MF_STORE;
	bool ok = putv(out, m);
	jsonFree(m);
	return ok ? MF_OK : MF_STORE;
}

mf_code mf_decode(mf_codec codec, const uint8_t *bytes, size_t length, Json **out) {
	Json *r = cborDecode(bytes, length, NULL, NULL), *x = NULL;
	*out = NULL;
	if (!r) return MF_STORE;
	if (codec == MF_PLAN) x = planread(r);
	else if (r->type == JSON_OBJECT) {
		const Json *root = jsonGet(r, "root"), *time = jsonGet(r, "time"), *done = jsonGet(r, "done"), *pass = jsonGet(r, "pass"), *format = jsonGet(r, "format");
		switch (codec) {
		case MF_META:
			if (jsonIsString(root) && jsonIsNumber(time)) {
				x = jsonObject();
				if (!add(x, "root", root) || !add(x, "time", time)) jsonFree(x), x = NULL;
			}
			break;
		case MF_SHOWN: x = shownread(r); break;
		case MF_STATE:
			if (only(r, statekeys, 3) && jsonIsNumber(format) && format->number == 1 && jsonIsNumber(done) && texts(pass)) {
				x = jsonObject();
				if (!add(x, "format", format) || !add(x, "done", done) || !add(x, "pass", pass)) jsonFree(x), x = NULL;
			}
			break;
		default: break;
		}
	}
	jsonFree(r);
	*out = x;
	return x ? MF_OK : MF_STORE;
}

void mf_records_free(mf_record *records, size_t count) {
	for (size_t i = 0; i < count; i++) free((char *)records[i].key), free((uint8_t *)records[i].data);
	free(records);
}

static int byhex(const void *a, const void *b) {
	return strcmp(a, b);
}

mf_code mf_named(const mf_record *records, size_t count, mf_hex **hashes, size_t *length) {
	mf_hex *out = NULL;
	size_t n = 0, capacity = 0;
	*hashes = NULL, *length = 0;
	mf_code c = MF_OK;
	for (size_t i = 0; i < count && c == MF_OK; i++) {
		const mf_record *r = &records[i];
		if (strncmp(r->key, "node:", 5) == 0) {
			mf_kept *k;
			size_t m;
			if ((c = mf_kepts(r->data, r->length, &k, &m)) != MF_OK) break;
			for (size_t j = 0; j < m; j++) {
				if (n == capacity) out = realloc(out, (capacity = capacity ? capacity * 2 : 16) * sizeof *out);
				memcpy(out[n++], k[j].hash, 65);
			}
			free(k);
		} else if (strcmp(r->key, "plan") == 0) {
			Json *steps;
			if ((c = mf_decode(MF_PLAN, r->data, r->length, &steps)) != MF_OK) break;
			for (int s = 0; s < steps->array.count; s++) {
				const Json *step = steps->array.items[s], *info = jsonGet(step, "info");
				for (int w = 0; w < 2; w++) {
					const Json *f = jsonGet(jsonGet(step, w ? "after" : "before"), "file");
					if (f) {
						if (n == capacity) out = realloc(out, (capacity = capacity ? capacity * 2 : 16) * sizeof *out);
						memcpy(out[n++], f->string, 65);
					}
				}
				for (int e = 0; info && e < info->array.count; e++) {
					if (n == capacity) out = realloc(out, (capacity = capacity ? capacity * 2 : 16) * sizeof *out);
					memcpy(out[n++], info->array.items[e]->array.items[1]->string, 65);
				}
			}
			jsonFree(steps);
		}
	}
	if (c != MF_OK) return free(out), c;
	qsort(out, n, sizeof *out, byhex);
	size_t m = 0;
	for (size_t i = 0; i < n; i++)
		if (!m || strcmp(out[m - 1], out[i]) != 0) memcpy(out[m++], out[i], 65);
	*hashes = out, *length = m;
	return MF_OK;
}

// records by key ----------------------------------------------------------------------------------

typedef struct {
	char *key;
	size_t keylength;
	uint8_t *data; // NULL in a map of sizes
	size_t length;
	size_t units; // the key's length in UTF-16 code units, as JavaScript counts it
} Entry;

// a map of records, in no order: items dense, an index of open addressing over them (0 empty,
// TOMB gone, else item + 1)
typedef struct {
	Entry *items;
	size_t count, capacity;
	size_t *index, slots, tombs;
	size_t live; // each record's key's units, bytes and 4, together
} Map;

#define TOMB ((size_t)-1)
#define NONE ((size_t)-1)

static size_t fnv(const char *key, size_t n) {
	uint64_t h = 14695981039346656037u;
	for (size_t i = 0; i < n; i++) h = (h ^ (unsigned char)key[i]) * 1099511628211u;
	return (size_t)h;
}

static void rehash(Map *m, size_t slots) {
	free(m->index);
	m->index = calloc(slots, sizeof *m->index);
	if (!m->index) abort();
	m->slots = slots, m->tombs = 0;
	for (size_t i = 0; i < m->count; i++) {
		size_t s = fnv(m->items[i].key, m->items[i].keylength) & (slots - 1);
		while (m->index[s]) s = (s + 1) & (slots - 1);
		m->index[s] = i + 1;
	}
}

// the slot of a key, or NONE
static size_t lookup(const Map *m, const char *key, size_t n) {
	if (!m->slots) return NONE;
	for (size_t s = fnv(key, n) & (m->slots - 1); m->index[s]; s = (s + 1) & (m->slots - 1)) {
		if (m->index[s] == TOMB) continue;
		const Entry *e = &m->items[m->index[s] - 1];
		if (e->keylength == n && memcmp(e->key, key, n) == 0) return s;
	}
	return NONE;
}

// a key's length in UTF-16 code units: its code points, two for each past U+FFFF
static size_t units(const char *key, size_t n) {
	size_t u = 0;
	for (size_t i = 0; i < n; i++) {
		unsigned char c = (unsigned char)key[i];
		if ((c & 0xC0) != 0x80) u++;
		if (c >= 0xF0) u++;
	}
	return u;
}

// sets a record; takes data (NULL for a map of sizes)
static void mapset(Map *m, const char *key, size_t n, uint8_t *data, size_t length) {
	size_t s = lookup(m, key, n);
	if (s != NONE) {
		Entry *e = &m->items[m->index[s] - 1];
		free(e->data);
		m->live += length - e->length;
		e->data = data, e->length = length;
		return;
	}
	if ((m->count + m->tombs + 1) * 2 > m->slots) {
		size_t want = 16;
		while (want < (m->count + 1) * 4) want *= 2;
		rehash(m, want);
	}
	if (m->count == m->capacity) {
		m->items = realloc(m->items, (m->capacity = m->capacity ? m->capacity * 2 : 16) * sizeof *m->items);
		if (!m->items) abort();
	}
	Entry *e = &m->items[m->count++];
	*e = (Entry){copy(key, n), n, data, length, units(key, n)};
	m->live += e->units + length + 4;
	s = fnv(key, n) & (m->slots - 1);
	while (m->index[s] && m->index[s] != TOMB) s = (s + 1) & (m->slots - 1);
	if (m->index[s] == TOMB) m->tombs--;
	m->index[s] = m->count;
}

static void mapdelete(Map *m, const char *key, size_t n) {
	size_t s = lookup(m, key, n);
	if (s == NONE) return;
	size_t i = m->index[s] - 1, last = m->count - 1;
	Entry *e = &m->items[i];
	m->live -= e->units + e->length + 4;
	free(e->key), free(e->data);
	m->index[s] = TOMB, m->tombs++;
	if (i != last) {
		m->items[i] = m->items[last];
		size_t t = fnv(m->items[i].key, m->items[i].keylength) & (m->slots - 1);
		while (m->index[t] != last + 1) t = (t + 1) & (m->slots - 1);
		m->index[t] = i + 1;
	}
	m->count--;
}

static void mapfree(Map *m) {
	for (size_t i = 0; i < m->count; i++) free(m->items[i].key), free(m->items[i].data);
	free(m->items), free(m->index);
	*m = (Map){0};
}

// frames ----------------------------------------------------------------------------------------

typedef struct {
	sp_bytes key; // its CBOR
	const mf_record *record;
} Keyed;

static int bykey(const void *a, const void *b) {
	const sp_bytes *x = &((const Keyed *)a)->key, *y = &((const Keyed *)b)->key;
	size_t n = x->length < y->length ? x->length : y->length;
	int c = memcmp(x->data, y->data, n);
	return c ? c : x->length < y->length ? -1 : x->length > y->length;
}

// a frame: its length, 4 bytes big-endian, then the CBOR of a map from key to bytes or null
static mf_code frame(const mf_record *records, size_t count, sp_bytes *out) {
	Keyed *keyed = grab(count * sizeof *keyed);
	size_t made = 0;
	mf_code c = MF_OK;
	for (size_t i = 0; i < count; i++, made++) {
		keyed[i] = (Keyed){{0}, &records[i]};
		if (!putt(&keyed[i].key, records[i].key, strlen(records[i].key))) {
			c = MF_STORE;
			made++;
			break;
		}
	}
	if (c == MF_OK) {
		qsort(keyed, count, sizeof *keyed, bykey);
		put(out, "\0\0\0\0", 4);
		head(out, 5, count);
		for (size_t i = 0; i < count; i++) {
			put(out, keyed[i].key.data, keyed[i].key.length);
			if (keyed[i].record->data) putb(out, keyed[i].record->data, keyed[i].record->length);
			else put(out, "\xf6", 1);
		}
		size_t body = out->length - 4;
		if (body > 0xffffffffu) c = MF_STORE;
		else for (int i = 0; i < 4; i++) out->data[i] = (uint8_t)(body >> (24 - 8 * i));
	}
	for (size_t i = 0; i < made; i++) free(keyed[i].key.data);
	free(keyed);
	return c;
}

// the folder -------------------------------------------------------------------------------------

struct mf_manifest {
	char *dir, *log, *values, *tmp;
	mf_sync sync;
	void *context;
	size_t slack;
	// once read: each record's size; how many bytes of the log are whole frames; whether a frame
	// cut short follows them; whether the log is there
	bool read;
	Map sizes;
	size_t size;
	bool cut, there;
};

static char *join(const char *dir, const char *name) {
	char *p = grab(strlen(dir) + strlen(name) + 2);
	return strcat(strcat(strcpy(p, dir), "/"), name);
}

mf_manifest *mf_open(const char *dir, mf_sync sync, void *context, size_t slack) {
	mf_manifest *m = grab(sizeof *m);
	*m = (mf_manifest){0};
	m->dir = copy(dir, strlen(dir));
	m->log = join(dir, "manifest");
	m->values = join(dir, "values");
	m->tmp = join(dir, "tmp");
	m->sync = sync, m->context = context, m->slack = slack;
	return m;
}

void mf_close(mf_manifest *m) {
	if (!m) return;
	mapfree(&m->sizes);
	free(m->dir), free(m->log), free(m->values), free(m->tmp);
	free(m);
}

// 0, or -1 with errno
static int syncpath(mf_manifest *m, const char *path) {
	if (m->sync) return m->sync(m->context, path);
	int fd = open(path, O_RDONLY);
	if (fd < 0) return -1;
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

// makes a folder and the ones above it, as mkdir -p
static int mkdirs(const char *path) {
	char *p = copy(path, strlen(path));
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
	free(p);
	return result;
}

// the file's whole bytes: 0, 1 when it is not there, -1 with errno
static int readfile(const char *path, uint8_t **data, size_t *length) {
	*data = NULL, *length = 0;
	int fd = open(path, O_RDONLY);
	if (fd < 0) return errno == ENOENT ? 1 : -1;
	size_t capacity = 4096, n = 0;
	uint8_t *b = grab(capacity);
	for (;;) {
		if (n == capacity) b = realloc(b, capacity *= 2);
		if (!b) abort();
		ssize_t r = read(fd, b + n, capacity - n);
		if (r < 0) {
			if (errno == EINTR) continue;
			int e = errno;
			free(b), close(fd);
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

// writes the bytes to the file, made if it is not there; flags: O_TRUNC or O_APPEND
static int writefile(const char *path, const uint8_t *data, size_t length, int flags) {
	int fd = open(path, O_WRONLY | O_CREAT | flags, 0666);
	if (fd < 0) return -1;
	for (size_t at = 0; at < length;) {
		ssize_t w = write(fd, data + at, length - at);
		if (w < 0) {
			if (errno == EINTR) continue;
			int e = errno;
			close(fd);
			errno = e;
			return -1;
		}
		at += (size_t)w;
	}
	return close(fd);
}

// writes bytes in tmp/ as name, synced, then renames them to path, and syncs its folder
static mf_code through(mf_manifest *m, const char *name, const uint8_t *data, size_t length, const char *path) {
	mf_code c = MF_IO;
	char *t = join(m->tmp, name), *folder = copy(path, (size_t)(strrchr(path, '/') - path));
	if (mkdirs(m->tmp) == 0 && writefile(t, data, length, O_TRUNC) == 0 && syncpath(m, t) == 0 && rename(t, path) == 0 && syncpath(m, folder) == 0) c = MF_OK;
	free(t), free(folder);
	return c;
}

mf_code mf_make(mf_manifest *m) {
	return mf_make_kept(m, true);
}

mf_code mf_make_kept(mf_manifest *m, bool kept) {
	char *id = join(m->dir, "id");
	bool ok = (!kept || mkdirs(m->values) == 0) && mkdirs(m->tmp) == 0 && mkdirs(id) == 0;
	free(id);
	return ok ? MF_OK : MF_IO;
}

mf_code mf_exists(mf_manifest *m, bool *exists) {
	struct stat st;
	*exists = false;
	if (lstat(m->log, &st) == -1) return errno == ENOENT ? MF_OK : MF_IO;
	*exists = S_ISREG(st.st_mode);
	return MF_OK;
}

// reads the log into its records, and what it says of itself
static mf_code scan(mf_manifest *m, Map *records) {
	uint8_t *all;
	size_t length, at = 0;
	int r = readfile(m->log, &all, &length);
	if (r < 0) return MF_IO;
	mf_code c = MF_OK;
	while (at + 4 <= length) {
		size_t end = at + 4 + ((size_t)all[at] << 24 | (size_t)all[at + 1] << 16 | (size_t)all[at + 2] << 8 | all[at + 3]);
		if (end > length) break;
		Json *f = cborDecode(all + at + 4, end - at - 4, NULL, NULL);
		if (!f) {
			// the last frame, cut short by a crash during its append
			if (end == length) break;
			c = MF_STORE;
			break;
		}
		if (f->type != JSON_OBJECT) c = MF_STORE;
		for (int i = 0; c == MF_OK && i < f->object.count; i++) {
			const JsonMember *k = &f->object.members[i];
			if (k->value->type == JSON_NULL) mapdelete(records, k->key, k->keyLength);
			else if (k->value->type == JSON_BYTES) mapset(records, k->key, k->keyLength, memcpy(grab(k->value->bytes.length), k->value->bytes.data, k->value->bytes.length), k->value->bytes.length);
			else c = MF_STORE;
		}
		jsonFree(f);
		if (c != MF_OK) break;
		at = end;
	}
	free(all);
	if (c != MF_OK) return c;
	Map sizes = {0};
	for (size_t i = 0; i < records->count; i++) mapset(&sizes, records->items[i].key, records->items[i].keylength, NULL, records->items[i].length);
	mapfree(&m->sizes);
	m->sizes = sizes;
	m->read = true;
	m->size = at;
	m->cut = at < length;
	m->there = r == 0;
	return MF_OK;
}

mf_code mf_read(mf_manifest *m, mf_record **out, size_t *count) {
	Map records = {0};
	*out = NULL, *count = 0;
	mf_code c = scan(m, &records);
	if (c == MF_OK) {
		mf_record *list = grab(records.count * sizeof *list);
		// the records take the map's own key and bytes
		for (size_t i = 0; i < records.count; i++) {
			Entry *e = &records.items[i];
			list[i].key = e->key;
			list[i].length = e->length;
			list[i].data = e->data;
			e->key = NULL, e->data = NULL;
		}
		*out = list, *count = records.count;
	}
	mapfree(&records);
	return c;
}

mf_code mf_append(mf_manifest *m, const mf_record *records, size_t count) {
	if (!m->read) {
		Map scratch = {0};
		mf_code c = scan(m, &scratch);
		mapfree(&scratch);
		if (c != MF_OK) return c;
	}
	sp_bytes bytes = {0};
	mf_code c = frame(records, count, &bytes);
	if (c != MF_OK) return free(bytes.data), c;
	bool made = !m->there;
	bool ok = true;
	if (m->cut && truncate(m->log, (off_t)m->size) == -1 && errno != ENOENT) ok = false;
	ok = ok && writefile(m->log, bytes.data, bytes.length, O_APPEND) == 0 && syncpath(m, m->log) == 0 && (!made || syncpath(m, m->dir) == 0);
	if (!ok) {
		// what was written of it is cut off before the next append
		int e = errno;
		m->cut = true;
		free(bytes.data);
		errno = e;
		return MF_IO;
	}
	m->cut = false, m->there = true;
	m->size += bytes.length;
	for (size_t i = 0; i < count; i++) {
		if (records[i].data) mapset(&m->sizes, records[i].key, strlen(records[i].key), NULL, records[i].length);
		else mapdelete(&m->sizes, records[i].key, strlen(records[i].key));
	}
	free(bytes.data);
	return MF_OK;
}

bool mf_grown(const mf_manifest *m) {
	return m->read && m->size > 4 * m->sizes.live + m->slack;
}

mf_code mf_fold(mf_manifest *m, const mf_record *records, size_t count) {
	mf_hex *keep;
	size_t kept;
	mf_code c = mf_named(records, count, &keep, &kept);
	if (c != MF_OK) return c;
	sp_bytes bytes = {0};
	if ((c = frame(records, count, &bytes)) == MF_OK && (c = through(m, "manifest", bytes.data, bytes.length, m->log)) == MF_OK) {
		Map sizes = {0};
		for (size_t i = 0; i < count; i++) mapset(&sizes, records[i].key, strlen(records[i].key), NULL, records[i].length);
		mapfree(&m->sizes);
		m->sizes = sizes;
		m->read = true, m->size = bytes.length, m->cut = false, m->there = true;
		// the fold is synced: what it no longer names goes
		DIR *d = opendir(m->values);
		if (!d && errno != ENOENT) c = MF_IO;
		for (struct dirent *e; d && c == MF_OK && (e = readdir(d));) {
			if (strlen(e->d_name) != 64 || !ishash(e->d_name) || bsearch(e->d_name, keep, kept, sizeof *keep, byhex)) continue;
			char *path = join(m->values, e->d_name);
			if (remove(path) == -1 && errno != ENOENT) c = MF_IO;
			free(path);
		}
		if (d) closedir(d);
	}
	free(bytes.data);
	free(keep);
	return c;
}

mf_code mf_put(mf_manifest *m, const Json *value, const char *given, mf_kept *kept) {
	const char *form = mf_form(value);
	sp_bytes cbor = {0}, file = {0};
	if (!putv(&cbor, value)) return free(cbor.data), MF_WRONG;
	mf_kept k = {0};
	if (given) {
		if (strlen(given) >= sizeof k.hash) return free(cbor.data), MF_STORE;
		strcpy(k.hash, given);
	} else mf_digest(cbor.data, cbor.length, k.hash);
	k.form = form;
	char *path = join(m->values, k.hash);
	struct stat st;
	mf_code c = MF_OK;
	if (lstat(path, &st) == -1) {
		if (errno != ENOENT) c = MF_IO;
		else if (strcmp(form, "cbor") == 0) c = through(m, k.hash, cbor.data, cbor.length, path);
		else if ((c = mf_render(value, form, &file)) == MF_OK) c = through(m, k.hash, file.data, file.length, path);
	}
	free(path), free(cbor.data), free(file.data);
	if (c == MF_OK && kept) *kept = k;
	return c;
}

mf_code mf_get(mf_manifest *m, const char *hash, const char *form, Json **value) {
	*value = NULL;
	if (!ishash(hash) || !known(form, strlen(form))) return MF_STORE;
	char *path = join(m->values, hash);
	uint8_t *bytes;
	size_t length;
	int r = readfile(path, &bytes, &length);
	free(path);
	if (r < 0) return MF_IO;
	if (r > 0) return MF_STORE;
	Json *v = NULL;
	if (strcmp(form, "cbor") == 0) v = cborDecode(bytes, length, NULL, NULL);
	else if (mf_parse(bytes, length, form, &v) != MF_OK) v = NULL;
	free(bytes);
	char h[65];
	if (!v || !mf_hash(v, h) || strcmp(h, hash) != 0) return jsonFree(v), MF_STORE;
	*value = v;
	return MF_OK;
}
