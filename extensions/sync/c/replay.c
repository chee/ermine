// A node's tables at a commit (replay.h), in C
#include "replay.h"
#include "snapshot.h"

#include <stdlib.h>
#include <string.h>

typedef struct {
	size_t capacity;
	pk_read read;
	nd_entry **made;
	size_t made_length, made_capacity;
	cm_commit *commits;
	size_t commits_length, commits_capacity;
	// what rp_put_copy made: blocks to free, values to let go of
	void **blocks;
	size_t blocks_length, blocks_capacity;
	op_value **values;
	size_t values_length, values_capacity;
} owned;

void rp_init(rp_tables *t) {
	*t = (rp_tables){0};
	t->own = allocate(sizeof(owned));
}

void rp_free(rp_tables *t) {
	owned *o = t->own;
	if (o == NULL) return;
	for (size_t i = 0; i < o->made_length; i++) nd_free_entry(o->made[i]);
	for (size_t i = 0; i < o->commits_length; i++) cm_free(&o->commits[i]);
	pk_free(&o->read);
	for (size_t i = 0; i < o->blocks_length; i++) free(o->blocks[i]);
	for (size_t i = 0; i < o->values_length; i++) op_free(o->values[i]);
	free(o->blocks);
	free(o->values);
	free(o->made);
	free(o->commits);
	free(o);
	free(t->slots);
	*t = (rp_tables){0};
}

const nd_entry *rp_find(const rp_tables *t, const char *table) {
	for (size_t i = 0; i < t->length; i++)
		if (strcmp(t->slots[i].table, table) == 0) return t->slots[i].entry;
	return NULL;
}

static size_t slot_of(const rp_tables *t, const char *table) {
	size_t i = 0;
	while (i < t->length && strcmp(t->slots[i].table, table) != 0) i++;
	return i;
}

static void put_slot(rp_tables *t, const char *table, nd_entry *entry) {
	owned *o = t->own;
	size_t i = slot_of(t, table);
	if (i == t->length) {
		if (t->length == o->capacity) {
			o->capacity = o->capacity ? o->capacity * 2 : 4;
			t->slots = realloc(t->slots, o->capacity * sizeof *t->slots);
			if (t->slots == NULL) abort();
		}
		t->length++;
	}
	t->slots[i] = (nd_slot){table, entry};
}

static void made(owned *o, nd_entry *e) {
	if (o->made_length == o->made_capacity) {
		o->made_capacity = o->made_capacity ? o->made_capacity * 2 : 16;
		o->made = realloc(o->made, o->made_capacity * sizeof *o->made);
		if (o->made == NULL) abort();
	}
	o->made[o->made_length++] = e;
}

void rp_put(rp_tables *t, const char *table, op_value *value, const ch_header *change) {
	nd_entry *e = nd_make_entry(value, change, NULL);
	if (e == NULL) abort();
	made(t->own, e);
	put_slot(t, table, e);
}

static void *block(owned *o, size_t n) {
	if (o->blocks_length == o->blocks_capacity) {
		o->blocks_capacity = o->blocks_capacity ? o->blocks_capacity * 2 : 16;
		o->blocks = realloc(o->blocks, o->blocks_capacity * sizeof *o->blocks);
		if (o->blocks == NULL) abort();
	}
	return o->blocks[o->blocks_length++] = allocate(n ? n : 1);
}
static char *text(owned *o, const char *s) {
	size_t n = strlen(s) + 1;
	return memcpy(block(o, n), s, n);
}
static const void *held(owned *o, const void *v) {
	if (v == NULL) return NULL;
	if (o->values_length == o->values_capacity) {
		o->values_capacity = o->values_capacity ? o->values_capacity * 2 : 16;
		o->values = realloc(o->values, o->values_capacity * sizeof *o->values);
		if (o->values == NULL) abort();
	}
	return o->values[o->values_length++] = op_ref((op_value *)v);
}

void rp_put_copy(rp_tables *t, const char *table, op_value *value, const ch_header *in) {
	owned *o = t->own;
	ch_header *c = block(o, sizeof *c);
	*c = (ch_header){.has_time = in->has_time, .time = in->time};
	c->actor = held(o, in->actor);
	if (in->reader != NULL) c->reader = text(o, in->reader);
	if (in->external != NULL) {
		ch_site *ss = block(o, (in->external_length + 1) * sizeof *ss);
		for (size_t i = 0; i < in->external_length; i++) {
			ss[i] = in->external[i];
			if (ss[i].file != NULL) ss[i].file = text(o, ss[i].file);
			if (ss[i].function != NULL) ss[i].function = text(o, ss[i].function);
		}
		c->external = ss;
		c->external_length = in->external_length;
	}
	if (in->metadata != NULL) {
		ch_entry *es = block(o, (in->metadata_length + 1) * sizeof *es);
		for (size_t i = 0; i < in->metadata_length; i++) {
			es[i].key = in->metadata[i].key != NULL ? text(o, in->metadata[i].key) : NULL;
			es[i].value = held(o, in->metadata[i].value);
		}
		c->metadata = es;
		c->metadata_length = in->metadata_length;
	}
	rp_put(t, text(o, table), value, c);
}

const rp_merge *rp_merge_find(const rp_merges *m, const char *name) {
	for (size_t i = 0; m != NULL && name != NULL && i < m->length; i++)
		if (strcmp(m->list[i].rule->name, name) == 0) return &m->list[i];
	return NULL;
}

void rp_adopt(rp_tables *t, pk_read *read) {
	owned *o = t->own;
	pk_free(&o->read);
	o->read = *read;
	*read = (pk_read){0};
	for (size_t i = 0; i < o->read.length; i++)
		put_slot(t, o->read.entries[i].part.string, (nd_entry *)o->read.entries[i].node);
}

bool rp_check(const rp_tables *t, const cm_commit *c) {
	const nd_entry *e = rp_find(t, c->table);
	op_value *after;
	size_t failed;
	if (op_apply(e ? e->value : NULL, c->patches, c->patches_length, NULL, &after, &failed) != OP_OK)
		return false;
	op_free(after);
	return true;
}

rp_code rp_apply(rp_tables *t, cm_commit *c) {
	owned *o = t->own;
	size_t i = slot_of(t, c->table);
	nd_entry *e = i < t->length ? t->slots[i].entry : NULL;
	op_value *after;
	size_t failed;
	op_apply_options options = {.in_place = 1};
	if (op_apply(e ? e->value : NULL, c->patches, c->patches_length, &options, &after, &failed) != OP_OK)
		return RP_PATCHES;
	// the commit is the tables' now: what the entry's change refers to
	if (o->commits_length == o->commits_capacity) {
		o->commits_capacity = o->commits_capacity ? o->commits_capacity * 2 : 16;
		o->commits = realloc(o->commits, o->commits_capacity * sizeof *o->commits);
		if (o->commits == NULL) abort();
	}
	cm_commit *kept = &o->commits[o->commits_length++];
	*kept = *c;
	*c = (cm_commit){0};
	if (e != NULL) {
		// the hold apply made goes to the entry, the one before is let go of
		op_free(e->value);
		e->value = after;
		if (after == NULL) {
			memmove(&t->slots[i], &t->slots[i + 1], (t->length - i - 1) * sizeof *t->slots);
			t->length--;
		} else e->change = kept->change;
		return RP_OK;
	}
	if (after == NULL) return RP_OK;
	e = nd_make_entry(after, &kept->change, NULL);
	if (e == NULL) abort();
	op_free(after);
	made(o, e);
	put_slot(t, kept->table, e);
	return RP_OK;
}

typedef struct {
	const hy_history *h;
	rp_snapshots snapshots;
	void *context;
} plain_t;

static rp_code walk(const hy_history *h, const uint8_t name[32], rp_snapshots snapshots, void *context,
	const rp_merges *merges, bool merging, rp_tables *out);

// what a rule is given: one commit's tables had without merging; never several
static bool plain_get(void *context, const hy_kept *const *from, size_t n, rp_tables *out) {
	const plain_t *p = context;
	if (n != 1) return false;
	rp_tables t;
	if (walk(p->h, from[0]->name, p->snapshots, p->context, NULL, false, &t) != RP_OK) return false;
	rp_free(out);
	*out = t;
	return true;
}

static rp_code walk(const hy_history *h, const uint8_t name[32], rp_snapshots snapshots, void *context,
	const rp_merges *merges, bool merging, rp_tables *out) {
	rp_init(out);
	const hy_kept *k = hy_get(h, name);
	if (k == NULL) {
		rp_free(out);
		return RP_NOT_TAKEN;
	}
	const hy_kept **line = NULL;
	size_t n = 0, capacity = 0;
	rp_code code = RP_OK;
	for (; k != NULL;) {
		if (snapshots != NULL && snapshots(context, k->name, out)) break;
		if (n == capacity) {
			capacity = capacity ? capacity * 2 : 16;
			line = realloc(line, capacity * sizeof *line);
			if (line == NULL) abort();
		}
		line[n++] = k;
		if (k->merge != NULL) {
			const rp_merge *m = merging ? rp_merge_find(merges, k->merge) : NULL;
			if (m == NULL) {
				code = RP_UNMERGED;
				break;
			}
			const hy_kept **heads = allocate((k->parents_length + 1) * sizeof *heads);
			for (size_t i = 0; i < k->parents_length; i++) heads[i] = hy_get(h, k->parents[i]);
			plain_t p = {h, snapshots, context};
			rp_free(out);
			rp_init(out);
			m->rule->merge(m->state, h, heads, k->parents_length, plain_get, &p, out);
			free(heads);
			break;
		}
		k = k->has_base ? hy_get(h, k->base) : NULL;
	}
	for (size_t i = n; i-- > 0 && code == RP_OK;) {
		cm_commit c;
		if (cm_decode(line[i]->bytes, line[i]->length, &c, NULL) != CM_OK) code = RP_PATCHES;
		else if ((code = rp_apply(out, &c)) != RP_OK) cm_free(&c);
	}
	free(line);
	if (code != RP_OK) rp_free(out);
	return code;
}

rp_code rp_replay(const hy_history *h, const uint8_t name[32], rp_snapshots snapshots, void *context,
	const rp_merges *merges, rp_tables *out) {
	return walk(h, name, snapshots, context, merges, true, out);
}

bool rp_matches(const hy_history *h, const uint8_t name[32], const uint8_t *bytes, size_t length,
	rp_snapshots snapshots, void *context, const rp_merges *merges) {
	rp_tables replayed, given;
	if (rp_replay(h, name, snapshots, context, merges, &replayed) != RP_OK) return false;
	rp_init(&given);
	bool same = sn_tables(bytes, length, &given) == PK_OK && sn_alike(&replayed, &given);
	rp_free(&given);
	rp_free(&replayed);
	return same;
}

rp_code rp_plain(const hy_history *h, const uint8_t name[32], rp_snapshots snapshots, void *context,
	rp_tables *out) {
	return walk(h, name, snapshots, context, NULL, false, out);
}
