// What an object holds after a blop (APPLY.tex), in C. Same steps as apply.ts.
#include "apply.h"

#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// the side kept for a blop taken in: a head's, or one made again since the last trim; held here
// until the histories let it go (apply_release)
typedef struct {
	op_value *side;
} kept;

static void *grab(size_t n) {
	void *p = malloc(n ? n : 1);
	if (p == NULL) abort();
	return p;
}

// a patch's value as op holds it, new; NULL for what it cannot. No recursion: what is being made
// waits on a stack of its own, so a value may nest as deep as memory allows
typedef struct {
	const Json *from;
	op_value *made; // the list or map filling; NULL for a stand, which waits on its kind
	int done;       // children taken in
} making;

static size_t children(const Json *j) {
	return j->type == JSON_ARRAY ? (size_t)j->array.count : j->type == JSON_OBJECT ? (size_t)j->object.count : 1;
}
static const Json *child(const Json *j, int i) {
	return j->type == JSON_ARRAY ? j->array.items[i] : j->type == JSON_OBJECT ? j->object.members[i].value : j->stand.kind;
}

op_value *apply_value(const Json *root) {
	making *stack = NULL;
	size_t n = 0, room = 0;
	op_value *result = NULL;
	const Json *j = root;
	for (;;) {
		switch (j->type) {
		case JSON_NULL: result = op_null(); break;
		case JSON_BOOLEAN: result = op_bool(j->boolean); break;
		case JSON_NUMBER: result = j->big ? op_whole(j->bigNegative, j->big, j->bigLength) : op_num(j->number); break;
		case JSON_STRING: result = op_str_n(j->string, j->stringLength); break;
		case JSON_BYTES: result = op_bytes(j->bytes.data, j->bytes.length); break;
		case JSON_TYPED: result = op_typed((op_elements)j->typed.kind, j->typed.data, j->typed.count); break;
		case JSON_STAND:
		case JSON_ARRAY:
		case JSON_OBJECT:
			if (n == room) stack = realloc(stack, (room = room ? room * 2 : 16) * sizeof *stack);
			if (stack == NULL) abort();
			stack[n++] = (making){j, j->type == JSON_ARRAY ? op_list() : j->type == JSON_OBJECT ? op_map() : NULL, 0};
			break;
		default: goto fail;
		}
		// a value is done (result) or a container just begun (result NULL): take it in, then go on to
		// the next child, or finish the container and take that in
		for (;;) {
			if (n == 0) {
				free(stack);
				return result;
			}
			making *f = &stack[n - 1];
			if (result != NULL) {
				if (f->from->type == JSON_ARRAY) op_push(f->made, result);
				else if (f->from->type == JSON_OBJECT) op_set(f->made, f->from->object.members[f->done].key, result);
				else f->made = op_stand(result);
				result = NULL;
				f->done++;
			}
			if ((size_t)f->done < children(f->from)) {
				j = child(f->from, f->done);
				break;
			}
			result = f->made;
			n--;
		}
	}
fail:
	for (size_t i = 0; i < n; i++)
		if (stack[i].made != NULL) op_free(stack[i].made);
	free(stack);
	return NULL;
}

typedef struct {
	const op_value *from;
	Json *made; // the array or object filling; NULL for a stand
	size_t done;
} writing;

Json *apply_json(const op_value *root) {
	writing *stack = NULL;
	size_t n = 0, room = 0;
	Json *result = NULL;
	const op_value *v = root;
	for (;;) {
		switch (v->type) {
		case OP_NULL: result = jsonNull(); break;
		case OP_BOOL: result = jsonBoolean(v->bool_); break;
		case OP_NUM: result = v->big ? jsonWhole(v->bigNegative, v->big, v->bigLength) : jsonNumber(v->num); break;
		case OP_STR: result = jsonStringOfLength(v->str, v->bytes); break;
		case OP_BYTES: result = jsonBytes(v->data, v->bytes); break;
		case OP_TYPED: result = jsonTyped((JsonKind)v->kind, v->data, op_length(v)); break;
		default:
			if (n == room) stack = realloc(stack, (room = room ? room * 2 : 16) * sizeof *stack);
			if (stack == NULL) abort();
			stack[n++] = (writing){v, v->type == OP_LIST ? jsonArray() : v->type == OP_MAP ? jsonObject() : NULL, 0};
			break;
		}
		for (;;) {
			if (n == 0) {
				free(stack);
				return result;
			}
			writing *f = &stack[n - 1];
			if (result != NULL) {
				if (f->from->type == OP_LIST) jsonPush(f->made, result);
				else if (f->from->type == OP_MAP) jsonAdd(f->made, f->from->keys[f->done], result);
				else f->made = jsonStand(result);
				result = NULL;
				f->done++;
			}
			if (f->done < (f->from->type == OP_STAND ? 1 : f->from->count)) {
				v = f->from->items[f->done];
				break;
			}
			result = f->made;
			n--;
		}
	}
}

// a place; anything malformed is a negative key, which no patch can be (not-a-patch)
static const op_key bad_key = {.type = OP_NUM_KEY, .n = -1};
static bool whole(const Json *x, long *out) {
	int64_t n;
	if (x == NULL || !jsonIsWhole(x, &n) || n > 1000000000000000 || n < -1000000000000000) return false;
	*out = (long)n;
	return true;
}
static void place_of(const Json *m, op_target *p) {
	memset(p, 0, sizeof *p);
	const Json *path = jsonGet(m, "path");
	if (path == NULL || path->type != JSON_ARRAY) goto bad;
	op_key *ks = grab((size_t)path->array.count * sizeof *ks + sizeof *ks);
	for (int i = 0; i < path->array.count; i++) {
		const Json *x = path->array.items[i];
		long n;
		ks[i] = (op_key){0};
		if (x->type == JSON_STRING) ks[i] = (op_key){.type = OP_STR_KEY, .s = x->string};
		else if (x->type == JSON_NUMBER && whole(x, &n)) ks[i] = (op_key){.type = OP_NUM_KEY, .n = n};
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
static void free_place(op_target *p) {
	if (p->path != &bad_key) free((void *)p->path);
}

void apply_patches_free(op_patch *patches, size_t count) {
	for (size_t i = 0; i < count; i++) {
		free_place(&patches[i].place);
		if (patches[i].has_move) free_place(&patches[i].move);
		// whatever else holds the value keeps its own hold
		op_free((op_value *)patches[i].value);
	}
	free(patches);
}

bool apply_patches(const Json *list, op_patch **out, size_t *count) {
	size_t n = list && list->type == JSON_ARRAY ? (size_t)list->array.count : 0;
	op_patch *patches = grab(n * sizeof *patches);
	for (size_t made = 0; made < n; made++) {
		const Json *j = list->array.items[made];
		op_patch *p = &patches[made];
		memset(p, 0, sizeof *p);
		place_of(j, &p->place);
		const Json *value = jsonGet(j, "value"), *move = jsonGet(j, "move");
		if (value) {
			p->has_value = 1;
			if ((p->value = apply_value(value)) == NULL) {
				apply_patches_free(patches, made + 1);
				return false;
			}
		}
		if (move) {
			p->has_move = 1;
			place_of(move, &p->move);
		}
	}
	*out = patches;
	*count = n;
	return true;
}

static bool bytes(const Json *j) {
	return j != NULL && j->type == JSON_BYTES && j->bytes.length == 32;
}

// a blop's base: its base, else its first parent; NULL: none
static const uint8_t *base_of(const Json *blop) {
	const Json *base = jsonGet(blop, "base"), *parents = jsonGet(blop, "parents");
	if (base == NULL && parents && parents->type == JSON_ARRAY && parents->array.count) {
		base = parents->array.items[0];
	}
	return bytes(base) ? base->bytes.data : NULL;
}

// the side after the blop's patches on before into *out, one hold of it the caller's (op_free);
// false: they do not apply
static bool after(const Json *blop, const op_value *before, op_value **out) {
	*out = NULL;
	op_patch *patches;
	size_t n;
	if (!apply_patches(jsonGet(blop, "patches"), &patches, &n)) return false;
	size_t failed;
	bool applied = op_apply(before, patches, n, NULL, out, &failed) == OP_OK;
	apply_patches_free(patches, n);
	return applied;
}

static kept *keep(op_value *side) {
	kept *k = grab(sizeof *k);
	k->side = side;
	return k;
}

const op_value *apply_side(histories *c, const uint8_t name[32]) {
	void **slot = history_slot(c, name);
	if (slot == NULL) return NULL;
	if (*slot) return ((kept *)*slot)->side;
	// not kept: back along the bases to the nearest side kept (or the root, none), then each blop's
	// patches again, forward. The blops got stay good till the next trim; each side made goes as
	// the next is made from it
	uint8_t (*line)[32] = NULL;
	size_t n = 0, room = 0;
	const op_value *from = NULL;
	for (const uint8_t *at = name; at;) {
		void **s = history_slot(c, at);
		if (s == NULL) break;
		if (*s) {
			from = ((kept *)*s)->side;
			break;
		}
		if (n == room) {
			room = room ? room * 2 : 16;
			line = realloc(line, room * sizeof *line);
			if (line == NULL) abort();
		}
		memcpy(line[n++], at, 32);
		at = base_of(history_get(c, at));
	}
	op_value *side = NULL;
	for (size_t i = n; i-- > 0;) {
		op_value *next;
		// taken in: they applied, and apply again
		after(history_get(c, line[i]), from, &next);
		op_free(side);
		from = side = next;
	}
	free(line);
	*history_slot(c, name) = keep(side);
	return side;
}

void apply_release(void *slot) {
	kept *k = slot;
	op_free(k->side);
	free(k);
}

bool apply_check(void *context, histories *c, const Json *blop, void **slot) {
	(void)context;
	const uint8_t *base = base_of(blop);
	op_value *side;
	if (!after(blop, base ? apply_side(c, base) : NULL, &side)) return false;
	*slot = keep(side);
	return true;
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
		const op_value *content = apply_side(c, heads[i].name);
		const Json *blop = heads[i].blop, *signer = jsonGet(blop, "signer"), *site = jsonGet(blop, "site");
		apply_version *v = &vs[made++];
		memset(v, 0, sizeof *v);
		v->content = content;
		v->layer = "sync";
		hex_of(heads[i].name, v->name);
		v->lamport = (int64_t)jsonGet(blop, "lamport")->number;
		if (bytes(signer)) hex_of(signer->bytes.data, v->signer);
		v->change = (ch_header){
			.has_time = 1,
			.time = time(context, v->name),
			.actor = jsonGet(blop, "actor"),
			.reader = jsonText(jsonGet(blop, "reader")),
		};
		if (site) {
			site_of(site, &v->site);
			v->change.external = &v->site;
			v->change.external_length = 1;
		}
		size_t m = 0;
		const Json *cause = jsonGet(blop, "cause"), *wallclock = jsonGet(blop, "wallclock"),
			*message = jsonGet(blop, "message");
		if (cause) v->entries[m++] = (ch_entry){"cause", cause};
		if (wallclock) {
			v->wallclock = (int64_t)wallclock->number;
			v->entries[m++] = (ch_entry){"wallclock", &v->wallclock};
		}
		if (message) v->entries[m++] = (ch_entry){"message", jsonText(message)};
		if (m) v->change.metadata = v->entries, v->change.metadata_length = m;
	}
	free(heads);
	*out = made ? vs : (free(vs), NULL);
	return made;
}
