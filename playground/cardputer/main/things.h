// the cardputer's things: runners on software (experiments/software/c), as the dens page's things.ts:
// keys, screen, pigs. each writes what it gives on its own process node: its first outlet at
// attributes["thing.out"], any other at attributes["thing.<name>"] (keys: text, then typed; pigs:
// their weights, then says). it reads its sources the same way, by path (their nodes here, or
// mirrored from another den by away). its args say what it reads: triples [input, den id, path],
// each followed by "=<outlet>" when it reads an outlet other than the first, and settings
// "name=value" (host.ts' contract)
#ifndef THINGS_H
#define THINGS_H

#include "experiments/software/c/software.h"

#define THING_OUT "thing.out"
#define THING_SAYS "thing.says"
#define THING_TYPED "thing.typed"
// the most letters the keys thing holds
#define KEYS_LONGEST 280

// the runners into the registry: "keys", "screen", "pigs", the den's "speaker", and the parts'
// (parts.h): "tilt", "loudness", "led", "ir", "battery", "sd", "grove"
void things_add(hf *fs);
// each loop: the parts' things (tilt, loudness, battery, sd, grove) read what they read
void things_tick(int64_t now);
// a key on the keyboard to the keys thing running here: a letter, " ", or "del"
void things_key(const char *key);
// the platform's: show a picture (fb.h's paint: called again for each strip, so it draws from what
// it keeps, the same each time)
void frame_show(void (*paint)(void));

#endif
