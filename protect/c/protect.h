// Protect (typescript/protect.ts) in C: may this actor do this to that, at this version? An
// answer, never an effect. The suite in protect/conformance/protect/ holds both to the same rules.
//
// An ask has a who (an op_value header map, opaque, or NULL), an op string, a target and the
// version `at` (opaque, or NULL for now), which is passed to the reader with every read. Ids are
// tb_keys (table.h). A target says as much as the asker knows; unset parts are NULL. A node is a
// target too, the node a placement gives a name to; no grants rule reads it, a pr_call may.
//
// A policy is a tree built with the pr_ constructors and freed whole by pr_policy_free. It reads
// through the asker's own read; a read of what is not there is NULL, and a policy that needs it
// answers pending. Answers are borrowed from the policy and good until pr_policy_free. Out of
// memory aborts.
#ifndef PROTECT_H
#define PROTECT_H

#include <stddef.h>

#include "../../graph/c/table.h"
#include "../../changeable/c/value.h"

typedef enum { PR_YES, PR_NO, PR_PENDING } pr_verdict;
typedef struct {
	const char *part;
	tb_key id;
} pr_where;

typedef struct {
	const pr_where *where;
	size_t index;
} pr_grant;

typedef struct {
	pr_verdict verdict;
	const char *reason;
	const void *need;
	// The grant that decided, for a yes or no from a grants policy. all, any and only pass it
	// through. Borrowed from the policy, like need.
	pr_grant grant;
} pr_answer;

// Where something stands. A NULL path and route mean it was not reached by names.
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
	pr_target node;
	pr_place from;
	const op_value *at;
} pr_ask;

typedef const op_value *(*pr_reader)(void *ctx, const char *part, tb_key id, const op_value *path,
	const op_value *at);
typedef struct {
	pr_reader reader;
	void *ctx;
	const op_value *at;
} pr_read;
const op_value *pr_read_at(const pr_read *read, const char *part, tb_key id, const op_value *path);

typedef struct pr_policy pr_policy;
typedef pr_answer (*pr_call_fn)(void *ctx, const pr_ask *ask, const pr_read *read);

pr_policy *pr_yes(void);
pr_policy *pr_no(const char *reason);
pr_policy *pr_pending(void);
pr_policy *pr_call(pr_call_fn fn, void *ctx);
// Every policy must say yes. A no is final, even after a pending; otherwise any pending is pending.
pr_policy *pr_all(pr_policy *const *policies, size_t n);
// One yes is enough; otherwise any pending is pending, otherwise the first no ("no policy" if none).
pr_policy *pr_any(pr_policy *const *policies, size_t n);
pr_policy *pr_only(const char *const *ops, size_t n, pr_policy *policy);
// The one data-driven policy (see protect.ts): the node at where holds a list of grants.
pr_policy *pr_grants(pr_where where);
void pr_policy_free(pr_policy *policy);

int pr_same(const op_value *a, const op_value *b);

pr_answer pr_ask_of(const pr_policy *policy, const pr_ask *ask, pr_reader reader, void *ctx);

#endif
