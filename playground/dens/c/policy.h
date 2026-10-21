// policy (policy.c): may it. the policy asked with who, the op, the target (a part, an id, a path) and
// whether the ask is another den's; none given: yes here, no for another den's. inside the den's files
#ifndef DN_POLICY_H
#define DN_POLICY_H
#include "common.h"

// the policy asked; none: yes here, no for another den's. path NULL: not given
pr_answer dn_permit(dn *d, const op_value *who, const char *op, const char *part, const char *id,
	char *const *path, size_t npath, int remote);
// refused no-permission: the op asked, the answer (a pending's need dropped)
void dn_no_permission(dn_refusal *r, const char *op, pr_answer a);

#endif
