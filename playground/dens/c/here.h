// here (here.c): the den's own node. the session's process at /system/session, and in its body the
// den's node (the install's) written and placed at /system/dens/<id> and /system/den (the same id),
// what it says of itself, how it closes, and what others see of it. dn_id, dn_node, dn_session_id,
// dn_self, dn_scope, dn_places, dn_scheduler, dn_table, dn_close_at and dn_nodes are dens.h's. the
// den's offers are scopes under its process's, so what runs on them is under it: its going takes
// them, then its loads, then here's leaves. inside the den's files
#ifndef DN_HERE_H
#define DN_HERE_H
#include "common.h"

// in the session's scope, as processes' start gives it: the den's node written, its methods, the
// leaves, and the effect that takes its status away at the first pulse
void dn_den_body(pr_process *life, void *data);
// the session's process going, what is under it gone already: the leaves out
void dn_den_end(pr_process *life, void *data);
// the den's own asked stop on its node (as any process), then dn_close. 1: refused
int dn_stop_self(dn *d, const op_value *who, int remote, const op_value *reason,
	dn_refusal *refused);

#endif
