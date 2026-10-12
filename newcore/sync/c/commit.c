// A change made on this device as a blop (newcore/sync/COMMIT.tex), in C. Same steps as commit.ts.
#include "commit.h"

#include "apply.h"

#include <stdlib.h>
#include <string.h>

const char *commit_code_name(commit_code code) {
	return code == COMMIT_RANGE ? "range" : "";
}

static void *grab(size_t n) {
	void *p = malloc(n ? n : 1);
	if (p == NULL) abort();
	return p;
}

// a path's parts, split on / and \; the pieces point into the text
typedef struct {
	const char *start;
	size_t length;
} part;
typedef struct {
	part *items;
	size_t count;
} parts;

static bool letter(char x) {
	return (x >= 'a' && x <= 'z') || (x >= 'A' && x <= 'Z');
}

// a local path: starting /, a drive letter, or file://; false for any other
static bool local(const char *file, parts *out) {
	if (strncmp(file, "file://", 7) == 0) {
		file += 7;
		if (file[0] == '/' && letter(file[1]) && file[2] == ':') file++;
	} else if (!(file[0] == '/' || (letter(file[0]) && file[1] == ':' && (file[2] == '/' || file[2] == '\\')))) {
		return false;
	}
	out->items = grab(strlen(file) * sizeof(part) + sizeof(part));
	out->count = 0;
	for (const char *p = file; *p;) {
		if (*p == '/' || *p == '\\') {
			p++;
			continue;
		}
		const char *q = p;
		while (*q && *q != '/' && *q != '\\') q++;
		out->items[out->count++] = (part){p, (size_t)(q - p)};
		p = q;
	}
	return true;
}

static bool same(part a, part b) {
	return a.length == b.length && memcmp(a.start, b.start, a.length) == 0;
}

// the site shareable: a local path relative to the nearest root, else its last part; others kept.
// One hold of it the caller's
static Json *share(const Json *site, const char *const *roots, size_t count) {
	const char *file = jsonText(jsonGet(site, "file"));
	parts path;
	if (file == NULL || !local(file, &path)) return jsonRef((Json *)site);
	// no parts at all ("/", "file://"): kept as it is
	if (path.count == 0) return free(path.items), jsonRef((Json *)site);
	size_t best = 0;
	bool found = false;
	for (size_t i = 0; i < count; i++) {
		parts root;
		if (!local(roots[i], &root)) continue;
		bool holds = root.count <= path.count;
		for (size_t k = 0; holds && k < root.count; k++) holds = same(root.items[k], path.items[k]);
		if (holds && (!found || root.count > best)) best = root.count, found = true;
		free(root.items);
	}
	// what is left of the path under the root, else its last part
	size_t from = found && best < path.count ? best : path.count ? path.count - 1 : 0;
	size_t length = 0;
	for (size_t k = from; k < path.count; k++) length += path.items[k].length + 1;
	char *shared = grab(length + 1), *w = shared;
	for (size_t k = from; k < path.count; k++) {
		if (k > from) *w++ = '/';
		memcpy(w, path.items[k].start, path.items[k].length);
		w += path.items[k].length;
	}
	*w = 0;
	Json *copy = jsonShallow(site);
	jsonSet(copy, "file", 4, jsonString(shared));
	free(shared);
	free(path.items);
	return copy;
}

// bytewise
static int by_name(const void *x, const void *y) {
	return memcmp(x, y, 32);
}

Json *commit_make(chains *c, const Json *change, commit_at at, const char *const *roots,
	size_t count, commit_random random, void *context, commit_code *code) {
	const Json *object = jsonGet(change, "object"), *header = jsonGet(change, "header");
	// the versions' heads: those that have a side
	chain_head *all;
	size_t n = chain_heads(c, object, &all), have = 0;
	for (size_t i = 0; i < n; i++) {
		if (apply_side(c, all[i].name) != NULL) all[have++] = all[i];
	}
	// the heads used: [from, to) of the versions, or none for the object with no versions
	size_t from = 0, to = 0;
	if (!(at.kind == COMMIT_VERSION && have == 0 && at.from == 0)) {
		if (at.from < 0 || at.from >= at.to || (size_t)at.to > have) {
			free(all);
			*code = COMMIT_RANGE;
			return NULL;
		}
		from = (size_t)at.from, to = (size_t)at.to;
	}

	// parents: the heads used, and for a pop the first kept
	uint8_t (*parents)[32] = grab((have + 1) * 32);
	size_t np = 0;
	const chain_head *base = NULL;
	bool combine = false, removal = false, empty = false;
	if (at.kind == COMMIT_POP) {
		for (size_t i = from; i < to; i++) memcpy(parents[np++], all[i].name, 32);
		if (to - from < have) {
			// the first kept: version 0, else the one after the popped
			base = &all[from > 0 ? 0 : to];
			memcpy(parents[np++], base->name, 32);
			empty = true;
		} else {
			removal = true;
			if (to - from > 1) base = &all[from];
		}
	} else {
		for (size_t i = from; i < to; i++) memcpy(parents[np++], all[i].name, 32);
		if (to - from > 1) base = &all[from], combine = true;
	}
	qsort(parents, np, 32, by_name);
	// one more than the parents' highest: the first kept of a pop is a parent too
	int64_t lamport = 0;
	for (size_t i = from; i < to; i++) {
		int64_t l = (int64_t)jsonGet(all[i].blop, "lamport")->number;
		if (l > lamport) lamport = l;
	}
	if (empty) {
		int64_t l = (int64_t)jsonGet(base->blop, "lamport")->number;
		if (l > lamport) lamport = l;
	}

	// what it shares of the change, held
	Json *blop = jsonObject();
	jsonAdd(blop, "node", jsonRef(jsonGet(change, "node")));
	jsonAdd(blop, "object", jsonRef((Json *)object));
	const Json *actor = jsonGet(header, "actor"), *reader = jsonGet(header, "reader"),
		*site = jsonGet(header, "site"), *cause = jsonGet(header, "cause");
	jsonAdd(blop, "actor", actor ? jsonRef((Json *)actor) : jsonNull());
	if (reader) jsonAdd(blop, "reader", jsonRef((Json *)reader));
	if (site) jsonAdd(blop, "site", share(site, roots, count));
	if (cause) jsonAdd(blop, "cause", jsonRef((Json *)cause));
	jsonAdd(blop, "signer", jsonRef(jsonGet(change, "signer")));
	uint8_t nonce[8];
	random(context, 8, nonce);
	jsonAdd(blop, "nonce", jsonBytes(nonce, 8));
	Json *list = jsonArray();
	for (size_t i = 0; i < np; i++) jsonPush(list, jsonBytes(parents[i], 32));
	jsonAdd(blop, "parents", list);
	if (base) jsonAdd(blop, "base", jsonBytes(base->name, 32));
	if (combine) jsonAdd(blop, "combine", jsonBoolean(true));
	jsonAdd(blop, "lamport", jsonInteger(lamport + 1));
	if (empty) jsonAdd(blop, "patches", jsonArray());
	else if (removal) {
		Json *patch = jsonObject(), *patches = jsonArray();
		jsonAdd(patch, "path", jsonArray());
		jsonPush(patches, patch);
		jsonAdd(blop, "patches", patches);
	} else jsonAdd(blop, "patches", jsonRef(jsonGet(change, "patches")));
	free(parents);
	free(all);
	*code = COMMIT_OK;
	return blop;
}
