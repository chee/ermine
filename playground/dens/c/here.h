// here (here.c): the den's own node. /system/dens/<id> and /system/den (the same id), what it says
// of itself, how it closes, and what others see of it. dn_id, dn_node, dn_self, dn_scope, dn_places,
// dn_scheduler, dn_table, dn_close_at and dn_nodes are dens.h's. the den's offers are scopes under
// its node's, so what runs on them is under it: its going takes them, then its loads, then here and
// its row. inside the den's files
#ifndef DN_HERE_H
#define DN_HERE_H
#include "common.h"

// in the den's scope, as processes' start gives it: its methods, /system/den, and the effect that
// takes its status away at the first pulse
void dn_den_body(pr_process *life, void *data);
// the den's own process going, what is under it gone already: /system/den out
void dn_den_end(pr_process *life, void *data);
// the den's own asked stop on its node (as any process), then dn_close. 1: refused
int dn_stop_self(dn *d, const op_value *who, int remote, const op_value *reason,
	dn_refusal *refused);

#endif
