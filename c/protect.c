// protect.c: the reference protect. CORE.tex "Running and wrapping"
// (protect); PROTOCOL.tex "The reference protect". Owner: the
// Protect+Main agent.
//
// protect asks may before every op that passes through it (a lookup's
// directory reads arrive as their own ERM_OP_DIRECTORY ops, through the top,
// with the lookup's ctx), before subscribe (op "subscribe", the node) and
// unsubscribe (op "unsubscribe", the node of that subscription when it was
// made through this protect); on no it answers ermRefused(...) without
// calling the layer below. record, finish pass through; setTop passes on.
// Rule fields compare with jsonEqual; "process" against the ctx's process
// as a string (no process never matches a given one); "op" against
// ermOpName; "node" against ermOpNode (NULL for a lookup: a rule giving a
// node never matches it).

#include "ermine.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct Protect {
	ErmInterface inner;
	ErmMay may;
	void *mayData;
	ErmMap subscriptionNodes; // subscription number (as decimal text) -> Json * node
} Protect;

ErmErr ermRulesFrom(Json *rules, ErmRules *out) {
	ErmRules list = { 0 };
	if (rules) {
		if (!jsonIsArray(rules)) return ermInvalid("rules must be a list of rules");
		for (int i = 0; i < rules->array.count; i++) {
			Json *rule = rules->array.items[i];
			if (!jsonIsObject(rule)) return ermInvalid("a rule must be an object");
			Json *allow = jsonGet(rule, "allow");
			if (!jsonIsBoolean(allow)) return ermInvalid("a rule needs a boolean allow");
			ErmRule r = { jsonGet(rule, "agent"), jsonGet(rule, "process"), jsonGet(rule, "op"), jsonGet(rule, "node"),
				          allow->boolean };
			ERM_PUSH(list, r);
		}
	}
	*out = list;
	return ermOk();
}

/** a field the rule does not give matches anything; a given one only an equal value the operation has */
static bool given(const Json *want, const Json *have) {
	if (!want) return true;
	return have && jsonEqual(want, have);
}

bool ermMayFromRules(void *rules, Json *agent, const char *process, const char *op, Json *node) {
	const ErmRules *list = rules;
	if (!list) return true;
	Json *processValue = process ? jsonString(process) : NULL;
	Json *opValue = jsonString(op);
	bool answer = true;
	for (int i = 0; i < list->count; i++) {
		const ErmRule *rule = &list->items[i];
		if (given(rule->agent, agent) && given(rule->process, processValue) && given(rule->op, opValue) &&
		    given(rule->node, node)) {
			answer = rule->allow;
			break;
		}
	}
	if (processValue) jsonFree(processValue);
	jsonFree(opValue);
	return answer;
}

static bool allowed(Protect *protect, const ErmCtx *ctx, const char *op, Json *node) {
	return protect->may(protect->mayData, ctx->agent, ctx->process, op, node);
}

/** "protect: agent A as process P may not OP NODE" */
static ErmErr refusal(const ErmCtx *ctx, const char *op, Json *node) {
	char *agent = jsonPrint(ctx->agent ? ctx->agent : jsonNull());
	char *process = NULL;
	if (ctx->process) {
		Json *p = jsonString(ctx->process);
		process = jsonPrint(p);
		jsonFree(p);
	}
	char *target = node ? jsonPrint(node) : NULL;
	ErmErr err = ermRefused("protect: agent %s%s%s may not %s%s%s", agent, process ? " as process " : "",
	                        process ? process : "", op, target ? " " : "", target ? target : "");
	free(agent);
	free(process);
	free(target);
	return err;
}

static ErmErr protectOp(void *self, const ErmCtx *ctx, const ErmStamp *stamp, const ErmOp *op, ErmResult *out) {
	Protect *protect = self;
	const char *name = ermOpName(op->kind);
	Json *node = ermOpNode(op);
	if (!allowed(protect, ctx, name, node)) return refusal(ctx, name, node);
	return protect->inner.vt->op(protect->inner.self, ctx, stamp, op, out);
}

static ErmErr protectSubscribe(void *self, const ErmCtx *ctx, Json *node, ErmEventFn fn, void *data, int64_t *sub) {
	Protect *protect = self;
	if (!allowed(protect, ctx, "subscribe", node)) return refusal(ctx, "subscribe", node);
	ErmErr err = protect->inner.vt->subscribe(protect->inner.self, ctx, node, fn, data, sub);
	if (!err.kind) {
		char key[32];
		snprintf(key, sizeof key, "%lld", (long long)*sub);
		ermMapPut(&protect->subscriptionNodes, key, node);
	}
	return err;
}

static ErmErr protectUnsubscribe(void *self, const ErmCtx *ctx, int64_t sub) {
	Protect *protect = self;
	char key[32];
	snprintf(key, sizeof key, "%lld", (long long)sub);
	Json *node = ermMapGet(&protect->subscriptionNodes, key);
	if (!allowed(protect, ctx, "unsubscribe", node)) return refusal(ctx, "unsubscribe", node);
	ErmErr err = protect->inner.vt->unsubscribe(protect->inner.self, ctx, sub);
	if (!err.kind) ermMapRemove(&protect->subscriptionNodes, key);
	return err;
}

static ErmRecording *protectRecord(void *self, ErmApi api, int64_t run, const ErmRefs *marked) {
	Protect *protect = self;
	return protect->inner.vt->record(protect->inner.self, api, run, marked);
}

static ErmRecord *protectFinish(void *self, ErmRecording *recording, ErmEnding ending) {
	Protect *protect = self;
	return protect->inner.vt->finish(protect->inner.self, recording, ending);
}

static void protectSetTop(void *self, ErmInterface top) {
	Protect *protect = self;
	protect->inner.vt->setTop(protect->inner.self, top);
}

static const ErmVtable protectVtable = {
	protectOp, protectSubscribe, protectUnsubscribe, protectRecord, protectFinish, protectSetTop,
};

ErmInterface ermProtect(ErmInterface inner, ErmMay may, void *mayData) {
	Protect *protect = allocate(sizeof *protect);
	protect->inner = inner;
	protect->may = may;
	protect->mayData = mayData;
	return (ErmInterface){ &protectVtable, protect };
}
