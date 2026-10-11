// Who may do what, in C. Same shape as protect.ts.
#include <stdlib.h>
#include <string.h>

#include "protect.h"

struct pr_block {
	pr_block *next;
};

void *pr_alloc(pr_arena *a, size_t size) {
	size = (size + 15) & ~(size_t)15;
	if (size > a->left) {
		size_t room = size > 65536 ? size : 65536;
		pr_block *b = malloc(sizeof(pr_block) + 16 + room);
		if (!b) abort();
		b->next = a->head;
		a->head = b;
		a->cur = (char *)b + sizeof(pr_block) + 16;
		a->left = room;
	}
	void *p = a->cur;
	a->cur += size;
	a->left -= size;
	return p;
}

void pr_free(pr_arena *a) {
	while (a->head) {
		pr_block *next = a->head->next;
		free(a->head);
		a->head = next;
	}
	a->cur = NULL;
	a->left = 0;
}

pr_value pr_null(void) { return (pr_value){.kind = PR_NULL}; }
pr_value pr_bool(int yes) { return (pr_value){.kind = PR_BOOL, .yes = yes != 0}; }
pr_value pr_num(double num) { return (pr_value){.kind = PR_NUM, .num = num}; }
pr_value pr_lit(const char *s) { return (pr_value){.kind = PR_STR, .str = s, .n = strlen(s)}; }
pr_value pr_list(void) { return (pr_value){.kind = PR_LIST}; }
pr_value pr_map(void) { return (pr_value){.kind = PR_MAP}; }

pr_value pr_str(pr_arena *a, const char *s, size_t n) {
	char *c = pr_alloc(a, n + 1);
	memcpy(c, s, n);
	c[n] = 0;
	return (pr_value){.kind = PR_STR, .str = c, .n = n};
}

static void room(pr_arena *a, pr_value *v) {
	if (v->n < v->cap) return;
	size_t cap = v->cap ? v->cap * 2 : 4;
	pr_value *items = pr_alloc(a, cap * sizeof *items);
	if (v->n) memcpy(items, v->items, v->n * sizeof *items);
	if (v->kind == PR_MAP) {
		const char **keys = pr_alloc(a, cap * sizeof *keys);
		if (v->n) memcpy(keys, v->keys, v->n * sizeof *keys);
		v->keys = keys;
	}
	v->items = items;
	v->cap = cap;
}

void pr_push(pr_arena *a, pr_value *list, pr_value v) {
	room(a, list);
	list->items[list->n++] = v;
}

void pr_put(pr_arena *a, pr_value *map, const char *key, pr_value v) {
	for (size_t i = 0; i < map->n; i++) {
		if (!strcmp(map->keys[i], key)) {
			map->items[i] = v;
			return;
		}
	}
	room(a, map);
	map->keys[map->n] = key;
	map->items[map->n++] = v;
}

const pr_value *pr_get(const pr_value *map, const char *key) {
	if (!map || map->kind != PR_MAP) return NULL;
	for (size_t i = 0; i < map->n; i++) if (!strcmp(map->keys[i], key)) return &map->items[i];
	return NULL;
}

int pr_equal(const pr_value *a, const pr_value *b) {
	if (a->kind != b->kind) return 0;
	switch (a->kind) {
	case PR_NULL: return 1;
	case PR_BOOL: return a->yes == b->yes;
	case PR_NUM: return a->num == b->num;
	case PR_STR: return a->n == b->n && !memcmp(a->str, b->str, a->n);
	case PR_LIST:
		if (a->n != b->n) return 0;
		for (size_t i = 0; i < a->n; i++) if (!pr_equal(&a->items[i], &b->items[i])) return 0;
		return 1;
	default:
		if (a->n != b->n) return 0;
		for (size_t i = 0; i < a->n; i++) {
			const pr_value *o = pr_get(b, a->keys[i]);
			if (!o || !pr_equal(&a->items[i], o)) return 0;
		}
		return 1;
	}
}

pr_answer pr_ask_may(const pr_may *may, pr_arena *a, const pr_value *actor, const char *op,
		const pr_value *args, const pr_read *read) {
	return may->fn(may->ctx, a, actor, op, args, read);
}

static pr_answer anyone_fn(const void *ctx, pr_arena *a, const pr_value *actor, const char *op,
		const pr_value *args, const pr_read *read) {
	(void)ctx; (void)a; (void)actor; (void)op; (void)args; (void)read;
	return (pr_answer){.kind = PR_YES};
}

const pr_may pr_anyone = {anyone_fn, NULL};

typedef struct {
	pr_may *mays;
	size_t n;
} firsts;

static pr_answer first_fn(const void *ctx, pr_arena *a, const pr_value *actor, const char *op,
		const pr_value *args, const pr_read *read) {
	const firsts *f = ctx;
	for (size_t i = 0; i < f->n; i++) {
		pr_answer r = pr_ask_may(&f->mays[i], a, actor, op, args, read);
		if (r.kind != PR_YES) return r;
	}
	return (pr_answer){.kind = PR_YES};
}

pr_may pr_first(pr_arena *a, const pr_may *mays, size_t n) {
	firsts *f = pr_alloc(a, sizeof *f);
	f->mays = pr_alloc(a, (n ? n : 1) * sizeof *mays);
	if (n) memcpy(f->mays, mays, n * sizeof *mays);
	f->n = n;
	return (pr_may){first_fn, f};
}

pr_checked pr_check(const pr_may *may, pr_arena *a, const pr_value *actor, const pr_ask *asks,
		size_t n, const pr_read *read) {
	for (size_t i = 0; i < n; i++) {
		pr_answer r = pr_ask_may(may, a, actor, asks[i].op, &asks[i].args, read);
		if (r.kind != PR_YES) return (pr_checked){r, 1, i};
	}
	return (pr_checked){.answer = {.kind = PR_YES}};
}

// what is asked

pr_asks pr_pass(pr_arena *a, const pr_step *route, size_t n) {
	pr_asks r = {pr_alloc(a, (n ? n : 1) * sizeof(pr_ask)), n};
	for (size_t i = 0; i < n; i++) {
		pr_value args = pr_map();
		if (route[i].node) pr_put(a, &args, "node", pr_lit(route[i].node));
		if (route[i].name) pr_put(a, &args, "name", pr_lit(route[i].name));
		r.items[i] = (pr_ask){"pass", args};
	}
	return r;
}

pr_ask pr_list_ask(pr_arena *a, const char *node) {
	pr_value args = pr_map();
	pr_put(a, &args, "node", pr_lit(node));
	return (pr_ask){"list", args};
}

static pr_ask read_ask(pr_arena *a, const char *id, pr_value object) {
	pr_value args = pr_map();
	pr_put(a, &args, "node", pr_lit(id));
	pr_put(a, &args, "object", object);
	return (pr_ask){"read", args};
}

static pr_value pair(pr_arena *a, const char *kind, const char *name) {
	pr_value v = pr_list();
	pr_push(a, &v, pr_lit(kind));
	pr_push(a, &v, pr_lit(name));
	return v;
}

pr_asks pr_read_asks(pr_arena *a, const char *id, size_t nvalue, const char **info, size_t ninfo,
		const char **children, size_t nchildren) {
	pr_asks r = {pr_alloc(a, (1 + ninfo + nchildren) * sizeof(pr_ask)), 0};
	if (nvalue > 0) r.items[r.n++] = read_ask(a, id, pr_lit("value"));
	for (size_t i = 0; i < ninfo; i++) r.items[r.n++] = read_ask(a, id, pair(a, "info", info[i]));
	for (size_t i = 0; i < nchildren; i++) {
		r.items[r.n++] = read_ask(a, id, pair(a, "children", children[i]));
	}
	return r;
}

pr_ask pr_edit(pr_arena *a, const char *op, const char *node, const pr_value *object,
		const pr_value *at) {
	pr_value args = pr_map();
	pr_put(a, &args, "node", pr_lit(node));
	if (object) pr_put(a, &args, "object", *object);
	pr_put(a, &args, "at", at ? *at : pr_num(0));
	return (pr_ask){op, args};
}

static pr_ask placed(pr_arena *a, const char *op, const char *node, const char *name,
		pr_value id) {
	pr_value args = pr_map();
	pr_put(a, &args, "node", pr_lit(node));
	pr_put(a, &args, "name", pr_lit(name));
	pr_put(a, &args, "id", id);
	return (pr_ask){op, args};
}

pr_asks pr_placing(pr_arena *a, const char *node, const char *name, const pr_value *before,
		const pr_value *after) {
	size_t nb = before->kind == PR_LIST ? before->n : 0, na = after->kind == PR_LIST ? after->n : 0;
	// the ids of before in first-seen order, and how many of each are left
	const pr_value **ids = pr_alloc(a, (nb + 1) * sizeof *ids);
	size_t *count = pr_alloc(a, (nb + 1) * sizeof *count), nid = 0, total = 0;
	for (size_t i = 0; i < nb; i++) {
		const pr_value *x = &before->items[i];
		if (x->kind != PR_STR) continue;
		size_t k = 0;
		while (k < nid && !pr_equal(ids[k], x)) k++;
		if (k == nid) ids[nid++] = x, count[k] = 0;
		count[k]++;
		total++;
	}
	const pr_value **added = pr_alloc(a, (na + 1) * sizeof *added);
	size_t nadd = 0;
	for (size_t i = 0; i < na; i++) {
		const pr_value *x = &after->items[i];
		if (x->kind != PR_STR) continue;
		size_t k = 0;
		while (k < nid && !pr_equal(ids[k], x)) k++;
		if (k < nid && count[k] > 0) count[k]--, total--;
		else added[nadd++] = x;
	}
	pr_asks r = {pr_alloc(a, (total + nadd + 1) * sizeof(pr_ask)), 0};
	for (size_t k = 0; k < nid; k++) {
		for (size_t i = 0; i < count[k]; i++) r.items[r.n++] = placed(a, "unplace", node, name, *ids[k]);
	}
	for (size_t i = 0; i < nadd; i++) r.items[r.n++] = placed(a, "place", node, name, *added[i]);
	return r;
}

// rules

static const char *const FIELDS[] = {"actor", "peer", "person", "trusted", "process", "program",
	"op", "node", "id", "name", "object", "allow"};

static int known(const char *k) {
	for (size_t i = 0; i < sizeof FIELDS / sizeof *FIELDS; i++) if (!strcmp(FIELDS[i], k)) return 1;
	return 0;
}

pr_value pr_facts(pr_arena *a, const pr_value *actor, const char *op, const pr_value *args) {
	pr_value f = pr_map();
	const pr_value *m = actor->kind == PR_MAP ? actor : NULL, *own = pr_get(m, "actor");
	pr_put(a, &f, "actor", own ? *own : *actor);
	static const char *const own3[] = {"peer", "person", "trusted"};
	for (size_t i = 0; i < 3; i++) {
		const pr_value *v = pr_get(m, own3[i]);
		if (v) pr_put(a, &f, own3[i], *v);
	}
	const pr_value *code = pr_get(m, "code");
	if (code && code->kind == PR_LIST && code->n > 0) {
		const pr_value *last = &code->items[code->n - 1];
		if (last->kind == PR_MAP) {
			const pr_value *process = pr_get(last, "process"), *program = pr_get(last, "program");
			if (process && process->kind == PR_STR) pr_put(a, &f, "process", *process);
			if (program && program->kind == PR_MAP) program = pr_get(program, "node");
			if (program && program->kind == PR_STR) pr_put(a, &f, "program", *program);
		}
	}
	pr_put(a, &f, "op", pr_str(a, op, strlen(op)));
	if (args->kind == PR_MAP) for (size_t i = 0; i < args->n; i++) pr_put(a, &f, args->keys[i], args->items[i]);
	return f;
}

int pr_matches(const pr_value *rule, const pr_value *facts) {
	// a rule is a map; anything else matches nothing
	if (rule->kind != PR_MAP) return 0;
	for (size_t i = 0; i < rule->n; i++) {
		if (!strcmp(rule->keys[i], "allow")) continue;
		const pr_value *v = pr_get(facts, rule->keys[i]);
		if (!v || !pr_equal(&rule->items[i], v)) return 0;
	}
	return 1;
}

// why a list of rules is no list of rules, or NULL; a field no rule has comes back in *field
static const char *malformed(const pr_value *list, const char **field) {
	const char *bad = "rules are a list of rules";
	if (!list || list->kind != PR_LIST) return bad;
	for (size_t i = 0; i < list->n; i++) {
		const pr_value *rule = &list->items[i];
		if (rule->kind != PR_MAP) return bad;
		for (size_t k = 0; k < rule->n; k++) {
			if (known(rule->keys[k])) continue;
			*field = rule->keys[k];
			return "a rule has no field ";
		}
		const pr_value *allow = pr_get(rule, "allow");
		if (!allow || allow->kind != PR_BOOL) return "a rule's allow is true or false";
	}
	return NULL;
}

static pr_answer rules_fn(const void *ctx, pr_arena *a, const pr_value *actor, const char *op,
		const pr_value *args, const pr_read *read) {
	const pr_value *value = NULL;
	if (!read->get(read->ctx, ctx, &value)) return (pr_answer){.kind = PR_PENDING};
	const char *field = NULL, *wrong = malformed(value, &field);
	if (wrong) {
		size_t n = strlen(wrong), k = field ? strlen(field) : 0;
		char *text = pr_alloc(a, n + k + 1);
		memcpy(text, wrong, n);
		if (field) memcpy(text + n, field, k);
		text[n + k] = 0;
		pr_value why = pr_map();
		pr_put(a, &why, "code", pr_lit("wrong-field"));
		pr_put(a, &why, "field", pr_lit("rules"));
		pr_put(a, &why, "text", pr_str(a, text, n + k));
		return (pr_answer){PR_NO, why};
	}
	pr_value f = pr_facts(a, actor, op, args);
	for (size_t rule = 0; rule < value->n; rule++) {
		if (!pr_matches(&value->items[rule], &f)) continue;
		if (pr_get(&value->items[rule], "allow")->yes) return (pr_answer){.kind = PR_YES};
		pr_value why = pr_map();
		pr_put(a, &why, "code", pr_lit("rule"));
		pr_put(a, &why, "rule", pr_num((double)rule));
		return (pr_answer){PR_NO, why};
	}
	return (pr_answer){.kind = PR_YES};
}

pr_may pr_rules(pr_arena *a, const char *id) {
	size_t n = strlen(id);
	char *c = pr_alloc(a, n + 1);
	memcpy(c, id, n + 1);
	return (pr_may){rules_fn, c};
}
