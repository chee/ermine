// the drivers (drivers.h)
#include "drivers.h"
#include <stdio.h>

static int presses;

es_out keyboard(es_context *c, void *ctx) {
	(void)ctx;
	op_value *v = op_map();
	op_set(v, "n", op_num(0));
	es_handle *n;
	int code = es_ensure_node(c, es_text("/keyboard"), v, &n);
	op_free(v);
	return code ? es_out_code(code) : es_out_of(NULL);
}

typedef struct {
	es_context *c;
	const op_patch *patch;
} pressing;

static int press(void *data) {
	pressing *x = data;
	return es_patch(x->c, es_on_path(es_text("/keyboard")), x->patch, 1);
}

// outside a run, so with the keyboard's process open (es_within)
void keyboard_press(es_context *keyboard, const char *key) {
	op_value *v = op_map();
	op_set(v, "key", op_str(key));
	op_set(v, "n", op_num(++presses));
	op_patch p = {.place = {NULL, 0}, .has_value = 1, .value = v};
	pressing x = {keyboard, &p};
	int code = es_within(keyboard, press, &x);
	if (code) fprintf(stderr, "keyboard: %s %s\n", es_code_name(code), es_thrown()->message);
	op_free(v);
}

static es_out screen(es_context *c, void *ctx, const op_value *previous) {
	(void)ctx, (void)previous;
	const op_value *v;
	int code = es_read(c, es_on_path(es_text("/programs/shell/screen")), NULL, 0, &v);
	if (code) return es_out_code(code);
	return es_out_of(v ? op_ref((op_value *)v) : NULL);
}

static int draw(es_context *c, void *ctx, const op_value *value, const op_value *before) {
	(void)c, (void)ctx, (void)before;
	if (value) show(value);
	return 0;
}

es_out display(es_context *c, void *ctx) {
	(void)ctx;
	es_handle *n;
	int code = es_create_effect(c, es_text("draw"), screen, draw, NULL, NULL, &n);
	return code ? es_out_code(code) : es_out_of(NULL);
}
