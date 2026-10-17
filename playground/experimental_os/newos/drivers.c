// drivers.c: the drivers built into ermineOS, by name, and their runner
// (drivers.h): one table, a name to its setup (drv_*.c's driver<Name>) and,
// where it has one, its stop (hostOff).

#include "drivers.h"
#include "drv.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef ErmErr Setup(void *data, const ErmGiven *g, Json **out);
typedef void Stop(void);

Setup driverKbd, driverPointer, driverPower, driverClip, driverUart, driverStack, driverHotplug, driverDisplay, driverFont, driverVram, driverPty,
	driverSock, driverMac, driverWeb, driverWayland, driverVnc, driverLink, driverSync;
Stop vramStop, sockStop, vncStop;

static const struct {
	const char *name;
	Setup *setup;
	Stop *stop;
} DRIVERS[] = {
	{ "kbd", driverKbd, NULL },         { "pointer", driverPointer, NULL }, { "power", driverPower, NULL },     { "clip", driverClip, NULL },
	{ "uart", driverUart, NULL },       { "stack", driverStack, NULL },     { "hotplug", driverHotplug, NULL }, { "display", driverDisplay, NULL },
	{ "font", driverFont, NULL },       { "vram", driverVram, vramStop },   { "pty", driverPty, NULL },         { "sock", driverSock, sockStop },
	{ "mac", driverMac, NULL },         { "web", driverWeb, NULL },         { "wayland", driverWayland, NULL }, { "vnc", driverVnc, vncStop },
	{ "link", driverLink, NULL },       { "sync", driverSync, NULL },
};

ap_fn *driverSetup(Host *host, const char *name) {
	for (size_t i = 0; i < sizeof DRIVERS / sizeof *DRIVERS; i++)
		if (strcmp(DRIVERS[i].name, name) == 0) return drvFn((ErmFn){ DRIVERS[i].setup, host });
	return NULL;
}

void driversStop(void) {
	for (size_t i = 0; i < sizeof DRIVERS / sizeof *DRIVERS; i++)
		if (DRIVERS[i].stop) DRIVERS[i].stop();
}

hf_run driverRun(const op_value *code, void *api, void *data) {
	Host *h = data;
	const op_value *name = code && code->type == OP_MAP ? op_get(code, "name") : NULL;
	ap_fn *setup = name && name->type == OP_STR ? driverSetup(h, name->str) : NULL;
	if (!setup) return (hf_run){ .error = strdup("not-a-program: a driver's value is {name}, a driver built in") };
	const ap_error *e = ap_run_setup(api, setup);
	if (!e) return (hf_run){ 0 };
	char text[512];
	snprintf(text, sizeof text, "%s%s%s", e->code ? e->code : "thrown", e->message ? ": " : "", e->message ? e->message : "");
	return (hf_run){ .error = strdup(text) };
}
