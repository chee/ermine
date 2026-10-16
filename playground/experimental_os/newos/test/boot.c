// boot.c: ermineOS booted with no metal: a device tree, the
// image, a few turns, then power off. Says what the metal is told.

#include "../os.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void command(void *data, const char *json) {
	(void)data;
	printf("[metal] %s\n", json);
	fflush(stdout);
}

int main(int argc, char **argv) {
	static uint32_t fb[2][64 * 48];
	const char *image = argc > 1 ? argv[1] : "playground/experimental_os/newos/test/image";
	const char *dt =
	    "{\"user\": \"chee\", \"fb\": {\"w\": 64, \"h\": 48, \"maxw\": 64, \"maxh\": 48, \"unit\": 1},"
	    " \"devices\": [{\"name\": \"display\", \"irq\": 33}, {\"name\": \"keyboard\", \"irq\": 34}, {\"name\": \"pointer\", \"irq\": 35}],"
	    " \"font\": {\"alpha\": \"AAEC\"}}";
	ErmosConfig config = { .sd = getenv("CARD") ? getenv("CARD") : "/tmp/ermineOS-card", .dt = dt, .buffers = { fb[0], fb[1] }, .image = image, .runner = "playground/experimental_os/newos/js/runner.js", .command = command };
	ermosStart(&config);
	sleep(2);
	ermosPost("{\"irq\": 34, \"event\": \"key\", \"key\": \"a\", \"down\": true, \"mods\": [\"shift\"]}");
	ermosPost("{\"irq\": 35, \"event\": \"move\", \"x\": 10, \"y\": 20, \"buttons\": []}");
	sleep(1);
	ermosPost("{\"irq\": 1, \"why\": \"test\"}");
	sleep(1);
	ermosStop();
	return 0;
}
