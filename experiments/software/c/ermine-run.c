// ermine-run: run one program through a loader, in your terminal.
//   ermine-run table hello         a program built into this binary, by name
//   ermine-run table count 5       the same, with an argument
//   ermine-run dlopen ./hello.so   a shared library: its exported `setup` is the program
// it makes an ermine, places two loaders as the host ("table" and "dlopen"), places the program as a
// node (its value is the code), runs it through the loader at /run/main, pulses until nothing
// changes, then prints the process's value, its status, and the call that started it.
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../../core/changeable/c/json.h"
#include "software.h"

// --- the table loader: programs built in. the code is "name" or "name argument" -----------------

static es_out hello(es_context *c, void *ctx) {
	(void)c, (void)ctx;
	return es_out_of(op_str("hello, world"));
}

// count N: writes 1 … N as nodes inside its own node, and is their sum. (a program that runs again by
// its own writes is a loop, and the scheduler cuts it: so it does not count over pulses)
static long limit;
static es_out count(es_context *c, void *ctx) {
	(void)ctx;
	long total = 0;
	for (long i = 1; i <= limit; i++) {
		char name[24];
		snprintf(name, sizeof name, "%ld", i);
		op_value *n = op_num((double)i);
		int rc = es_ensure_node(c, es_text(name), n, NULL);
		op_free(n);
		if (rc != 0) return es_out_code(rc);
		total += i;
	}
	return es_out_of(op_num((double)total));
}

static const struct {
	const char *name;
	es_program setup;
} programs[] = {{"hello", hello}, {"count", count}};

static int load_table(void *ctx, es_context *c, const op_value *code, sw_setup *out) {
	(void)ctx, (void)c;
	if (code == NULL || code->type != OP_STR) return es_fail_text("the code is not a name");
	const char *space = strchr(code->str, ' ');
	size_t n = space == NULL ? strlen(code->str) : (size_t)(space - code->str);
	limit = space == NULL ? 3 : atol(space + 1);
	for (size_t i = 0; i < sizeof programs / sizeof *programs; i++) {
		if (strlen(programs[i].name) == n && strncmp(programs[i].name, code->str, n) == 0) {
			*out = (sw_setup){programs[i].setup, NULL};
			return 0;
		}
	}
	return es_fail_text("no program of that name is built in");
}

// --- the dlopen loader: the code is a path to a shared library with an exported `setup` ----------

static int load_dlopen(void *ctx, es_context *c, const op_value *code, sw_setup *out) {
	(void)ctx, (void)c;
	if (code == NULL || code->type != OP_STR) return es_fail_text("the code is not a path");
	void *lib = dlopen(code->str, RTLD_NOW);
	if (lib == NULL) return es_fail_text(dlerror());
	void *setup = dlsym(lib, "setup");
	if (setup == NULL) return es_fail_text("the library exports no setup");
	*out = (sw_setup){(es_program)setup, NULL};
	return 0;
}

// --- main -------------------------------------------------------------------------------------

#define TRY(x) \
	do { \
		int rc_ = (x); \
		if (rc_ != 0) { \
			fprintf(stderr, "ermine-run: %s\n", es_thrown()->message ? es_thrown()->message : es_code_name(rc_)); \
			return 1; \
		} \
	} while (0)

static void show(const char *label, const op_value *v) {
	printf("%s: ", label);
	if (v == NULL) printf("(none)");
	else op_json_write(stdout, v);
	printf("\n");
}

int main(int argc, char **argv) {
	if (argc < 3 || (strcmp(argv[1], "table") != 0 && strcmp(argv[1], "dlopen") != 0)) {
		fprintf(stderr, "usage: ermine-run table <name> [argument]\n       ermine-run dlopen <library.so>\n");
		return 2;
	}
	char code[512] = "";
	for (int i = 2; i < argc; i++) strncat(strncat(code, i > 2 ? " " : "", sizeof code - strlen(code) - 1), argv[i], sizeof code - strlen(code) - 1);
	char loader[64];
	snprintf(loader, sizeof loader, "/loaders/%s", argv[1]);

	es_ermine *e;
	TRY(es_create(&(es_options){0}, &e));
	es_context *host = es_host_context(e);
	static sw_loader table = {load_table, NULL}, library = {load_dlopen, NULL};
	TRY(sw_place_loader(host, es_text("/loaders/table"), &table, NULL));
	TRY(sw_place_loader(host, es_text("/loaders/dlopen"), &library, NULL));
	op_value *value = op_str(code);
	TRY(es_ensure_node(host, es_text("/programs/main"), value, NULL));
	op_free(value);

	op_value *run;
	TRY(sw_run(host, es_text(loader), es_text("/programs/main"), es_text("/run/main"), &run));
	if (op_get(run, "refused") != NULL) {
		fprintf(stderr, "ermine-run: /run/main is taken\n");
		return 1;
	}

	// pulse until a pulse changes nothing we show
	char *before = NULL;
	for (int pulses = 0; pulses < 100; pulses++) {
		TRY(es_pulse(host));
		const op_value *v = NULL;
		es_read(host, es_on_path(es_text("/run/main")), NULL, 0, &v);
		es_status st = {0};
		es_get_status(host, es_on_path(es_text("/run/main")), &st);
		char *now = v == NULL ? strdup("") : op_json_text(v);
		char *same = malloc(strlen(now) + 32);
		sprintf(same, "%s %s", now, st.state);
		free(now);
		es_status_free(&st);
		int settled = before != NULL && strcmp(before, same) == 0;
		free(before);
		before = same;
		if (settled) break;
	}
	free(before);

	const op_value *v = NULL;
	es_read(host, es_on_path(es_text("/run/main")), NULL, 0, &v);
	show("value", v);
	es_status st;
	TRY(sw_status(host, run, &st));
	printf("status: %s", st.state);
	if (st.error != NULL) printf(" (%s)", st.error);
	printf("\n");
	es_status_free(&st);

	char *id, *program;
	TRY(es_id_through(host, es_on_path(es_text(loader)), &id));
	TRY(es_id_through(host, es_on_path(es_text("/programs/main")), &program));
	const es_call *call = es_records_call(e, id);
	int read_program = 0;
	for (size_t i = 0; call != NULL && i < call->nreads; i++) read_program |= strcmp(call->reads[i].id, program) == 0;
	printf("call: loader %s (%s), program /programs/main (read: %s), end %s\n", loader, id,
		read_program ? "yes" : "no", call == NULL ? "none" : call->end);
	free(id);
	free(program);
	op_free(run);
	es_close(e);
	es_free(e);
	return 0;
}
