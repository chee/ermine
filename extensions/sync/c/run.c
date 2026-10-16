// A run of sealed commits as columns (run.h), in C. Everything is worked out on Json values
// (ermine/encoding/c/json.h): pack reads each commit's fields from its decoded bytes and
// writes the columns; unpack reads the columns, makes each commit's Json, and has commit.h check
// and encode it. The columns, and the order of the checks, are run.ts's header
#include "run.h"

#include "../../../ermine/encoding/c/cbor.h"
#include "../../../ermine/encoding/c/commit.h"

#include <math.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

#define SAFE 9007199254740991.0
#define SAFE_INT 9007199254740991LL

const char *rn_code_name(rn_code code) {
	switch (code) {
	case RN_NOT_A_RUN: return "not-a-run";
	case RN_COUNT: return "count";
	case RN_SIGNATURES: return "signatures";
	case RN_RUNS: return "runs";
	case RN_DIFFERENCES: return "differences";
	case RN_PARENTS: return "parents";
	case RN_PATCHES: return "patches";
	case RN_REF: return "ref";
	case RN_INSERT: return "insert";
	case RN_COMMIT: return "commit";
	case RN_OK:
	case RN_INPUT: break;
	}
	return "";
}

// --- what the columns share ---

// an integer from -(2^53 - 1) to 2^53 - 1 (Number.isSafeInteger)
static bool safe_integer(const Json *x, int64_t *out) {
	if (x == NULL || x->type != JSON_NUMBER) return false;
	double d = x->number;
	if (!(d >= -SAFE && d <= SAFE) || d != floor(d)) return false;
	if (out != NULL) *out = (int64_t)d;
	return true;
}

static bool is_bytes(const Json *x) { return x != NULL && x->type == JSON_BYTES; }

// the insert a commit's patches end with, and where it ended: isInsert and after in run.ts. A
// patch of one text put into a range of no width. path and at are what the next insert goes on from
static bool insert_end(const Json *patches, const Json **path, double *at) {
	if (patches == NULL || patches->type != JSON_ARRAY || patches->array.count == 0) return false;
	const Json *p = patches->array.items[patches->array.count - 1];
	if (p->type != JSON_OBJECT || jsonGet(p, "move") != NULL) return false;
	const Json *value = jsonGet(p, "value"), *range = jsonGet(p, "range");
	if (!jsonIsString(value) || range == NULL || range->type != JSON_ARRAY || range->array.count != 2) return false;
	const Json *from = range->array.items[0], *to = range->array.items[1];
	if (from->type != JSON_NUMBER || to->type != JSON_NUMBER || from->number != to->number) return false;
	*path = jsonGet(p, "path");
	*at = from->number + (double)utf8Count(value->string, value->stringLength);
	return true;
}

// --- writing ---

// [value, how many] for each stretch of equal values
static Json *runs(const Json *const *values, size_t n) {
	Json *out = jsonArray(), *count = NULL;
	for (size_t i = 0; i < n; i++) {
		if (i > 0 && jsonEqual(values[i], values[i - 1])) {
			count->number++;
			continue;
		}
		Json *pair = jsonArray();
		count = jsonNumber(1);
		jsonPush(pair, jsonRef((Json *)values[i]));
		jsonPush(pair, count);
		jsonPush(out, pair);
	}
	return out;
}

static void put_byte(uint8_t **b, size_t *n, size_t *capacity, uint8_t x) {
	if (*n == *capacity) {
		*capacity = *capacity ? *capacity * 2 : 64;
		*b = realloc(*b, *capacity);
		if (*b == NULL) abort();
	}
	(*b)[(*n)++] = x;
}

// the first, then each one's difference from the one before, each zigzag (0, -1, 1, -2 ... to 0,
// 1, 2, 3 ...) and seven bits a byte, the high bit set on all but the last
static Json *deltas(const int64_t *xs, size_t n) {
	uint8_t *b = NULL;
	size_t length = 0, capacity = 0;
	for (size_t i = 0; i < n; i++) {
		int64_t d = i == 0 ? xs[i] : xs[i] - xs[i - 1];
		uint64_t z = d >= 0 ? 2 * (uint64_t)d : 2 * (uint64_t)(-d) - 1;
		while (z >= 128) {
			put_byte(&b, &length, &capacity, (uint8_t)(z % 128 + 128));
			z /= 128;
		}
		put_byte(&b, &length, &capacity, (uint8_t)z);
	}
	Json *j = jsonBytes(b, length);
	free(b);
	return j;
}

// the commits' names by place, first of each: a hash on the name's first bytes
typedef struct {
	const uint8_t (*names)[32];
	size_t *slot, mask;
} places;

static size_t hash_of(const uint8_t name[32]) {
	size_t h;
	memcpy(&h, name, sizeof h);
	return h;
}
static void places_make(places *p, const uint8_t (*names)[32], size_t n) {
	size_t slots = 4;
	while (slots < 2 * n + 2) slots *= 2;
	p->names = names;
	p->slot = allocate(slots * sizeof *p->slot);
	p->mask = slots - 1;
	for (size_t i = 0; i < n; i++) {
		size_t s = hash_of(names[i]) & p->mask;
		while (p->slot[s] != 0 && memcmp(names[p->slot[s] - 1], names[i], 32) != 0) s = (s + 1) & p->mask;
		if (p->slot[s] == 0) p->slot[s] = i + 1;
	}
}
// the first place of the name, or n when none
static size_t places_find(const places *p, const uint8_t name[32], size_t n) {
	size_t s = hash_of(name) & p->mask;
	while (p->slot[s] != 0) {
		if (memcmp(p->names[p->slot[s] - 1], name, 32) == 0) return p->slot[s] - 1;
		s = (s + 1) & p->mask;
	}
	return n;
}

// a ref: a commit earlier in the run by its place, else its name
static Json *ref_of(const places *p, const Json *name, size_t i, size_t n) {
	size_t j = places_find(p, name->bytes.data, n);
	return j < i ? jsonNumber((double)j) : jsonRef((Json *)name);
}

static bool same_path(const Json *a, const Json *b) {
	if (a->array.count != b->array.count) return false;
	for (int i = 0; i < a->array.count; i++)
		if (!jsonEqual(a->array.items[i], b->array.items[i])) return false;
	return true;
}

rn_code rn_pack(const rn_item *sealed, size_t n, uint8_t **out, size_t *length) {
	*out = NULL;
	*length = 0;
	rn_code code = RN_OK;
	Json **commits = allocate((n + 1) * sizeof *commits);
	uint8_t(*names)[32] = allocate((n + 1) * 32);
	uint8_t *signatures = allocate(64 * n + 1);
	size_t made = 0;
	for (; made < n; made++) {
		Json *x = cborDecode(sealed[made].bytes, sealed[made].length, NULL, NULL);
		const Json *commit = jsonGet(x, "commit"), *signature = jsonGet(x, "signature");
		Json *c = NULL;
		if (is_bytes(commit) && is_bytes(signature) && signature->bytes.length == 64) {
			c = cborDecode(commit->bytes.data, commit->bytes.length, NULL, NULL);
			if (c != NULL && cm_check(c, NULL) != CM_OK) jsonFree(c), c = NULL;
		}
		if (c == NULL) {
			jsonFree(x);
			code = RN_INPUT;
			goto done;
		}
		commits[made] = c;
		cm_name(commit->bytes.data, commit->bytes.length, names[made]);
		memcpy(signatures + 64 * made, signature->bytes.data, 64);
		jsonFree(x);
	}
	places at;
	places_make(&at, (const uint8_t(*)[32])names, n);
	Json *cols = jsonObject(), *none = jsonNull();
	const Json **v = allocate((n + 1) * sizeof *v);
	int64_t *numbers = allocate((n + 1) * sizeof *numbers);
	jsonAdd(cols, "n", jsonNumber((double)n));
	static const char *const kept[] = {"table", "actor", "reader", "external", "metadata", "signer"};
	for (size_t k = 0; k < sizeof kept / sizeof *kept; k++) {
		for (size_t i = 0; i < n; i++) {
			const Json *f = jsonGet(commits[i], kept[k]);
			v[i] = f != NULL ? f : none;
		}
		jsonAdd(cols, kept[k], runs(v, n));
	}
	static const char *const counted[] = {"time", "nonce", "lamport"};
	for (size_t k = 0; k < sizeof counted / sizeof *counted; k++) {
		for (size_t i = 0; i < n; i++) numbers[i] = (int64_t)jsonGet(commits[i], counted[k])->number;
		jsonAdd(cols, counted[k], deltas(numbers, n));
	}
	Json *parents = jsonArray();
	for (size_t i = 0; i < n; i++) {
		const Json *ps = jsonGet(commits[i], "parents");
		if (i > 0 && ps->array.count == 1 && memcmp(ps->array.items[0]->bytes.data, names[i - 1], 32) == 0) {
			jsonPush(parents, jsonNull());
			continue;
		}
		Json *list = jsonArray();
		for (int p = 0; p < ps->array.count; p++) jsonPush(list, ref_of(&at, ps->array.items[p], i, n));
		jsonPush(parents, list);
	}
	jsonAdd(cols, "parents", parents);
	Json **bases = allocate((n + 1) * sizeof *bases);
	for (size_t i = 0; i < n; i++) {
		const Json *b = jsonGet(commits[i], "base");
		v[i] = bases[i] = b != NULL ? ref_of(&at, b, i, n) : jsonNull();
	}
	jsonAdd(cols, "base", runs(v, n));
	for (size_t i = 0; i < n; i++) jsonFree(bases[i]);
	free(bases);
	// the merge column only when a commit in the run is a merge by a rule
	bool merges = false;
	for (size_t i = 0; i < n; i++) {
		const Json *m = jsonGet(commits[i], "merge");
		v[i] = m != NULL ? (merges = true, m) : none;
	}
	if (merges) jsonAdd(cols, "merge", runs(v, n));
	Json *patches = jsonArray();
	for (size_t i = 0; i < n; i++) {
		const Json *ps = jsonGet(commits[i], "patches"), *path;
		double start;
		// one insert going on from the commit before's last
		if (ps->array.count == 1 && i > 0 && insert_end(jsonGet(commits[i - 1], "patches"), &path, &start)) {
			const Json *p = ps->array.items[0], *p_path, *value = jsonGet(p, "value");
			double p_start;
			if (insert_end(ps, &p_path, &p_start) && same_path(p_path, path) &&
				jsonGet(p, "range")->array.items[0]->number == start) {
				jsonPush(patches, jsonStringOfLength(value->string, value->stringLength));
				continue;
			}
		}
		jsonPush(patches, jsonRef((Json *)ps));
	}
	jsonAdd(cols, "patches", patches);
	jsonAdd(cols, "signatures", jsonBytes(signatures, 64 * n));
	cborEncode(cols, NULL, 0, &made, NULL);
	*out = allocate(made ? made : 1);
	cborEncode(cols, *out, made, length, NULL);
	jsonFree(cols);
	jsonFree(none);
	free((void *)v);
	free(numbers);
	free(at.slot);
	made = n;
done:
	for (size_t i = 0; i < made; i++) jsonFree(commits[i]);
	free(commits);
	free(names);
	free(signatures);
	return code;
}

// --- reading ---

static const char *const COLUMNS[] = {"n", "table", "actor", "reader", "external", "metadata", "signer",
	"time", "nonce", "lamport", "parents", "base", "merge", "patches", "signatures"};

// canonical order: shorter first, then bytewise (a key's U+0000 held as C0 80 is the byte 00)
static size_t real(const char *s, size_t n, unsigned char *out) {
	size_t m = 0;
	for (size_t i = 0; i < n; i++) {
		unsigned char c = (unsigned char)s[i];
		if (c == 0xC0 && i + 1 < n && (unsigned char)s[i + 1] == 0x80) c = 0, i++;
		if (out) out[m] = c;
		m++;
	}
	return m;
}
static int canonical(const JsonMember *a, const JsonMember *b) {
	size_t x = real(a->key, a->keyLength, NULL), y = real(b->key, b->keyLength, NULL);
	if (x != y) return x < y ? -1 : 1;
	unsigned char *p = allocate(x + 1), *q = allocate(y + 1);
	real(a->key, a->keyLength, p), real(b->key, b->keyLength, q);
	int c = memcmp(p, q, x);
	free(p), free(q);
	return c;
}

// a column of runs as a list of n values (pointers into the column); NULL: it is not one
static const Json **unruns(const Json *r, size_t n) {
	if (r == NULL || r->type != JSON_ARRAY) return NULL;
	const Json **out = allocate((n + 1) * sizeof *out);
	size_t have = 0;
	for (int i = 0; i < r->array.count; i++) {
		const Json *pair = r->array.items[i];
		int64_t count;
		// a run's count is no bigger than n, before it is spread
		if (pair->type != JSON_ARRAY || pair->array.count != 2 || !safe_integer(pair->array.items[1], &count) ||
			count < 1 || (uint64_t)count > n - have) {
			free(out);
			return NULL;
		}
		for (int64_t k = 0; k < count; k++) out[have++] = pair->array.items[0];
	}
	if (have != n) return free(out), NULL;
	return out;
}

// a column of differences as n whole numbers; false: it is not one
static bool undeltas(const Json *b, size_t n, int64_t *out) {
	if (!is_bytes(b)) return false;
	size_t at = 0;
	for (size_t i = 0; i < n; i++) {
		uint64_t z = 0;
		for (int k = 0;; k++) {
			if (at >= b->bytes.length || k >= 8) return false;
			uint8_t byte = b->bytes.data[at++];
			z |= (uint64_t)(byte & 127) << (7 * k);
			if (byte < 128) break;
		}
		int64_t d = z % 2 == 0 ? (int64_t)(z / 2) : -(int64_t)((z + 1) / 2);
		if (d > (1LL << 53) || d < -(1LL << 53)) return false;
		int64_t x = i == 0 ? d : out[i - 1] + d;
		if (x > SAFE_INT || x < -SAFE_INT) return false;
		out[i] = x;
	}
	return at == b->bytes.length;
}

static rn_code fail(rn_code code, char **column, const char *name) {
	if (column != NULL && name != NULL) *column = copyString(name);
	return code;
}

// the commit i's place or name, from a ref: bytes are the name; a whole number below i a place
static bool deref(const Json *r, size_t i, const uint8_t (*names)[32], const Json **bytes, const uint8_t **name) {
	int64_t j;
	if (is_bytes(r)) return *bytes = r, true;
	if (!safe_integer(r, &j) || j < 0 || (uint64_t)j >= i) return false;
	return *name = names[j], *bytes = NULL, true;
}

// a name as the Json the commit has it
static Json *name_json(const Json *bytes, const uint8_t *name) {
	return bytes != NULL ? jsonRef((Json *)bytes) : jsonBytes(name, 32);
}

rn_code rn_unpack(const uint8_t *bytes, size_t length, rn_unpacked *out, char **column) {
	*out = (rn_unpacked){0};
	if (column != NULL) *column = NULL;
	Json *x = cborDecode(bytes, length, NULL, NULL);
	if (x == NULL) return RN_NOT_A_RUN;
	// a stand-in is an object with the one key kind
	if (x->type == JSON_STAND) return jsonFree(x), fail(RN_NOT_A_RUN, column, "kind");
	if (x->type != JSON_OBJECT) return jsonFree(x), RN_NOT_A_RUN;
	rn_code code = RN_OK;
	const JsonMember *stray = NULL;
	for (int i = 0; i < x->object.count; i++) {
		const JsonMember *m = &x->object.members[i];
		size_t k = 0;
		while (k < sizeof COLUMNS / sizeof *COLUMNS && strcmp(COLUMNS[k], m->key) != 0) k++;
		if (k == sizeof COLUMNS / sizeof *COLUMNS && (stray == NULL || canonical(m, stray) < 0)) stray = m;
	}
	if (stray != NULL) {
		if (column != NULL) *column = copyStringOfLength(stray->key, stray->keyLength);
		jsonFree(x);
		return RN_NOT_A_RUN;
	}
	int64_t n64;
	const Json *signatures = jsonGet(x, "signatures");
	// Number.isSafeInteger(n) && n >= 0
	if (!safe_integer(jsonGet(x, "n"), &n64) || n64 < 0) return jsonFree(x), RN_COUNT;
	size_t n = (size_t)n64;
	if (!is_bytes(signatures) || signatures->bytes.length / 64 != n || signatures->bytes.length % 64 != 0) {
		jsonFree(x);
		return RN_SIGNATURES;
	}
	// the columns of runs, in the order run.ts reads them
	static const char *const run_columns[] = {"table", "actor", "reader", "external", "metadata", "signer", "base"};
	const Json **col[8] = {0};
	int64_t *time = allocate((n + 1) * sizeof *time), *nonce = allocate((n + 1) * sizeof *nonce),
		*lamport = allocate((n + 1) * sizeof *lamport);
	uint8_t(*names)[32] = allocate((n + 1) * 32);
	Json *before = NULL;
	for (int k = 0; k < 7; k++) {
		if ((col[k] = unruns(jsonGet(x, run_columns[k]), n)) == NULL) {
			code = fail(RN_RUNS, column, run_columns[k]);
			goto done;
		}
	}
	// merge: only when the run has the column
	if (jsonGet(x, "merge") != NULL && (col[7] = unruns(jsonGet(x, "merge"), n)) == NULL) {
		code = fail(RN_RUNS, column, "merge");
		goto done;
	}
	if (!undeltas(jsonGet(x, "time"), n, time)) {
		code = fail(RN_DIFFERENCES, column, "time");
		goto done;
	}
	if (!undeltas(jsonGet(x, "nonce"), n, nonce)) {
		code = fail(RN_DIFFERENCES, column, "nonce");
		goto done;
	}
	if (!undeltas(jsonGet(x, "lamport"), n, lamport)) {
		code = fail(RN_DIFFERENCES, column, "lamport");
		goto done;
	}
	const Json *parents = jsonGet(x, "parents"), *patches = jsonGet(x, "patches");
	if (parents == NULL || parents->type != JSON_ARRAY || (size_t)parents->array.count != n) {
		code = RN_PARENTS;
		goto done;
	}
	if (patches == NULL || patches->type != JSON_ARRAY || (size_t)patches->array.count != n) {
		code = RN_PATCHES;
		goto done;
	}
	out->sealed = allocate((n + 1) * sizeof *out->sealed);
	out->lengths = allocate((n + 1) * sizeof *out->lengths);
	for (size_t i = 0; i < n; i++) {
		const Json *ps = parents->array.items[i], *p = patches->array.items[i];
		Json *plist = jsonArray(), *c = NULL, *own_patches = NULL;
		if (ps->type == JSON_NULL && i > 0) jsonPush(plist, jsonBytes(names[i - 1], 32));
		else if (ps->type == JSON_ARRAY) {
			for (int k = 0; k < ps->array.count; k++) {
				const Json *b;
				const uint8_t *name;
				if (!deref(ps->array.items[k], i, (const uint8_t(*)[32])names, &b, &name)) {
					jsonFree(plist);
					code = RN_REF;
					goto done;
				}
				jsonPush(plist, name_json(b, name));
			}
		} else {
			jsonFree(plist);
			code = RN_PARENTS;
			goto done;
		}
		const Json *these;
		if (p->type == JSON_STRING) {
			// the insert going on from the commit before's last
			const Json *path;
			double at;
			if (!insert_end(before, &path, &at)) {
				jsonFree(plist);
				code = RN_INSERT;
				goto done;
			}
			Json *patch = jsonObject(), *range = jsonArray();
			jsonPush(range, jsonNumber(at));
			jsonPush(range, jsonNumber(at));
			jsonAdd(patch, "path", jsonRef((Json *)path));
			jsonAdd(patch, "range", range);
			jsonAdd(patch, "value", jsonRef((Json *)p));
			own_patches = jsonArray();
			jsonPush(own_patches, patch);
			these = own_patches;
		} else if (p->type == JSON_ARRAY) these = p;
		else {
			jsonFree(plist);
			code = RN_PATCHES;
			goto done;
		}
		c = jsonObject();
		jsonAdd(c, "table", jsonRef((Json *)col[0][i]));
		jsonAdd(c, "actor", jsonRef((Json *)col[1][i]));
		if (col[2][i]->type != JSON_NULL) jsonAdd(c, "reader", jsonRef((Json *)col[2][i]));
		if (col[3][i]->type != JSON_NULL) jsonAdd(c, "external", jsonRef((Json *)col[3][i]));
		if (col[4][i]->type != JSON_NULL) jsonAdd(c, "metadata", jsonRef((Json *)col[4][i]));
		jsonAdd(c, "time", jsonNumber((double)time[i]));
		jsonAdd(c, "signer", jsonRef((Json *)col[5][i]));
		jsonAdd(c, "nonce", jsonNumber((double)nonce[i]));
		jsonAdd(c, "parents", plist);
		bool bad_ref = false;
		if (col[6][i]->type != JSON_NULL) {
			const Json *b;
			const uint8_t *name;
			if (deref(col[6][i], i, (const uint8_t(*)[32])names, &b, &name)) jsonAdd(c, "base", name_json(b, name));
			else bad_ref = true;
		}
		if (col[7] != NULL && col[7][i]->type != JSON_NULL) jsonAdd(c, "merge", jsonRef((Json *)col[7][i]));
		jsonAdd(c, "lamport", jsonNumber((double)lamport[i]));
		jsonAdd(c, "patches", own_patches != NULL ? own_patches : jsonRef((Json *)these));
		if (bad_ref) {
			jsonFree(c);
			code = RN_REF;
			goto done;
		}
		uint8_t *b;
		size_t b_length;
		if (cm_encode_json(c, &b, &b_length, NULL) != CM_OK) {
			jsonFree(c);
			code = RN_COMMIT;
			goto done;
		}
		cm_name(b, b_length, names[i]);
		// the next insert goes on from these patches: the column's own, or the one made
		jsonFree(before);
		before = jsonRef((Json *)these);
		jsonFree(c);
		Json *s = jsonObject();
		jsonAdd(s, "commit", jsonBytes(b, b_length));
		jsonAdd(s, "signature", jsonBytes(signatures->bytes.data + 64 * i, 64));
		free(b);
		size_t size;
		cborEncode(s, NULL, 0, &size, NULL);
		out->sealed[i] = allocate(size);
		cborEncode(s, out->sealed[i], size, &out->lengths[i], NULL);
		jsonFree(s);
		out->count++;
	}
done:
	for (int k = 0; k < 8; k++) free((void *)col[k]);
	free(time), free(nonce), free(lamport), free(names);
	jsonFree(before);
	jsonFree(x);
	if (code != RN_OK) rn_free(out);
	return code;
}

void rn_free(rn_unpacked *u) {
	for (size_t i = 0; i < u->count; i++) free(u->sealed[i]);
	free(u->sealed);
	free(u->lengths);
	*u = (rn_unpacked){0};
}
