// host.c: ermineOS's host (host.h; ../ERMINEOS.md). Core 0's own work: the
// card (peer.c: the device and Subduction's store), the stack, /hw from the
// device tree, what boots, the drain, which hands each turn's records to the
// driver that claimed their line, the clock, and the commands to the metal.
//
// The stack: the bare graph, the library over it, sync's keeper over that, protect over that, the
// sync wrapper over protect, the scheduler over the wrapper:
// schedule(sync(protect(keeper(library(graph))))). So every operation a program
// makes, and the host's, passes through the wrapper, which commits what is
// made on a document (SYNC.tex, Sync is a process and a wrapper), while the
// scheduler's bookkeeping and what arrives go through the keeper, beneath it
// (SCHEDULER.tex, Open, The top of the stack: here the wrappers go beneath
// the scheduler). Host code acts through the scheduler's interface with an
// agent whose code is empty, its changes carrying a site (SCHEDULER.tex,
// What a process acts as). What it keeps for itself, /hw, is placed
// beneath, on the keeper: ephemeral, made again each boot, and never the
// scheduler's business.

#include "host.h"

#include "jsload.h"
#include "exec.h"
#include "drivers.h"
#include "drv.h"
#include "peer.h"

#include "../../core/graph/c/entry.h"
#include "../../core/graph/c/library.h"
#include "../../core/protect/c/protect.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>

/** a line waiting for its driver: its records, oldest first */
typedef struct Held {
	int irq;
	ERM_LIST(Json *) records;
} Held;

struct Host {
	ErmosConfig config;
	Json *dt;
	ErmInterface graph, kept, protect, wrapped, top;
	ErmSchedule *schedule;
	ErmSync *sync;
	Json *machine, *person, *personAgent, *site;
	char *user;
	ErmTime base, last;
	int64_t started;    // µs, CLOCK_MONOTONIC, at boot
	int64_t wake;       // the earliest turn a driver asked for; 0: none
	int64_t second;     // the clock's last second written
	bool running;
	ERM_LIST(Held) held;
	Json *rules;        // /etc/rules as last read
	ErmRules may;
};

// --- small things

static Json *keyed(const char *key, Json *value) {
	Json *m = jsonObject();
	jsonAdd(m, key, value);
	return m;
}

static Json *names(const char *first, ...) {
	Json *a = jsonArray();
	va_list ap;
	va_start(ap, first);
	for (const char *n = first; n; n = va_arg(ap, const char *)) jsonPush(a, jsonString(n));
	va_end(ap);
	return a;
}

static Json *parse(const char *text) {
	char *why = NULL;
	return jsonParse(text, strlen(text), &why);
}

static int64_t monotonic(void) {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (int64_t)ts.tv_sec * 1000000 + ts.tv_nsec / 1000;
}

const ErmosConfig *hostConfig(Host *h) {
	return &h->config;
}

Json *hostTree(Host *h) {
	return h->dt;
}

void hostCommand(Host *h, const Json *command) {
	char *text = jsonPrint(command);
	h->config.command(h->config.data, text);
	free(text);
}

int64_t hostNow(Host *h) {
	return monotonic() - h->started;
}

void hostWake(Host *h, int64_t at) {
	if (!h->wake || at < h->wake) h->wake = at;
}

void hostSay(Host *h, const char *format, ...) {
	(void)h;
	va_list ap;
	va_start(ap, format);
	fprintf(stderr, "[os] ");
	vfprintf(stderr, format, ap);
	fputc('\n', stderr);
	va_end(ap);
}

/** the clock (SCHEDULER The reference scheduler): µs since boot, after the card's highest time, always greater than the last */
static ErmTime next(void *data) {
	Host *h = data;
	ErmTime t = h->base + (ErmTime)hostNow(h);
	if (t <= h->last) t = h->last + 1;
	h->last = t;
	return t;
}

// --- operations

static ErmOpKind kindOf(const char *name) {
	ErmOpKind kind = 0;
	while (kind < ERM_OPS && strcmp(ermOpName(kind), name) != 0) kind++;
	return kind;
}

/** what an operation's ok holds, as a part's interface answers it */
static Json *okOf(const ErmOp *op, const ErmResult *r) {
	if (ermOpIsChange(op->kind)) return ermChangeAnswer(r);
	if (op->kind == ERM_OP_CWD) {
		Json *cwd = jsonArray();
		for (int i = 0; i < r->cwd.count; i++) jsonPush(cwd, jsonString(r->cwd.items[i]));
		return keyed("cwd", cwd);
	}
	if (op->kind == ERM_OP_DIRECTORY && !op->name) {
		Json *listed = keyed("directory", ermListingToJson(&r->listing));
		jsonAdd(listed, "apart", ermItemsToJson(&r->apart));
		return listed;
	}
	if (op->kind == ERM_OP_SUBSCRIBE) return keyed("sub", jsonInteger(r->sub));
	if (op->kind == ERM_OP_TAKE) return keyed("events", ermEventsToJson(&r->events));
	return keyed("items", ermItemsToJson(&r->items));
}

/** an operation through iface, with fields as a request's, as agent; changes carry the host's site */
static ErmErr operate(Host *h, ErmInterface iface, Json *agent, const char *name, Json *fields, Json **out) {
	*out = NULL;
	ErmOpKind kind = kindOf(name);
	if (kind == ERM_OPS) return ermDetail(ermInvalid("unsupported"), "op", jsonString(name));
	if (ermOpIsChange(kind) && !jsonGet(fields, "site")) jsonAdd(fields, "site", jsonShallow(h->site));
	// a place with a value and no id is a making: the sync wrapper gets its id from the folder's lock (SYNC.tex, Making and mounting)
	bool making = kind == ERM_OP_PLACE && !jsonGet(fields, "id") && jsonGet(fields, "value");
	if (making) jsonAdd(fields, "id", jsonString(""));
	ErmRequest request = { fields, false, ermOk() };
	ErmOp op;
	ErmStamp stamp;
	ermRequestOp(&request, kind, false, false, &op, &stamp);
	if (request.err.kind) return request.err;
	if (making) op.id = NULL;
	if (op.kind == ERM_OP_TAKE || op.kind == ERM_OP_UNSUBSCRIBE) ermRequestWhole(&request, "sub", true, 1, &op.sub);
	if (request.err.kind) return request.err;
	ErmCtx ctx = { .agent = agent };
	ErmResult r = { 0 };
	ErmErr err = iface.vt->op(iface.self, &ctx, &stamp, &op, &r);
	if (!err.kind) *out = okOf(&op, &r);
	return err;
}

ErmErr hostDo(Host *h, Json *agent, const char *name, Json *fields, Json **out) {
	*out = NULL;
	if (!agent) agent = h->machine;
	ErmRequest request = { fields, false, ermOk() };
	ErmCtx ctx = { .agent = agent };
	ErmErr err;
	ermScheduleBegin(h->schedule);
	if (strcmp(name, "start") == 0) {
		ErmAddress address = ermRequestAddress(&request, "address");
		Json *program = ermRequestField(&request, "program", true);
		const char *pname = ermRequestText(&request, "name", false, true);
		const char *id = ermRequestText(&request, "id", false, false);
		ErmStamp stamp = { .site = h->site };
		ErmResult r = { 0 };
		// through the wrapper, which follows a document whose id the start gave
		err = request.err.kind ? request.err : ermSyncStart(h->sync, &ctx, &stamp, &address, program, pname, id, &r);
		if (!err.kind) *out = ermChangeAnswer(&r);
	} else if (strcmp(name, "call") == 0) {
		ErmAddress address = ermRequestAddress(&request, "address");
		Json *args = ermRequestField(&request, "args", false);
		err = request.err.kind ? request.err : ermScheduleCall(h->schedule, &ctx, &address, args);
	} else if (strcmp(name, "replace") == 0) {
		ErmAddress address = ermRequestAddress(&request, "address");
		ErmStamp stamp = { .site = h->site };
		ErmResult r = { 0 };
		err = request.err.kind ? request.err : ermScheduleReplace(h->schedule, &ctx, &stamp, &address, &r);
		if (!err.kind) *out = ermChangeAnswer(&r);
	} else {
		err = operate(h, h->top, agent, name, fields, out);
	}
	ErmErr ended = ermScheduleEnd(h->schedule, true);
	return err.kind ? err : ended;
}

/** the id of the node an address reaches, read as the machine on the keeper; NULL when none does */
static const char *nodeId(Host *h, Json *address) {
	ErmRequest request = { keyed("address", address), false, ermOk() };
	ErmOp read = { .kind = ERM_OP_READ, .address = ermRequestAddress(&request, "address") };
	if (request.err.kind) return NULL;
	// the root, which no route leads to
	if (!read.address.names.count && !read.address.ups) return ermSyncRoot(h->sync);
	ErmCtx ctx = { .agent = h->machine };
	ErmResult r = { 0 };
	if (h->kept.vt->op(h->kept.self, &ctx, &(ErmStamp){ 0 }, &read, &r).kind) return NULL;
	for (int i = 0; i < r.items.count; i++) {
		const ErmItem *item = &r.items.items[i];
		if (item->kind == ERM_ITEM_VALUE && item->route.count) return item->route.items[item->route.count - 1].node;
	}
	return NULL;
}

/**
 * an operation beneath protect, the wrapper and the scheduler: the host's own
 * bookkeeping. A change is the scheduler's arrive, at the id of the node the
 * address reaches, so it is made on the keeper and never committed, and the
 * parts that read what it changed run again (SCHEDULER Arrivals)
 */
ErmErr hostBare(Host *h, const char *name, Json *fields, Json **out) {
	*out = NULL;
	ErmOpKind kind = kindOf(name);
	if (ermOpIsChange(kind)) {
		ErmRequest request = { fields, false, ermOk() };
		ErmOp op;
		ErmStamp stamp;
		if (!jsonGet(fields, "site")) jsonAdd(fields, "site", jsonShallow(h->site));
		ermRequestOp(&request, kind, false, false, &op, &stamp);
		if (request.err.kind) return request.err;
		const char *at = nodeId(h, jsonGet(fields, "address"));
		if (!at) return ermInvalid("nothing-there");
		op.address = (ErmAddress){ 0 };
		ErmCtx ctx = { .agent = h->machine, .at = at };
		ErmResult r = { 0 };
		ermScheduleBegin(h->schedule);
		ErmErr err = ermScheduleArrive(h->schedule, NULL, &ctx, &stamp, &op, &r);
		ErmErr ended = ermScheduleEnd(h->schedule, true);
		if (!err.kind) *out = r.change ? okOf(&op, &r) : jsonNull();
		return err.kind ? err : ended;
	}
	return operate(h, h->kept, h->machine, name, fields, out);
}

static ErmErr bare(Host *h, const char *name, Json *fields) {
	Json *out = NULL;
	return hostBare(h, name, fields, &out);
}

static void place(Host *h, Json *at, const char *name, const char *id, Json *value, bool ephemeral) {
	Json *f = jsonObject();
	jsonAdd(f, "address", at);
	jsonAdd(f, "name", jsonString(name));
	jsonAdd(f, "id", jsonString(id));
	jsonAdd(f, "value", value);
	if (ephemeral) jsonAdd(f, "ephemeral", jsonBoolean(true));
	ErmErr err = bare(h, "place", f);
	if (err.kind) {
		char *why = jsonPrint(err.why);
		hostSay(h, "place %s: %s", name, why);
		free(why);
	}
}

/** the value the address reaches, read as the machine on the keeper */
static Json *peek(Host *h, Json *address) {
	Json *f = keyed("address", address), *out = NULL;
	if (operate(h, h->kept, h->machine, "read", f, &out).kind) return NULL;
	Json *items = jsonGet(out, "items");
	return items && items->array.count ? jsonGet(items->array.items[0], "value") : NULL;
}

// --- protect: /etc/rules, read again when it changes

static ErmAnswer may(void *data, Json *agent, const char *process, const char *op, const ErmArgs *args) {
	Host *h = data;
	// the lock's first, naming the document's access node as what it read (SYNC.tex, The access node), then the rules'
	ErmAnswer lock = ermSyncMay(h->sync, agent, process, op, args);
	if (lock.kind != ERM_YES) return lock;
	Json *list = peek(h, names("/", "etc", "rules", NULL));
	if (list != h->rules) {
		h->rules = list;
		h->may.list = NULL;
		ErmRules rules;
		if (jsonIsArray(list) && ermRulesFrom(jsonShallow(list), &rules)) h->may = rules;
	}
	if (!h->may.list) return lock;
	ErmAnswer rules = ermRulesMay(&h->may, agent, process, op, args);
	for (int i = 0; i < lock.depends.count; i++) ERM_PUSH(rules.depends, lock.depends.items[i]);
	return rules;
}

// --- loaders

/** loaders/c: a driver built into ermineOS, {"kind": "c", "name": n} */
static ErmErr loadC(void *data, Json *program, ErmCode *out) {
	Host *h = data;
	const char *name = jsonText(jsonGet(program, "name"));
	bool found = false;
	ErmFn setup = name ? driverSetup(h, name, &found) : (ErmFn){ 0 };
	if (!found) return ermDetail(ermInvalid("not-a-program"), "text", jsonString("no such driver in ermineOS"));
	*out = (ErmCode){ .shape = ERM_SETUP, .setup = setup };
	return ermOk();
}

/** code given to start as data: {"compute": f} or {"compute": f, "effect": g}, each a function */
static ErmErr loadGiven(void *data, Json *program, ErmCode *out) {
	(void)data;
	ErmFn compute, effect;
	if (!ermFunctionOf(jsonGet(program, "compute"), &compute)) return ermInvalid("not-a-program");
	if (ermFunctionOf(jsonGet(program, "effect"), &effect)) *out = (ErmCode){ .shape = ERM_EFFECT, .compute = compute, .effect = effect };
	else *out = (ErmCode){ .shape = ERM_COMPUTE, .compute = compute };
	return ermOk();
}

// --- /hw, from the device tree

static void makeHw(Host *h) {
	Json *dt = h->dt;
	Json *hw = jsonObject();
	for (int i = 0; i < dt->object.count; i++) {
		const char *k = dt->object.members[i].key;
		if (strcmp(k, "font") && strcmp(k, "devices") && strcmp(k, "fb") && strcmp(k, "screens")) jsonAdd(hw, k, dt->object.members[i].value);
	}
	place(h, names("/", NULL), "hw", "hw", hw, true);
	place(h, names("/", "hw", NULL), "fb", "hw.fb", jsonGet(dt, "fb"), true);
	place(h, names("/", "hw", NULL), "screens", "hw.screens", jsonGet(dt, "screens") ? jsonGet(dt, "screens") : jsonArray(), true);
	// the font ROM, its coverage as bytes
	Json *font = jsonGet(dt, "font"), *rom = jsonObject();
	for (int i = 0; font && i < font->object.count; i++) {
		const char *k = font->object.members[i].key;
		if (strcmp(k, "alpha") == 0) {
			// base64, as the metal sends it
			const char *text = jsonText(font->object.members[i].value);
			size_t n = 0;
			uint8_t *bytes = drvUnbase64(text ? text : "", &n);
			jsonAdd(rom, "alpha", jsonBytes(bytes, n));
			free(bytes);
		} else jsonAdd(rom, k, font->object.members[i].value);
	}
	place(h, names("/", "hw", NULL), "font", "hw.font", rom, true);
	place(h, names("/", "hw", NULL), "devices", "hw.devices", jsonNull(), true);
	place(h, names("/", "hw", NULL), "irq", "hw.irq", jsonNull(), true);
	Json *devices = jsonGet(dt, "devices");
	Json *own = parse("[{\"name\": \"timer\", \"irq\": 97, \"note\": \"core 0's own\"},"
	                  " {\"name\": \"blitter\", \"note\": \"core 0's own: BitBlt, text, and the draw device's ops\"}]");
	for (int pass = 0; pass < 2; pass++) {
		Json *list = pass ? own : devices;
		for (int i = 0; list && i < list->array.count; i++) {
			Json *d = list->array.items[i];
			const char *name = jsonText(jsonGet(d, "name"));
			if (!name) continue;
			char *id = formatString("hw.dev.%s", name);
			place(h, names("/", "hw", "devices", NULL), name, id, d, true);
			if (strcmp(name, "blitter") == 0) {
				char *port = formatString("%s.port", id);
				place(h, names("/", "hw", "devices", name, NULL), "port", port, jsonLive("blitter"), true);
				free(port);
			}
			free(id);
			int64_t irq;
			if (jsonIsWhole(jsonGet(d, "irq"), &irq)) {
				char n[16];
				snprintf(n, sizeof n, "%lld", (long long)irq);
				char *line = formatString("hw.irq.%s", n);
				Json *v = jsonObject();
				jsonAdd(v, "device", jsonString(name));
				jsonAdd(v, "owner", jsonNull());
				jsonAdd(v, "count", jsonInteger(0));
				place(h, names("/", "hw", "irq", NULL), n, line, v, true);
				free(line);
			}
		}
	}
}

// --- the image: what a first boot puts on the card (../image/image.json)

static char *slurp(const char *path) {
	FILE *f = fopen(path, "rb");
	if (!f) return NULL;
	fseek(f, 0, SEEK_END);
	long n = ftell(f);
	fseek(f, 0, SEEK_SET);
	char *text = malloc((size_t)n + 1);
	size_t got = fread(text, 1, (size_t)n, f);
	text[got] = 0;
	fclose(f);
	return text;
}

static Json *image(Host *h) {
	char *path = formatString("%s/image.json", h->config.image);
	char *text = slurp(path);
	free(path);
	if (!text) {
		hostSay(h, "no image at %s", h->config.image);
		return NULL;
	}
	char *why = NULL;
	Json *img = jsonParse(text, strlen(text), &why);
	free(text);
	if (!img) hostSay(h, "the image is not JSON: %s", why);
	return img;
}

/** a node's value as the image gives it: its value, or a program's source read from the image's folder */
static Json *imageValue(Host *h, Json *entry) {
	const char *source = jsonText(jsonGet(entry, "source"));
	if (!source) return jsonGet(entry, "value") ? jsonGet(entry, "value") : jsonNull();
	char *path = formatString("%s/%s", h->config.image, source);
	char *text = slurp(path);
	free(path);
	Json *v = jsonObject();
	jsonAdd(v, "kind", jsonString("js"));
	jsonAdd(v, "source", jsonString(text ? text : ""));
	free(text);
	return v;
}

/**
 * What a first boot puts on the card: each node made by name through the
 * top, as the machine, so the wrapper makes it a document, its id from the
 * lock (SYNC.tex, Making and mounting), and it is kept: the image's ids are
 * not used. The root's value is written first, which carries its lock
 * record (SYNC.tex: the root's first value commit is the first write of its
 * value through the wrapper).
 */
static void makeImage(Host *h, Json *img) {
	Json *f = keyed("address", names("/", NULL)), *out = NULL;
	Json *patches = jsonArray(), *patch = keyed("type", jsonString("snapshot"));
	jsonAdd(patch, "value", keyed("machine", jsonString(h->user)));
	jsonPush(patches, patch);
	jsonAdd(f, "patches", patches);
	ErmErr err = hostDo(h, NULL, "write", f, &out);
	if (err.kind) {
		char *why = jsonPrint(err.why);
		hostSay(h, "image: the root: %s", why);
		free(why);
	}
	Json *nodes = jsonGet(img, "nodes");
	for (int i = 0; nodes && i < nodes->array.count; i++) {
		Json *e = nodes->array.items[i];
		Json *at = jsonShallow(jsonGet(e, "at"));
		Json *address = jsonArray();
		jsonPush(address, jsonString("/"));
		for (int k = 0; at && k < at->array.count; k++) jsonPush(address, at->array.items[k]);
		Json *f = jsonObject();
		jsonAdd(f, "address", address);
		jsonAdd(f, "name", jsonShallow(jsonGet(e, "name")));
		jsonAdd(f, "value", imageValue(h, e));
		err = hostDo(h, NULL, "place", f, &out);
		if (err.kind) {
			char *why = jsonPrint(err.why);
			hostSay(h, "image: %s: %s", jsonText(jsonGet(e, "name")), why);
			free(why);
		}
	}
}

/**
 * A card an older image made, brought up to date: each image node it lacks
 * is made, by name, as a first boot makes it; one whose value differs from
 * the image's gets the image's, if its last change is the machine's, so the
 * image wrote it and no one has since. What a person changed is left as they
 * left it, and the log says so.
 */
static void updateImage(Host *h, Json *img) {
	Json *nodes = jsonGet(img, "nodes");
	int made = 0, updated = 0;
	for (int i = 0; nodes && i < nodes->array.count; i++) {
		Json *e = nodes->array.items[i], *at = jsonGet(e, "at");
		const char *name = jsonText(jsonGet(e, "name"));
		if (!name) continue;
		Json *parent = jsonArray();
		jsonPush(parent, jsonString("/"));
		for (int k = 0; jsonIsArray(at) && k < at->array.count; k++) jsonPush(parent, at->array.items[k]);
		Json *address = jsonShallow(parent), *out = NULL;
		jsonPush(address, jsonString(name));
		Json *item = NULL;
		if (!hostDo(h, NULL, "read", keyed("address", address), &out).kind) {
			Json *items = jsonGet(out, "items");
			for (int k = 0; jsonIsArray(items) && k < items->array.count && !item; k++)
				if (jsonGet(items->array.items[k], "value")) item = items->array.items[k];
		}
		Json *value = imageValue(h, e);
		if (!item) {
			Json *f = keyed("address", parent);
			jsonAdd(f, "name", jsonString(name));
			jsonAdd(f, "value", value);
			ErmErr err = hostDo(h, NULL, "place", f, &out);
			if (err.kind) {
				char *why = jsonPrint(err.why);
				hostSay(h, "image: %s: %s", name, why);
				free(why);
			} else made++;
			continue;
		}
		if (jsonEqual(jsonGet(item, "value"), value)) continue;
		const char *actor = jsonText(jsonGet(jsonGet(jsonGet(item, "change"), "agent"), "actor"));
		char *where = jsonPrint(address);
		if (!actor || strcmp(actor, "machine") != 0) {
			hostSay(h, "image: %s was changed by %s since the image made it: kept as it is", where, actor ? actor : "someone");
			free(where);
			continue;
		}
		Json *patches = jsonArray(), *patch = keyed("type", jsonString("snapshot"));
		jsonAdd(patch, "value", value);
		jsonPush(patches, patch);
		Json *f = keyed("address", address);
		jsonAdd(f, "patches", patches);
		ErmErr err = hostDo(h, NULL, "write", f, &out);
		if (err.kind) {
			char *why = jsonPrint(err.why);
			hostSay(h, "image: %s: %s", where, why);
			free(why);
		} else updated++;
		free(where);
	}
	if (made || updated) hostSay(h, "the image brought the SD card up to date: %d made, %d newer", made, updated);
}

/** what boots: each entry started as its actor; its data in a node inside it */
static void boot(Host *h, Json *img) {
	Json *list = jsonGet(img, "boot");
	for (int i = 0; list && i < list->array.count; i++) {
		Json *e = list->array.items[i];
		Json *address = jsonArray();
		jsonPush(address, jsonString("/"));
		Json *at = jsonGet(e, "start");
		for (int k = 0; at && k < at->array.count; k++) jsonPush(address, at->array.items[k]);
		Json *f = jsonObject();
		jsonAdd(f, "address", address);
		jsonAdd(f, "program", jsonShallow(jsonGet(e, "program")));
		if (jsonGet(e, "name")) jsonAdd(f, "name", jsonShallow(jsonGet(e, "name")));
		const char *actor = jsonText(jsonGet(e, "actor"));
		Json *agent = actor && strcmp(actor, "person") == 0 ? h->personAgent : h->machine;
		Json *out = NULL;
		ErmErr err = hostDo(h, agent, "start", f, &out);
		char *where = jsonPrint(address), *what = jsonPrint(jsonGet(e, "program"));
		if (err.kind) {
			char *why = jsonPrint(err.why);
			hostSay(h, "boot: %s %s: %s", where, what, why);
			free(why);
		} else {
			const char *pid = jsonText(jsonGet(jsonGet(out, "change"), "id"));
			hostSay(h, "start %s  %s  %s", pid, where, what);
			Json *data = jsonGet(e, "data");
			if (data && pid) {
				Json *inside = jsonShallow(address);
				jsonPush(inside, jsonString(jsonText(jsonGet(e, "name")) ? jsonText(jsonGet(e, "name")) : pid));
				char *id = formatString("%s.data", pid);
				place(h, inside, "data", id, data, true);
				free(id);
			}
		}
		free(where);
		free(what);
	}
}

/** the scheduler's moments (SCHEDULER.tex, Hooks): a run that fails or is stopped is said in the log (a parked loop is not: its process says so) */
static void moment(void *data, Json *m) {
	Host *h = data;
	const char *ended = jsonText(jsonGet(m, "ended"));
	if (!ended || strcmp(ended, "failed")) return;
	char *text = jsonPrint(m);
	hostSay(h, "run: %s", text);
	free(text);
}

// --- the scheduler's top: the sync wrapper, which is made over the scheduler, so after it

/**
 * A program's making: the scheduler reads a place's fields as a request's,
 * which name an id, so a program gives "" for a node it makes by name, and it
 * goes on to the wrapper with none, as the conformance harness's making does
 * (core/graph/c/main.c). An ephemeral node a program makes keeps the id it
 * gave: the scheduler holds the node as its process's by it.
 */
static ErmErr laterOp(void *self, const ErmCtx *ctx, const ErmStamp *stamp, const ErmOp *op, ErmResult *out) {
	Host *h = self;
	ErmInterface to = h->wrapped.vt ? h->wrapped : h->protect;
	if (op->kind == ERM_OP_PLACE && op->id && !*op->id && op->value && !op->ephemeral) {
		ErmOp making = *op;
		making.id = NULL;
		return to.vt->op(to.self, ctx, stamp, &making, out);
	}
	return to.vt->op(to.self, ctx, stamp, op, out);
}

static void laterForget(void *self, const char *reader) {
	Host *h = self;
	ErmInterface to = h->wrapped.vt ? h->wrapped : h->protect;
	to.vt->forget(to.self, reader);
}

static const ErmVtable laterVtable = { laterOp, laterForget };

// --- booting

Host *hostBoot(const ErmosConfig *config) {
	Host *h = calloc(1, sizeof *h);
	h->config = *config;
	h->started = monotonic();
	h->site = parse("{\"file\": \"experimental_os/c/host.c\", \"line\": 1}");
	char *why = NULL;
	h->dt = config->dt ? jsonParse(config->dt, strlen(config->dt), &why) : NULL;
	if (!jsonIsObject(h->dt)) {
		hostSay(h, "no device tree: %s", why ? why : "none given");
		return NULL;
	}
	const char *user = jsonText(jsonGet(h->dt, "user"));
	h->user = copyString(user ? user : "person");
	h->machine = parse("{\"actor\": \"machine\", \"code\": []}");
	h->person = jsonString(h->user);
	h->personAgent = jsonObject();
	jsonAdd(h->personAgent, "actor", jsonString(h->user));
	jsonAdd(h->personAgent, "person", jsonString(h->user));
	jsonAdd(h->personAgent, "trusted", jsonBoolean(true));
	jsonAdd(h->personAgent, "code", jsonArray());

	// the card: the device, and what Subduction holds (peer.c), from which the graph is made again
	const char *sd = config->sd ? config->sd : "/tmp/ermineOS-card";
	const char *wrong = NULL;
	bool made = false;
	h->sync = peerOpen(h, sd, config->fresh, &made, &wrong);
	if (!h->sync) {
		hostSay(h, "the SD card (%s) could not be used: %s", sd, wrong);
		return NULL;
	}
	h->graph = ermGraph(ermSyncRoot(h->sync), NULL);
	struct timespec wall;
	clock_gettime(CLOCK_REALTIME, &wall);
	h->base = (ErmTime)wall.tv_sec * 1000000 + wall.tv_nsec / 1000;
	h->last = h->base - 1;

	// schedule(sync(protect(keeper(library(graph))))): the scheduler's top is the wrapper, made after it
	h->kept = ermSyncKeeper(h->sync, ermLibrary(h->graph, ermSyncRoot(h->sync)));
	h->protect = ermProtect(h->kept, may, h);
	static ErmLoader loaders[3];
	loaders[0] = (ErmLoader){ "c", h, loadC };
	loaders[1] = jsLoader(h);
	loaders[2] = execLoader(h);
	ErmScheduleOptions options = {
		.graph = h->kept,
		.code = ermReferenceCode(loaders, 3),
		.given = { "given", h, loadGiven },
		.clock = { next, h },
		.hooks = { moment, h },
	};
	h->schedule = ermSchedule((ErmInterface){ &laterVtable, h }, &options);
	h->wrapped = ermSyncWrap(h->sync, h->protect, h->schedule);
	h->top = ermScheduleInterface(h->schedule);
	h->running = true;

	int taken = peerStart(h, h->schedule);
	Json *img = image(h);
	bool empty = !peek(h, names("/", "etc", NULL));
	hostSay(h, empty ? "the SD card (%s) is empty" : "the SD card (%s) holds a graph: %d changes taken in from its store", sd, taken);
	if (empty && img) {
		makeImage(h, img);
		hostSay(h, "first boot: the image made the SD card");
	} else if (img) {
		updateImage(h, img);
	}
	(void)made;
	makeHw(h);
	if (!config->bare && img) boot(h, img);
	hostCommand(h, parse("{\"op\": \"ready\"}"));
	return h;
}

// --- the drain: each record to the driver that claimed its line

static bool trusted(int irq) {
	return irq == 34 || irq == 35;
}

static void deliver(Host *h, int irq, Json *records) {
	// loaders/exec's own line: a program's frames came, or it exited
	if (irq == 60) {
		for (int i = 0; i < records->array.count; i++) execRecord(h, records->array.items[i]);
		return;
	}
	// the network's (peer.c): the connection opened, or something came
	if (irq == 61) {
		for (int i = 0; i < records->array.count; i++) peerRecord(h, records->array.items[i]);
		return;
	}
	char n[16];
	snprintf(n, sizeof n, "%d", irq);
	Json *line = peek(h, names("/", "hw", "irq", n, NULL));
	Json *owner = jsonGet(line, "owner");
	if (!jsonIsArray(owner)) {
		// no driver has the line yet: it waits, as a level-triggered interrupt does
		Held *held = NULL;
		for (int i = 0; i < h->held.count && !held; i++) if (h->held.items[i].irq == irq) held = &h->held.items[i];
		if (!held) {
			ERM_PUSH(h->held, ((Held){ .irq = irq }));
			held = &h->held.items[h->held.count - 1];
		}
		for (int i = 0; i < records->array.count && held->records.count < 64; i++) ERM_PUSH(held->records, records->array.items[i]);
		return;
	}
	Json *f = jsonObject(), *args = jsonArray(), *out = NULL;
	jsonPush(args, records);
	jsonAdd(f, "address", jsonShallow(owner));
	jsonAdd(f, "args", args);
	ErmErr err = hostDo(h, trusted(irq) ? h->personAgent : h->machine, "call", f, &out);
	if (err.kind) {
		char *why = jsonPrint(err.why);
		hostSay(h, "irq %d to %s: %s", irq, jsonPrint(owner), why);
		free(why);
	}
}

/**
 * writes /dev/clock/second and wall each second, and minute as it turns:
 * ephemeral nodes, the host's own, made and written beneath on the keeper,
 * as /hw is; never kept, and made again each boot
 */
static void tick(Host *h) {
	time_t now = time(NULL);
	if ((int64_t)now == h->second) return;
	bool minute = h->second / 60 != (int64_t)now / 60;
	h->second = (int64_t)now;
	struct tm tm = *localtime(&now);
	char wall[16];
	strftime(wall, sizeof wall, "%H:%M:%S", &tm);
	const char *nodes[3] = { "second", "minute", "wall" };
	Json *values[3] = { jsonInteger((int64_t)now), jsonInteger((int64_t)now / 60), jsonString(wall) };
	for (int i = 0; i < 3; i++) {
		if (i == 1 && !minute) continue;
		Json *f = jsonObject(), *patches = jsonArray();
		jsonPush(patches, keyed("type", jsonString("snapshot")));
		jsonAdd(patches->array.items[0], "value", values[i]);
		jsonAdd(f, "address", names("/", "dev", "clock", nodes[i], NULL));
		jsonAdd(f, "patches", patches);
		if (bare(h, "write", f).kind) {
			char *id = formatString("clock-%s", nodes[i]);
			place(h, names("/", "dev", "clock", NULL), nodes[i], id, values[i], true);
			free(id);
		}
	}
}

void hostTurn(Host *h, const char *const *records, int count) {
	// lines claimed since the last turn get what waited for them, first
	for (int i = 0; i < h->held.count; i++) {
		Held *held = &h->held.items[i];
		if (!held->records.count) continue;
		char n[16];
		snprintf(n, sizeof n, "%d", held->irq);
		if (!jsonIsArray(jsonGet(peek(h, names("/", "hw", "irq", n, NULL)), "owner"))) continue;
		Json *list = jsonArray();
		for (int k = 0; k < held->records.count; k++) jsonPush(list, held->records.items[k]);
		held->records.count = 0;
		deliver(h, held->irq, list);
	}
	// this turn's, by line, in order
	ERM_LIST(int) irqs = { 0 };
	ERM_LIST(Json *) groups = { 0 };
	for (int i = 0; i < count; i++) {
		char *why = NULL;
		Json *r = jsonParse(records[i], strlen(records[i]), &why);
		int64_t irq;
		if (!r || !jsonIsWhole(jsonGet(r, "irq"), &irq)) continue;
		if (irq == 1) {
			hostSay(h, "power off (%s)", jsonText(jsonGet(r, "why")) ? jsonText(jsonGet(r, "why")) : "");
			h->running = false;
			continue;
		}
		int at = -1;
		for (int k = 0; k < irqs.count; k++) if (irqs.items[k] == (int)irq) at = k;
		if (at < 0) {
			ERM_PUSH(irqs, (int)irq);
			ERM_PUSH(groups, jsonArray());
			at = irqs.count - 1;
		}
		jsonPush(groups.items[at], r);
	}
	if (h->wake && hostNow(h) >= h->wake) h->wake = 0;
	for (int k = 0; k < irqs.count; k++) deliver(h, irqs.items[k], groups.items[k]);
	// programs' timers that are due
	ermScheduleBegin(h->schedule);
	int64_t timer = jsTimers(h);
	ermScheduleEnd(h->schedule, true);
	if (timer >= 0) hostWake(h, hostNow(h) + timer);
	free(irqs.items);
	free(groups.items);
	tick(h);
	peerTurn(h);
	linkTurn(h);
}

int64_t hostWait(Host *h) {
	int64_t now = hostNow(h);
	// the clock's next second
	struct timespec ts;
	clock_gettime(CLOCK_REALTIME, &ts);
	int64_t until = 1000000 - ts.tv_nsec / 1000;
	if (h->wake) {
		int64_t w = h->wake - now;
		if (w < until) until = w < 0 ? 0 : w;
	}
	return until;
}

bool hostRunning(Host *h) {
	return h->running;
}

void hostOff(Host *h) {
	linkStop(h);
	peerStop(h);
	execStop(h);
	jsStop(h);
	hostSay(h, "off: the SD card holds every change as it was made");
}
