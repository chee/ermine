// offers (offers.c): what a den can run, as nodes. a runner, a compiler or a surface a den (or a
// process it runs) puts under its node; dn_offer_at, dn_offered_at and dn_withdraw_at are dens.h's. an
// offer is a scope under its folder's, under its owner's: what runs on it runs under it, so its node
// going takes them, newest first. inside the den's files
#ifndef DN_OFFERS_H
#define DN_OFFERS_H
#include "common.h"

// the kinds' names, by dn_kind
extern const char *const dn_kinds[3];
// the standing offer at an id; NULL: none
offer *dn_live_offer(const dn *d, const char *id);

#endif
