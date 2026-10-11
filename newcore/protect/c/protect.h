// Who may do what (newcore/protect/PROTECT.tex), in C. Same shape as protect.ts. Only the scheduler calls it.
// Nothing here reads the graph: a policy's own reads go through the read the caller gives.
//
// memory: the caller owns it. everything the library builds (values, asks, answers' whys, rule
// facts) lives in a pr_arena the caller gives, until pr_free. pointers into values the caller
// passes in (actors, args, rule lists) are borrowed, never freed: keep them alive as long as
// anything built from them. strings are NUL-terminated and carry no NUL inside.
#ifndef PROTECT_H
#define PROTECT_H

#include <stddef.h>

// an arena: start it zeroed ({0}); pr_free frees all of it and leaves it ready again
typedef struct pr_block pr_block;
typedef struct {
	pr_block *head;
	char *cur;
	size_t left;
} pr_arena;

void *pr_alloc(pr_arena *a, size_t size);
void pr_free(pr_arena *a);

// a value, as JSON has them. numbers are doubles. maps keep their keys in order, keys unique
// a string's bytes are str, n of them; a list's or map's members are items, n of them, keys[i] names items[i]
enum { PR_NULL, PR_BOOL, PR_NUM, PR_STR, PR_LIST, PR_MAP };
typedef struct pr_value {
	int kind;
	int yes;
	double num;
	const char *str;
	size_t n;
	size_t cap;
	struct pr_value *items;
	const char **keys;
} pr_value;

pr_value pr_null(void);
pr_value pr_bool(int yes);
pr_value pr_num(double num);
pr_value pr_lit(const char *s);                         // borrowed
pr_value pr_str(pr_arena *a, const char *s, size_t n);  // copied
pr_value pr_list(void);
pr_value pr_map(void);
void pr_push(pr_arena *a, pr_value *list, pr_value v);
void pr_put(pr_arena *a, pr_value *map, const char *key, pr_value v); // key borrowed; an old one is replaced
const pr_value *pr_get(const pr_value *map, const char *key);         // NULL: not a map, or no key
int pr_equal(const pr_value *a, const pr_value *b);                    // deep; 1 and 1.0 equal, 1 and "1" not

// an answer: yes, no with its why (a map: code and details), or pending
enum { PR_YES, PR_NO, PR_PENDING };
typedef struct {
	int kind;
	pr_value why; // PR_NO only
} pr_answer;

// a policy's read: a node's value. 0: not loaded. 1: loaded, *value its value, NULL if it has none
typedef struct {
	int (*get)(void *ctx, const char *id, const pr_value **value);
	void *ctx;
} pr_read;

// a may: asked of an actor, an op and its args (a map: node, object, name, id, at)
typedef struct pr_may {
	pr_answer (*fn)(const void *ctx, pr_arena *a, const pr_value *actor, const char *op,
			const pr_value *args, const pr_read *read);
	const void *ctx; // the may's own, borrowed
} pr_may;

pr_answer pr_ask_may(const pr_may *may, pr_arena *a, const pr_value *actor, const char *op,
		const pr_value *args, const pr_read *read);

extern const pr_may pr_anyone;
// the first answer not yes, outside in; the mays are copied
pr_may pr_first(pr_arena *a, const pr_may *mays, size_t n);
// reads its rules from the value of node id (copied), through read, at each ask: the first rule
// matching wins; none: allowed. not loaded: pending; not a list of rules: refused
pr_may pr_rules(pr_arena *a, const char *id);

// what is asked, about one node: op and args
typedef struct {
	const char *op;
	pr_value args;
} pr_ask;

// asks in order: the first answer not yes and its place (has_at, at); all yes: yes, has_at 0
typedef struct {
	pr_answer answer;
	int has_at;
	size_t at;
} pr_checked;

pr_checked pr_check(const pr_may *may, pr_arena *a, const pr_value *actor, const pr_ask *asks,
		size_t n, const pr_read *read);

// asks come as arrays in the arena
typedef struct {
	pr_ask *items;
	size_t n;
} pr_asks;

// by path: pass at each step of a route, at the node whose list it is, by the step's name
// a NULL node or name is left out
typedef struct {
	const char *node;
	const char *name;
} pr_step;
pr_asks pr_pass(pr_arena *a, const pr_step *route, size_t n);

// by path: a node's names read without a name
pr_ask pr_list_ask(pr_arena *a, const char *node);

// by node: read, per object of a node (value once if it has any, each info name, each child name)
pr_asks pr_read_asks(pr_arena *a, const char *id, size_t nvalue, const char **info, size_t ninfo,
		const char **children, size_t nchildren);

// by node: an edit at an object, at its version; object: "value", "order" or ["info"|"children", name]
// object NULL: left out. at NULL: 0, else a number or [number, number]
pr_ask pr_edit(pr_arena *a, const char *op, const char *node, const pr_value *object,
		const pr_value *at);

// by node: a list's ids before and after (lists): unplace for each removed, place for each added,
// as often as it was; non-string ids skipped; one may place only what one may read: the caller
// adds read at each added id whose node is loaded
pr_asks pr_placing(pr_arena *a, const char *node, const char *name, const pr_value *before,
		const pr_value *after);

// rules: a list of maps of these fields: actor peer person trusted process program op node id name object allow

// what a rule is matched against: the actor's own actor, else the whole actor; its own peer,
// person and trusted; process and program from its code's last step; and the ask's
pr_value pr_facts(pr_arena *a, const pr_value *actor, const char *op, const pr_value *args);

// every field a rule gives equals the ask's; one the ask lacks never matches
int pr_matches(const pr_value *rule, const pr_value *facts);

#endif
