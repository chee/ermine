// software.h: the loader's action, and run as its call
#include "software.h"

#include <string.h>

static char *copy(const char *s) {
	char *r = malloc(strlen(s) + 1);
	if (r == NULL) abort();
	return strcpy(r, s);
}

// the process of a program whose code was not there: an effect reads it (pending till it is placed)
// and its act asks the loader and runs the setup, once
typedef struct {
	sw_loader *loader;
	char *program;
	int ran;
} waiting;

static es_out wait_read(es_context *c, void *ctx, const op_value *previous) {
	(void)previous;
	const op_value *code;
	int rc = es_read(c, es_on_path(es_text(((waiting *)ctx)->program)), NULL, 0, &code);
	return rc == 0 ? es_out_of(op_ref((op_value *)code)) : es_out_code(rc);
}

static int wait_run(es_context *c, void *ctx, const op_value *code, const op_value *before) {
	(void)before;
	waiting *w = ctx;
	if (w->ran) return 0;
	w->ran = 1;
	sw_setup setup;
	int rc = w->loader->load(w->loader->ctx, c, code, &setup);
	if (rc != 0) return rc;
	es_out out = setup.fn(c, setup.ctx);
	if (out.kind == ES_OUT_FAILED) {
		rc = es_fail_text(out.error);
		free(out.error);
		return rc;
	}
	op_free(out.value);
	return out.kind == ES_OUT_PENDING ? ES_PENDING : 0;
}

static void wait_free(void *ctx, const char *why) {
	(void)why;
	waiting *w = ctx;
	free(w->program);
	free(w);
}

static es_out wait_setup(es_context *c, void *ctx) {
	waiting *w = ctx;
	es_add_teardown(c, wait_free, w);
	int rc = es_create_effect(c, es_text("code"), wait_read, wait_run, w, NULL, NULL);
	return rc == 0 ? es_out_of(NULL) : es_out_code(rc);
}

static es_out loader_action(es_context *c, void *ctx, const op_value *const *args, size_t nargs) {
	sw_loader *l = ctx;
	if (nargs != 2 || args[0]->type != OP_STR || args[1]->type != OP_STR) {
		return es_out_failed(copy("a loader is called with (program, at), both paths"));
	}
	const char *program = args[0]->str, *at = args[1]->str;
	const op_value *code;
	sw_setup setup;
	es_child child = {0};
	es_refused refused = {0};
	int rc = es_read(c, es_on_path(es_text(program)), NULL, 0, &code);
	if (rc == 0) rc = l->load(l->ctx, c, code, &setup);
	if (rc == ES_PENDING) {
		waiting *w = malloc(sizeof *w);
		if (w == NULL) abort();
		*w = (waiting){l, copy(program), 0};
		setup = (sw_setup){wait_setup, w};
		rc = 0;
	}
	if (rc != 0) return es_out_code(rc);
	rc = es_start_in(c, setup.fn, setup.ctx, es_text(at), NULL, &child, &refused);
	if (rc != 0) return es_out_code(rc);
	op_value *out = op_map(), *names = op_list();
	if (refused.refused != NULL) {
		for (size_t i = 0; i < refused.nat; i++) op_push(names, op_str(refused.at[i]));
		op_set(out, "refused", op_str(refused.refused));
		es_refused_free(&refused);
	} else {
		for (size_t i = 0; i < child.at.n; i++) op_push(names, op_str(child.at.names[i]));
		op_set(out, "id", op_str(child.id));
		es_child_free(&child);
	}
	op_set(out, "at", names);
	return es_out_of(out);
}

int sw_place_loader(es_context *c, es_at name, sw_loader *loader, es_handle **out) {
	return es_create_action(c, name, loader_action, loader, out);
}

int sw_run(es_context *c, es_at loader, es_at program, es_at at, op_value **out) {
	if (program.text == NULL || at.text == NULL) return es_fail_text("run takes paths as text");
	op_value *args[] = {op_str(program.text), op_str(at.text)};
	int rc = es_execute_action(c, es_on_path(loader), (const op_value *const *)args, 2, out);
	op_free(args[0]);
	op_free(args[1]);
	return rc;
}

static const char *id_of(const op_value *run) {
	op_value *id = run->type == OP_MAP ? op_get(run, "id") : NULL;
	return id != NULL && id->type == OP_STR ? id->str : NULL;
}

int sw_stop(es_context *c, const op_value *run, const char *why) {
	const char *id = id_of(run);
	return id == NULL ? 0 : es_child_stop(c, id, why);
}

int sw_status(es_context *c, const op_value *run, es_status *out) {
	const char *id = id_of(run);
	return id == NULL ? es_fail_text("nothing was started") : es_child_status(c, id, out);
}
