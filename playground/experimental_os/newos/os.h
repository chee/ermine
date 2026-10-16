// os.h: ermineOS's OS, as the metal sees it (../ERMINEOS.md, Bridge), and the
// metal's bridging header (build.sh). The metal and the OS are one binary; the
// metal's records and the OS's commands keep METAL.md's shapes, as JSON text,
// through these functions.

#ifndef ERMOS_OS_H
#define ERMOS_OS_H

#include <stdbool.h>
#include <stdint.h>

typedef struct ErmosConfig {
	const char *dt;                  // the device tree, METAL.md's JSON
	uint32_t *buffers[2];            // the frame buffers, rows of maxw
	uint32_t **planes;               // the page planes, rows of maxw
	int nplanes;
	const char *sd;                  // the SD card's folder
	const char *image;               // the image's folder: programs' sources, read at boot
	const char *runner;              // deno's runner script, for loaders/deno-js
	bool fresh, bare, service;
	void (*command)(void *data, const char *json); // a METAL.md command, called from the OS's thread
	void *data;
} ErmosConfig;

/** boots the OS and runs it on a thread of its own; config is copied */
void ermosStart(const ErmosConfig *config);
/** a METAL.md record, {"irq": n, "at": µs, ...}, from any thread */
void ermosPost(const char *json);
/** powers off: the OS writes the SD card, its thread ends, then this returns */
void ermosStop(void);

#endif
