// protocol.c: protocol.h. c/main.c is included whole, its main renamed, so a
// request is read, checked and answered by the very code the conformance
// harness runs (ctxOf, addressOf, events, respond ...); only the session,
// the clock and the binding are the host's.

#define main ermineHarnessMain
#include "../main.c"
#undef main

#include "protocol.h"

struct Speaker {
	Session session;            // its top is the host's graph; its queues are numbered as the speaker's own subscriptions
	ERM_LIST(int64_t) subs;     // the graph's number of each of them
	ErmTime *clock;
	Binding binding;
	ErmIds made;
	bool stopped;
};

/** every speaker made, for speakersHolding */
static ERM_LIST(Speaker *) speakers;

Speaker *speakerNew(ErmInterface graph, ErmTime *clock, Binding binding) {
	Speaker *speaker = allocate(sizeof *speaker);
	speaker->session = (Session){ .started = true, .top = graph };
	speaker->clock = clock;
	speaker->binding = binding;
	ERM_PUSH(speakers, speaker);
	return speaker;
}

/** a queued row's change is to the node, or it reaches the node */
static bool rowOf(Json *row, const char *node) {
	const char *changed = jsonText(jsonGet(jsonGet(row, "change"), "node"));
	if (changed && strcmp(changed, node) == 0) return true;
	Json *reaches = jsonGet(row, "reaches");
	for (int i = 0; jsonIsArray(reaches) && i < reaches->array.count; i++) {
		Json *route = jsonGet(jsonGet(reaches->array.items[i], "from"), "route");
		const char *at = jsonIsArray(route) && route->array.count ? jsonText(jsonGet(route->array.items[route->array.count - 1], "node")) : NULL;
		if (at && strcmp(at, node) == 0) return true;
	}
	return false;
}

bool speakersHolding(void *data, const char *node) {
	(void)data;
	for (int s = 0; s < speakers.count; s++) {
		const Speaker *speaker = speakers.items[s];
		if (speaker->stopped || speaker->binding.push) continue;
		for (int i = 0; i < speaker->session.queues.count; i++) {
			const Queue *queue = speaker->session.queues.items[i];
			for (int e = 0; e < queue->events.count; e++) {
				if (rowOf(queue->events.items[e], node)) return true;
			}
		}
	}
	return false;
}

const ErmIds *speakerMade(const Speaker *speaker) {
	return &speaker->made;
}

void speakerStop(Speaker *speaker) {
	ErmInterface top = speaker->session.top;
	for (int i = 0; i < speaker->subs.count; i++) {
		if (!speaker->session.queues.items[i]->unsubscribed) top.vt->unsubscribe(top.self, NULL, speaker->subs.items[i]);
		speaker->session.queues.items[i]->unsubscribed = speaker->session.queues.items[i]->gone = true;
		speaker->session.queues.items[i]->events.count = 0; // never taken now: they hold nothing
	}
	speaker->stopped = true;
}

static Json *names(const ErmIds *ids, int count) {
	Json *list = jsonArray();
	for (int i = 0; i < count; i++) jsonPush(list, jsonString(ids->items[i]));
	return list;
}

/** a pushed subscription: its speaker, and its number there */
typedef struct Pushed {
	Speaker *speaker;
	int64_t sub;
} Pushed;

/** PROTOCOL Commands, events: a program speaking to a host may be sent each event as it happens */
static void pushChange(void *data, const ErmChange *change, const ErmItems *reaches) {
	Pushed *pushed = data;
	Speaker *speaker = pushed->speaker;
	if (speaker->stopped) return;
	Json *row = keyed("change", ermChangeToJson(change, false));
	if (reaches) jsonAdd(row, "reaches", ermItemsToJson(reaches));
	char *event = jsonPrint(row);
	char *line = formatString("{\"sub\":%lld,\"event\":%s}", (long long)pushed->sub, event);
	const Json *patches = change->kind == ERM_WRITE ? change->patches : NULL;
	bool whole = !reaches && jsonIsArray(patches) && patches->array.count == 1
		&& jsonText(jsonGet(patches->array.items[0], "type")) && strcmp(jsonText(jsonGet(patches->array.items[0], "type")), "snapshot") == 0;
	speaker->binding.push(speaker->binding.pushData, line, pushed->sub, whole);
	free(event);
	free(line);
	// the row is printed: what it made is freed, and what it shares with the graph kept
	ERM_LIST(Json *) shared = { 0 };
	ERM_PUSH(shared, change->patches);
	ERM_PUSH(shared, change->agent);
	ERM_PUSH(shared, change->cause);
	ERM_PUSH(shared, change->value);
	for (int i = 0; reaches && i < reaches->count; i++) {
		const ErmItem *item = &reaches->items[i];
		ERM_PUSH(shared, item->value);
		if (item->change) {
			ERM_PUSH(shared, item->change->agent);
			ERM_PUSH(shared, item->change->cause);
		}
	}
	jsonSweep(&row, 1, shared.items, shared.count);
	free(shared.items);
}

/** subscribe and unsubscribe, numbered as the speaker's own, from 1 (PROTOCOL Commands) */
static Reply subscription(Speaker *speaker, Request *request) {
	Session *session = &speaker->session;
	ErmInterface top = session->top;
	ErmCtx ctx = ctxOf(request);
	if (strcmp(request->cmd, "subscribe") == 0) {
		ErmAddress address = addressOf(request);
		if (request->err.kind) return replyError(request->err);
		Queue *queue = allocate(sizeof *queue);
		int64_t sub;
		Pushed *pushed = allocate(sizeof *pushed);
		*pushed = (Pushed){ speaker, session->queues.count + 1 };
		ErmErr err = speaker->binding.push
			? top.vt->subscribe(top.self, &ctx, &address, pushChange, pushed, &sub)
			: top.vt->subscribe(top.self, &ctx, &address, queueChange, queue, &sub);
		if (err.kind) return replyError(err);
		ERM_PUSH(session->queues, queue);
		ERM_PUSH(speaker->subs, sub);
		return replyOk(keyed("sub", jsonInteger(session->queues.count)));
	}
	int64_t sub;
	Queue *queue = queueOf(session, request, &sub);
	if (queue && queue->unsubscribed) problem(request, "wrong-field", "sub");
	if (request->err.kind) return replyError(request->err);
	ErmErr err = top.vt->unsubscribe(top.self, &ctx, speaker->subs.items[sub - 1]);
	if (err.kind) return replyError(err);
	queue->unsubscribed = true;
	return replyOk(jsonNull());
}

/**
 * the agent a request acts as: the binding's own; or, for a speaker that
 * relays and a request whose agent is an object with an "actor", that actor
 * and its "peer" (if any) with the binding's code, so the speaker's process
 * stays the last step: who, and through what
 */
static Json *agentFor(const Binding *b, Json *given, Json *discarded) {
	Json *own = jsonParse(b->agent, strlen(b->agent), NULL);
	Json *actor = b->relay && jsonIsObject(given) ? jsonGet(given, "actor") : NULL;
	if (!actor) return own;
	Json *agent = jsonObject(), *peer = jsonGet(given, "peer"), *code = jsonGet(own, "code");
	jsonAdd(agent, "actor", actor);
	if (peer) jsonAdd(agent, "peer", peer);
	jsonAdd(agent, "code", code ? code : jsonArray());
	jsonPush(discarded, own);
	return agent;
}

/** what one request was made of besides itself (the members it lost), and whether the collector took it */
typedef struct Handling {
	Json *discarded;
	bool taken;
} Handling;

/** sets a member, keeping what it held among the discarded */
static void replace(Json *json, const char *key, Json *value, Handling *h) {
	Json *was = jsonGet(json, key);
	if (was) jsonPush(h->discarded, was);
	jsonSet(json, key, strlen(key), value);
}

/** a write, collected (collect.h) when the binding has a collector: read before, written, read after */
static Reply collected(Speaker *speaker, Request *request, Handling *h) {
	Collector *collector = speaker->binding.collector;
	if (!collector || request->err.kind) return respond(&speaker->session, request);
	Request probe = *request;
	ErmCtx ctx = ctxOf(&probe);
	ErmAddress address = addressOf(&probe);
	Before before = probe.err.kind ? (Before){ 0 } : collectBefore(collector, &ctx, &address);
	Reply reply = respond(&speaker->session, request);
	if (reply.ok && !reply.error.kind) {
		Json *tree = jsonArray();
		jsonPush(tree, request->json);
		jsonPush(tree, h->discarded);
		h->taken = collectAfter(collector, &ctx, &address, before, tree);
		if (!h->taken) {
			free(tree->array.items);
			free(tree);
		}
	}
	free(ctx.place.names.items);
	free(address.names.items);
	return reply;
}

static Reply answer(Speaker *speaker, Request *request, Json *cause, Handling *h) {
	const char *cmd = request->cmd;
	Binding *b = &speaker->binding;
	Json *json = request->json;
	if (speaker->stopped) return replyError(ermInvalid("stopped"));
	if (b->bound || !jsonGet(json, "agent")) replace(json, "agent", agentFor(b, jsonGet(json, "agent"), h->discarded), h);
	if (b->bound) {
		if (jsonGet(json, "process")) jsonPush(h->discarded, jsonGet(json, "process"));
		jsonRemove(json, "process", 7);
		if (b->process) jsonSet(json, "process", 7, jsonString(b->process));
		// a place below its own, chrooted at its own (plus the request's chroot); otherwise its own
		Json *below = jsonGet(json, "place"), *hidden = jsonGet(json, "chroot");
		bool under = jsonIsArray(below);
		for (int i = 0; under && i < below->array.count; i++) under = jsonText(below->array.items[i]) != NULL;
		int64_t more = 0;
		if (under && hidden && !jsonIsWhole(hidden, &more)) more = -1;
		if (under && more >= 0 && more <= below->array.count) {
			Json *place = names(&b->place.names, b->place.names.count);
			for (int i = 0; i < below->array.count; i++) jsonPush(place, below->array.items[i]);
			replace(json, "place", place, h);
			replace(json, "chroot", jsonInteger(b->place.names.count + more), h);
		} else if (under) {
			return replyError(ermDetail(ermInvalid("wrong-field"), "field", jsonString("chroot")));
		} else {
			replace(json, "place", names(&b->place.names, b->place.names.count), h);
			replace(json, "chroot", jsonInteger(b->place.chroot), h);
		}
	}
	if (cause && !jsonGet(json, "cause")) jsonSet(json, "cause", 5, cause);
	replace(json, "time", jsonNumber(*speaker->clock + 1), h);
	const char *unsupported[] = { "reset", "reload", "batch", "start", "fire" };
	for (size_t i = 0; i < sizeof unsupported / sizeof *unsupported; i++) {
		if (strcmp(cmd, unsupported[i]) == 0) return (Reply){ NULL, ermOk(), cmd };
	}
	if (strcmp(cmd, "subscribe") == 0 || strcmp(cmd, "unsubscribe") == 0) {
		Reply reply = subscription(speaker, request);
		reply.error.op = cmd;
		return reply;
	}
	Reply reply = strcmp(cmd, "write") == 0 ? collected(speaker, request, h) : respond(&speaker->session, request);
	bool change = strcmp(cmd, "write") == 0 || strcmp(cmd, "place") == 0 || strcmp(cmd, "unplace") == 0;
	if (reply.ok && change) {
		*speaker->clock = ermGraphLast(speaker->session.top);
		Json *ephemeral = jsonGet(json, "ephemeral");
		if (strcmp(cmd, "place") == 0 && ephemeral && ephemeral->type == JSON_BOOLEAN && ephemeral->boolean) {
			ERM_PUSH(speaker->made, jsonText(jsonGet(json, "id")));
		}
	}
	return reply;
}

static Json *answered(Json *seq, Reply reply) {
	Json *out = jsonObject();
	jsonAdd(out, "seq", seq ? seq : jsonNull());
	if (reply.unsupported) jsonAdd(out, "unsupported", jsonString(reply.unsupported));
	else if (reply.error.kind) jsonAdd(out, "error", ermErrToJson(reply.error));
	else jsonAdd(out, "ok", reply.ok);
	return out;
}

/**
 * a request already read as one JSON object; *done says whether the request
 * holds nothing the graph keeps once answered, so it may be freed with what
 * it lost (h->discarded): a read, directory, lookup, events, unsubscribe, an
 * unsupported command, or any error; a write the collector took is its
 */
static Json *requestAnswer(Speaker *speaker, Json *json, Json *cause, Handling *h, bool *done) {
	Request request = { json, jsonText(jsonGet(json, "cmd")), ermOk() };
	Json *seq = jsonGet(json, "seq");
	*done = false;
	if (!request.cmd) {
		problem(&request, jsonGet(json, "cmd") ? "wrong-field" : "missing", "cmd");
		*done = true;
		return answered(seq, replyError(request.err));
	}
	Reply reply = answer(speaker, &request, cause, h);
	static const char *const passing[] = { "read", "directory", "lookup", "events", "unsubscribe" };
	*done = reply.unsupported || reply.error.kind;
	for (size_t i = 0; i < sizeof passing / sizeof *passing; i++) *done = *done || strcmp(request.cmd, passing[i]) == 0;
	*done = *done && !h->taken;
	return answered(seq, reply);
}

Json *speakerRequest(Speaker *speaker, Json *request, Json *cause) {
	Handling h = { jsonArray(), false };
	bool done;
	return requestAnswer(speaker, request, cause, &h, &done);
}

char *speakerLine(Speaker *speaker, const char *line, size_t length) {
	char *why = NULL;
	Json *read = NULL;
	Json *json = jsonParseRead(line, length, &why, &read);
	Json *out;
	Handling h = { jsonArray(), false };
	bool done = false;
	if (jsonIsObject(json)) {
		out = requestAnswer(speaker, json, NULL, &h, &done);
	} else {
		ErmErr err = ermDetail(ermInvalid("not-a-request"), "text", jsonString(why ? why : "a request is one JSON object"));
		out = answered(seqRead(read), replyError(err));
		jsonFree(json);
		json = NULL;
	}
	free(why);
	jsonFree(read);
	char *text = jsonPrint(out);
	// printed: what the answer made is freed (an error's is left: its parts may be the request's or anyone's);
	// then the request, when nothing keeps it
	if (!jsonGet(out, "error")) jsonFreeAnswer(out);
	if (done) {
		Json *roots[] = { json, h.discarded };
		jsonSweep(roots, 2, NULL, 0);
	} else if (!h.taken && !json) {
		jsonSweep(&h.discarded, 1, NULL, 0);
	}
	return text;
}
