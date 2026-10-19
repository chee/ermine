// the drivers (drivers.h)
#include "drivers.h"

static int presses;

int keyboard(api *a) {
	op_value *v = op_map();
	op_set(v, "n", op_num(0));
	api_node n;
	int code = api_open(a, "/keyboard", v, &n);
	op_free(v);
	if (code == API_OK) api_node_free(&n);
	return code;
}

void keyboard_press(api *a, const char *key) {
	op_value *v = op_map();
	op_set(v, "key", op_str(key));
	op_set(v, "n", op_num(++presses));
	op_patch p = {.place = {NULL, 0}, .has_value = 1, .value = v};
	api_edit(a, api_at("/keyboard"), &p, 1);
	op_free(v);
}

static sc_out screen(api *a, const op_value *previous, void *ctx) {
	(void)previous, (void)ctx;
	const op_value *v;
	int code = api_read(a, api_at("/programs/shell/screen"), NULL, 0, &v);
	if (code == API_PENDING) return (sc_out){.kind = SC_PENDING};
	return (sc_out){.kind = SC_VALUE, .value = v ? op_ref((op_value *)v) : NULL};
}

static void draw(api *a, const op_value *value, const op_value *before, void *ctx) {
	(void)a, (void)before, (void)ctx;
	if (value) show(value);
}

int display(api *a) {
	api_node n;
	int code = api_effect(a, "draw", screen, draw, NULL, NULL, &n);
	if (code == API_OK) api_node_free(&n);
	return code;
}
