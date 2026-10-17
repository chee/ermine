// A node's history, replay and snapshots on the line protocol (conformance/c/harness.h): the
// history, replay, snapshot and egwalker suites, as extensions/sync/typescript/history_harness.ts has
// them. State lasts for the process: one history, the commits made by label, the snapshots kept. The
// history's check is the integration's: a commit is taken in when its patches apply to its table at
// its base (replay), kept snapshots used; a merge commit's, to its rule's merge of its parents. The
// rules known: "eg-walker" (egwalker.h); a merge by any other is refused "merge"; a commit held (hold)
// it cannot judge yet, and it waits on the check. eg-walker's merges
// are made twice: by the pure rule, and by a keeping walker kept for the process, which must give the
// same, byte for byte
#include "commits.h"
#include "egwalker.h"
#include "snapshot.h"

#include "../../../conformance/c/protocol.h"
#include "../../../ermine/encoding/c/cbor.h"
#include "../../../ermine/encoding/c/commit_form.h"

#include <stdlib.h>
#include <string.h>

static cs_commits *commits;
static hy_history *history;
// tables kept: a snapshot at a commit (its name's hex), or several commits' merge (their names' hex
// sorted, spaced)
typedef struct {
	char *key;
	uint8_t *bytes;
	size_t length;
} snap;
static snap *kept;
static size_t kept_length;
// the names the check cannot judge yet (hold)
static uint8_t (*held)[32];
static size_t held_length;
static const rp_merge rules[] = {{&eg_rule, NULL}};
static const rp_merges merges = {rules, 1};
static void *walked;

static int by_hex(const void *a, const void *b) { return strcmp(*(char *const *)a, *(char *const *)b); }

// the key of several names: hex, sorted, spaced; malloc'd
static char *key_of(const uint8_t (*names)[32], size_t n) {
	char **each = malloc((n + 1) * sizeof *each), *out = malloc(n * 65 + 1);
	if (each == NULL || out == NULL) abort();
	for (size_t i = 0; i < n; i++) {
		each[i] = malloc(65);
		if (each[i] == NULL) abort();
		for (int b = 0; b < 32; b++) snprintf(each[i] + 2 * b, 3, "%02x", names[i][b]);
	}
	qsort(each, n, sizeof *each, by_hex);
	out[0] = 0;
	for (size_t i = 0; i < n; i++) {
		if (i) strcat(out, " ");
		strcat(out, each[i]);
		free(each[i]);
	}
	free(each);
	return out;
}

static const snap *find(const char *key) {
	for (size_t i = 0; i < kept_length; i++)
		if (strcmp(kept[i].key, key) == 0) return &kept[i];
	return NULL;
}

static bool snapshots(void *context, const uint8_t name[32], rp_tables *out) {
	(void)context;
	char *key = key_of((const uint8_t(*)[32])name, 1);
	const snap *s = find(key);
	free(key);
	return s != NULL && sn_tables(s->bytes, s->length, out) == PK_OK;
}

// several commits' merge, when kept
static bool several(const hy_kept *const *from, size_t n, rp_tables *out) {
	uint8_t(*names)[32] = malloc(n * 32 + 1);
	if (names == NULL) abort();
	for (size_t i = 0; i < n; i++) memcpy(names[i], from[i]->name, 32);
	char *key = key_of((const uint8_t(*)[32])names, n);
	free(names);
	const snap *s = find(key);
	free(key);
	return s != NULL && sn_tables(s->bytes, s->length, out) == PK_OK;
}

// what a rule is given: one commit's tables had without merging; several, kept as eg-walker's merge
static bool get(void *context, const hy_kept *const *from, size_t n, rp_tables *out) {
	const char *rule = context;
	if (n == 1) {
		rp_tables t;
		if (rp_plain(history, from[0]->name, snapshots, NULL, &t) != RP_OK) return false;
		rp_free(out);
		*out = t;
		return true;
	}
	return strcmp(rule, eg_rule.name) == 0 && several(from, n, out);
}

// heads (taken) merged by the rule (known) into out, new tables
static void merged(const uint8_t (*names)[32], size_t n, const char *rule, rp_tables *out) {
	const hy_kept **heads = malloc((n + 1) * sizeof *heads);
	if (heads == NULL) abort();
	for (size_t i = 0; i < n; i++) heads[i] = hy_get(history, names[i]);
	const rp_merge *m = rp_merge_find(&merges, rule);
	rp_init(out);
	m->rule->merge(m->state, history, heads, n, get, (void *)m->rule->name, out);
	if (m->rule == &eg_rule) {
		rp_tables w;
		rp_init(&w);
		eg_rule.merge(walked, history, heads, n, get, (void *)m->rule->name, &w);
		uint8_t *a = NULL, *b = NULL;
		size_t al = 0, bl = 0;
		pk_code ca = sn_snapshot(out, &a, &al), cb = sn_snapshot(&w, &b, &bl);
		if (ca != cb || al != bl || (al && memcmp(a, b, al) != 0)) {
			fprintf(stderr, "eg-walker's walker merged otherwise\n");
			abort();
		}
		free(a), free(b);
		rp_free(&w);
	}
	free(heads);
}

// whether the commit's patches apply to its table at its base, or its rule's merge of its parents
static hy_refusal check(void *context, const hy_kept *k, const cm_commit *commit) {
	(void)context;
	for (size_t i = 0; i < held_length; i++)
		if (memcmp(held[i], k->name, 32) == 0) return HY_WAIT;
	if (commit->merge != NULL && rp_merge_find(&merges, commit->merge) == NULL) return HY_MERGE;
	rp_tables tables;
	if (commit->merge != NULL) merged(commit->parents, commit->parents_length, commit->merge, &tables);
	else if (!k->has_base || rp_replay(history, k->base, snapshots, NULL, &merges, &tables) != RP_OK)
		rp_init(&tables);
	bool ok = rp_check(&tables, commit);
	rp_free(&tables);
	return ok ? 0 : HY_PATCHES;
}

void hh_start(void) {
	commits = cs_create();
	history = hy_create(check, NULL);
	walked = eg_rule.create();
}

void hh_finish(void) {
	for (size_t i = 0; i < kept_length; i++) free(kept[i].bytes), free(kept[i].key);
	free(kept);
	eg_rule.free(walked);
	hy_free(history);
	cs_destroy(commits);
	free(held);
}

static void put_failure(FILE *out, const cs_failure *why) {
	if (why->text != NULL) hh_error(out, "%s", why->text);
	else cf_put_refusal(out, why->code, why->field);
}

static void put_added(FILE *out, hy_added *a) {
	fputs("{\"added\":", out);
	switch (a->kind) {
	case HY_TAKEN: fputs("\"taken\"", out); break;
	case HY_PASSED: fputs("\"passed\"", out); break;
	case HY_REFUSED: fprintf(out, "{\"refused\":\"%s\"}", hy_refusal_name(a->refusal)); break;
	case HY_WAITING:
		fputs("{\"waiting\":[", out);
		for (size_t i = 0; i < a->waiting_length; i++) {
			if (i) fputc(',', out);
			cs_put_name(commits, out, a->waiting[i]);
		}
		fputs("]}", out);
		break;
	}
	fputc('}', out);
	hy_added_free(a);
}

static void make(const op_value *r, FILE *out) {
	cs_failure why;
	if (cs_make(commits, r, &why) == NULL) {
		put_failure(out, &why);
		free(why.field);
	} else fputs("{}", out);
}

static void add(const op_value *r, FILE *out) {
	const char *hex = hh_str(r, "bytes");
	uint8_t *bytes;
	size_t length;
	if (op_get(r, "bytes") != NULL) {
		if (hex == NULL || !cf_unhex(hex, &bytes, &length)) {
			hh_error(out, "not hex");
			return;
		}
	} else {
		cs_failure why;
		const cs_made *m = cs_make(commits, r, &why);
		if (m == NULL) {
			put_failure(out, &why);
			free(why.field);
			return;
		}
		bytes = m->bytes;
		length = m->length;
	}
	hy_added a = hy_add(history, bytes, length, NULL);
	put_added(out, &a);
}

static void put_names(FILE *out, const char *key, const hy_kept **list, size_t n) {
	fprintf(out, "{\"%s\":[", key);
	for (size_t i = 0; i < n; i++) {
		if (i) fputc(',', out);
		cs_put_name(commits, out, list[i]->name);
	}
	fputs("]}", out);
	free(list);
}

static void waiting(FILE *out) {
	hy_waiting_row *rows;
	size_t n = hy_waiting(history, &rows);
	fputs("{\"waiting\":[", out);
	for (size_t i = 0; i < n; i++) {
		if (i) fputc(',', out);
		fputs("{\"name\":", out);
		cs_put_name(commits, out, rows[i].name);
		fputs(",\"waiting\":[", out);
		for (size_t k = 0; k < rows[i].waiting_length; k++) {
			if (k) fputc(',', out);
			cs_put_name(commits, out, rows[i].waiting[k]);
		}
		fputs("]}", out);
	}
	fputs("]}", out);
	hy_waiting_free(rows, n);
}

static void refused(FILE *out) {
	hy_refused_row *rows;
	size_t n = hy_refused(history, &rows);
	fputs("{\"refused\":[", out);
	for (size_t i = 0; i < n; i++) {
		if (i) fputc(',', out);
		fputs("{\"name\":", out);
		cs_put_name(commits, out, rows[i].name);
		fprintf(out, ",\"refused\":\"%s\"}", hy_refusal_name(rows[i].refusal));
	}
	fputs("]}", out);
	free(rows);
}

// a commit named in a request: its name; the answer is written when there is none
static bool named(const op_value *r, FILE *out, uint8_t name[32]) {
	const char *error = NULL;
	if (cs_resolve(commits, op_get(r, "commit"), name, &error)) return true;
	hh_error(out, "%s", error);
	return false;
}

// { op: "hold", commits }: the check answers HY_WAIT for these, until the next hold
static void hold(const op_value *r, FILE *out) {
	const op_value *list = op_get(r, "commits");
	if (list == NULL || list->type != OP_LIST) {
		hh_error(out, "hold: commits a list");
		return;
	}
	uint8_t(*names)[32] = malloc((list->count + 1) * 32);
	if (names == NULL) abort();
	for (size_t i = 0; i < list->count; i++) {
		const char *error = NULL;
		if (!cs_resolve(commits, list->items[i], names[i], &error)) {
			free(names);
			hh_error(out, "%s", error);
			return;
		}
	}
	free(held);
	held = names;
	held_length = list->count;
	fputs("{}", out);
}

// a request's tables, {table: {value, change}}, as tables: the line's memory is what they refer to
static void tables_of(const op_value *given, rp_tables *t) {
	rp_init(t);
	if (given == NULL || given->type != OP_MAP) return;
	for (size_t i = 0; i < given->count; i++) {
		const op_value *e = given->items[i];
		ch_header *h = hh_take(sizeof *h);
		*h = e->type == OP_MAP && op_get(e, "change") ? hh_header(op_get(e, "change")) : (ch_header){0};
		rp_put(t, given->keys[i], e->type == OP_MAP ? op_get(e, "value") : NULL, h);
	}
}

static void put_tables(FILE *out, const rp_tables *t) {
	fputs("{\"tables\":{", out);
	for (size_t i = 0; i < t->length; i++) {
		if (i) fputc(',', out);
		op_json_string(out, t->slots[i].table);
		fputc(':', out);
		hh_put_entry(out, t->slots[i].entry);
	}
	fputs("}}", out);
}

static void replay(const op_value *r, FILE *out) {
	uint8_t name[32];
	if (!named(r, out, name)) return;
	rp_tables t;
	rp_code code = rp_replay(history, name, snapshots, NULL, &merges, &t);
	if (code == RP_NOT_TAKEN) fputs("{}", out);
	else if (code != RP_OK) hh_error(out, "patches do not apply");
	else {
		put_tables(out, &t);
		rp_free(&t);
	}
}

// the tables of a request, packed: written when they cannot be
static bool packed(const op_value *r, FILE *out, uint8_t **bytes, size_t *length) {
	rp_tables t;
	tables_of(op_get(r, "tables"), &t);
	pk_code code = sn_snapshot(&t, bytes, length);
	rp_free(&t);
	if (code == PK_OK) return true;
	fprintf(out, "{\"error\":\"%s\"}", pk_code_name(code));
	return false;
}

// a list of commits named in a request (labels or hex): malloc'd names; the answer is written when
// one is not
static bool names_of(const op_value *list, FILE *out, uint8_t (**names)[32], size_t *n) {
	if (list == NULL || list->type != OP_LIST) {
		hh_error(out, "not a list of commits");
		return false;
	}
	*names = malloc(list->count * 32 + 1);
	if (*names == NULL) abort();
	*n = list->count;
	for (size_t i = 0; i < list->count; i++) {
		const char *error = NULL;
		if (!cs_resolve(commits, list->items[i], (*names)[i], &error)) {
			hh_error(out, "%s", error);
			free(*names);
			return false;
		}
	}
	return true;
}

static void keep(const op_value *r, FILE *out) {
	uint8_t *bytes, (*names)[32];
	size_t length, n;
	if (op_get(r, "commits") != NULL) {
		if (!names_of(op_get(r, "commits"), out, &names, &n)) return;
	} else {
		names = malloc(32);
		if (names == NULL) abort();
		n = 1;
		if (!named(r, out, names[0])) {
			free(names);
			return;
		}
	}
	char *key = key_of((const uint8_t(*)[32])names, n);
	free(names);
	if (!packed(r, out, &bytes, &length)) {
		free(key);
		return;
	}
	for (size_t i = 0; i < kept_length; i++) {
		if (strcmp(kept[i].key, key) == 0) {
			free(kept[i].bytes);
			free(key);
			kept[i].bytes = bytes;
			kept[i].length = length;
			fputs("{}", out);
			return;
		}
	}
	kept = realloc(kept, (kept_length + 1) * sizeof *kept);
	if (kept == NULL) abort();
	kept[kept_length].key = key;
	kept[kept_length].bytes = bytes;
	kept[kept_length++].length = length;
	fputs("{}", out);
}

// heads (taken) merged by the rule, default eg-walker
static void merge(const op_value *r, FILE *out) {
	uint8_t(*names)[32];
	size_t n;
	if (!names_of(op_get(r, "heads"), out, &names, &n)) return;
	for (size_t i = 0; i < n; i++) {
		if (hy_get(history, names[i]) == NULL) {
			hh_error(out, "not taken");
			free(names);
			return;
		}
	}
	const char *rule = hh_str(r, "rule");
	if (rule == NULL) rule = eg_rule.name;
	if (rp_merge_find(&merges, rule) == NULL) {
		hh_error(out, "no rule %s", rule);
		free(names);
		return;
	}
	rp_tables t;
	merged((const uint8_t(*)[32])names, n, rule, &t);
	put_tables(out, &t);
	rp_free(&t);
	free(names);
}

// since's start known: one commit had without merging, or several kept
static bool known(void *context, const hy_kept *const *from, size_t n) {
	(void)context;
	rp_tables t;
	bool got;
	if (n == 1) {
		got = rp_plain(history, from[0]->name, snapshots, NULL, &t) == RP_OK;
	} else {
		rp_init(&t);
		got = several(from, n, &t);
	}
	if (got || n != 1) rp_free(&t);
	return got;
}

static void since(const op_value *r, FILE *out) {
	uint8_t(*names)[32];
	size_t n;
	if (!names_of(op_get(r, "heads"), out, &names, &n)) return;
	const hy_kept **heads = malloc((n + 1) * sizeof *heads);
	if (heads == NULL) abort();
	for (size_t i = 0; i < n; i++) {
		if ((heads[i] = hy_get(history, names[i])) == NULL) {
			hh_error(out, "not taken");
			free(heads), free(names);
			return;
		}
	}
	const hy_kept **from, **list;
	size_t nf, nc;
	hy_since(history, heads, n, known, NULL, &from, &nf, &list, &nc);
	fputs("{\"from\":[", out);
	for (size_t i = 0; i < nf; i++) {
		if (i) fputc(',', out);
		cs_put_name(commits, out, from[i]->name);
	}
	fputs("],\"commits\":[", out);
	for (size_t i = 0; i < nc; i++) {
		if (i) fputc(',', out);
		cs_put_name(commits, out, list[i]->name);
	}
	fputs("]}", out);
	free(from), free(list), free(heads), free(names);
}

static void snapshot(const op_value *r, FILE *out) {
	uint8_t *bytes;
	size_t length;
	if (!packed(r, out, &bytes, &length)) return;
	fputs("{\"snapshot\":", out);
	cf_put_hex(out, bytes, length);
	fputc('}', out);
	free(bytes);
}

static void tables(const op_value *r, FILE *out) {
	const op_value *value = op_get(r, "value");
	const char *hex = hh_str(r, "snapshot");
	uint8_t *bytes;
	size_t length;
	if (value != NULL) {
		if (!cf_value_bytes(value, &bytes, &length)) {
			hh_error(out, "no encoding");
			return;
		}
	} else if (hex == NULL || !cf_unhex(hex, &bytes, &length)) {
		hh_error(out, "not hex");
		return;
	}
	rp_tables t;
	rp_init(&t);
	pk_code code = sn_tables(bytes, length, &t);
	if (code != PK_OK) fprintf(out, "{\"error\":\"%s\"}", pk_code_name(code));
	else put_tables(out, &t);
	rp_free(&t);
}

void hh_answer(const op_value *r, FILE *out) {
	const char *op = hh_str(r, "op");
	if (op == NULL) hh_unknown(out, r);
	else if (strcmp(op, "make") == 0) make(r, out);
	else if (strcmp(op, "add") == 0) add(r, out);
	else if (strcmp(op, "hold") == 0) hold(r, out);
	else if (strcmp(op, "again") == 0) hy_again(history), fputs("{}", out);
	else if (strcmp(op, "heads") == 0) {
		const hy_kept **list;
		size_t n = hy_heads(history, &list);
		put_names(out, "heads", list, n);
	} else if (strcmp(op, "all") == 0) {
		const hy_kept **list;
		size_t n = hy_all(history, &list);
		put_names(out, "all", list, n);
	} else if (strcmp(op, "waiting") == 0) waiting(out);
	else if (strcmp(op, "refused") == 0) refused(out);
	else if (strcmp(op, "name") == 0) {
		uint8_t name[32];
		if (named(r, out, name)) {
			fputs("{\"name\":", out);
			cf_put_hex(out, name, 32);
			fputc('}', out);
		}
	} else if (strcmp(op, "replay") == 0) replay(r, out);
	else if (strcmp(op, "keep") == 0) keep(r, out);
	else if (strcmp(op, "merge") == 0) merge(r, out);
	else if (strcmp(op, "since") == 0) since(r, out);
	else if (strcmp(op, "snapshot") == 0) snapshot(r, out);
	else if (strcmp(op, "tables") == 0) tables(r, out);
	else hh_unknown(out, r);
}
