// the drivers: programs that are the device's hardware in the graph. the keyboard puts each key
// at /keyboard; the display draws what /programs/shell/screen holds, by the platform's show
#ifndef DRIVERS_H
#define DRIVERS_H

#include "ermine/api/c/api.h"

int keyboard(api *a);
// a key pressed: "a", "A", "enter", "backspace", "esc", "up", ...
void keyboard_press(api *a, const char *key);

int display(api *a);
// the platform's: draw a screen value, {lines, prompt}
void show(const op_value *screen);

#endif
