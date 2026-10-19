// the cardputer's things: runners for a den (ermine/dens/c/dens.h), as the dens page's things.ts:
// keys, screen, pigs. each writes what it gives on its own process node, attributes["thing.out"],
// and reads its sources the same way, by path (their nodes here, or mirrored from another den by
// away). its args say what it reads: triples [input, den id, path], and settings "name=value"
#ifndef THINGS_H
#define THINGS_H

#include "ermine/dens/c/dens.h"

#define THING_OUT "thing.out"
#define THING_SAYS "thing.says"

// the runners into the registry: "keys", "screen", "pigs"
void things_add(hf *fs);
// a key on the keyboard to the keys thing running here: a letter, " ", or "del"
void things_key(const char *key);
// the platform's: the framebuffer (fb.h) drawn, show it
void frame_show(void);

#endif
