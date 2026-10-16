// libermine.c: the ABI for C programs (libermine.h).

#include "libermine.h"

#include "../abi.h"

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

typedef struct Fn {
	ErmEvent f;
	void *data;
} Fn;

struct Erm {
	int in, out;
	int64_t seq;
	Fn *fns; // the handlers given, by their number
	int count, capacity;
	Json **events; // events that came while an answer was awaited, oldest first
	int nevents, room;
	bool gone;
};

static Json *field(const Json *m, const char *k) {
	return jsonGet(m, k);
}

static int64_t whole(const Json *v) {
	int64_t n = -1;
	return jsonIsWhole(v, &n) ? n : -1;
}

static Json *codeOf(const char *code, const char *message) {
	Json *e = jsonObject();
	jsonAdd(e, "code", jsonString(code));
	if (message) jsonAdd(e, "message", jsonString(message));
	return e;
}

Erm *ermOpen(void) {
	// one socket, or two pipes: "in,out"
	const char *env = getenv("ERMINE_FD");
	int in = env ? atoi(env) : 3, out = in;
	const char *comma = env ? strchr(env, ',') : NULL;
	if (comma) out = atoi(comma + 1);
	if (in < 0 || out < 0) return NULL;
	Erm *erm = calloc(1, sizeof *erm);
	erm->in = in;
	erm->out = out;
	return erm;
}

Json *ermDo(Erm *erm, const char *op, Json *fields, Json **error) {
	*error = NULL;
	if (erm->gone) {
		jsonFree(fields);
		*error = codeOf("gone", "the OS is gone");
		return NULL;
	}
	int64_t seq = ++erm->seq;
	Json *ask = jsonObject();
	jsonAdd(ask, "seq", jsonInteger(seq));
	jsonAdd(ask, "op", jsonString(op));
	jsonAdd(ask, "fields", fields ? fields : jsonObject());
	const char *why = NULL;
	bool sent = abiWrite(erm->out, ask, &why);
	jsonFree(ask);
	if (!sent) {
		erm->gone = true;
		*error = codeOf("gone", why);
		return NULL;
	}
	for (;;) {
		Json *frame = abiRead(erm->in, &why);
		if (!frame) {
			erm->gone = true;
			*error = codeOf("gone", why);
			return NULL;
		}
		// an event, kept for ermWait: run here, it could ask for operations of its own in the middle of this one
		if (field(frame, "event")) {
			erm->events = growArray(erm->events, erm->nevents, &erm->room, sizeof *erm->events);
			erm->events[erm->nevents++] = frame;
			continue;
		}
		if (whole(field(frame, "seq")) != seq) {
			jsonFree(frame);
			continue;
		}
		Json *e = field(frame, "error"), *ok = field(frame, "ok");
		Json *out = e ? NULL : ok ? jsonRef(ok) : jsonNull();
		if (e) *error = jsonRef(e);
		jsonFree(frame);
		return out;
	}
}

Json *ermHandler(Erm *erm, const char *name, ErmEvent f, void *data, Json **error) {
	erm->fns = growArray(erm->fns, erm->count, &erm->capacity, sizeof *erm->fns);
	erm->fns[erm->count] = (Fn){ f, data };
	Json *fields = jsonObject();
	jsonAdd(fields, "name", jsonString(name));
	jsonAdd(fields, "fn", jsonInteger(erm->count++));
	return ermDo(erm, "handler", fields, error);
}

/** an event: its handler called with its args; the frame let go */
static void run(Erm *erm, Json *frame) {
	int64_t fn = whole(field(frame, "event"));
	Json *args = field(frame, "args"), *none = NULL;
	if (fn >= 0 && fn < erm->count && erm->fns[fn].f) {
		if (!args) args = none = jsonArray();
		erm->fns[fn].f(erm, args, erm->fns[fn].data);
	}
	jsonFree(none);
	jsonFree(frame);
}

static int64_t ms(void) {
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

bool ermWait(Erm *erm, int wait) {
	// those that came while an answer was awaited, first
	while (erm->nevents) {
		Json *frame = erm->events[0];
		memmove(erm->events, erm->events + 1, sizeof *erm->events * (size_t)(erm->nevents - 1));
		erm->nevents--;
		run(erm, frame);
	}
	int64_t until = ms() + (wait < 0 ? 0 : wait);
	bool first = true;
	while (!erm->gone) {
		// the first waited for; then each already here
		int left = !first ? 0 : wait < 0 ? -1 : (int)(until > ms() ? until - ms() : 0);
		struct pollfd p = { erm->in, POLLIN, 0 };
		int r = poll(&p, 1, left);
		if (r < 0 && errno == EINTR) continue;
		if (r <= 0) break;
		first = false;
		const char *why = NULL;
		Json *frame = abiRead(erm->in, &why);
		if (!frame) {
			erm->gone = true;
			break;
		}
		if (field(frame, "event")) run(erm, frame);
		else jsonFree(frame);
	}
	return !erm->gone;
}

// --- conveniences

Json *ermPath(const char *first, ...) {
	Json *a = jsonArray();
	va_list ap;
	va_start(ap, first);
	for (const char *part = first; part; part = va_arg(ap, const char *)) jsonPush(a, jsonString(part));
	va_end(ap);
	return a;
}

/** an op's fields: key, value (taken), ..., NULL */
static Json *fieldsOf(const char *key, ...) {
	Json *m = jsonObject();
	va_list ap;
	va_start(ap, key);
	for (const char *k = key; k; k = va_arg(ap, const char *)) jsonAdd(m, k, va_arg(ap, Json *));
	va_end(ap);
	return m;
}

/** a version that is a process's status, written in front of its value */
static bool status(const Json *v) {
	const char *place = jsonText(field(field(v, "because"), "place"));
	return place && !strcmp(place, "status");
}

Json *ermGet(Erm *erm, Json *address) {
	Json *error = NULL, *items = ermDo(erm, "content", fieldsOf("address", address, NULL), &error), *out = NULL;
	jsonFree(error);
	for (int i = 0; jsonIsArray(items) && i < items->array.count; i++) {
		Json *vs = field(items->array.items[i], "versions");
		if (!jsonIsArray(vs)) continue;
		for (int k = 0; k < vs->array.count && !out; k++)
			if (!status(vs->array.items[k])) out = field(vs->array.items[k], "content") ? jsonRef(field(vs->array.items[k], "content")) : jsonNull();
		break;
	}
	jsonFree(items);
	return out;
}

char *ermIdAt(Erm *erm, Json *address) {
	Json *error = NULL, *items = ermDo(erm, "look", fieldsOf("address", address, NULL), &error);
	jsonFree(error);
	char *out = NULL;
	for (int i = 0; jsonIsArray(items) && i < items->array.count && !out; i++)
		if (field(items->array.items[i], "node")) out = copyString(jsonText(field(items->array.items[i], "id")));
	jsonFree(items);
	return out;
}

bool ermPut(Erm *erm, Json *address, Json *value, Json **error) {
	Json *patches = jsonArray();
	jsonPush(patches, fieldsOf("path", jsonArray(), "value", value, NULL));
	Json *time = ermDo(erm, "write", fieldsOf("address", address, "patches", patches, NULL), error);
	bool ok = time != NULL;
	jsonFree(time);
	return ok;
}

char *ermMake(Erm *erm, Json *address, const char *name, Json *value, bool ephemeral, Json **error) {
	*error = NULL;
	Json *at = jsonShallow(address);
	jsonPush(at, jsonString(name));
	char *had = ermIdAt(erm, at);
	if (had) {
		jsonFree(address);
		jsonFree(value);
		return had;
	}
	char *parent = ermIdAt(erm, address);
	if (!parent) {
		jsonFree(value);
		*error = codeOf("nothing-there", "nothing at the address to make it in");
		return NULL;
	}
	Json *fields = fieldsOf("value", value ? value : jsonNull(), NULL);
	if (ephemeral) jsonAdd(fields, "ephemeral", jsonBoolean(true));
	Json *id = ermDo(erm, "create", fields, error);
	Json *time = id ? ermDo(erm, "insert", fieldsOf("id", jsonString(parent), "name", jsonString(name), "child", jsonShallow(id), NULL), error) : NULL;
	char *out = time && jsonText(id) ? copyString(jsonText(id)) : NULL;
	jsonFree(time);
	jsonFree(id);
	free(parent);
	return out;
}

bool ermDrop(Erm *erm, Json *address, const char *name, const char *id, Json **error) {
	*error = NULL;
	char *parent = ermIdAt(erm, jsonShallow(address));
	if (!parent) {
		jsonFree(address);
		*error = codeOf("nothing-there", "nothing at the address");
		return false;
	}
	Json *items = ermDo(erm, "children", fieldsOf("address", address, "name", jsonString(name), NULL), error);
	int at = -1;
	for (int i = 0; jsonIsArray(items) && i < items->array.count && at < 0; i++)
		if (!id || !strcmp(jsonText(field(items->array.items[i], "id")) ? jsonText(field(items->array.items[i], "id")) : "", id)) at = i;
	jsonFree(items);
	if (at < 0) {
		free(parent);
		if (!*error) *error = codeOf("nothing-there", "no such id in that list");
		return false;
	}
	Json *time = ermDo(erm, "remove", fieldsOf("id", jsonString(parent), "name", jsonString(name), "index", jsonInteger(at), NULL), error);
	free(parent);
	bool ok = time != NULL;
	jsonFree(time);
	return ok;
}

Json *ermHere(Erm *erm) {
	Json *error = NULL, *here = ermDo(erm, "here", NULL, &error);
	jsonFree(error);
	return here;
}

// --- video memory

ErmPlane *ermPlane(Erm *erm, const char *name, int w, int h, Json **error) {
	*error = NULL;
	// the node, then the driver's memory for it, mapped
	char *made = ermMake(erm, ermPath("/", "dev", "vram", "planes", NULL), name, fieldsOf("w", jsonInteger(w), "h", jsonInteger(h), NULL), true, error);
	if (!made) return NULL;
	free(made);
	// the driver says the plane in the node once it has made it: a call answers nothing
	Json *v = NULL;
	for (int tries = 0; tries < 2000; tries++) {
		jsonFree(v);
		v = ermGet(erm, ermPath("/", "dev", "vram", "planes", name, NULL));
		if (jsonText(field(v, "shm")) || erm->gone) break;
		usleep(1000);
	}
	int64_t id = whole(field(v, "id")), pw = whole(field(v, "w")), ph = whole(field(v, "h")), stride = whole(field(v, "stride"));
	const char *shm = jsonText(field(v, "shm"));
	if (id < 0 || !shm || pw != w || ph != h || stride < w) {
		jsonFree(v);
		*error = codeOf("no-plane", "the vram driver made no plane");
		return NULL;
	}
	int fd = shm_open(shm, O_RDWR);
	void *bits = fd < 0 ? MAP_FAILED : mmap(NULL, (size_t)(stride * ph) * 4, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	if (fd >= 0) close(fd);
	jsonFree(v);
	if (bits == MAP_FAILED) {
		*error = codeOf("no-plane", "its shared memory would not map");
		return NULL;
	}
	ErmPlane *p = calloc(1, sizeof *p);
	*p = (ErmPlane){ bits, (int)pw, (int)ph, (int)stride, id, 0 };
	return p;
}

Json *ermPlaneValue(const ErmPlane *plane) {
	return fieldsOf("source", jsonString("vram"), "id", jsonInteger(plane->id), "serial", jsonInteger(plane->serial), NULL);
}

bool ermDrawn(Erm *erm, ErmPlane *plane, Json *layer, int x, int y, int w, int h, Json **error) {
	Json *patches = jsonArray();
	jsonPush(patches, fieldsOf("path", ermPath("plane", "serial", NULL), "value", jsonInteger(++plane->serial), NULL));
	jsonPush(patches, fieldsOf("path", ermPath("plane", "dirty", NULL), "value",
	                           fieldsOf("x", jsonInteger(x), "y", jsonInteger(y), "w", jsonInteger(w), "h", jsonInteger(h), NULL), NULL));
	Json *time = ermDo(erm, "write", fieldsOf("address", layer, "patches", patches, NULL), error);
	bool ok = time != NULL;
	jsonFree(time);
	return ok;
}
