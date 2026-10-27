// the drivers: programs that are the device's hardware in the graph. the keyboard puts each key
// at /keyboard; the display draws what /programs/shell/screen holds, by the platform's show
#ifndef DRIVERS_H
#define DRIVERS_H

#include "ermine/system/c/ermine.h"

// setups (host_start's): the keyboard makes /keyboard, the display's effect draws
es_out keyboard(es_context *c, void *ctx);
// a key pressed, as the keyboard's process: "a", "A", "enter", "backspace", "esc", "up", ...
void keyboard_press(es_context *keyboard, const char *key);

es_out display(es_context *c, void *ctx);
// the platform's: draw a screen value, {lines, prompt}
void show(const op_value *screen);

#endif
