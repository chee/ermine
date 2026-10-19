// A pack of sealed commits as columns (packer.h), in C. Everything is worked out on Json values
// (ermine/encoding/c/json.h): pack reads each commit's fields from its decoded bytes and
// writes the columns; unpack reads the columns, makes each commit's Json, and has commit.h check
// and encode it. The columns, and the order of the checks, are packer.ts's header
#include "packer.h"

#include "../../../ermine/encoding/c/cbor.h"
#include "../../../ermine/encoding/c/commit.h"
#include "seal.h"

#include <math.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

#define SAFE 9007199254740991.0
#define SAFE_INT 9007199254740991LL

const char *pkr_code_name(pkr_code code) {
	switch (code) {
	case PKR_NOT_A_PACK: return "not-a-pack";
	case PKR_COUNT: return "count";
	case PKR_SIGNATURES: return "signatures";
	case PKR_RUNS: return "runs";
	case PKR_DIFFERENCES: return "differences";
	case PKR_PARENTS: return "parents";
	case PKR_PATCHES: return "patches";
	case PKR_REF: return "ref";
	case PKR_INSERT: return "insert";
	case PKR_COMMIT: return "commit";
	case PKR_IDS: return "ids";
	case PKR_VOUCHED: return "vouched";
	case PKR_SIZE: return "size";
	case PKR_OK:
	case PKR_INPUT:
	case PKR_STOPPED: break;
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

// the insert a commit's patches end with, and where it ended: isInsert and after in packer.ts. A
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
	const uint8_t (*names)[CM_NAME];
	size_t *slot, mask;
} places;

static size_t hash_of(const uint8_t name[CM_NAME]) {
	size_t h;
	memcpy(&h, name + CM_NAME - sizeof h, sizeof h);
	return h;
}
static void places_make(places *p, const uint8_t (*names)[CM_NAME], size_t n) {
	size_t slots = 4;
	while (slots < 2 * n + 2) slots *= 2;
	p->names = names;
	p->slot = allocate(slots * sizeof *p->slot);
	p->mask = slots - 1;
	for (size_t i = 0; i < n; i++) {
		size_t s = hash_of(names[i]) & p->mask;
		while (p->slot[s] != 0 && memcmp(names[p->slot[s] - 1], names[i], CM_NAME) != 0) s = (s + 1) & p->mask;
		if (p->slot[s] == 0) p->slot[s] = i + 1;
	}
}
// the first place of the name, or n when none
static size_t places_find(const places *p, const uint8_t name[CM_NAME], size_t n) {
	size_t s = hash_of(name) & p->mask;
	while (p->slot[s] != 0) {
		if (memcmp(p->names[p->slot[s] - 1], name, CM_NAME) == 0) return p->slot[s] - 1;
		s = (s + 1) & p->mask;
	}
	return n;
}

// a ref: a commit earlier in the pack by its place, else its name
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

pkr_code pkr_pack(const pkr_item *sealed, size_t n, uint8_t **out, size_t *length) {
	*out = NULL;
	*length = 0;
	pkr_code code = PKR_OK;
	Json **commits = allocate((n + 1) * sizeof *commits);
	uint8_t(*names)[CM_NAME] = allocate((n + 1) * CM_NAME), (*ids)[32] = allocate((n + 1) * 32);
	// each signature's varsig header, and the bytes after it (NULL: given without a seal)
	Json **header = allocate((n + 1) * sizeof *header), **tail = allocate((n + 1) * sizeof *tail);
	bool *vouched = allocate((n + 1) * sizeof *vouched);
	// each commit's own bytes, when they are not what its columns encode to
	uint8_t **raw = allocate((n + 1) * sizeof *raw);
	size_t *raw_length = allocate((n + 1) * sizeof *raw_length);
	bool extra = false;
	size_t made = 0;
	for (; made < n; made++) {
		const pkr_item *it = &sealed[made];
		Json *x = NULL, *c = NULL;
		const Json *commit = NULL, *signature = NULL;
		const uint8_t *cb = it->bytes;
		size_t cl = it->length;
		if (it->stored == NULL) {
			x = cborDecode(it->bytes, it->length, NULL, NULL);
			commit = jsonGet(x, "commit"), signature = jsonGet(x, "signature");
			if (is_bytes(commit) && is_bytes(signature)) cb = commit->bytes.data, cl = commit->bytes.length;
			else cb = NULL;
		}
		if (cb != NULL) {
			c = cborDecode(cb, cl, NULL, NULL);
			if (c != NULL && cm_check_decoded(c, NULL) != CM_OK) jsonFree(c), c = NULL;
		}
		if (c == NULL) {
			jsonFree(x);
			code = PKR_INPUT;
			goto done;
		}
		commits[made] = c;
		// a key no commit has (a later device's): the columns leave it out, so the bytes go too
		if (cm_check(c, NULL) != CM_OK) raw[made] = memcpy(allocate(cl), cb, cl), raw_length[made] = cl, extra = true;
		cm_name(cb, cl, names[made]);
		if (it->stored != NULL) memcpy(ids[made], it->stored, 32);
		else {
			sl_stored(it->bytes, it->length, ids[made]);
			size_t h = sl_header_length(signature->bytes.data, signature->bytes.length);
			header[made] = jsonBytes(signature->bytes.data, h);
			tail[made] = jsonBytes(signature->bytes.data + h, signature->bytes.length - h);
		}
		jsonFree(x);
	}
	// each one the next goes on alone, by the same signer
	for (size_t i = 0; i + 1 < n; i++) {
		const Json *ps = jsonGet(commits[i + 1], "parents"), *a = jsonGet(commits[i], "signer"),
			   *b = jsonGet(commits[i + 1], "signer");
		vouched[i] = ps->array.count == 1 && memcmp(ps->array.items[0]->bytes.data, names[i], CM_NAME) == 0 &&
			a->bytes.length == b->bytes.length && memcmp(a->bytes.data, b->bytes.data, a->bytes.length) == 0;
	}
	for (size_t i = 0; i < n; i++) {
		if (vouched[i] || header[i] != NULL) continue;
		// one that must be signed, given without its seal
		code = PKR_INPUT;
		goto done;
	}
	places at;
	places_make(&at, (const uint8_t(*)[CM_NAME])names, n);
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
		if (i > 0 && ps->array.count == 1 && memcmp(ps->array.items[0]->bytes.data, names[i - 1], CM_NAME) == 0) {
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
	// the merge column only when a commit in the pack is a merge by a rule
	bool merges = false;
	for (size_t i = 0; i < n; i++) {
		const Json *m = jsonGet(commits[i], "merge");
		v[i] = m != NULL ? (merges = true, m) : none;
	}
	if (merges) jsonAdd(cols, "merge", runs(v, n));
	if (extra) {
		Json *list = jsonArray();
		for (size_t i = 0; i < n; i++) jsonPush(list, raw[i] != NULL ? jsonBytes(raw[i], raw_length[i]) : jsonNull());
		jsonAdd(cols, "bytes", list);
	}
	for (size_t i = 0; i < n; i++) v[i] = vouched[i] ? none : header[i];
	jsonAdd(cols, "headers", runs(v, n));
	Json *patches = jsonArray();
	for (size_t i = 0; i < n; i++) {
		const Json *ps = jsonGet(commits[i], "patches"), *path;
		double start;
		// one insert going on from the commit before's last
		if (ps->array.count == 1 && i > 0 && insert_end(jsonGet(commits[i - 1], "patches"), &path, &start)) {
			const Json *p = ps->array.items[0], *p_path, *value = jsonGet(p, "value");
			double p_start;
			// a string is the insert alone: one that replaces something goes whole
			if (insert_end(ps, &p_path, &p_start) && jsonGet(p, "replaces") == NULL && same_path(p_path, path) &&
				jsonGet(p, "range")->array.items[0]->number == start) {
				jsonPush(patches, jsonStringOfLength(value->string, value->stringLength));
				continue;
			}
		}
		jsonPush(patches, jsonRef((Json *)ps));
	}
	jsonAdd(cols, "patches", patches);
	Json *tails = jsonArray(), *said = jsonArray();
	for (size_t i = 0; i < n; i++) {
		if (vouched[i]) jsonPush(said, jsonBytes(ids[i], 32));
		else jsonPush(tails, jsonRef(tail[i]));
	}
	jsonAdd(cols, "signatures", tails);
	jsonAdd(cols, "ids", said);
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
	for (size_t i = 0; i < made; i++) jsonFree(commits[i]), jsonFree(header[i]), jsonFree(tail[i]);
	free(commits);
	free(names);
	free(ids);
	free(header);
	free(tail);
	free(vouched);
	return code;
}

// --- reading ---

static const char *const COLUMNS[] = {"n", "table", "actor", "reader", "external", "metadata", "signer",
	"time", "nonce", "lamport", "parents", "base", "merge", "bytes", "patches", "headers", "signatures", "ids"};

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

static pkr_code fail(pkr_code code, char **column, const char *name) {
	if (column != NULL && name != NULL) *column = copyString(name);
	return code;
}

// the commit i's place or name, from a ref: bytes are the name; a whole number below i a place
static bool deref(const Json *r, size_t i, const uint8_t (*names)[CM_NAME], const Json **bytes, const uint8_t **name) {
	int64_t j;
	if (is_bytes(r)) return *bytes = r, true;
	if (!safe_integer(r, &j) || j < 0 || (uint64_t)j >= i) return false;
	return *name = names[j], *bytes = NULL, true;
}

// a name as the Json the commit has it
static Json *name_json(const Json *bytes, const uint8_t *name) {
	return bytes != NULL ? jsonRef((Json *)bytes) : jsonBytes(name, CM_NAME);
}

// what a pack of this many bytes may give, as packer.ts's most: 64 times, and a MiB
static size_t most(size_t length) {
	return length > (SIZE_MAX - ((size_t)1 << 20)) / 64 ? SIZE_MAX : 64 * length + ((size_t)1 << 20);
}

pkr_code pkr_each(const uint8_t *bytes, size_t length, pkr_each_fn each, void *context, char **column) {
	if (column != NULL) *column = NULL;
	Json *x = cborDecode(bytes, length, NULL, NULL);
	if (x == NULL) return PKR_NOT_A_PACK;
	// a stand-in is an object with the one key kind
	if (x->type == JSON_STAND) return jsonFree(x), fail(PKR_NOT_A_PACK, column, "kind");
	if (x->type != JSON_OBJECT) return jsonFree(x), PKR_NOT_A_PACK;
	pkr_code code = PKR_OK;
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
		return PKR_NOT_A_PACK;
	}
	int64_t n64;
	const Json *signatures = jsonGet(x, "signatures"), *ids = jsonGet(x, "ids");
	// Number.isSafeInteger(n) && n >= 0
	if (!safe_integer(jsonGet(x, "n"), &n64) || n64 < 0) return jsonFree(x), PKR_COUNT;
	size_t n = (size_t)n64;
	bool listed = signatures != NULL && signatures->type == JSON_ARRAY;
	for (int i = 0; listed && i < signatures->array.count; i++) listed = is_bytes(signatures->array.items[i]);
	if (!listed) {
		jsonFree(x);
		return PKR_SIGNATURES;
	}
	listed = ids != NULL && ids->type == JSON_ARRAY;
	for (int i = 0; listed && i < ids->array.count; i++)
		listed = is_bytes(ids->array.items[i]) && ids->array.items[i]->bytes.length == 32;
	if (!listed) {
		jsonFree(x);
		return PKR_IDS;
	}
	// the columns of runs, in the order packer.ts reads them
	static const char *const run_columns[] = {"table", "actor", "reader", "external", "metadata", "signer", "base"};
	const Json **col[9] = {0};
	int64_t *time = allocate((n + 1) * sizeof *time), *nonce = allocate((n + 1) * sizeof *nonce),
		*lamport = allocate((n + 1) * sizeof *lamport);
	uint8_t(*names)[CM_NAME] = allocate((n + 1) * CM_NAME);
	Json *before = NULL;
	// one with no header, until the next shows it vouched for
	pkr_member held = {0};
	uint8_t *held_commit = NULL;
	for (int k = 0; k < 7; k++) {
		if ((col[k] = unruns(jsonGet(x, run_columns[k]), n)) == NULL) {
			code = fail(PKR_RUNS, column, run_columns[k]);
			goto done;
		}
	}
	// merge: only when the run has the column
	if (jsonGet(x, "merge") != NULL && (col[7] = unruns(jsonGet(x, "merge"), n)) == NULL) {
		code = fail(PKR_RUNS, column, "merge");
		goto done;
	}
	// bytes: only when the run has the column, a list of n: null, or a commit's own bytes
	const Json *exact = jsonGet(x, "bytes");
	if (exact != NULL) {
		bool shaped = exact->type == JSON_ARRAY && (size_t)exact->array.count == n;
		for (int i = 0; shaped && i < exact->array.count; i++)
			shaped = exact->array.items[i]->type == JSON_NULL || is_bytes(exact->array.items[i]);
		if (!shaped) {
			code = fail(PKR_RUNS, column, "bytes");
			goto done;
		}
	}
	// headers: runs of bytes, or null for one vouched for by the next
	if ((col[8] = unruns(jsonGet(x, "headers"), n)) == NULL) {
		code = fail(PKR_RUNS, column, "headers");
		goto done;
	}
	size_t signed_count = 0;
	for (size_t i = 0; i < n; i++) {
		if (col[8][i]->type == JSON_NULL) continue;
		if (!is_bytes(col[8][i])) {
			code = fail(PKR_RUNS, column, "headers");
			goto done;
		}
		signed_count++;
	}
	if ((size_t)signatures->array.count != signed_count) {
		code = PKR_SIGNATURES;
		goto done;
	}
	if ((size_t)ids->array.count != n - signed_count) {
		code = PKR_IDS;
		goto done;
	}
	if (!undeltas(jsonGet(x, "time"), n, time)) {
		code = fail(PKR_DIFFERENCES, column, "time");
		goto done;
	}
	if (!undeltas(jsonGet(x, "nonce"), n, nonce)) {
		code = fail(PKR_DIFFERENCES, column, "nonce");
		goto done;
	}
	if (!undeltas(jsonGet(x, "lamport"), n, lamport)) {
		code = fail(PKR_DIFFERENCES, column, "lamport");
		goto done;
	}
	const Json *parents = jsonGet(x, "parents"), *patches = jsonGet(x, "patches");
	if (parents == NULL || parents->type != JSON_ARRAY || (size_t)parents->array.count != n) {
		code = PKR_PARENTS;
		goto done;
	}
	if (patches == NULL || patches->type != JSON_ARRAY || (size_t)patches->array.count != n) {
		code = PKR_PATCHES;
		goto done;
	}
	size_t room = most(length), made = 0, sig = 0, id = 0;
	for (size_t i = 0; i < n; i++) {
		const Json *ps = parents->array.items[i], *p = patches->array.items[i];
		Json *plist = jsonArray(), *c = NULL, *own_patches = NULL;
		if (ps->type == JSON_NULL && i > 0) jsonPush(plist, jsonBytes(names[i - 1], CM_NAME));
		else if (ps->type == JSON_ARRAY) {
			for (int k = 0; k < ps->array.count; k++) {
				const Json *b;
				const uint8_t *name;
				if (!deref(ps->array.items[k], i, (const uint8_t(*)[CM_NAME])names, &b, &name)) {
					jsonFree(plist);
					code = PKR_REF;
					goto done;
				}
				jsonPush(plist, name_json(b, name));
			}
		} else {
			jsonFree(plist);
			code = PKR_PARENTS;
			goto done;
		}
		const Json *these;
		if (p->type == JSON_STRING) {
			// the insert going on from the commit before's last
			const Json *path;
			double at;
			if (!insert_end(before, &path, &at)) {
				jsonFree(plist);
				code = PKR_INSERT;
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
			code = PKR_PATCHES;
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
			if (deref(col[6][i], i, (const uint8_t(*)[CM_NAME])names, &b, &name)) jsonAdd(c, "base", name_json(b, name));
			else bad_ref = true;
		}
		if (col[7] != NULL && col[7][i]->type != JSON_NULL) jsonAdd(c, "merge", jsonRef((Json *)col[7][i]));
		jsonAdd(c, "lamport", jsonNumber((double)lamport[i]));
		jsonAdd(c, "patches", own_patches != NULL ? own_patches : jsonRef((Json *)these));
		if (bad_ref) {
			jsonFree(c);
			code = PKR_REF;
			goto done;
		}
		uint8_t *b;
		size_t b_length;
		if (cm_encode_json(c, &b, &b_length, NULL) != CM_OK) {
			jsonFree(c);
			code = PKR_COMMIT;
			goto done;
		}
		// the commit as its own bytes have it: the columns' and no other
		if (exact != NULL && is_bytes(exact->array.items[i])) {
			const Json *g = exact->array.items[i];
			cm_commit d;
			uint8_t *e = NULL;
			size_t e_length = 0;
			bool ok = cm_decode(g->bytes.data, g->bytes.length, &d, NULL) == CM_OK;
			if (ok) {
				ok = cm_encode(&d, &e, &e_length, NULL) == CM_OK && e_length == b_length && memcmp(e, b, b_length) == 0;
				cm_free(&d);
				free(e);
			}
			if (!ok) {
				jsonFree(c);
				free(b);
				code = PKR_COMMIT;
				goto done;
			}
			free(b);
			b = allocate(g->bytes.length + 1);
			memcpy(b, g->bytes.data, g->bytes.length);
			b_length = g->bytes.length;
		}
		cm_name(b, b_length, names[i]);
		// the one before, held: vouched for only if this one goes on it alone, by its signer
		if (held.commit != NULL) {
			const Json *ps = jsonGet(c, "parents"), *was = col[5][i - 1], *now = col[5][i];
			bool on = ps->array.count == 1 && memcmp(ps->array.items[0]->bytes.data, held.name, CM_NAME) == 0 &&
				was->bytes.length == now->bytes.length &&
				memcmp(was->bytes.data, now->bytes.data, was->bytes.length) == 0;
			if (!on) code = PKR_VOUCHED;
			else if (!each(context, &held)) code = PKR_STOPPED;
			free(held_commit);
			held_commit = NULL;
			held = (pkr_member){0};
			if (code != PKR_OK) {
				jsonFree(c);
				free(b);
				goto done;
			}
		}
		// the next insert goes on from these patches: the column's own, or the one made
		jsonFree(before);
		before = jsonRef((Json *)these);
		jsonFree(c);
		made += b_length;
		const Json *h = col[8][i];
		if (h->type == JSON_NULL) {
			held = (pkr_member){.commit = b, .commit_length = b_length};
			held_commit = b;
			memcpy(held.name, names[i], CM_NAME);
			memcpy(held.stored, ids->array.items[id++]->bytes.data, 32);
			if (made > room) {
				code = PKR_SIZE;
				goto done;
			}
			continue;
		}
		const Json *t = signatures->array.items[sig++];
		Json *s = jsonObject();
		jsonAdd(s, "commit", jsonBytes(b, b_length));
		uint8_t *whole = allocate(h->bytes.length + t->bytes.length + 1);
		memcpy(whole, h->bytes.data, h->bytes.length);
		memcpy(whole + h->bytes.length, t->bytes.data, t->bytes.length);
		jsonAdd(s, "signature", jsonBytes(whole, h->bytes.length + t->bytes.length));
		free(whole);
		size_t size;
		cborEncode(s, NULL, 0, &size, NULL);
		uint8_t *sealed = allocate(size);
		cborEncode(s, sealed, size, &size, NULL);
		jsonFree(s);
		made += size;
		if (made > room) {
			free(sealed), free(b);
			code = PKR_SIZE;
			goto done;
		}
		pkr_member m = {.commit = b, .commit_length = b_length, .sealed = sealed, .sealed_length = size};
		memcpy(m.name, names[i], CM_NAME);
		sl_stored(sealed, size, m.stored);
		bool on = each(context, &m);
		free(sealed), free(b);
		if (!on) {
			code = PKR_STOPPED;
			goto done;
		}
	}
	// the last one vouched for by none
	if (held.commit != NULL) code = PKR_VOUCHED;
done:
	free(held_commit);
	for (int k = 0; k < 9; k++) free((void *)col[k]);
	free(time), free(nonce), free(lamport), free(names);
	jsonFree(before);
	jsonFree(x);
	return code;
}

// each commit kept in the unpacked, its own bytes
static bool collect(void *context, const pkr_member *m) {
	pkr_unpacked *out = context;
	out->members = realloc(out->members, (out->count + 1) * sizeof *out->members);
	if (out->members == NULL) abort();
	pkr_member *k = &out->members[out->count++];
	*k = *m;
	uint8_t *commit = allocate(m->commit_length + 1);
	memcpy(commit, m->commit, m->commit_length);
	k->commit = commit;
	if (m->sealed != NULL) {
		uint8_t *sealed = allocate(m->sealed_length + 1);
		memcpy(sealed, m->sealed, m->sealed_length);
		k->sealed = sealed;
	}
	return true;
}

pkr_code pkr_unpack(const uint8_t *bytes, size_t length, pkr_unpacked *out, char **column) {
	*out = (pkr_unpacked){0};
	pkr_code code = pkr_each(bytes, length, collect, out, column);
	if (code != PKR_OK) pkr_free(out);
	return code;
}

void pkr_free(pkr_unpacked *u) {
	for (size_t i = 0; i < u->count; i++) free((void *)u->members[i].commit), free((void *)u->members[i].sealed);
	free(u->members);
	*u = (pkr_unpacked){0};
}
