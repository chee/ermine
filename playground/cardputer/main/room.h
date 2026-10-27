// the room driver: lab-pig's room and pigs on littlesync (playground/together/stacks/littlesync; the
// format: playground/demos/pigs/littlesync/pigs.h) as nodes in the graph.
// /pigs/room is the room's value (its pigs are its children, each followed), /pigs/<first 8 hex of a
// pig's id> a pig's stored value, and
// /pigs/<pig>/held the value its carrier is holding up (null: none), /pigs/<pig>/also the other drop
// when two devices dropped it at once (null: none), /pigs/room/pointers the others' pointers (their
// presence rows at the room: web pigs' and littlesync devices', [{who, name, colour, x, y}]; this
// device has no pointer, so sends no row). a /pigs value written in the graph that littlesync
// does not have is put to littlesync, replacing every item (ls_pick: a clash ends). littlesync's own IO
// is the host's (main.c)
#ifndef ROOM_H
#define ROOM_H

#include "ermine/system/c/ermine.h"
#include "littlesync.h"

// the device the driver follows its nodes on; before the program starts
void room_device(ls_dev *dev);
es_out room(es_context *c, void *ctx);
// littlesync's nodes into the graph, where they changed; after each ls_tick / ls_feed
void room_mirror(es_context *c);
// the pig that changed last (NULL: none yet), for showing what it costs (ls_cost_of)
const ls_node *room_last(void);

#endif
