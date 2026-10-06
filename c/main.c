// main.c: the harness. PROTOCOL.tex Lines, Encodings, The session,
// Commands. Owner: the Protect+Main agent.
//
// The line loop: one JSON object per line each way, every request answered
// in order under its seq, nothing else on stdout, exit when stdin closes; a
// line that is not one JSON object is an invalid error under seq null (a
// line that parses as an object but has no string cmd is invalid under its
// seq).
//
// Choices the protocol leaves to the harness (as haskell/Main.hs):
// - A request needs a string cmd and, except reset and events, an agent;
//   missing required fields are invalid (main's own check). Argument values
//   pass to the stack raw, so the graph decides whether they are good.
// - reset answers null. A request before the first reset is invalid.
// - "process" is the process a request acts as, except in fire, where it
//   names the process whose handler runs (fire acts as no process).
// - "path" is the path a request acts at; lookup needs one.
// - Below drive a given "time" must be a whole number; a missing one is
//   passed as ERM_NO_TIME and the graph rejects it ("a change needs a
//   time"). With drive "time" is ignored.
// - With drive every change answer carries "runs" and "stopped" from the
//   driver's take after the request, failed requests included. Inside a
//   batch each inner answer is built the same way; the batch's runs and
//   stopped are what finished after the last inner request.
// - events on an unknown subscription is invalid; unsubscribing keeps what
//   already arrived, for a later events.
// Requests are never freed (the graph may keep parts of them); the printed
// answer is.

#define _POSIX_C_SOURCE 200809L // getdelim

#include "ermine.h"

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/** one subscription's events since the last "events" */
typedef struct Queue {
	ERM_LIST(Json *) events;
} Queue;

/** one harness session: the stack reset built */
typedef struct Session {
	bool started;      // a reset has built a stack
	ErmInterface top;  // every request enters here
	ErmDriver *driver; // with stack "drive"; NULL otherwise
	ErmMap events;     // subscription number (decimal text) -> Queue *
} Session;

/** what a request is answered with, before its seq is added: exactly one of ok, error, unsupported */
typedef struct Reply {
	Json *ok;                // the result (a JSON null for reset/unsubscribe)
	ErmErr error;            // kind != ERM_OK: {"error": ermErrToJson(error)}
	const char *unsupported; // the command, when the stack does not have it
} Reply;

static Reply replyOk(Json *ok) {
	return (Reply){ ok, ermOk(), NULL };
}

static Reply replyError(ErmErr error) {
	return (Reply){ NULL, error, NULL };
}

static Reply replyUnsupported(const char *cmd) {
	return (Reply){ NULL, ermOk(), cmd };
}

/** the answer's fields after seq, added to `object`: also the shape of a batch's inner answers */
static void replyFields(Json *object, Reply reply) {
	if (reply.unsupported) jsonAdd(object, "unsupported", jsonString(reply.unsupported));
	else if (reply.error.kind) jsonAdd(object, "error", ermErrToJson(reply.error));
	else jsonAdd(object, "ok", reply.ok ? reply.ok : jsonNull());
}

// the session ----------------------------------------------------------------------

/** PROTOCOL The session: reset {stack, rules?, root?} */
static Reply reset(Session *session, Json *request) {
	const char *stack = jsonText(jsonGet(request, "stack"));
	if (!stack) return replyError(ermInvalid("reset needs a string stack"));
	ErmInterface top;
	ErmDriver *driver = NULL;
	if (strcmp(stack, "graph") == 0) {
		top = ermGraph();
	} else if (strcmp(stack, "protect") == 0 || strcmp(stack, "drive") == 0) {
		bool drive = strcmp(stack, "drive") == 0;
		const char *root = NULL;
		if (drive) {
			root = jsonText(jsonGet(request, "root"));
			if (!root) return replyError(ermInvalid("a drive reset needs a string root"));
		}
		ErmRules *rules = allocate(sizeof *rules);
		ErmErr err = ermRulesFrom(jsonGet(request, "rules"), rules);
		if (err.kind) return replyError(err);
		ErmInterface graph = ermGraph();
		ErmInterface protect = ermProtect(graph, ermMayFromRules, rules);
		if (drive) {
			driver = ermDrive(protect, graph, root, ermLoadProgram);
			top = ermDriverInterface(driver);
		} else {
			top = protect;
		}
	} else {
		return replyError(ermInvalid("there is no stack %s", stack));
	}
	top.vt->setTop(top.self, top);
	*session = (Session){ .started = true, .top = top, .driver = driver };
	return replyOk(jsonNull());
}

// decoding requests ----------------------------------------------------------------

/** a required field: *out set, or an invalid error */
static ErmErr need(const char *cmd, const char *key, Json *request, Json **out) {
	*out = jsonGet(request, key);
	if (!*out) return ermInvalid("%s needs %s", cmd, key);
	return ermOk();
}

static ErmErr needText(const char *cmd, const char *key, Json *request, const char **out) {
	Json *value;
	ErmErr err = need(cmd, key, request, &value);
	if (err.kind) return err;
	*out = jsonText(value);
	if (!*out) return ermInvalid("%s's %s must be a string", cmd, key);
	return ermOk();
}

static ErmErr needWhole(const char *cmd, const char *key, Json *request, int64_t *out) {
	Json *value;
	ErmErr err = need(cmd, key, request, &value);
	if (err.kind) return err;
	if (!jsonIsWhole(value, out)) return ermInvalid("%s's %s must be a whole number", cmd, key);
	return ermOk();
}

/** the acting context of a request from outside: its agent, the process it acts as, the path it acts at */
static ErmErr ctxOf(const char *cmd, Json *request, ErmCtx *out) {
	Json *agent;
	ErmErr err = need(cmd, "agent", request, &agent);
	if (err.kind) return err;
	const char *process = NULL;
	if (strcmp(cmd, "fire") != 0) {
		Json *value = jsonGet(request, "process");
		if (value) {
			process = jsonText(value);
			if (!process) return ermInvalid("process must be a string");
		}
	}
	ErmPath path = { 0 };
	Json *pathValue = jsonGet(request, "path");
	if (pathValue) {
		err = ermPathFrom(pathValue, &path);
		if (err.kind) return err;
	} else if (strcmp(cmd, "lookup") == 0) {
		return ermInvalid("lookup needs a path");
	}
	*out = ermOutsideCtx(agent, process, path);
	return ermOk();
}

/** a change's stamp: cause and site as given; below drive the request's time, with drive none */
static ErmErr stampOf(const Session *session, Json *request, ErmStamp *out) {
	ErmStamp stamp = { jsonGet(request, "cause"), jsonGet(request, "site"), 0 };
	Json *time = jsonGet(request, "time");
	if (!session->driver && time && !jsonIsWhole(time, &stamp.time)) {
		return ermInvalid("time must be a whole number");
	}
	if (!session->driver && !time) stamp.time = ERM_NO_TIME;
	*out = stamp;
	return ermOk();
}

// answers --------------------------------------------------------------------------

static Json *absentJson(void) {
	Json *object = jsonObject();
	jsonAdd(object, "absent", jsonBoolean(true));
	return object;
}

static Json *keyed(const char *key, Json *value) {
	Json *object = jsonObject();
	jsonAdd(object, key, value);
	return object;
}

/** read, data, directory and lookup answers */
static Json *resultJson(ErmOpKind kind, const ErmResult *result) {
	switch (kind) {
		case ERM_OP_READ: return result->value ? keyed("value", result->value) : absentJson();
		case ERM_OP_DATA: return result->data ? keyed("data", result->data) : absentJson();
		case ERM_OP_DIRECTORY:
			switch (result->listing) {
				case ERM_LIST_ABSENT: return absentJson();
				case ERM_LIST_SLOT: return keyed("slot", ermIdsToJson(&result->slot));
				case ERM_LIST_WHOLE: {
					Json *list = jsonArray();
					for (int i = 0; i < result->whole.count; i++) {
						Json *pair = jsonArray();
						jsonPush(pair, jsonString(result->whole.items[i].name));
						jsonPush(pair, ermIdsToJson(&result->whole.items[i].ids));
						jsonPush(list, pair);
					}
					return keyed("directory", list);
				}
			}
			return absentJson();
		case ERM_OP_LOOKUP: return keyed("found", ermIdsToJson(&result->found));
		default: return ermAppliedToJson(&result->applied);
	}
}

/** "runs" and "stopped", with drive: what the driver finished since the last take */
static void addRan(const Session *session, Json *object) {
	if (!session->driver) return;
	ErmRan ran = ermDriverTake(session->driver);
	Json *runs = jsonArray();
	for (int i = 0; i < ran.runs.count; i++) jsonPush(runs, ermRecordToJson(ran.runs.items[i]));
	jsonAdd(object, "runs", runs);
	Json *stopped = jsonArray();
	for (int i = 0; i < ran.stopped.count; i++) {
		Json *stop = jsonObject();
		jsonAdd(stop, "process", jsonString(ran.stopped.items[i].process));
		jsonAdd(stop, "changes", ermChangesToJson(&ran.stopped.items[i].changes));
		jsonPush(stopped, stop);
	}
	jsonAdd(object, "stopped", stopped);
}

// commands -------------------------------------------------------------------------

static void queueEvent(void *data, const ErmEvent *event) {
	Queue *queue = data;
	ERM_PUSH(queue->events, ermEventToJson(event));
}

static char *subKey(int64_t sub) {
	return formatString("%lld", (long long)sub);
}

static Reply change(Session *session, const char *cmd, Json *request, ErmOp op) {
	ErmCtx ctx;
	ErmStamp stamp;
	ErmErr err = ctxOf(cmd, request, &ctx);
	if (!err.kind) err = stampOf(session, request, &stamp);
	if (err.kind) return replyError(err);
	ErmResult result = { 0 };
	err = session->top.vt->op(session->top.self, &ctx, &stamp, &op, &result);
	if (err.kind) {
		if (session->driver) ermDriverTake(session->driver); // nothing the failed request finished is answered
		return replyError(err);
	}
	Json *answer = ermAppliedToJson(&result.applied);
	addRan(session, answer);
	return replyOk(answer);
}

static Reply query(Session *session, const char *cmd, Json *request, ErmOp op) {
	ErmCtx ctx;
	ErmErr err = ctxOf(cmd, request, &ctx);
	if (err.kind) return replyError(err);
	ErmResult result = { 0 };
	ErmStamp stamp = ermNoStamp();
	err = session->top.vt->op(session->top.self, &ctx, &stamp, &op, &result);
	if (err.kind) return replyError(err);
	return replyOk(resultJson(op.kind, &result));
}

/** the fields every command takes from the request, or an invalid error */
#define NEED(key, var) \
	do { \
		ErmErr needErr = need(cmd, key, request, &var); \
		if (needErr.kind) return replyError(needErr); \
	} while (0)

static Reply dispatch(Session *session, const char *cmd, Json *request);

static Reply batch(Session *session, const char *cmd, Json *request) {
	Json *requests;
	NEED("requests", requests);
	if (!jsonIsArray(requests)) return replyError(ermInvalid("batch's requests must be a list"));
	Json *answers = jsonArray();
	ermDriverBatchBegin(session->driver);
	for (int i = 0; i < requests->array.count; i++) {
		Json *inner = requests->array.items[i];
		const char *innerCmd = jsonText(jsonGet(inner, "cmd"));
		Reply reply;
		if (!jsonIsObject(inner) || !innerCmd) {
			reply = replyError(ermInvalid("a batch's request must be an object with a string cmd"));
		} else if (strcmp(innerCmd, "reset") == 0) {
			reply = replyError(ermInvalid("a batch cannot reset"));
		} else {
			reply = dispatch(session, innerCmd, inner);
		}
		Json *answer = jsonObject();
		replyFields(answer, reply);
		jsonPush(answers, answer);
	}
	ermDriverBatchEnd(session->driver);
	Json *ok = keyed("answers", answers);
	addRan(session, ok);
	return replyOk(ok);
}

static Reply fire(Session *session, const char *cmd, Json *request) {
	ErmCtx ctx;
	const char *process, *handler;
	ErmErr err = ctxOf(cmd, request, &ctx);
	if (!err.kind) err = needText(cmd, "process", request, &process);
	if (!err.kind) err = needText(cmd, "handler", request, &handler);
	if (err.kind) return replyError(err);
	ErmFired fired = { 0 };
	err = ermDriverFire(session->driver, &ctx, process, handler, jsonGet(request, "input"), &fired);
	if (err.kind) {
		ermDriverTake(session->driver);
		return replyError(err);
	}
	Json *ok = keyed("changes", ermChangesToJson(&fired.changes));
	addRan(session, ok);
	if (fired.error.kind) jsonAdd(ok, "error", ermErrToJson(fired.error));
	return replyOk(ok);
}

/** PROTOCOL Commands: one request (an object with a string cmd) after reset */
static Reply dispatch(Session *session, const char *cmd, Json *request) {
	Json *a, *b, *c;
	if (strcmp(cmd, "make") == 0) {
		NEED("id", a);
		NEED("value", b);
		return change(session, cmd, request, ermOpMake(a, b, jsonGet(request, "data")));
	}
	if (strcmp(cmd, "write") == 0) {
		NEED("node", a);
		NEED("patches", b);
		return change(session, cmd, request, ermOpWrite(a, b));
	}
	if (strcmp(cmd, "place") == 0) {
		NEED("parent", a);
		NEED("name", b);
		NEED("id", c);
		return change(session, cmd, request, ermOpPlace(a, b, c, jsonGet(request, "position")));
	}
	if (strcmp(cmd, "unplace") == 0) {
		NEED("parent", a);
		NEED("name", b);
		NEED("id", c);
		return change(session, cmd, request, ermOpUnplace(a, b, c));
	}
	if (strcmp(cmd, "read") == 0) {
		NEED("node", a);
		return query(session, cmd, request, ermOpRead(a));
	}
	if (strcmp(cmd, "data") == 0) {
		NEED("node", a);
		return query(session, cmd, request, ermOpData(a));
	}
	if (strcmp(cmd, "directory") == 0) {
		NEED("node", a);
		return query(session, cmd, request, ermOpDirectory(a, jsonGet(request, "name")));
	}
	if (strcmp(cmd, "lookup") == 0) {
		NEED("name", a);
		return query(session, cmd, request, ermOpLookup(a));
	}
	if (strcmp(cmd, "subscribe") == 0) {
		ErmCtx ctx;
		ErmErr err = ctxOf(cmd, request, &ctx);
		if (err.kind) return replyError(err);
		NEED("node", a);
		Queue *queue = allocate(sizeof *queue);
		int64_t sub = 0;
		err = session->top.vt->subscribe(session->top.self, &ctx, a, queueEvent, queue, &sub);
		if (err.kind) return replyError(err);
		char *key = subKey(sub);
		ermMapPut(&session->events, key, queue);
		free(key);
		return replyOk(keyed("sub", jsonInteger(sub)));
	}
	if (strcmp(cmd, "unsubscribe") == 0) {
		ErmCtx ctx;
		int64_t sub;
		ErmErr err = ctxOf(cmd, request, &ctx);
		if (!err.kind) err = needWhole(cmd, "sub", request, &sub);
		if (err.kind) return replyError(err);
		err = session->top.vt->unsubscribe(session->top.self, &ctx, sub);
		if (err.kind) return replyError(err);
		return replyOk(jsonNull());
	}
	if (strcmp(cmd, "events") == 0) {
		int64_t sub;
		ErmErr err = needWhole(cmd, "sub", request, &sub);
		if (err.kind) return replyError(err);
		char *key = subKey(sub);
		Queue *queue = ermMapGet(&session->events, key);
		free(key);
		if (!queue) return replyError(ermInvalid("there is no subscription %lld", (long long)sub));
		Json *list = jsonArray();
		for (int i = 0; i < queue->events.count; i++) jsonPush(list, queue->events.items[i]);
		queue->events.count = 0;
		return replyOk(list);
	}
	if (strcmp(cmd, "batch") == 0) {
		if (!session->driver) return replyUnsupported(cmd);
		return batch(session, cmd, request);
	}
	if (strcmp(cmd, "fire") == 0) {
		if (!session->driver) return replyUnsupported(cmd);
		return fire(session, cmd, request);
	}
	return replyUnsupported(cmd);
}

static Reply respond(Session *session, const char *cmd, Json *request) {
	if (strcmp(cmd, "reset") == 0) return reset(session, request);
	if (!session->started) return replyError(ermInvalid("no session: send reset first"));
	return dispatch(session, cmd, request);
}

// lines ----------------------------------------------------------------------------

/** one line in, one answer out (PROTOCOL Lines) */
static Json *answerLine(Session *session, const char *line, size_t length) {
	char *why = NULL;
	Json *request = jsonParse(line, length, &why);
	Json *answer = jsonObject();
	if (!request || !jsonIsObject(request)) {
		jsonAdd(answer, "seq", jsonNull());
		replyFields(answer, replyError(ermInvalid("%s", request ? "a request must be one JSON object" : why)));
		free(why);
		if (request) jsonFree(request);
		return answer;
	}
	Json *seq = jsonGet(request, "seq");
	jsonAdd(answer, "seq", seq ? seq : jsonNull());
	const char *cmd = jsonText(jsonGet(request, "cmd"));
	if (!cmd) replyFields(answer, replyError(ermInvalid("a request needs a string cmd")));
	else replyFields(answer, respond(session, cmd, request));
	return answer;
}

/** the line loop, run on the big stack */
static void *serve(void *unused) {
	(void)unused;
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
	return NULL;
}

/**
 * Values, paths and the process tree can nest as deep as requests make them:
 * no limit is in the protocol, and parsing, printing, comparing, patching
 * and the tree walk recurse once per level. So the session runs on a thread
 * whose stack is far bigger than any line or session reaches. The memory is
 * only reserved: pages are touched as the recursion goes, so a shallow
 * session costs what it would on the main thread. If the stack cannot be
 * had, fall back to smaller ones, then to the main thread.
 */
int main(void) {
	static const size_t sizes[] = { (size_t)64 << 30, (size_t)16 << 30, (size_t)4 << 30, (size_t)1 << 30, (size_t)256 << 20 };
	for (size_t i = 0; i < sizeof sizes / sizeof *sizes; i++) {
		pthread_attr_t attr;
		pthread_t thread;
		if (pthread_attr_init(&attr) != 0) break;
		bool ok = pthread_attr_setstacksize(&attr, sizes[i]) == 0 && pthread_create(&thread, &attr, serve, NULL) == 0;
		pthread_attr_destroy(&attr);
		if (ok) {
			pthread_join(thread, NULL);
			return 0;
		}
	}
	serve(NULL);
	return 0;
}
