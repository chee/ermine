// program.c: the test program language. PROTOCOL.tex "Programs as data":
// expressions, variables, steps. Owner: the Drive+Program agent.
//
// ermLoadProgram turns a program node's value (a list of step objects) into
// an ErmProgram; the same steps run as a compute (variables self, path,
// changes; api read-only) or as an effect (self, value, previous; api
// write-only). A handler step registers an ErmNamedHandler; a cleanup step
// sets the cleanup; both are ErmHandlers whose steps run later with the
// lasting interface (a handler has self and input, a cleanup only self).
//
// Readings (the same as ../haskell/Program.hs):
// - Absent is a NULL Json; a variable may hold it, a value never does: a
//   member of a list or object that evaluates to absent throws.
// - "$get" answers absent for a key that is not there, including a key into
//   a value that is not an object or a list; "$concat" of nothing is [];
//   "return" with no value returns null; a "throw" with no message throws
//   null; a directory step on an absent node binds [].
// - One flat scope per part: a variable bound inside an if, each or try is
//   still bound after it.
// - read/directory/lookup in an effect or handler, and make/write/place/
//   unplace in a compute, are made anyway: the graph answers invalid (the
//   mode), so the error lands in the record. "pending" outside a compute and
//   "handler"/"cleanup" outside an effect throw.
// - An operation's error is thrown as ermWithOp(err, its name); a caught
//   error is ermErrToJson of it. A throw step's message is its why; an
//   operator error is {"kind": "thrown", "why": text}.

#include "ermine.h"

#include <string.h>

// ===========================================================================
// variables

/** a bound variable: value NULL is absent */
typedef struct Box {
	Json *value;
} Box;

typedef struct Env {
	ErmMap vars;
} Env;

static void bindVar(Env *env, const char *name, Json *value) {
	Box *box = allocate(sizeof *box);
	box->value = value;
	ermMapPut(&env->vars, name, box);
}

// ===========================================================================
// expressions

static ErmErr thrownText(const char *format, const char *detail) {
	return ermThrown(jsonStringFormat(format, detail ? detail : ""));
}

static const char *kindOf(const Json *value) {
	if (!value) return "absent";
	switch (value->type) {
		case JSON_NULL: return "null";
		case JSON_BOOLEAN: return "boolean";
		case JSON_NUMBER: return "number";
		case JSON_STRING: return "string";
		case JSON_ARRAY: return "list";
		case JSON_OBJECT: return "object";
	}
	return "value";
}

static ErmErr evaluate(Env *env, Json *expression, Json **out);

/** evaluates, and throws if the result is absent */
static ErmErr present(Env *env, Json *expression, Json **out) {
	ErmErr err = evaluate(env, expression, out);
	if (err.kind) return err;
	if (!*out) return ermThrown(jsonString("absent is not a value"));
	return ermOk();
}

/** an operator's arguments: a literal list evaluated member by member, or an expression giving a list */
static ErmErr arguments(Env *env, Json *argument, Json **out) {
	if (jsonIsArray(argument)) {
		Json *list = jsonArray();
		for (int i = 0; i < argument->array.count; i++) {
			Json *item;
			ErmErr err = present(env, argument->array.items[i], &item);
			if (err.kind) return err;
			jsonPush(list, item);
		}
		*out = list;
		return ermOk();
	}
	Json *value;
	ErmErr err = present(env, argument, &value);
	if (err.kind) return err;
	if (!jsonIsArray(value)) return ermThrown(jsonString("an operator needs a list"));
	*out = value;
	return ermOk();
}

static bool keyIs(const JsonMember *member, const char *name) {
	return member->keyLength == strlen(name) && memcmp(member->key, name, member->keyLength) == 0;
}

/** one step of $get: absent stays absent; a key not there is absent */
static Json *getStep(Json *value, Json *key) {
	if (!value) return NULL;
	if (jsonIsObject(value) && jsonIsString(key)) return jsonGetOfLength(value, key->string, key->stringLength);
	int64_t index;
	if (jsonIsArray(value) && jsonIsWhole(key, &index) && index >= 0 && index < value->array.count) {
		return value->array.items[index];
	}
	return NULL;
}

static ErmErr operator(Env *env, const JsonMember *member, Json **out) {
	Json *argument = member->value;
	*out = NULL;
	if (keyIs(member, "$")) {
		const char *name = jsonText(argument);
		if (!name) return ermThrown(jsonString("$ needs a variable name"));
		Box *box = ermMapGet(&env->vars, name);
		if (!box) return thrownText("no variable %s", name);
		*out = box->value;
		return ermOk();
	}
	if (keyIs(member, "$get")) {
		if (!jsonIsArray(argument) || argument->array.count < 1) {
			return ermThrown(jsonString("$get needs a list of a value and keys"));
		}
		Json *value;
		ErmErr err = present(env, argument->array.items[0], &value);
		if (err.kind) return err;
		Json **keys = allocate(sizeof *keys * (size_t)argument->array.count);
		for (int i = 1; i < argument->array.count; i++) {
			err = present(env, argument->array.items[i], &keys[i]);
			if (err.kind) return err;
		}
		for (int i = 1; i < argument->array.count; i++) value = getStep(value, keys[i]);
		*out = value;
		return ermOk();
	}
	if (keyIs(member, "$eq")) {
		Json *list;
		ErmErr err = arguments(env, argument, &list);
		if (err.kind) return err;
		if (list->array.count != 2) return ermThrown(jsonString("$eq needs two values"));
		*out = jsonBoolean(jsonEqual(list->array.items[0], list->array.items[1]));
		return ermOk();
	}
	if (keyIs(member, "$not")) {
		Json *value;
		ErmErr err = present(env, argument, &value);
		if (err.kind) return err;
		if (!jsonIsBoolean(value)) return thrownText("$not needs a boolean, not %s", kindOf(value));
		*out = jsonBoolean(!value->boolean);
		return ermOk();
	}
	if (keyIs(member, "$absent")) {
		Json *value;
		ErmErr err = evaluate(env, argument, &value);
		if (err.kind) return err;
		*out = jsonBoolean(value == NULL);
		return ermOk();
	}
	if (keyIs(member, "$add")) {
		Json *list;
		ErmErr err = arguments(env, argument, &list);
		if (err.kind) return err;
		double sum = 0;
		for (int i = 0; i < list->array.count; i++) {
			if (!jsonIsNumber(list->array.items[i])) return ermThrown(jsonString("$add needs numbers"));
			sum += list->array.items[i]->number;
		}
		*out = jsonNumber(sum);
		return ermOk();
	}
	if (keyIs(member, "$concat")) {
		Json *list;
		ErmErr err = arguments(env, argument, &list);
		if (err.kind) return err;
		if (list->array.count == 0) {
			*out = jsonArray();
			return ermOk();
		}
		bool strings = true, lists = true;
		size_t length = 0;
		for (int i = 0; i < list->array.count; i++) {
			Json *item = list->array.items[i];
			if (!jsonIsString(item)) strings = false;
			else length += item->stringLength;
			if (!jsonIsArray(item)) lists = false;
		}
		if (strings) {
			char *text = allocate(length + 1);
			size_t at = 0;
			for (int i = 0; i < list->array.count; i++) {
				Json *item = list->array.items[i];
				memcpy(text + at, item->string, item->stringLength);
				at += item->stringLength;
			}
			*out = jsonStringOfLength(text, length);
			return ermOk();
		}
		if (lists) {
			Json *joined = jsonArray();
			for (int i = 0; i < list->array.count; i++) {
				Json *item = list->array.items[i];
				for (int j = 0; j < item->array.count; j++) jsonPush(joined, item->array.items[j]);
			}
			*out = joined;
			return ermOk();
		}
		return ermThrown(jsonString("$concat needs all strings or all lists"));
	}
	if (keyIs(member, "$len")) {
		Json *value;
		ErmErr err = present(env, argument, &value);
		if (err.kind) return err;
		if (jsonIsString(value)) *out = jsonInteger((int64_t)utf8Count(value->string, value->stringLength));
		else if (jsonIsArray(value)) *out = jsonInteger(value->array.count);
		else if (jsonIsObject(value)) *out = jsonInteger(value->object.count);
		else return thrownText("$len needs a string, list or object, not %s", kindOf(value));
		return ermOk();
	}
	if (keyIs(member, "$quote")) {
		*out = argument;
		return ermOk();
	}
	char *name = copyStringOfLength(member->key, member->keyLength);
	return thrownText("no operator %s", name);
}

/** evaluates an expression; *out NULL is absent */
static ErmErr evaluate(Env *env, Json *expression, Json **out) {
	*out = NULL;
	if (jsonIsObject(expression)) {
		if (expression->object.count == 1 && expression->object.members[0].keyLength > 0 &&
		    expression->object.members[0].key[0] == '$') {
			return operator(env, &expression->object.members[0], out);
		}
		Json *object = jsonObject();
		for (int i = 0; i < expression->object.count; i++) {
			JsonMember *member = &expression->object.members[i];
			Json *value;
			ErmErr err = present(env, member->value, &value);
			if (err.kind) return err;
			jsonAddOfLength(object, member->key, member->keyLength, value);
		}
		*out = object;
		return ermOk();
	}
	if (jsonIsArray(expression)) {
		Json *list = jsonArray();
		for (int i = 0; i < expression->array.count; i++) {
			Json *value;
			ErmErr err = present(env, expression->array.items[i], &value);
			if (err.kind) return err;
			jsonPush(list, value);
		}
		*out = list;
		return ermOk();
	}
	*out = expression;
	return ermOk();
}

// ===========================================================================
// steps

typedef enum { PART_COMPUTE, PART_EFFECT, PART_HANDLER } PartKind;

typedef struct Part {
	PartKind kind;
	ErmApi api;
	Env env;
	ERM_LIST(ErmNamedHandler) handlers; // effect: registered, in order
	bool hasCleanup;
	ErmHandler cleanup;
} Part;

/** how a run of steps ended */
typedef enum { CTL_NONE, CTL_RETURN, CTL_PENDING, CTL_THROW } CtlKind;

typedef struct Ctl {
	CtlKind kind;
	Json *value; // CTL_RETURN
	ErmErr err;  // CTL_THROW
} Ctl;

static Ctl ctlNone(void) {
	return (Ctl){ CTL_NONE, NULL, { 0 } };
}

static Ctl ctlThrow(ErmErr err) {
	return (Ctl){ CTL_THROW, NULL, err };
}

static Ctl ctlThrowText(const char *format, const char *detail) {
	return ctlThrow(thrownText(format, detail));
}

/** the steps a handler or cleanup runs later */
typedef struct HandlerSteps {
	Json *steps;
	bool withInput; // a handler has input; a cleanup does not
} HandlerSteps;

static Ctl runSteps(Part *part, Json *steps);

static ErmErr runHandler(void *self, ErmApi lasting, const char *process, Json *input) {
	HandlerSteps *handler = self;
	Part part = { 0 };
	part.kind = PART_HANDLER;
	part.api = lasting;
	bindVar(&part.env, "self", jsonString(process));
	if (handler->withInput) bindVar(&part.env, "input", input);
	Ctl ctl = runSteps(&part, handler->steps);
	if (ctl.kind == CTL_THROW) return ctl.err;
	return ermOk();
}

static ErmHandler handlerOf(Json *steps, bool withInput) {
	HandlerSteps *handler = allocate(sizeof *handler);
	handler->steps = steps;
	handler->withInput = withInput;
	return (ErmHandler){ handler, runHandler };
}

/** a required field, evaluated, present */
static Ctl need(Part *part, Json *step, const char *key, Json **out) {
	Json *field = jsonGet(step, key);
	if (!field) return ctlThrowText("a step needs %s", key);
	ErmErr err = present(&part->env, field, out);
	return err.kind ? ctlThrow(err) : ctlNone();
}

/** an optional field, evaluated, present when given; *out NULL when not given */
static Ctl optional(Part *part, Json *step, const char *key, Json **out) {
	Json *field = jsonGet(step, key);
	*out = NULL;
	if (!field) return ctlNone();
	ErmErr err = present(&part->env, field, out);
	return err.kind ? ctlThrow(err) : ctlNone();
}

/** a field that must be text, not evaluated */
static Ctl nameAt(Json *step, const char *key, const char **out) {
	*out = jsonText(jsonGet(step, key));
	if (!*out) return ctlThrowText("a step needs a string %s", key);
	return ctlNone();
}

static Ctl stepsAt(Json *step, const char *key, Json **out) {
	*out = jsonGet(step, key);
	if (!jsonIsArray(*out)) return ctlThrowText("a step needs a list of steps in %s", key);
	return ctlNone();
}

#define TRY(expression) \
	do { \
		Ctl tried_ = (expression); \
		if (tried_.kind != CTL_NONE) return tried_; \
	} while (0)

/** an operation's result: its error thrown with the op's name */
static Ctl result(ErmErr err, const char *op) {
	return err.kind ? ctlThrow(ermWithOp(err, op)) : ctlNone();
}

static Json *slotsToJson(const ErmResult *result) {
	switch (result->listing) {
		case ERM_LIST_ABSENT: return jsonArray();
		case ERM_LIST_SLOT: return ermIdsToJson(&result->slot);
		case ERM_LIST_WHOLE: {
			Json *list = jsonArray();
			for (int i = 0; i < result->whole.count; i++) {
				Json *pair = jsonArray();
				jsonPush(pair, jsonString(result->whole.items[i].name));
				jsonPush(pair, ermIdsToJson(&result->whole.items[i].ids));
				jsonPush(list, pair);
			}
			return list;
		}
	}
	return jsonArray();
}

static Ctl runStep(Part *part, Json *step) {
	const char *what = jsonText(jsonGet(step, "do"));
	if (!what) return ctlThrow(ermThrown(jsonString("a step needs a string do")));
	ErmApi api = part->api;
	Env *env = &part->env;

	if (strcmp(what, "read") == 0) {
		Json *node;
		const char *as;
		TRY(need(part, step, "node", &node));
		TRY(nameAt(step, "as", &as));
		Json *value = NULL;
		TRY(result(ermApiRead(api, node, &value, NULL), "read"));
		bindVar(env, as, value);
		return ctlNone();
	}
	if (strcmp(what, "directory") == 0) {
		Json *node, *name;
		const char *as;
		TRY(need(part, step, "node", &node));
		TRY(optional(part, step, "name", &name));
		TRY(nameAt(step, "as", &as));
		ErmResult listed = { 0 };
		TRY(result(ermApiDirectory(api, node, name, &listed), "directory"));
		bindVar(env, as, slotsToJson(&listed));
		return ctlNone();
	}
	if (strcmp(what, "lookup") == 0) {
		Json *name;
		const char *as;
		TRY(need(part, step, "name", &name));
		TRY(nameAt(step, "as", &as));
		ErmResult found = { 0 };
		TRY(result(ermApiLookup(api, name, &found), "lookup"));
		bindVar(env, as, ermIdsToJson(&found.found));
		return ctlNone();
	}
	if (strcmp(what, "let") == 0) {
		const char *as;
		TRY(nameAt(step, "as", &as));
		Json *expression = jsonGet(step, "value");
		if (!expression) return ctlThrow(ermThrown(jsonString("a let needs a value")));
		Json *value;
		ErmErr err = evaluate(env, expression, &value);
		if (err.kind) return ctlThrow(err);
		bindVar(env, as, value);
		return ctlNone();
	}
	if (strcmp(what, "if") == 0) {
		Json *test, *body;
		TRY(need(part, step, "test", &test));
		if (!jsonIsBoolean(test)) return ctlThrowText("an if needs a boolean test, not %s", kindOf(test));
		if (test->boolean) {
			TRY(stepsAt(step, "then", &body));
			return runSteps(part, body);
		}
		if (!jsonGet(step, "else")) return ctlNone();
		TRY(stepsAt(step, "else", &body));
		return runSteps(part, body);
	}
	if (strcmp(what, "each") == 0) {
		Json *list, *body;
		const char *as;
		TRY(need(part, step, "list", &list));
		TRY(nameAt(step, "as", &as));
		TRY(stepsAt(step, "steps", &body));
		if (!jsonIsArray(list)) return ctlThrowText("each needs a list, not %s", kindOf(list));
		for (int i = 0; i < list->array.count; i++) {
			bindVar(env, as, list->array.items[i]);
			TRY(runSteps(part, body));
		}
		return ctlNone();
	}
	if (strcmp(what, "return") == 0) {
		Json *value;
		TRY(optional(part, step, "value", &value));
		return (Ctl){ CTL_RETURN, value ? value : jsonNull(), { 0 } };
	}
	if (strcmp(what, "pending") == 0) {
		if (part->kind != PART_COMPUTE) return ctlThrow(ermThrown(jsonString("pending is for a compute only")));
		return (Ctl){ CTL_PENDING, NULL, { 0 } };
	}
	if (strcmp(what, "throw") == 0) {
		Json *message;
		TRY(optional(part, step, "message", &message));
		return ctlThrow(ermThrown(message ? message : jsonNull()));
	}
	if (strcmp(what, "try") == 0) {
		Json *body;
		const char *as;
		TRY(stepsAt(step, "steps", &body));
		TRY(nameAt(step, "as", &as));
		Ctl ctl = runSteps(part, body);
		if (ctl.kind == CTL_RETURN || ctl.kind == CTL_PENDING) return ctl;
		bindVar(env, as, ctl.kind == CTL_THROW ? ermErrToJson(ctl.err) : jsonNull());
		return ctlNone();
	}
	if (strcmp(what, "make") == 0) {
		Json *id, *value, *data, *cause;
		TRY(need(part, step, "id", &id));
		TRY(need(part, step, "value", &value));
		TRY(optional(part, step, "data", &data));
		TRY(optional(part, step, "cause", &cause));
		ErmStamp stamp = { cause, NULL, 0 };
		return result(ermApiMake(api, &stamp, id, value, data, NULL), "make");
	}
	if (strcmp(what, "write") == 0) {
		Json *node, *patches, *cause;
		TRY(need(part, step, "node", &node));
		TRY(need(part, step, "patches", &patches));
		TRY(optional(part, step, "cause", &cause));
		ErmStamp stamp = { cause, NULL, 0 };
		return result(ermApiWrite(api, &stamp, node, patches, NULL), "write");
	}
	if (strcmp(what, "place") == 0) {
		Json *parent, *name, *id, *position, *cause;
		TRY(need(part, step, "parent", &parent));
		TRY(need(part, step, "name", &name));
		TRY(need(part, step, "id", &id));
		TRY(optional(part, step, "position", &position));
		TRY(optional(part, step, "cause", &cause));
		ErmStamp stamp = { cause, NULL, 0 };
		return result(ermApiPlace(api, &stamp, parent, name, id, position, NULL), "place");
	}
	if (strcmp(what, "unplace") == 0) {
		Json *parent, *name, *id, *cause;
		TRY(need(part, step, "parent", &parent));
		TRY(need(part, step, "name", &name));
		TRY(need(part, step, "id", &id));
		TRY(optional(part, step, "cause", &cause));
		ErmStamp stamp = { cause, NULL, 0 };
		return result(ermApiUnplace(api, &stamp, parent, name, id, NULL), "unplace");
	}
	if (strcmp(what, "handler") == 0) {
		if (part->kind != PART_EFFECT) return ctlThrow(ermThrown(jsonString("handler is for an effect only")));
		const char *name;
		Json *body;
		TRY(nameAt(step, "name", &name));
		TRY(stepsAt(step, "steps", &body));
		ERM_PUSH(part->handlers, ((ErmNamedHandler){ name, handlerOf(body, true) }));
		return ctlNone();
	}
	if (strcmp(what, "cleanup") == 0) {
		if (part->kind != PART_EFFECT) return ctlThrow(ermThrown(jsonString("cleanup is for an effect only")));
		Json *body;
		TRY(stepsAt(step, "steps", &body));
		part->hasCleanup = true;
		part->cleanup = handlerOf(body, false);
		return ctlNone();
	}
	return ctlThrowText("no step %s", what);
}

static Ctl runSteps(Part *part, Json *steps) {
	for (int i = 0; i < steps->array.count; i++) TRY(runStep(part, steps->array.items[i]));
	return ctlNone();
}

// ===========================================================================
// the program

static ErmComputeOut compute(void *self, const ErmComputeIn *in) {
	Part part = { 0 };
	part.kind = PART_COMPUTE;
	part.api = in->api;
	bindVar(&part.env, "self", jsonString(in->self));
	bindVar(&part.env, "path", ermPathToJson(&in->path));
	bindVar(&part.env, "changes", ermChangesToJson(&in->changes));
	Ctl ctl = runSteps(&part, self);
	switch (ctl.kind) {
		case CTL_NONE: return (ErmComputeOut){ ERM_RETURNED, jsonNull(), { 0 } };
		case CTL_RETURN: return (ErmComputeOut){ ERM_RETURNED, ctl.value, { 0 } };
		case CTL_PENDING: return (ErmComputeOut){ ERM_WENT_PENDING, NULL, { 0 } };
		case CTL_THROW: break;
	}
	return (ErmComputeOut){ ERM_THREW, NULL, ctl.err };
}

static ErmEffectOut effect(void *self, const ErmEffectIn *in) {
	Part part = { 0 };
	part.kind = PART_EFFECT;
	part.api = in->api;
	bindVar(&part.env, "self", jsonString(in->self));
	bindVar(&part.env, "value", in->value);
	bindVar(&part.env, "previous", in->previous);
	Ctl ctl = runSteps(&part, self);
	ErmEffectOut out = { 0 };
	if (ctl.kind == CTL_THROW) out.threw = ctl.err;
	for (int i = 0; i < part.handlers.count; i++) ERM_PUSH(out.handlers, part.handlers.items[i]);
	out.hasCleanup = part.hasCleanup;
	out.cleanup = part.cleanup;
	return out;
}

ErmErr ermLoadProgram(Json *value, ErmProgram *out) {
	*out = (ErmProgram){ 0 };
	if (!jsonIsArray(value)) return ermInvalid("a program must be a list of steps, not %s", kindOf(value));
	for (int i = 0; i < value->array.count; i++) {
		if (!jsonIsObject(value->array.items[i])) return ermInvalid("a program's steps must be objects");
	}
	*out = (ErmProgram){ value, compute, effect };
	return ermOk();
}
