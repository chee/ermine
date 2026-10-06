// main.c: the harness. PROTOCOL.tex Lines, Encodings, Errors, The session,
// Commands.
//
// One JSON object per line each way: every request is answered in order
// under its seq, nothing else goes to stdout, and the harness exits when
// stdin closes. Only the graph stack is built: a reset with stack "protect"
// or "drive" is unsupported, and so are batch and fire. A request is checked
// field by field, in the order the commands below read them, and the first
// problem answers (missing, wrong-field); then the graph checks it. The
// readings the protocol leaves open are in NOTES.md.
//
// Requests are never freed (the graph keeps parts of them); each printed
// answer is.

#define _POSIX_C_SOURCE 200809L // getdelim

#include "ermine.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/** one subscription's changes since the last events */
typedef struct Queue {
	ERM_LIST(Json *) events;
} Queue;

/** what reset built */
typedef struct Session {
	bool started;
	ErmInterface top;
	ERM_LIST(Queue *) queues; // by subscription number, from 1, as the graph numbers them
} Session;

/** a request being read: the first problem found with it stands */
typedef struct Request {
	Json *json;
	const char *cmd;
	ErmErr err;
} Request;

/** what a request is answered with, before its seq: exactly one of ok, error and unsupported */
typedef struct Reply {
	Json *ok;
	ErmErr error;
	const char *unsupported;
} Reply;

static Reply replyOk(Json *ok) {
	return (Reply){ ok, ermOk(), NULL };
}

static Reply replyError(ErmErr error) {
	return (Reply){ NULL, error, NULL };
}

static Json *keyed(const char *key, Json *value) {
	Json *object = jsonObject();
	jsonAdd(object, key, value);
	return object;
}

// reading a request ---------------------------------------------------------------

static void problem(Request *request, const char *code, const char *field) {
	if (!request->err.kind) request->err = ermDetail(ermInvalid(code), "field", jsonString(field));
}

static Json *field(Request *request, const char *key, bool required) {
	Json *value = jsonGet(request->json, key);
	if (!value && required) problem(request, "missing", key);
	return value;
}

/** a string field; a name, when `name`, may not be ".", ".." or "/" */
static const char *text(Request *request, const char *key, bool required, bool name) {
	Json *value = field(request, key, required);
	const char *out = jsonText(value);
	if (value && (!out || (name && !ermIsName(out)))) problem(request, "wrong-field", key);
	return out;
}

/**
 * a whole number field of any size, at least `least`: false when it is not
 * given or not one. Past int64 it is held at the edge (jsonIsWhole), still
 * past every count it is checked against: position, chroot, sub.
 */
static bool whole(Request *request, const char *key, bool required, int64_t least, int64_t *out) {
	Json *value = field(request, key, required);
	if (!value) return false;
	if (jsonIsWhole(value, out) && *out >= least) return true;
	problem(request, "wrong-field", key);
	return false;
}

/** a time: a whole number of any size, kept as given; whether it is late enough is for the graph (code time) */
static ErmTime timeOf(Request *request) {
	Json *value = field(request, "time", true);
	if (!value) return 0;
	if (jsonIsWhole(value, NULL)) return value->number;
	problem(request, "wrong-field", "time");
	return 0;
}

/** PROTOCOL Acting as someone: agent, process?, place?, chroot? */
static ErmCtx ctxOf(Request *request) {
	ErmCtx ctx = { .agent = field(request, "agent", true) };
	ctx.process = text(request, "process", false, false);
	Json *place = field(request, "place", false);
	if (place && !ermNamesFrom(place, &ctx.place.names)) problem(request, "wrong-field", "place");
	int64_t chroot;
	if (whole(request, "chroot", false, 0, &chroot)) {
		if (chroot > ctx.place.names.count) problem(request, "wrong-field", "chroot");
		else ctx.place.chroot = (int)chroot;
	}
	return ctx;
}

static ErmAddress addressOf(Request *request) {
	ErmAddress address = { 0 };
	Json *value = field(request, "address", true);
	if (value && !ermAddressFrom(value, &address)) problem(request, "wrong-field", "address");
	return address;
}

// the session ----------------------------------------------------------------------

/** PROTOCOL The session: reset {stack, root} */
static Reply reset(Session *session, Request *request) {
	const char *stack = text(request, "stack", true, false);
	if (stack && (strcmp(stack, "protect") == 0 || strcmp(stack, "drive") == 0)) return (Reply){ NULL, ermOk(), "reset" };
	if (stack && strcmp(stack, "graph") != 0) problem(request, "wrong-field", "stack");
	const char *root = text(request, "root", true, false);
	if (request->err.kind) return replyError(request->err);
	*session = (Session){ .started = true, .top = ermGraph(root) };
	session->top.vt->setTop(session->top.self, session->top);
	return replyOk(jsonNull());
}

static void queueChange(void *data, const ErmChange *change) {
	Queue *queue = data;
	ERM_PUSH(queue->events, keyed("change", ermChangeToJson(change)));
}

/** the queue of the subscription the request names, or NULL (wrong-field sub) */
static Queue *queueOf(Session *session, Request *request, int64_t *sub) {
	if (!whole(request, "sub", true, 1, sub)) return NULL;
	if (*sub > session->queues.count) {
		problem(request, "wrong-field", "sub");
		return NULL;
	}
	return session->queues.items[*sub - 1];
}

// commands -------------------------------------------------------------------------

/** PROTOCOL Commands, below drive */
static Reply command(Session *session, Request *request) {
	const char *cmd = request->cmd;
	ErmCtx ctx = ctxOf(request);
	ErmInterface top = session->top;
	if (strcmp(cmd, "subscribe") == 0) {
		ErmAddress address = addressOf(request);
		if (request->err.kind) return replyError(request->err);
		Queue *queue = allocate(sizeof *queue);
		int64_t sub;
		ErmErr err = top.vt->subscribe(top.self, &ctx, &address, queueChange, queue, &sub);
		if (err.kind) return replyError(err);
		ERM_PUSH(session->queues, queue);
		return replyOk(keyed("sub", jsonInteger(sub)));
	}
	if (strcmp(cmd, "unsubscribe") == 0 || strcmp(cmd, "events") == 0) {
		int64_t sub;
		Queue *queue = queueOf(session, request, &sub);
		if (request->err.kind) return replyError(request->err);
		if (strcmp(cmd, "events") == 0) {
			// what arrived since the last events; unsubscribing keeps what already arrived
			Json *list = jsonArray();
			for (int i = 0; i < queue->events.count; i++) jsonPush(list, queue->events.items[i]);
			queue->events.count = 0;
			return replyOk(list);
		}
		ErmErr err = top.vt->unsubscribe(top.self, &ctx, sub);
		return err.kind ? replyError(err) : replyOk(jsonNull());
	}
	ErmOp op = { 0 };
	ErmStamp stamp = { 0 };
	while (strcmp(ermOpName(op.kind), cmd) != 0) op.kind++;
	bool slot = op.kind == ERM_OP_PLACE || op.kind == ERM_OP_UNPLACE;
	if (op.kind != ERM_OP_LOOKUP) op.address = addressOf(request);
	if (op.kind == ERM_OP_DIRECTORY || op.kind == ERM_OP_LOOKUP || slot) op.name = text(request, "name", op.kind != ERM_OP_DIRECTORY, true);
	if (slot) op.id = text(request, "id", true, false);
	if (op.kind == ERM_OP_PLACE) {
		op.hasPosition = whole(request, "position", false, 0, &op.position);
		op.value = field(request, "value", false);
	}
	if (op.kind == ERM_OP_WRITE) {
		op.patches = field(request, "patches", true);
		if (op.patches && !jsonIsArray(op.patches)) problem(request, "wrong-field", "patches");
	}
	bool changes = ermOpIsChange(op.kind);
	if (changes) {
		// below drive every change carries its time; from outside, its cause, which stands for its site
		stamp.cause = field(request, "cause", true);
		stamp.time = timeOf(request);
	}
	if (request->err.kind) return replyError(request->err);
	ErmResult result = { 0 };
	ErmErr err = top.vt->op(top.self, &ctx, &stamp, &op, &result);
	if (err.kind) return replyError(err);
	if (changes) return replyOk(ermChangeAnswer(&result));
	if (op.kind == ERM_OP_DIRECTORY && !op.name) return replyOk(keyed("directory", ermListingToJson(&result.listing)));
	return replyOk(keyed("items", ermItemsToJson(&result.items)));
}

static Reply respond(Session *session, Request *request) {
	const char *cmd = request->cmd;
	if (strcmp(cmd, "batch") == 0 || strcmp(cmd, "fire") == 0) return (Reply){ NULL, ermOk(), cmd }; // only with drive
	// CORE's operations; reset and events are the harness's, so their errors name no op (PROTOCOL Errors)
	bool operation = strcmp(cmd, "subscribe") == 0 || strcmp(cmd, "unsubscribe") == 0;
	for (int kind = ERM_OP_READ; kind <= ERM_OP_UNPLACE; kind++) operation = operation || strcmp(cmd, ermOpName(kind)) == 0;
	if (!operation && strcmp(cmd, "reset") != 0 && strcmp(cmd, "events") != 0) {
		return replyError(ermDetail(ermInvalid("unknown-command"), "cmd", jsonString(cmd)));
	}
	Reply reply;
	if (strcmp(cmd, "reset") == 0) {
		reply = reset(session, request);
	} else if (!session->started) {
		problem(request, "missing", "reset");
		reply = replyError(ermDetail(request->err, "text", jsonString("no session: send reset first")));
	} else {
		reply = command(session, request);
	}
	if (operation) reply.error.op = cmd;
	return reply;
}

// lines ----------------------------------------------------------------------------

/** one line in, one answer out (PROTOCOL Lines) */
static Json *answerLine(Session *session, const char *line, size_t length) {
	char *why = NULL;
	Json *json = jsonParse(line, length, &why);
	Json *answer = jsonObject();
	Json *seq = jsonIsObject(json) ? jsonGet(json, "seq") : NULL;
	jsonAdd(answer, "seq", seq ? seq : jsonNull());
	Reply reply;
	if (!jsonIsObject(json)) {
		ErmErr err = ermInvalid("not-a-request");
		reply = replyError(ermDetail(err, "text", jsonString(why ? why : "a request is one JSON object")));
		free(why);
		jsonFree(json);
	} else {
		Request request = { json, jsonText(jsonGet(json, "cmd")), ermOk() };
		if (!request.cmd) {
			problem(&request, jsonGet(json, "cmd") ? "wrong-field" : "missing", "cmd");
			reply = replyError(request.err);
		} else {
			reply = respond(session, &request);
		}
	}
	if (reply.unsupported) jsonAdd(answer, "unsupported", jsonString(reply.unsupported));
	else if (reply.error.kind) jsonAdd(answer, "error", ermErrToJson(reply.error));
	else jsonAdd(answer, "ok", reply.ok);
	return answer;
}

int main(void) {
	Session session = { 0 };
	char *line = NULL;
	size_t capacity = 0;
	ssize_t length;
	while ((length = getdelim(&line, &capacity, '\n', stdin)) != -1) {
		if (length > 0 && line[length - 1] == '\n') length--;
		char *text = jsonPrint(answerLine(&session, line, (size_t)length));
		fputs(text, stdout);
		fputc('\n', stdout);
		fflush(stdout);
		free(text);
	}
	free(line);
	return 0;
}
