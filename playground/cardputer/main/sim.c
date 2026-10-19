// the firmware's programs on the Mac: stdin is the keyboard (a line: its keys, then enter), the
// screen is printed. ./sim.sh builds and runs it
#include <stdio.h>
#include <string.h>

#include "drivers.h"
#include "host.h"
#include "shell.h"

void show(const op_value *screen) {
	const op_value *lines = op_get(screen, "lines"), *prompt = op_get(screen, "prompt");
	printf("+------------------------------+\n|%-30s|\n", "ermine");
	for (size_t i = 0; lines && i < lines->count; i++) printf("|%-30.30s|\n", lines->items[i]->str);
	printf("|> %-28.28s|\n+------------------------------+\n", prompt ? prompt->str : "");
}

int main(void) {
	host_init();
	api *keys = host_start("keyboard", keyboard);
	host_start("shell", shell);
	host_start("display", display);
	char line[256];
	while (fgets(line, sizeof line, stdin)) {
		for (char *c = line; *c && *c != '\n'; c++) {
			char key[2] = {*c, 0};
			keyboard_press(keys, key);
			host_settle();
		}
		keyboard_press(keys, "enter");
		host_settle();
	}
	return 0;
}
