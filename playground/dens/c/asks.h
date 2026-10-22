// asks (typescript/asks.ts) in C: telling a den something through the graph. an ask is a node under
// one of the den's methods (<den>/on/start, <den>/on/stop), named by its hash, its value the ask
// (without its op). whoever has the den's node (here, or carried from elsewhere) can write one; the
// den answers each once, at <ask>/answer. an ask written while the den is not running waits: it is
// answered when the den next starts. the same ask written twice is one ask (one hash), answered once.
// which question: how it is asked
//
//   dn_world w = {.table = t, .places = p, .scope = host};
//   char *n = dn_ask_write(&w, den, ask);       // the ask's id (to free); ask a map { op, who, ... }
//   const op_value *got = dn_ask_answer(&w, n); // { id, at } | {} | a refusal | { error }; NULL until then
//
// the den's side (dn_answering, from handlers.c): every ask under its methods with no answer, as
// dn_ask_at answers another den's (the policy asked, remote), in a run of one effect; an ask whose
// value is no ask: { error: "not-an-ask" }; one dn_ask_at refuses with a places code (not-a-name,
// nothing-there, already-there): { error: the code }. who an ask is from is what it says (who):
// checked once installs sign what they carry; nothing here checks it
// dn_world, dn_ask_write_at and dn_ask_answer are dens.h's. inside the den's files
#ifndef DN_ASKS_H
#define DN_ASKS_H
#include "common.h"

// the den's side: an effect, made with the on folder's scope open, answering every ask with no
// answer yet
void dn_answering(dn *d);

#endif
