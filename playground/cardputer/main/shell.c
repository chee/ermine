// the shell: a program on the process api (es_*) only. it reads /keyboard (the keyboard's last key, a map
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

static int edit(es_context *c, const char *at, const op_patch *p) {
	return es_patch(c, es_on_path(es_text(at)), p, 1);
}

static void put(es_context *c, const char *at, op_value *v) {
	op_patch p = {.place = {NULL, 0}, .has_value = 1, .value = v};
	edit(c, at, &p);
	op_free(v);
}

static void say(es_context *c, int code, const char *what) {
	char s[96];
	if (code) snprintf(s, sizeof s, "%s: %s %s", what, es_code_name(code), es_thrown()->message);
	else snprintf(s, sizeof s, "%s", what);
	put(c, "said", op_str(s));
}

static void command(es_context *c, const char *line) {
	char *eq = strchr(line, '=');
	if (strncmp(line, "rm ", 3) == 0) {
		char *name = trimmed(line + 3, strlen(line + 3));
		char *at = rooted(name);
		// the console is the host's: a process only unplaces, the host takes the node out
		say(c, es_remove(es_host_context(c->ermine), es_on_path(es_text(at))), "rm");
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
			code = edit(c, at, &p);
		} else {
			op_patch p = {.place = {NULL, 0}, .has_value = 1, .value = v};
			code = edit(c, at, &p);
			if (code == ES_NOTHING_THERE) {
				es_handle *n;
				code = es_ensure_node(c, es_text(at), v, &n);
			}
		}
		say(c, code, at);
		op_free(v);
		free(at), free(name), free(text);
	} else if (line[0]) put(c, "said", op_str("name = value, or rm name"));
}

// keys ---------------------------------------------------------------------------------------

// the newest key, tracked, and the line as it is, peeped (the act writes the line: tracking it
// would run this again for its own write)
typedef struct {
	es_context *c;
	const op_value *line;
} peeped;

static int peep_line(void *data) {
	peeped *x = data;
	return es_read(x->c, es_on_path(es_text("line")), NULL, 0, &x->line);
}

static es_out key(es_context *c, void *ctx, const op_value *previous) {
	(void)previous, (void)ctx;
	const op_value *v;
	int code = es_read(c, es_on_path(es_text("/keyboard")), NULL, 0, &v);
	if (code) return es_out_code(code);
	if (v == NULL || v->type != OP_MAP) return es_out_of(NULL);
	peeped p = {c, NULL};
	es_peep(c, peep_line, &p);
	const op_value *line = p.line;
	op_value *o = op_map();
	const op_value *k = op_get(v, "key"), *n = op_get(v, "n");
	if (k) op_set(o, "key", op_ref((op_value *)k));
	if (n) op_set(o, "n", op_ref((op_value *)n));
	op_set(o, "line", line && line->type == OP_STR ? op_ref((op_value *)line) : op_str(""));
	return es_out_of(o);
}

static int typed(es_context *c, void *ctx, const op_value *value, const op_value *before) {
	(void)before, (void)ctx;
	const op_value *k = value && value->type == OP_MAP ? op_get(value, "key") : NULL;
	if (k == NULL || k->type != OP_STR) return 0;
	const op_value *v = op_get(value, "line");
	const char *line = v && v->type == OP_STR ? v->str : "";
	size_t n = strlen(line);
	if (strcmp(k->str, "enter") == 0) {
		char *cmd = trimmed(line, n);
		put(c, "line", op_str(""));
		command(c, cmd);
		free(cmd);
	} else if (strcmp(k->str, "backspace") == 0) {
		if (n) put(c, "line", op_str_n(line, n - 1));
	} else if (strcmp(k->str, "esc") == 0) {
		put(c, "line", op_str(""));
	} else if (strlen(k->str) == 1) {
		char *s = malloc(n + 2);
		memcpy(s, line, n);
		s[n] = k->str[0], s[n + 1] = 0;
		put(c, "line", op_str(s));
		free(s);
	}
	return 0;
}

// sum ----------------------------------------------------------------------------------------

static es_out sum(es_context *c, void *ctx, const op_value *previous) {
	(void)previous, (void)ctx;
	es_names names;
	int code = es_list(c, es_on_path(es_text("/")), &names);
	if (code == ES_PENDING) return es_out_pending();
	double total = 0;
	for (size_t i = 0; code == 0 && i < names.n; i++) {
		char *at = joined("", names.names[i]);
		const op_value *v;
		int r = es_read(c, es_on_path(es_text(at)), NULL, 0, &v);
		free(at);
		if (r == 0 && v && v->type == OP_NUM) total += v->num;
	}
	if (code == 0) es_names_free(&names);
	return es_out_of(op_num(total));
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
static int tree(es_context *c, const char *at, int depth, op_value *lines) {
	es_names names;
	int code = es_list(c, es_on_path(es_text(at[0] ? at : "/")), &names);
	if (code == ES_PENDING) return ES_PENDING;
	if (code) return 0;
	qsort(names.names, names.n, sizeof *names.names, by_name);
	for (size_t i = 0; i < names.n && lines->count < ROWS; i++) {
		char *path = joined(at, names.names[i]);
		char value[64] = "";
		if (!unread(path)) {
			const op_value *v;
			int r = es_read(c, es_on_path(es_text(path)), NULL, 0, &v);
			// a pending read has no value to show (a folder the rows name has no node: /home); the read is
			// tracked, so its coming shows
			if (r == 0) shown(v, value, sizeof value);
		}
		char text[WIDTH * 4];
		snprintf(text, sizeof text, "%*s%s %s", depth * 2, "", names.names[i], value);
		op_push(lines, op_str(text));
		if (code == 0 && depth < DEEPEST) code = tree(c, path, depth + 1, lines);
		free(path);
		if (code == ES_PENDING) break;
	}
	es_names_free(&names);
	return code;
}

static es_out screen(es_context *c, void *ctx, const op_value *previous) {
	(void)previous, (void)ctx;
	op_value *lines = op_list();
	if (tree(c, "", 0, lines) == ES_PENDING) return op_free(lines), es_out_pending();
	const op_value *v;
	if (es_read(c, es_on_path(es_text("line")), NULL, 0, &v) == ES_PENDING) return op_free(lines), es_out_pending();
	op_value *o = op_map();
	op_set(o, "lines", lines);
	op_set(o, "prompt", v && v->type == OP_STR ? op_ref((op_value *)v) : op_str(""));
	return es_out_of(o);
}

es_out shell(es_context *c, void *ctx) {
	(void)ctx;
	es_handle *n;
	op_value *v = op_str("");
	int code = es_ensure_node(c, es_text("line"), v, &n);
	op_free(v);
	if (code) return es_out_code(code);
	// the screen is beside the line: in the process's own node
	self[0] = 0;
	for (size_t i = 0; i < c->nat; i++) {
		strncat(self, "/", sizeof self - strlen(self) - 1);
		strncat(self, c->at[i], sizeof self - strlen(self) - 1);
	}
	strncat(self, "/screen", sizeof self - strlen(self) - 1);
	v = op_str("type: name = value");
	code = es_ensure_node(c, es_text("said"), v, &n);
	op_free(v);
	if (code) return es_out_code(code);
	if ((code = es_create_memo(c, es_text("sum"), sum, NULL, NULL, &n))) return es_out_code(code);
	if ((code = es_create_memo(c, es_text("screen"), screen, NULL, NULL, &n))) return es_out_code(code);
	if ((code = es_create_effect(c, es_text("keys"), key, typed, NULL, NULL, &n))) return es_out_code(code);
	return es_out_of(NULL);
}
