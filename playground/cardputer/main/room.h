// the room driver: lab-pig's room and pigs on littlesync (extensions/together/stacks/littlesync; the
// format: playground/demos/pigs/littlesync/pigs.h) as nodes in the graph.
// /pigs/room is the room's value, /pigs/<first 8 hex of a pig's id> a pig's stored value, and
// /pigs/<pig>/held the value its carrier is holding up (null: none). a /pigs value written in the graph
// that littlesync does not have is put to littlesync. littlesync's own IO is the host's (main.c)
#ifndef ROOM_H
#define ROOM_H

#include "ermine/api/c/api.h"
#include "littlesync.h"

// the device the driver follows its nodes on; before the program starts
void room_device(ls_dev *dev);
int room(api *a);
// littlesync's nodes into the graph, where they changed; after each ls_tick / ls_feed
void room_mirror(api *a);
// the pig that changed last (NULL: none yet), for showing what it costs (ls_cost_of)
const ls_node *room_last(void);

#endif
