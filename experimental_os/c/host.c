// host.c: ermineOS's host (host.h; ../ERMINEOS.md). Core 0's own work: the
// SD card (store.c), the stack (the graph, protect with /etc/rules, the
// scheduler with the host's loaders), /hw from the device tree, what boots,
// the drain, which hands each turn's records to the driver that claimed
// their line, the clock, and the commands to the metal.
//
// The stack: the bare graph, protect over it, the scheduler over protect.
// Host code acts through the scheduler's interface with an agent whose code
// is empty, its changes carrying a site (SCHEDULER.tex, What a process acts
// as). What it keeps for itself, /hw, is placed beneath, on the bare graph:
// ephemeral, made again each boot, and never the scheduler's business.

#include "host.h"

#include "jsload.h"
#include "drivers.h"
#include "store.h"

#include "../../core/graph/c/entry.h"
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
	ErmInterface graph, protect, top;
	ErmSchedule *schedule;
	Json *machine, *person, *personAgent, *site;
	char *user;
	ErmTime base, last;
	int64_t started;    // µs, CLOCK_MONOTONIC, at boot
	int64_t wake;       // the earliest turn a driver asked for; 0: none
	int64_t savedAt;    // when the card was last written
	ErmTime savedTime;  // the graph's highest time then
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
	if (op->kind == ERM_OP_DIRECTORY && !op->name) return keyed("directory", ermListingToJson(&r->listing));
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
	ErmRequest request = { fields, false, ermOk() };
	ErmOp op;
	ErmStamp stamp;
	ermRequestOp(&request, kind, false, false, &op, &stamp);
	if (request.err.kind) return request.err;
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
		err = request.err.kind ? request.err : ermScheduleStart(h->schedule, &ctx, &stamp, &address, program, pname, id, &r);
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

/** an operation on the bare graph, beneath protect and the scheduler: the host's own bookkeeping */
static ErmErr bare(Host *h, const char *name, Json *fields) {
	Json *out = NULL;
	ErmOpKind kind = kindOf(name);
	if (ermOpIsChange(kind) && !jsonGet(fields, "time")) {
		// the bare graph takes the time from its caller
		ErmRequest request = { fields, false, ermOk() };
		ErmOp op;
		ErmStamp stamp;
		if (!jsonGet(fields, "site")) jsonAdd(fields, "site", jsonShallow(h->site));
		ermRequestOp(&request, kind, false, false, &op, &stamp);
		if (request.err.kind) return request.err;
		stamp.time = next(h);
		ErmCtx ctx = { .agent = h->machine };
		ErmResult r = { 0 };
		return h->graph.vt->op(h->graph.self, &ctx, &stamp, &op, &r);
	}
	return operate(h, h->graph, h->machine, name, fields, &out);
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

/** the value the address reaches, read as the machine on the bare graph */
static Json *peek(Host *h, Json *address) {
	Json *f = keyed("address", address), *out = NULL;
	if (operate(h, h->graph, h->machine, "read", f, &out).kind) return NULL;
	Json *items = jsonGet(out, "items");
	return items && items->array.count ? jsonGet(items->array.items[0], "value") : NULL;
}

// --- protect: /etc/rules, read again when it changes

static ErmAnswer may(void *data, Json *agent, const char *process, const char *op, const ErmArgs *args) {
	Host *h = data;
	Json *list = peek(h, names("/", "etc", "rules", NULL));
	if (list != h->rules) {
		h->rules = list;
		h->may.list = NULL;
		ErmRules rules;
		if (jsonIsArray(list) && ermRulesFrom(jsonShallow(list), &rules)) h->may = rules;
	}
	if (!h->may.list) return (ErmAnswer){ .kind = ERM_YES };
	return ermRulesMay(&h->may, agent, process, op, args);
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
			size_t n = text ? strlen(text) : 0;
			unsigned char *bytes = malloc(n * 3 / 4 + 3);
			size_t m = 0;
			int bits = 0, acc = 0;
			for (size_t j = 0; j < n; j++) {
				const char *table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
				const char *at = strchr(table, text[j]);
				if (!at || text[j] == '\0') continue;
				acc = acc << 6 | (int)(at - table);
				bits += 6;
				if (bits >= 8) {
					bits -= 8;
					bytes[m++] = (unsigned char)(acc >> bits);
				}
			}
			jsonAdd(rom, "alpha", jsonBytes(bytes, m));
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

static void makeImage(Host *h, Json *img) {
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
		jsonAdd(f, "id", jsonShallow(jsonGet(e, "id")));
		jsonAdd(f, "value", imageValue(h, e));
		ErmErr err = bare(h, "place", f);
		if (err.kind) {
			char *why = jsonPrint(err.why);
			hostSay(h, "image: %s: %s", jsonText(jsonGet(e, "name")), why);
			free(why);
		}
	}
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

	const char *sd = config->sd ? config->sd : "/tmp/ermineOS-card";
	if (config->fresh) {
		char *card = formatString("%s/graph.cbor", sd);
		remove(card);
		free(card);
	}
	const char *wrong = NULL;
	ErmSaved *saved = storeLoad(sd, &wrong);
	if (wrong) hostSay(h, "the SD card (%s) could not be read: %s; booting empty", sd, wrong);
	h->graph = ermGraph("machine", saved);
	h->base = saved ? saved->last + 1 : 1;
	h->last = h->base - 1;
	h->savedTime = saved ? saved->last : 0;
	h->savedAt = hostNow(h);
	hostSay(h, saved ? "the SD card (%s) holds a graph" : "the SD card (%s) is empty", sd);

	h->protect = ermProtect(h->graph, may, h);
	static ErmLoader loaders[2];
	loaders[0] = (ErmLoader){ "c", h, loadC };
	loaders[1] = jsLoader(h);
	ErmScheduleOptions options = {
		.graph = h->graph,
		.code = ermReferenceCode(loaders, 2),
		.given = { "given", h, loadGiven },
		.clock = { next, h },
		.hooks = { moment, h },
	};
	h->schedule = ermSchedule(h->protect, &options);
	h->top = ermScheduleInterface(h->schedule);
	h->running = true;

	Json *img = image(h);
	if (!saved && img) {
		makeImage(h, img);
		hostSay(h, "first boot: the image made the SD card");
	}
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

/** writes /dev/clock/second and wall each second, and minute as it turns */
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
		Json *f = jsonObject(), *patches = jsonArray(), *out = NULL;
		jsonPush(patches, keyed("type", jsonString("snapshot")));
		jsonAdd(patches->array.items[0], "value", values[i]);
		jsonAdd(f, "address", names("/", "dev", "clock", nodes[i], NULL));
		jsonAdd(f, "patches", patches);
		if (hostDo(h, NULL, "write", f, &out).kind) {
			Json *p = jsonObject();
			jsonAdd(p, "address", names("/", "dev", "clock", NULL));
			jsonAdd(p, "name", jsonString(nodes[i]));
			char *id = formatString("clock-%s", nodes[i]);
			jsonAdd(p, "id", jsonString(id));
			free(id);
			jsonAdd(p, "value", values[i]);
			hostDo(h, NULL, "place", p, &out);
		}
	}
}

static void save(Host *h, bool now) {
	ErmTime last = ermGraphLast(h->graph);
	if (last == h->savedTime) return;
	if (!now && hostNow(h) - h->savedAt < 5000000) return;
	const char *why = NULL;
	if (!storeSave(h->config.sd ? h->config.sd : "/tmp/ermineOS-card", h->graph, &why)) hostSay(h, "the SD card: %s", why);
	h->savedAt = hostNow(h);
	h->savedTime = last;
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
	save(h, false);
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
	save(h, true);
	jsStop(h);
	hostSay(h, "the SD card is written");
}
