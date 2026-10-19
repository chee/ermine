// the shell: a program on the process api only. it reads /keyboard (the keyboard's last key, a map
// {key, n}), keeps what is typed in ./line, says how the last command went in ./said, adds up the
// numbers at the root in ./sum, and makes ./screen: what the screen shows, {lines, prompt}, the
// tree from / with each value.
//
//   name = value     put value at /name (a number, true, false, null, {}, "text", or any other text)
//   name.key = value set one key of the map at /name (pigs/f849ff13.x = 0.2 moves a pig)
//   rm name          take /name out
//   esc              clear the line
#include "shell.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define WIDTH 30
#define ROWS 14
#define DEEPEST 4

// the screen's own path: its value is never read by itself
static char self[128];
// nor are the effects' nodes: a memo reading an effect's node had that effect's act writes taken
// for a loop and cut (no rerun), so the screen fell a key behind. the scheduler's, 2026-10-17
static const char *const effects[] = {"/programs/shell/keys", "/programs/display/draw", "/programs/room/push"};

static int unread(const char *path) {
	if (strcmp(path, self) == 0) return 1;
	for (size_t i = 0; i < sizeof effects / sizeof *effects; i++)
		if (strcmp(path, effects[i]) == 0) return 1;
	return 0;
}

static char *joined(const char *a, const char *b) {
	size_t n = strlen(a), m = strlen(b);
	char *s = malloc(n + m + 2);
	memcpy(s, a, n);
	s[n] = '/';
	memcpy(s + n + 1, b, m + 1);
	return s;
}

// a path as typed: from the root unless it says
static char *rooted(const char *name) {
	if (name[0] == '/') return strdup(name);
	return joined("", name);
}

static char *trimmed(const char *s, size_t n) {
	while (n && (*s == ' ')) s++, n--;
	while (n && s[n - 1] == ' ') n--;
	char *t = malloc(n + 1);
	memcpy(t, s, n);
	t[n] = 0;
	return t;
}

static op_value *parsed(const char *s) {
	if (strcmp(s, "true") == 0) return op_bool(1);
	if (strcmp(s, "false") == 0) return op_bool(0);
	if (strcmp(s, "null") == 0) return op_null();
	if (strcmp(s, "{}") == 0) return op_map();
	size_t n = strlen(s);
	if (n >= 2 && s[0] == '"' && s[n - 1] == '"') return op_str_n(s + 1, n - 2);
	char *end;
	double d = strtod(s, &end);
	if (n && *end == 0) return op_num(d);
	return op_str(s);
}

static void put(api *a, const char *at, op_value *v) {
	op_patch p = {.place = {NULL, 0}, .has_value = 1, .value = v};
	api_edit(a, api_at(at), &p, 1);
	op_free(v);
}

static void say(api *a, int code, const char *what) {
	char s[96];
	if (code) snprintf(s, sizeof s, "%s: %s %s", what, api_code_name(code), api_why(a));
	else snprintf(s, sizeof s, "%s", what);
	put(a, "said", op_str(s));
}

static void command(api *a, const char *line) {
	char *eq = strchr(line, '=');
	if (strncmp(line, "rm ", 3) == 0) {
		char *name = trimmed(line + 3, strlen(line + 3));
		char *at = rooted(name);
		say(a, api_remove(a, api_at(at)), "rm");
		free(at), free(name);
	} else if (eq) {
		char *name = trimmed(line, eq - line), *text = trimmed(eq + 1, strlen(eq + 1));
		// name.key: one key inside the value
		char *dot = strchr(name, '.');
		if (dot) *dot++ = 0;
		char *at = rooted(name);
		op_value *v = parsed(text);
		// written without reading (an act reads nothing): changed to it, else made with it
		int code;
		if (dot) {
			op_key k = {.type = OP_STR_KEY, .s = dot};
			op_patch p = {.place = {&k, 1}, .has_value = 1, .value = v};
			code = api_edit(a, api_at(at), &p, 1);
		} else {
			op_patch p = {.place = {NULL, 0}, .has_value = 1, .value = v};
			code = api_edit(a, api_at(at), &p, 1);
			if (code == API_NOTHING_THERE) {
				api_node n;
				code = api_open(a, at, v, &n);
				if (code == API_OK) api_node_free(&n);
			}
		}
		say(a, code, at);
		op_free(v);
		free(at), free(name), free(text);
	} else if (line[0]) put(a, "said", op_str("name = value, or rm name"));
}

// keys ---------------------------------------------------------------------------------------

// the newest key, tracked, and the line as it is, peeped (the act writes the line: tracking it
// would run this again for its own write)
static sc_out key(api *a, const op_value *previous, void *ctx) {
	(void)previous, (void)ctx;
	const op_value *v, *line;
	int code = api_read(a, api_at("/keyboard"), NULL, 0, &v);
	if (code == API_PENDING) return (sc_out){.kind = SC_PENDING};
	if (v == NULL || v->type != OP_MAP) return (sc_out){.kind = SC_VALUE, .value = NULL};
	api_peep(a, api_at("line"), NULL, 0, &line);
	op_value *o = op_map();
	const op_value *k = op_get(v, "key"), *n = op_get(v, "n");
	if (k) op_set(o, "key", op_ref((op_value *)k));
	if (n) op_set(o, "n", op_ref((op_value *)n));
	op_set(o, "line", line && line->type == OP_STR ? op_ref((op_value *)line) : op_str(""));
	return (sc_out){.kind = SC_VALUE, .value = o};
}

static void typed(api *a, const op_value *value, const op_value *before, void *ctx) {
	(void)before, (void)ctx;
	const op_value *k = value && value->type == OP_MAP ? op_get(value, "key") : NULL;
	if (k == NULL || k->type != OP_STR) return;
	const op_value *v = op_get(value, "line");
	const char *line = v && v->type == OP_STR ? v->str : "";
	size_t n = strlen(line);
	if (strcmp(k->str, "enter") == 0) {
		char *cmd = trimmed(line, n);
		put(a, "line", op_str(""));
		command(a, cmd);
		free(cmd);
	} else if (strcmp(k->str, "backspace") == 0) {
		if (n) put(a, "line", op_str_n(line, n - 1));
	} else if (strcmp(k->str, "esc") == 0) {
		put(a, "line", op_str(""));
	} else if (strlen(k->str) == 1) {
		char *s = malloc(n + 2);
		memcpy(s, line, n);
		s[n] = k->str[0], s[n + 1] = 0;
		put(a, "line", op_str(s));
		free(s);
	}
}

// sum ----------------------------------------------------------------------------------------

static sc_out sum(api *a, const op_value *previous, void *ctx) {
	(void)previous, (void)ctx;
	api_names names;
	int code = api_list(a, api_at("/"), &names);
	if (code == API_PENDING) return (sc_out){.kind = SC_PENDING};
	double total = 0;
	for (size_t i = 0; code == API_OK && i < names.n; i++) {
		char *at = joined("", names.items[i]);
		const op_value *v;
		int c = api_read(a, api_at(at), NULL, 0, &v);
		free(at);
		if (c == API_PENDING) return api_names_free(&names), (sc_out){.kind = SC_PENDING};
		if (c == API_OK && v && v->type == OP_NUM) total += v->num;
	}
	if (code == API_OK) api_names_free(&names);
	return (sc_out){.kind = SC_VALUE, .value = op_num(total)};
}

// screen -------------------------------------------------------------------------------------

static void shown(const op_value *v, char *out, size_t cap) {
	if (v == NULL) return (void)(out[0] = 0);
	switch (v->type) {
	case OP_NULL: snprintf(out, cap, "null"); break;
	case OP_BOOL: snprintf(out, cap, "%s", v->bool_ ? "true" : "false"); break;
	case OP_NUM: snprintf(out, cap, "%g", v->num); break;
	case OP_STR: snprintf(out, cap, "\"%s\"", v->str); break;
	case OP_LIST: snprintf(out, cap, "[%zu]", v->count); break;
	case OP_MAP: snprintf(out, cap, "{%zu}", v->count); break;
	default: snprintf(out, cap, "#"); break;
	}
}

static int by_name(const void *x, const void *y) { return strcmp(*(char *const *)x, *(char *const *)y); }

// the lines of the tree under at, depth deep; 0, or pending
static int tree(api *a, const char *at, int depth, op_value *lines) {
	api_names names;
	int code = api_list(a, api_at(at[0] ? at : "/"), &names);
	if (code == API_PENDING) return API_PENDING;
	if (code) return API_OK;
	qsort(names.items, names.n, sizeof *names.items, by_name);
	for (size_t i = 0; i < names.n && lines->count < ROWS; i++) {
		char *path = joined(at, names.items[i]);
		char value[64] = "";
		if (!unread(path)) {
			const op_value *v;
			int c = api_read(a, api_at(path), NULL, 0, &v);
			if (c == API_PENDING) code = API_PENDING;
			else if (c == API_OK) shown(v, value, sizeof value);
		}
		char text[WIDTH * 4];
		snprintf(text, sizeof text, "%*s%s %s", depth * 2, "", names.items[i], value);
		op_push(lines, op_str(text));
		if (code == API_OK && depth < DEEPEST) code = tree(a, path, depth + 1, lines);
		free(path);
		if (code == API_PENDING) break;
	}
	api_names_free(&names);
	return code;
}

static sc_out screen(api *a, const op_value *previous, void *ctx) {
	(void)previous, (void)ctx;
	op_value *lines = op_list();
	if (tree(a, "", 0, lines) == API_PENDING) return op_free(lines), (sc_out){.kind = SC_PENDING};
	const op_value *v;
	if (api_read(a, api_at("line"), NULL, 0, &v) == API_PENDING) return op_free(lines), (sc_out){.kind = SC_PENDING};
	op_value *o = op_map();
	op_set(o, "lines", lines);
	op_set(o, "prompt", v && v->type == OP_STR ? op_ref((op_value *)v) : op_str(""));
	return (sc_out){.kind = SC_VALUE, .value = o};
}

int shell(api *a) {
	api_node n;
	op_value *v = op_str("");
	int code = api_open(a, "line", v, &n);
	op_free(v);
	if (code) return code;
	// the screen is beside the line
	self[0] = 0;
	for (size_t i = 0; i + 1 < n.npath; i++) {
		strncat(self, "/", sizeof self - strlen(self) - 1);
		strncat(self, n.path[i], sizeof self - strlen(self) - 1);
	}
	strncat(self, "/screen", sizeof self - strlen(self) - 1);
	api_node_free(&n);
	v = op_str("type: name = value");
	code = api_open(a, "said", v, &n);
	op_free(v);
	if (code) return code;
	api_node_free(&n);
	if ((code = api_memo(a, "sum", sum, NULL, NULL, &n))) return code;
	api_node_free(&n);
	if ((code = api_memo(a, "screen", screen, NULL, NULL, &n))) return code;
	api_node_free(&n);
	if ((code = api_effect(a, "keys", key, typed, NULL, NULL, &n))) return code;
	api_node_free(&n);
	return API_OK;
}
