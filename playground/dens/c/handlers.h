// handlers (handlers.c): how a den is asked to do things from the graph. the method nodes under its
// node (on/start, on/stop), and the ask another den makes of it. dn_ask_at, dn_on_at and dn_refusal_value
// are dens.h's. inside the den's files
#ifndef DN_HANDLERS_H
#define DN_HANDLERS_H
#include "common.h"

// the den's children { on }, the folder on { start, stop }, each a method node holding hf_value("")
void dn_methods(dn *d);

#endif
