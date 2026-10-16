// drivers.c: the drivers built into ermineOS, by name, and their runner
// (drivers.h). A driver not built in is a weak one here whose setup fails
// "not built in", until its drv_*.c takes its place.

#include "drivers.h"
#include "drv.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef ErmErr Setup(void *data, const ErmGiven *g, Json **out);

Setup driverKbd, driverPointer, driverPower, driverClip, driverUart, driverStack;

static ErmErr notYet(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	(void)g;
	*out = NULL;
	return ermDetail(ermInvalid("not-a-program"), "text", jsonString("this driver is not built in"));
}
__attribute__((weak)) ErmErr driverDisplay(void *data, const ErmGiven *g, Json **out) { return notYet(data, g, out); }
__attribute__((weak)) ErmErr driverFont(void *data, const ErmGiven *g, Json **out) { return notYet(data, g, out); }
__attribute__((weak)) ErmErr driverVram(void *data, const ErmGiven *g, Json **out) { return notYet(data, g, out); }
__attribute__((weak)) ErmErr driverPty(void *data, const ErmGiven *g, Json **out) { return notYet(data, g, out); }
__attribute__((weak)) ErmErr driverSock(void *data, const ErmGiven *g, Json **out) { return notYet(data, g, out); }
__attribute__((weak)) ErmErr driverMac(void *data, const ErmGiven *g, Json **out) { return notYet(data, g, out); }
__attribute__((weak)) ErmErr driverWeb(void *data, const ErmGiven *g, Json **out) { return notYet(data, g, out); }
__attribute__((weak)) ErmErr driverWayland(void *data, const ErmGiven *g, Json **out) { return notYet(data, g, out); }
__attribute__((weak)) ErmErr driverVnc(void *data, const ErmGiven *g, Json **out) { return notYet(data, g, out); }
__attribute__((weak)) ErmErr driverLink(void *data, const ErmGiven *g, Json **out) { return notYet(data, g, out); }
__attribute__((weak)) ErmErr driverSync(void *data, const ErmGiven *g, Json **out) { return notYet(data, g, out); }

// what hostOff and the runner call, until their drivers are here
__attribute__((weak)) uint32_t *vramHold(int64_t id, size_t *bytes, void **ref) { (void)id, (void)bytes, (void)ref; return NULL; }
__attribute__((weak)) void vramDrop(void *ref) { (void)ref; }
__attribute__((weak)) void vramStop(void) {}
__attribute__((weak)) void vncStop(void) {}
__attribute__((weak)) void sockStop(void) {}

ap_fn *driverSetup(Host *host, const char *name) {
	static const struct {
		const char *name;
		Setup *setup;
	} table[] = {
		{ "kbd", driverKbd }, { "pointer", driverPointer }, { "power", driverPower },
		{ "clip", driverClip }, { "uart", driverUart }, { "stack", driverStack },
		{ "display", driverDisplay }, { "font", driverFont }, { "vram", driverVram },
		{ "pty", driverPty }, { "sock", driverSock }, { "mac", driverMac }, { "web", driverWeb },
		{ "wayland", driverWayland }, { "vnc", driverVnc }, { "link", driverLink }, { "sync", driverSync },
	};
	for (size_t i = 0; i < sizeof table / sizeof *table; i++)
		if (strcmp(table[i].name, name) == 0) return drvFn((ErmFn){ table[i].setup, host });
	return NULL;
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
