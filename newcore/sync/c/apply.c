// What an object holds after a blop (newcore/sync/APPLY.tex), in C. Same steps as apply.ts.
#include "apply.h"

#include "../../opstreams/c/mutate.h"

#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// the side kept for a blop taken in: held here until the histories let it go (apply_release)
typedef struct {
	nt_value *side;
} kept;

// what one call of mutate makes with the alloc given: all let go at once
typedef struct block {
	struct block *next;
	max_align_t align;
} block;
static void *arena_grab(void *context, size_t n) {
	block **head = context, *b = malloc(sizeof *b + n);
	if (b == NULL) abort();
	b->next = *head;
	*head = b;
	return b + 1;
}
static void arena_free(block *head) {
	while (head) {
		block *next = head->next;
		free(head);
		head = next;
	}
}

static void *grab(size_t n) {
	void *p = malloc(n ? n : 1);
	if (p == NULL) abort();
	return p;
}
// a patch's value as nt_value holds it, new; NULL for what it cannot
static nt_value *convert(const Json *j) {
	nt_value *v, *item;
	switch (j->type) {
	case JSON_NULL: return nt_null();
	case JSON_BOOLEAN: return nt_bool(j->boolean);
	case JSON_NUMBER: return nt_num(j->number);
	case JSON_STRING: return nt_str(j->string);
	case JSON_BYTES: return nt_bytes(j->bytes.data, j->bytes.length);
	case JSON_TYPED: return nt_typed((nt_elements)j->typed.kind, j->typed.data, j->typed.count);
	case JSON_STAND:
		if ((item = convert(j->stand.kind)) == NULL) return NULL;
		return nt_stand(item);
	case JSON_ARRAY:
		v = nt_list();
		for (int i = 0; i < j->array.count; i++) {
			if ((item = convert(j->array.items[i])) == NULL) return nt_free(v), NULL;
			nt_push(v, item);
		}
		return v;
	case JSON_OBJECT:
		v = nt_map();
		for (int i = 0; i < j->object.count; i++) {
			if ((item = convert(j->object.members[i].value)) == NULL) return nt_free(v), NULL;
			nt_set(v, j->object.members[i].key, item);
		}
		return v;
	default: return NULL;
	}
}

// a place; anything malformed is a negative key, which no patch can be (not-a-patch)
static const nt_key bad_key = {.type = NT_NUM_KEY, .n = -1};
static bool whole(const Json *x, long *out) {
	int64_t n;
	if (x == NULL || !jsonIsWhole(x, &n) || n > 1000000000000000 || n < -1000000000000000) return false;
	*out = (long)n;
	return true;
}
static void place_of(const Json *m, nt_place *p) {
	memset(p, 0, sizeof *p);
	const Json *path = jsonGet(m, "path");
	if (path == NULL || path->type != JSON_ARRAY) goto bad;
	nt_key *ks = grab((size_t)path->array.count * sizeof *ks + sizeof *ks);
	for (int i = 0; i < path->array.count; i++) {
		const Json *x = path->array.items[i];
		long n;
		ks[i] = (nt_key){0};
		if (x->type == JSON_STRING) ks[i] = (nt_key){.type = NT_STR_KEY, .s = x->string};
		else if (x->type == JSON_NUMBER && whole(x, &n)) ks[i] = (nt_key){.type = NT_NUM_KEY, .n = n};
		else {
			free(ks);
			goto bad;
		}
	}
	p->path = ks;
	p->length = (size_t)path->array.count;
	const Json *r = jsonGet(m, "range");
	if (r != NULL) {
		if (r->type != JSON_ARRAY || r->array.count != 2 || !whole(r->array.items[0], &p->from) ||
				!whole(r->array.items[1], &p->to)) {
			free(ks);
			goto bad;
		}
		p->has_range = 1;
	}
	return;
bad:
	memset(p, 0, sizeof *p);
	p->path = &bad_key;
	p->length = 1;
}
static void free_place(nt_place *p) {
	if (p->path != &bad_key) free((void *)p->path);
}

static bool bytes(const Json *j) {
	return j != NULL && j->type == JSON_BYTES && j->bytes.length == 32;
}

// the side after the blop's patches into *out, one hold of it the caller's (nt_free); false: they
// do not apply
static bool after(histories *c, const Json *blop, nt_value **out) {
	*out = NULL;
	const Json *base = jsonGet(blop, "base"), *parents = jsonGet(blop, "parents");
	if (base == NULL && parents && parents->type == JSON_ARRAY && parents->array.count) {
		base = parents->array.items[0];
	}
	const nt_value *before = bytes(base) ? apply_side(c, base->bytes.data) : NULL;

	const Json *list = jsonGet(blop, "patches"), *object = jsonGet(blop, "object");
	size_t n = list && list->type == JSON_ARRAY ? (size_t)list->array.count : 0;
	nt_patch *patches = grab(n * sizeof *patches);
	bool ok = true;
	size_t made = 0;
	for (; made < n; made++) {
		const Json *j = list->array.items[made];
		nt_patch *p = &patches[made];
		memset(p, 0, sizeof *p);
		place_of(j, &p->place);
		const Json *value = jsonGet(j, "value"), *move = jsonGet(j, "move");
		if (value) {
			p->has_value = 1;
			if ((p->value = convert(value)) == NULL) ok = false;
		}
		if (move) {
			p->has_move = 1;
			place_of(move, &p->move);
		}
		if (!ok) {
			made++;
			break;
		}
	}

	bool applied = false;
	if (ok) {
		bool value = object->type == JSON_STRING;
		bool children = !value && strcmp(object->array.items[0]->string, "children") == 0;
		const char *name = value ? NULL : object->array.items[1]->string;
		block *blocks = NULL;
		mu_alloc alloc = {arena_grab, &blocks};
		// a children list goes in as an nd_list
		nd_version version = {.content = children && before ? (const void *)mu_list_to(before, &alloc) : before,
			.change = blop};
		nd_object versions = {&version, before ? 1 : 0};
		nd_entry entry = {name, versions};
		nd_node node = {.id = "n"};
		if (value) node.value = versions;
		else if (children) node.children = &entry, node.children_length = 1;
		else node.info = &entry, node.info_length = 1;
		mu_which which = value ? (mu_which){MU_VALUE, NULL}
			: (mu_which){children ? MU_CHILDREN : MU_INFO, name};
		size_t failed;
		if (mu_mutate(&node, which, patches, n, blop, &alloc, NULL, &failed) == MU_OK) {
			const nd_object *left = value ? &node.value
				: children ? (node.children_length ? &node.children[0].object : NULL)
				: node.info_length ? &node.info[0].object : NULL;
			if (left && left->length) {
				const void *content = left->versions[0].content;
				// the new version's own hold is the caller's; a list is made again from its items
				*out = children ? mu_list_of(content) : (nt_value *)content;
			}
			applied = true;
		}
		arena_free(blocks);
	}
	for (size_t i = 0; i < n && i < made; i++) {
		free_place(&patches[i].place);
		if (patches[i].has_move) free_place(&patches[i].move);
		// the new side holds what it shares of them
		nt_free((nt_value *)patches[i].value);
	}
	free(patches);
	return applied;
}

const nt_value *apply_side(histories *c, const uint8_t name[32]) {
	void **slot = history_slot(c, name);
	if (slot == NULL) return NULL;
	if (*slot == NULL) {
		kept *k = grab(sizeof *k);
		after(c, history_get(c, name), &k->side);
		*slot = k;
	}
	return ((kept *)*slot)->side;
}

void apply_release(void *slot) {
	kept *k = slot;
	nt_free(k->side);
	free(k);
}

bool apply_check(void *context, histories *c, const Json *blop) {
	(void)context;
	nt_value *side;
	bool applies = after(c, blop, &side);
	nt_free(side);
	return applies;
}

// a site as the blop holds it; has_column 0 and function NULL when not given
static void site_of(const Json *j, ch_site *site) {
	int64_t n;
	const Json *file = jsonGet(j, "file"), *line = jsonGet(j, "line"), *column = jsonGet(j, "column");
	*site = (ch_site){.file = jsonText(file) ? jsonText(file) : "", .function = jsonText(jsonGet(j, "function"))};
	if (line && jsonIsWhole(line, &n)) site->line = (long)n;
	if (column && jsonIsWhole(column, &n)) site->column = (long)n, site->has_column = 1;
}

static void hex_of(const uint8_t *b, char *out) {
	for (int i = 0; i < 32; i++) snprintf(out + 2 * i, 3, "%02x", b[i]);
}

size_t apply_versions(histories *c, const Json *object, apply_time time, void *context,
	apply_version **out) {
	history_head *heads;
	size_t n = history_heads(c, object, &heads), made = 0;
	apply_version *vs = grab(n * sizeof *vs);
	// a removal as the only head: the object is not there
	if (n == 1 && apply_side(c, heads[0].name) == NULL) n = 0;
	for (size_t i = 0; i < n; i++) {
		const nt_value *content = apply_side(c, heads[i].name);
		const Json *blop = heads[i].blop, *signer = jsonGet(blop, "signer"), *site = jsonGet(blop, "site");
		apply_version *v = &vs[made++];
		v->content = content;
		hex_of(heads[i].name, v->place.name);
		v->place.lamport = (int64_t)jsonGet(blop, "lamport")->number;
		if (bytes(signer)) hex_of(signer->bytes.data, v->why.signer);
		else v->why.signer[0] = 0;
		ch_header header = {
			.has_time = 1,
			.time = time(context, v->place.name),
			.actor = jsonGet(blop, "actor"),
			.reader = jsonText(jsonGet(blop, "reader")),
			.cause = jsonGet(blop, "cause"),
			.message = jsonText(jsonGet(blop, "message")),
		};
		if (jsonGet(blop, "wallclock")) header.has_wallclock = 1, header.wallclock = (int64_t)jsonGet(blop, "wallclock")->number;
		if (site) header.has_site = 1, site_of(site, &header.site);
		v->change = ch_make(jsonText(jsonGet(blop, "node")), header, NULL);
		v->because = bc_make("sync", &v->place, &v->why, NULL);
	}
	free(heads);
	*out = made ? vs : (free(vs), NULL);
	return made;
}
