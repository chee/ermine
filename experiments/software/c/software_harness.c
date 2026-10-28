// software on the line protocol of typescript/software_harness.ts (its header says every request).
// one ermine, pulses only when asked; loaders are made of a kind (double, note, refuse, broken)
#include "software.h"

#include <stdio.h>
#include <string.h>

#include "../../../conformance/c/harness.h"

#define CHECK(x) \
	do { \
		int rc_ = (x); \
		if (rc_ != 0) { \
			hh_error(out, "%s", es_thrown()->message ? es_thrown()->message : es_code_name(rc_)); \
			return; \
		} \
	} while (0)

static es_ermine *e;
static es_context *host;
static op_value *log_list;

// what is kept by `at`: a run (the op_value sw_run gave) or an interpreter (its start)
#define KEPT 16
static struct {
	char *at;
	op_value *run;
	es_started *started;
} kept[KEPT];
static void keep(const char *at, op_value *run, es_started *started) {
	for (int i = 0; i < KEPT; i++) {
		if (kept[i].at != NULL) continue;
		kept[i].at = strdup(at);
		kept[i].run = run;
		kept[i].started = started;
		return;
	}
	hh_fail("too many kept");
}

static void logged(const char *what, const op_value *code) {
	op_value *item = op_list();
	op_push(item, op_str(what));
	op_push(item, code == NULL ? op_null() : op_ref((op_value *)code));
	op_push(log_list, item);
}

// kinds: the load, and the setup it makes
static es_out double_setup(es_context *c, void *ctx) {
	(void)c;
	const op_value *code = ctx;
	logged("ran", code);
	return es_out_of(op_num(code->num * 2));
}
static es_out note_setup(es_context *c, void *ctx) {
	const op_value *code = ctx;
	logged("ran", code);
	int rc = es_ensure_node(c, es_text("note"), code, NULL);
	return rc == 0 ? es_out_of(NULL) : es_out_code(rc);
}
static es_out broken_setup(es_context *c, void *ctx) {
	(void)c, (void)ctx;
	return es_out_failed(strdup("setup broke"));
}
static int load(void *kind, es_context *c, const op_value *code, sw_setup *out) {
	(void)c;
	const char *k = kind;
	if (strcmp(k, "double") == 0) {
		if (code->type != OP_NUM) return es_fail_text("the code is not a number");
		*out = (sw_setup){double_setup, (void *)code};
	} else if (strcmp(k, "note") == 0) *out = (sw_setup){note_setup, (void *)code};
	else if (strcmp(k, "broken") == 0) *out = (sw_setup){broken_setup, NULL};
	else return es_fail_text("no native code here");
	return 0;
}

// a loader of a kind, kept as long as the harness
#define LOADERS 16
static sw_loader loaders[LOADERS];
static int nloaders;
static sw_loader *made(const char *kind) {
	if (nloaders == LOADERS) hh_fail("too many loaders");
	loaders[nloaders] = (sw_loader){load, strdup(kind)};
	return &loaders[nloaders++];
}

// an interpreter: its setup places a loader at `name`, inside its node
typedef struct {
	char *name;
	sw_loader *loader;
} interpreter_t;
static interpreter_t interpreters[KEPT];
static int ninterpreters;
static es_out interpreter(es_context *c, void *ctx) {
	interpreter_t *i = ctx;
	int rc = sw_place_loader(c, es_text(i->name), i->loader, NULL);
	return rc == 0 ? es_out_of(NULL) : es_out_code(rc);
}

void hh_start(void) {
	es_options o = {.schedule = NULL};
	if (es_create(&o, &e) != 0) hh_fail("no ermine");
	host = es_host_context(e);
	log_list = op_list();
}
void hh_finish(void) {
	for (int i = 0; i < KEPT; i++) {
		free(kept[i].at);
		op_free(kept[i].run);
	}
	for (int i = 0; i < nloaders; i++) free(loaders[i].ctx);
	for (int i = 0; i < ninterpreters; i++) free(interpreters[i].name);
	op_free(log_list);
	es_close(e);
	es_free(e);
}

static const char *str(const op_value *r, const char *key) {
	const char *s = hh_str(r, key);
	return s != NULL ? s : "";
}
static void yes(FILE *out, int b) { fputs(b ? "true" : "false", out); }

void hh_answer(const op_value *r, FILE *out) {
	const char *op = str(r, "op");
	op_value *value = op_get(r, "value");
	if (strcmp(op, "node") == 0) {
		CHECK(es_ensure_node(host, es_text(str(r, "path")), value, NULL));
		fputs("{}", out);
	} else if (strcmp(op, "set") == 0) {
		op_patch p = {.has_value = 1, .value = value};
		CHECK(es_patch(host, es_on_path(es_text(str(r, "path"))), &p, 1));
		fputs("{}", out);
	} else if (strcmp(op, "loader") == 0) {
		CHECK(sw_place_loader(host, es_text(str(r, "path")), made(str(r, "kind")), NULL));
		fputs("{}", out);
	} else if (strcmp(op, "interpreter") == 0) {
		if (ninterpreters == KEPT) hh_fail("too many interpreters");
		interpreters[ninterpreters].name = strdup(str(r, "name"));
		interpreters[ninterpreters].loader = made(str(r, "kind"));
		es_started *s;
		es_refused no = {0};
		CHECK(es_start(e, interpreter, &interpreters[ninterpreters++], es_text(str(r, "at")), NULL, &s, &no));
		keep(str(r, "at"), NULL, s);
		fputs("{}", out);
	} else if (strcmp(op, "run") == 0) {
		op_value *result;
		CHECK(sw_run(host, es_text(str(r, "loader")), es_text(str(r, "program")),
			es_text(str(r, "at")), &result));
		if (op_get(result, "id") == NULL) op_json_write(out, result), op_free(result);
		else {
			fputs("{\"at\":", out), op_json_write(out, op_get(result, "at")), fputs("}", out);
			keep(str(r, "at"), result, NULL);
		}
	} else if (strcmp(op, "stop") == 0) {
		for (int i = 0; i < KEPT; i++) {
			if (kept[i].at == NULL || strcmp(kept[i].at, str(r, "at")) != 0) continue;
			if (kept[i].started != NULL) CHECK(es_stop(kept[i].started, NULL));
			else CHECK(sw_stop(host, kept[i].run, NULL));
		}
		fputs("{}", out);
	} else if (strcmp(op, "pulse") == 0) {
		CHECK(es_pulse(host));
		fputs("{}", out);
	} else if (strcmp(op, "read") == 0) {
		const op_value *v;
		int rc = es_read(host, es_on_path(es_text(str(r, "path"))), NULL, 0, &v);
		if (rc == ES_PENDING) fputs("{\"pending\":true}", out);
		else {
			CHECK(rc);
			fputs("{\"value\":", out);
			if (v == NULL) fputs("null", out);
			else op_json_write(out, v);
			fputs("}", out);
		}
	} else if (strcmp(op, "has") == 0) {
		int has;
		CHECK(es_has_node(host, es_on_path(es_text(str(r, "path"))), &has));
		fputs("{\"has\":", out), yes(out, has), fputs("}", out);
	} else if (strcmp(op, "status") == 0) {
		es_status st;
		if (es_get_status(host, es_on_path(es_text(str(r, "path"))), &st) != 0 || st.state == NULL) {
			fputs("{\"state\":null}", out);
		} else {
			fprintf(out, "{\"state\":\"%s\"}", st.state);
			es_status_free(&st);
		}
	} else if (strcmp(op, "log") == 0) {
		fputs("{\"log\":", out), op_json_write(out, log_list), fputs("}", out);
	} else if (strcmp(op, "call") == 0) {
		char *loader, *program;
		CHECK(es_id_through(host, es_on_path(es_text(str(r, "loader"))), &loader));
		CHECK(es_id_through(host, es_on_path(es_text(str(r, "program"))), &program));
		const es_call *call = es_records_call(e, loader);
		if (call == NULL) fputs("{\"end\":null,\"readsProgram\":false}", out);
		else {
			int reads = 0;
			for (size_t i = 0; i < call->nreads; i++) reads |= strcmp(call->reads[i].id, program) == 0;
			fprintf(out, "{\"end\":\"%s\"", call->end);
			if (call->error != NULL) fputs(",\"error\":", out), op_json_string(out, call->error);
			fputs(",\"readsProgram\":", out), yes(out, reads), fputs("}", out);
		}
		free(loader);
		free(program);
	} else hh_unknown(out, r);
}
