// drv_basic.c: the small drivers, as image/drivers/*.js were: kbd, pointer,
// power, clip, uart and hotplug (cpu, usb, net, volumes); and stack, the scheduler's replace. Each
// claims its irq lines, keeps its device's nodes in its ".", /dev/<device>, and hands records on or
// makes commands.

#include "drivers.h"
#include "drv.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static Json *first(const ErmGiven *g) {
	return g->args && g->args->array.count ? g->args->array.items[0] : NULL;
}

static const char *event(const Json *r) {
	const char *e = jsonText(jsonGet(r, "event"));
	return e ? e : "";
}

static int64_t whole(const Json *v, int64_t otherwise) {
	int64_t n;
	return jsonIsWhole(v, &n) ? n : otherwise;
}

// --- kbd (irq 34): each turn's keys, and what input methods make, to whoever claimed them in "to"

static ErmErr kbdIrq(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	*out = NULL;
	Json *recs = first(g), *all = jsonArray(), *last = NULL;
	int keys = 0;
	for (int i = 0; recs && i < recs->array.count; i++) {
		Json *r = recs->array.items[i];
		const char *e = event(r);
		if (strcmp(e, "key") && strcmp(e, "compose") && strcmp(e, "commit")) continue;
		jsonPush(all, jsonRef(r));
		if (!strcmp(e, "key")) last = r, keys++;
	}
	if (!all->array.count) return ermOk();
	Json *to = drvRead(g->api, drvPath("/", "dev", "kbd", "to", NULL));
	if (jsonIsArray(to)) {
		Json *args = jsonArray();
		jsonPush(args, all);
		drvOp(g->api, "call", drvMap("address", to, "args", args, NULL));
	}
	if (last) {
		Json *old = drvRead(g->api, drvPath("/", "dev", "kbd", "state", NULL));
		drvSnap(g->api, drvPath("/", "dev", "kbd", "state", NULL),
		        drvMap("mods", jsonShallow(jsonGet(last, "mods")), "last", drvMap("key", jsonShallow(jsonGet(last, "key")), "down", jsonShallow(jsonGet(last, "down")), NULL),
		               "keys", jsonInteger(whole(jsonGet(old, "keys"), 0) + keys), NULL));
	}
	return ermOk();
}

ErmErr driverKbd(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	*out = jsonNull();
	Json *here = drvHere(g);
	drvMake(g->api, drvPath("/", "dev", "kbd", NULL), "state", "kbd/state", drvMap("mods", jsonArray(), "last", jsonNull(), "keys", jsonInteger(0), NULL));
	drvMake(g->api, drvPath("/", "dev", "kbd", NULL), "to", "kbd/to", jsonNull());
	drvHandler(g, here, "irq", (ErmFn){ kbdIrq, NULL });
	drvClaim(g, here, 34);
	return ermOk();
}

// --- pointer (irq 35): the cursor plane, and each turn's events to whoever claimed them in "to".
// /dev/pointer/plane is the plane's picture, as a graphics card's cursor registers hold one:
// {w, h, hot: [x, y], pixels}, pixels w × h uint32 0xAARRGGBB, frame buffer pixels; this gives it
// to the metal, which moves the plane with the pointer itself. What it shows is a process's:
// programs/cursor draws /dev/pointer/cursor (what is wanted) there.

typedef struct Pointer {
	Host *host;
} Pointer;

static ErmErr cursorCompute(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	Json *v = drvRead(g->api, drvPath("/", "dev", "pointer", "plane", NULL));
	*out = v ? jsonShallow(v) : jsonNull();
	return ermOk();
}

/** a new picture on the plane: to the metal */
static ErmErr cursorEffect(void *data, const ErmGiven *g, Json **out) {
	Pointer *p = data;
	*out = jsonNull();
	int64_t w = whole(jsonGet(g->value, "w"), 0), h = whole(jsonGet(g->value, "h"), 0), hx = 0, hy = 0;
	Json *hot = jsonGet(g->value, "hot"), *px = jsonGet(g->value, "pixels");
	if (jsonIsArray(hot) && hot->array.count == 2) jsonIsWhole(hot->array.items[0], &hx), jsonIsWhole(hot->array.items[1], &hy);
	if (w < 1 || h < 1 || w > 512 || h > 512 || !px || px->type != JSON_TYPED || (px->typed.kind != JSON_UINT32 && px->typed.kind != JSON_INT32) ||
	    px->typed.count < (size_t)(w * h))
		return ermOk();
	char *b64 = drvBase64((const uint8_t *)px->typed.data, (size_t)(w * h) * 4);
	Json *shape = drvMap("w", jsonInteger(w), "h", jsonInteger(h), "hotx", jsonInteger(hx), "hoty", jsonInteger(hy), "pixels", jsonString(b64), NULL);
	free(b64);
	hostCommand(p->host, drvMap("op", jsonString("cursor"), "visible", jsonBoolean(true), "shape", shape, NULL));
	return ermOk();
}

static ErmErr pointerIrq(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	*out = NULL;
	Json *recs = first(g);
	if (!recs || !recs->array.count) return ermOk();
	Json *last = recs->array.items[recs->array.count - 1];
	Json *at = drvRead(g->api, drvPath("/", "dev", "pointer", "at", NULL));
	bool inside = jsonGet(at, "inside") ? jsonGet(at, "inside")->type == JSON_BOOLEAN && jsonGet(at, "inside")->boolean : true;
	for (int i = 0; i < recs->array.count; i++) {
		const char *e = event(recs->array.items[i]);
		if (!strcmp(e, "enter")) inside = true;
		if (!strcmp(e, "exit")) inside = false;
	}
	Json *to = drvRead(g->api, drvPath("/", "dev", "pointer", "to", NULL));
	if (jsonIsArray(to)) {
		Json *args = jsonArray();
		jsonPush(args, jsonRef(recs));
		drvOp(g->api, "call", drvMap("address", to, "args", args, NULL));
	}
	drvSnap(g->api, drvPath("/", "dev", "pointer", "at", NULL),
	        drvMap("x", jsonShallow(jsonGet(last, "x")), "y", jsonShallow(jsonGet(last, "y")),
	               "buttons", jsonGet(last, "buttons") ? jsonShallow(jsonGet(last, "buttons")) : jsonArray(), "inside", jsonBoolean(inside), NULL));
	return ermOk();
}

ErmErr driverPointer(void *data, const ErmGiven *g, Json **out) {
	*out = jsonNull();
	Pointer *p = calloc(1, sizeof *p);
	p->host = data;
	Json *here = drvHere(g);
	drvMake(g->api, drvPath("/", "dev", "pointer", NULL), "at", "pointer/at", drvMap("x", jsonInteger(0), "y", jsonInteger(0), "buttons", jsonArray(), "inside", jsonBoolean(false), NULL));
	drvMake(g->api, drvPath("/", "dev", "pointer", NULL), "to", "pointer/to", jsonNull());
	drvMake(g->api, drvPath("/", "dev", "pointer", NULL), "cursor", "pointer/cursor", jsonNull());
	drvMake(g->api, drvPath("/", "dev", "pointer", NULL), "plane", "pointer/plane", jsonNull());
	drvHandler(g, here, "irq", (ErmFn){ pointerIrq, p });
	drvClaim(g, here, 35);
	drvChild(g, here, "cursor", (ErmFn){ cursorCompute, NULL }, (ErmFn){ cursorEffect, p });
	return ermOk();
}

// --- power (irqs 40, 41, 42): the battery, the thermal state, sleep and the lock; and the switch

static ErmErr powerIrq(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	*out = NULL;
	Json *recs = first(g);
	for (int i = 0; recs && i < recs->array.count; i++) {
		Json *r = recs->array.items[i];
		int64_t irq = whole(jsonGet(r, "irq"), 0);
		if (irq == 40)
			drvSnap(g->api, drvPath("/", "dev", "power", "battery", NULL),
			        drvMap("ac", jsonShallow(jsonGet(r, "ac")), "battery", jsonShallow(jsonGet(r, "battery")), "percent", jsonShallow(jsonGet(r, "percent")),
			               "charging", jsonShallow(jsonGet(r, "charging")), "minutes", jsonGet(r, "minutes") ? jsonShallow(jsonGet(r, "minutes")) : jsonNull(), NULL));
		else if (irq == 41)
			drvSnap(g->api, drvPath("/", "dev", "power", "thermal", NULL), drvMap("state", jsonShallow(jsonGet(r, "state")), "lowPower", jsonShallow(jsonGet(r, "lowPower")), NULL));
		else if (irq == 42) {
			Json *s = jsonShallow(drvRead(g->api, drvPath("/", "dev", "power", "state", NULL)));
			const char *e = event(r);
			if (!strcmp(e, "sleep")) jsonSet(s, "awake", 5, jsonBoolean(false));
			if (!strcmp(e, "wake")) jsonSet(s, "awake", 5, jsonBoolean(true));
			if (!strcmp(e, "screensleep")) jsonSet(s, "screen", 6, jsonBoolean(false));
			if (!strcmp(e, "screenwake")) jsonSet(s, "screen", 6, jsonBoolean(true));
			if (!strcmp(e, "lock")) jsonSet(s, "locked", 6, jsonBoolean(true));
			if (!strcmp(e, "unlock")) jsonSet(s, "locked", 6, jsonBoolean(false));
			drvSnap(g->api, drvPath("/", "dev", "power", "state", NULL), s);
		}
	}
	return ermOk();
}

static ErmErr switchCompute(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	Json *off = jsonGet(drvRead(g->api, drvPath("/", "dev", "power", "switch", NULL)), "off");
	*out = jsonBoolean(off && off->type == JSON_BOOLEAN && off->boolean);
	return ermOk();
}

static ErmErr switchEffect(void *data, const ErmGiven *g, Json **out) {
	*out = jsonNull();
	if (g->value && g->value->type == JSON_BOOLEAN && g->value->boolean) hostCommand(data, drvMap("op", jsonString("quit"), NULL));
	return ermOk();
}

ErmErr driverPower(void *data, const ErmGiven *g, Json **out) {
	*out = jsonNull();
	Json *here = drvHere(g);
	drvMake(g->api, drvPath("/", "dev", "power", NULL), "battery", "power/battery", jsonNull());
	drvMake(g->api, drvPath("/", "dev", "power", NULL), "thermal", "power/thermal", jsonNull());
	drvMake(g->api, drvPath("/", "dev", "power", NULL), "state", "power/state", drvMap("awake", jsonBoolean(true), "locked", jsonBoolean(false), "screen", jsonBoolean(true), NULL));
	drvMake(g->api, drvPath("/", "dev", "power", NULL), "switch", "power/switch", drvMap("off", jsonBoolean(false), NULL));
	drvHandler(g, here, "irq", (ErmFn){ powerIrq, NULL });
	drvClaim(g, here, 40);
	drvClaim(g, here, 41);
	drvClaim(g, here, 42);
	drvChild(g, here, "switch", (ErmFn){ switchCompute, NULL }, (ErmFn){ switchEffect, data });
	return ermOk();
}

// --- clip (irq 46): the Mac's pasteboard in /dev/clip/text; a program copies by writing {"text"} there

static ErmErr clipIrq(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	*out = NULL;
	Json *recs = first(g);
	if (!recs || !recs->array.count) return ermOk();
	Json *r = recs->array.items[recs->array.count - 1];
	drvSnap(g->api, drvPath("/", "dev", "clip", "text", NULL),
	        drvMap("text", jsonGet(r, "text") ? jsonShallow(jsonGet(r, "text")) : jsonNull(), "count", jsonShallow(jsonGet(r, "count")), "from", jsonString("mac"), NULL));
	return ermOk();
}

static ErmErr copyCompute(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	Json *v = drvRead(g->api, drvPath("/", "dev", "clip", "text", NULL));
	const char *from = jsonText(jsonGet(v, "from"));
	// what came from the Mac's clipboard is not sent back to it; anything else written here is
	*out = v && !(from && !strcmp(from, "mac")) && jsonIsString(jsonGet(v, "text")) ? jsonShallow(jsonGet(v, "text")) : jsonNull();
	return ermOk();
}

static ErmErr copyEffect(void *data, const ErmGiven *g, Json **out) {
	*out = jsonNull();
	if (jsonIsString(g->value)) hostCommand(data, drvMap("op", jsonString("clipboard"), "text", jsonShallow(g->value), NULL));
	return ermOk();
}

ErmErr driverClip(void *data, const ErmGiven *g, Json **out) {
	*out = jsonNull();
	Json *here = drvHere(g);
	drvMake(g->api, drvPath("/", "dev", "clip", NULL), "text", "clip/text", drvMap("text", jsonNull(), "count", jsonInteger(0), "from", jsonString("mac"), NULL));
	drvHandler(g, here, "irq", (ErmFn){ clipIrq, NULL });
	drvClaim(g, here, 46);
	drvChild(g, here, "copy", (ErmFn){ copyCompute, NULL }, (ErmFn){ copyEffect, data });
	return ermOk();
}

// --- uart (irq 36): the serial line; rx what came, tx what to send, as bytes

#define KEEP 4096

static Json *bytesOf(const Json *v) {
	return v && v->type == JSON_BYTES ? (Json *)v : NULL;
}

static ErmErr uartIrq(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	*out = NULL;
	Json *recs = first(g);
	Json *old = bytesOf(drvRead(g->api, drvPath("/", "dev", "uart0", "rx", NULL)));
	size_t had = old ? old->bytes.length : 0, n = 0;
	uint8_t *all = malloc(had + 1);
	if (had) memcpy(all, old->bytes.data, had);
	for (int i = 0; recs && i < recs->array.count; i++) {
		const char *rx = jsonText(jsonGet(recs->array.items[i], "rx"));
		if (!rx) continue;
		size_t m;
		uint8_t *part = drvUnbase64(rx, &m);
		all = realloc(all, had + n + m + 1);
		memcpy(all + had + n, part, m);
		n += m;
		free(part);
	}
	if (n) {
		size_t total = had + n, from = total > KEEP ? total - KEEP : 0;
		drvSnap(g->api, drvPath("/", "dev", "uart0", "rx", NULL), jsonBytes(all + from, total - from));
		Json *stats = drvRead(g->api, drvPath("/", "dev", "uart0", "stats", NULL));
		drvSet(g->api, drvPath("/", "dev", "uart0", "stats", NULL), "rx", jsonInteger(whole(jsonGet(stats, "rx"), 0) + (int64_t)n));
	}
	free(all);
	return ermOk();
}

static ErmErr sendCompute(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	Json *tx = bytesOf(drvRead(g->api, drvPath("/", "dev", "uart0", "tx", NULL)));
	*out = tx ? tx : jsonBytes("", 0);
	return ermOk();
}

static ErmErr sendEffect(void *data, const ErmGiven *g, Json **out) {
	*out = jsonNull();
	Json *tx = bytesOf(g->value);
	if (!tx || !tx->bytes.length) return ermOk();
	char *b64 = drvBase64(tx->bytes.data, tx->bytes.length);
	hostCommand(data, drvMap("op", jsonString("tx"), "bytes", jsonString(b64), NULL));
	free(b64);
	Json *stats = drvRead(g->api, drvPath("/", "dev", "uart0", "stats", NULL));
	drvSnap(g->api, drvPath("/", "dev", "uart0", "tx", NULL), jsonBytes("", 0));
	drvSet(g->api, drvPath("/", "dev", "uart0", "stats", NULL), "tx", jsonInteger(whole(jsonGet(stats, "tx"), 0) + (int64_t)tx->bytes.length));
	return ermOk();
}

ErmErr driverUart(void *data, const ErmGiven *g, Json **out) {
	*out = jsonNull();
	Json *here = drvHere(g);
	drvMake(g->api, drvPath("/", "dev", "uart0", NULL), "rx", "uart0/rx", jsonBytes("", 0));
	drvMake(g->api, drvPath("/", "dev", "uart0", NULL), "tx", "uart0/tx", jsonBytes("", 0));
	drvMake(g->api, drvPath("/", "dev", "uart0", NULL), "stats", "uart0/stats", drvMap("rx", jsonInteger(0), "tx", jsonInteger(0), NULL));
	drvHandler(g, here, "irq", (ErmFn){ uartIrq, NULL });
	drvClaim(g, here, 36);
	drvChild(g, here, "send", (ErmFn){ sendCompute, NULL }, (ErmFn){ sendEffect, data });
	return ermOk();
}

// --- hotplug (irqs 43 cpu, 44 usb, 45 net, 48 volumes; mac/METAL.md): what the metal says of the
// machine, as nodes. /dev/cpu {load, memory}, as the metal posts it (once a second); /dev/usb/<id>, a
// device present, the attach record's fields, gone at detach; /dev/net {status, up, interfaces,
// expensive, constrained} and /dev/net/<interface> {name, type}, those gone taken out;
// /dev/volumes/<name> {path, name}, a volume mounted, gone at unmount

/** the record's fields, but its line and time */
static Json *fields(const Json *r) {
	Json *m = jsonObject();
	for (int i = 0; jsonIsObject(r) && i < r->object.count; i++) {
		const char *k = r->object.members[i].key;
		if (strcmp(k, "irq") && strcmp(k, "at")) jsonAdd(m, k, jsonShallow(r->object.members[i].value));
	}
	return m;
}

/** parent/name holding value: written, or placed (ephemeral, its id kind/name) */
static void present(const ErmPartApi *api, Json *parent, const char *kind, const char *name, Json *value) {
	Json *at = drvUnder(parent, name, NULL);
	if (drvHas(api, at)) drvSnap(api, at, value);
	else {
		char *id = formatString("%s/%s", kind, name);
		drvPlace(api, parent, name, id, value);
		free(id);
	}
}

/** parent/name unplaced, if it is there */
static void absent(const ErmPartApi *api, Json *parent, const char *name) {
	if (drvHas(api, drvUnder(parent, name, NULL))) drvOp(api, "unplace", drvMap("address", parent, "name", jsonString(name), NULL));
}

static ErmErr hotplugIrq(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	*out = NULL;
	Json *recs = first(g);
	for (int i = 0; recs && i < recs->array.count; i++) {
		Json *r = recs->array.items[i];
		int64_t irq = whole(jsonGet(r, "irq"), 0);
		const char *e = event(r);
		if (irq == 43) drvSnap(g->api, drvPath("/", "dev", "cpu", NULL), fields(r));
		else if (irq == 44) {
			const char *id = jsonText(jsonGet(r, "id"));
			if (!id || !*id) continue;
			Json *usb = drvPath("/", "dev", "usb", NULL);
			if (!strcmp(e, "attach")) present(g->api, usb, "usb", id, fields(r));
			else if (!strcmp(e, "detach")) absent(g->api, usb, id);
		} else if (irq == 45) {
			Json *net = drvPath("/", "dev", "net", NULL), *v = fields(r), *list = jsonGet(r, "interfaces");
			const char *status = jsonText(jsonGet(r, "status"));
			jsonAdd(v, "up", jsonBoolean(status && !strcmp(status, "satisfied")));
			Json *had = drvNames(g->api, net);
			drvSnap(g->api, net, v);
			for (int k = 0; jsonIsArray(list) && k < list->array.count; k++) {
				const char *name = jsonText(jsonGet(list->array.items[k], "name"));
				if (name && *name) present(g->api, net, "net", name, jsonShallow(list->array.items[k]));
			}
			for (int k = 0; k < had->array.count; k++) {
				const char *name = jsonText(had->array.items[k]);
				bool still = false;
				for (int j = 0; jsonIsArray(list) && j < list->array.count && !still; j++) {
					const char *n = jsonText(jsonGet(list->array.items[j], "name"));
					still = n && !strcmp(n, name);
				}
				if (!still) absent(g->api, net, name);
			}
		} else if (irq == 48) {
			const char *name = jsonText(jsonGet(r, "name")), *path = jsonText(jsonGet(r, "path"));
			if (!name || !*name) name = path && strrchr(path, '/') ? strrchr(path, '/') + 1 : path;
			if (!name || !*name) continue;
			Json *volumes = drvPath("/", "dev", "volumes", NULL);
			if (!strcmp(e, "mount")) present(g->api, volumes, "volumes", name, fields(r));
			else if (!strcmp(e, "unmount")) absent(g->api, volumes, name);
		}
	}
	return ermOk();
}

ErmErr driverHotplug(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	*out = jsonNull();
	Json *here = drvHere(g), *dev = drvPath("/", "dev", NULL);
	drvMake(g->api, dev, "cpu", "dev/cpu", drvMap("load", jsonArray(), "memory", jsonNull(), NULL));
	drvMake(g->api, dev, "usb", "dev/usb", jsonNull());
	drvMake(g->api, dev, "net", "dev/net", drvMap("status", jsonNull(), "up", jsonBoolean(false), "interfaces", jsonArray(), NULL));
	drvMake(g->api, dev, "volumes", "dev/volumes", jsonNull());
	drvHandler(g, here, "irq", (ErmFn){ hotplugIrq, NULL });
	drvClaim(g, here, 43);
	drvClaim(g, here, 44);
	drvClaim(g, here, 45);
	drvClaim(g, here, 48);
	return ermOk();
}

// --- stack: replace as a handler, on/replace (address): the process whose node it reaches is stopped
// and started again at its path, so it takes its program's code as its node holds it now (hostRestart)

static ErmErr stackReplace(void *data, const ErmGiven *g, Json **out) {
	Json *at = first(g);
	*out = jsonNull();
	size_t n;
	const char *const *address = jsonIsArray(at) ? hostPathOf(data, at, &n) : NULL;
	if (!address) return ermDetail(ermInvalid("bad"), "text", jsonString("replace takes a process's node"));
	const ap_error *e = hostRestart(data, address, n);
	return e ? ermDetail(ermInvalid(e->code ? e->code : "thrown"), "text", jsonString(e->message ? e->message : "")) : ermOk();
}

ErmErr driverStack(void *data, const ErmGiven *g, Json **out) {
	*out = jsonNull();
	drvHandler(g, drvHere(g), "replace", (ErmFn){ stackReplace, data });
	return ermOk();
}
