// Protect (typescript/protect.ts), in C: may this actor do this to that, at this version? An
// answer, never an effect. Same rules as protect.ts, which the suite in filesystem/protect/conformance/protect/
// holds both to.
//
// AN ASK. who: the change, a whole header (an op_value map with actor, reader, ..., or NULL: none), opaque. op: what for, any string. target: a
// node or a field of it. at: the version, opaque (an op_value, or NULL: now), passed to the reader
// with every read a policy makes. Ids are tb_keys (table.h): a string, or a symbol.
//
// A TARGET says as much as the asker knows: part, id (NULL part, NULL id.string and symbol: not
// given), field (an op_value list of steps, strings or whole numbers; NULL: the whole node), path
// (names from a start, when asked by path) and route (the id reached at each step, route[0] the
// start; nroute is npath + 1 when given).
//
// A POLICY is a tree made with the pr_ constructors below and freed whole by pr_free: all, any and
// only take the policies given. A policy reads through a pr_read: the asker's own read, so what
// it reads is the asker's to track. A read of what is not there is NULL: a policy that needs it
// answers pending.
//
// ANSWERS are borrowed from the policy (its strings and its need): good until pr_free. Out of
// memory aborts.
#ifndef PROTECT_H
#define PROTECT_H

#include <stddef.h>

#include "../../../core/graph/c/table.h"
#include "../../../core/op/c/value.h"

typedef enum { PR_YES, PR_NO, PR_PENDING } pr_verdict;
typedef struct {
	pr_verdict verdict;
	// PR_NO: why. never NULL
	const char *reason;
	// PR_PENDING: what it waits for, opaque (a grants policy: its pr_where); may be NULL
	const void *need;
} pr_answer;

typedef struct {
	const char *part;
	tb_key id;
} pr_where;

// where something stands among places: path NULL, route NULL: not reached by names
typedef struct {
	const char *const *path;
	size_t npath;
	const tb_key *route;
	size_t nroute;
} pr_place;

typedef struct {
	const char *part;
	tb_key id;
	const op_value *field;
	const char *const *path;
	size_t npath;
	const tb_key *route;
	size_t nroute;
} pr_target;

typedef struct {
	const op_value *who;
	const char *op;
	pr_target target;
	// the place the asker is at: none given is all NULL
	pr_place from;
	const op_value *at;
} pr_ask;

// the host's reader: the value at path (an op_value list, or NULL) in the node under (part, id)
// as it is at `at`; NULL: not there. borrowed: good until the next read
typedef const op_value *(*pr_reader)(void *ctx, const char *part, tb_key id, const op_value *path,
	const op_value *at);
// what a policy reads through: a reader, and the ask's version
typedef struct {
	pr_reader reader;
	void *ctx;
	const op_value *at;
} pr_read;
const op_value *pr_read_at(const pr_read *read, const char *part, tb_key id, const op_value *path);

typedef struct pr_policy pr_policy;
// a policy of your own: asked with the ask and the read
typedef pr_answer (*pr_call_fn)(void *ctx, const pr_ask *ask, const pr_read *read);

pr_policy *pr_yes(void);
pr_policy *pr_no(const char *reason);
pr_policy *pr_pending(void);
pr_policy *pr_call(pr_call_fn fn, void *ctx);
// all: every policy yes; a no is final even after a pending; else any pending is pending
pr_policy *pr_all(pr_policy *const *policies, size_t n);
// any: one yes is enough; else any pending is pending, else the first no (none: "no policy")
pr_policy *pr_any(pr_policy *const *policies, size_t n);
// the policy for the ops given (copied); any other op: yes
pr_policy *pr_only(const char *const *ops, size_t n, pr_policy *policy);
// grants: the one data-driven policy (protect.ts): the value of the node at where, a list of maps
pr_policy *pr_grants(pr_where where);
void pr_free(pr_policy *policy);

// values equal: scalars, lists in order, maps by keys
int pr_same(const op_value *a, const op_value *b);

pr_answer pr_ask_of(const pr_policy *policy, const pr_ask *ask, pr_reader reader, void *ctx);

#endif
