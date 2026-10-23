// the G0 menu (menu.h)
#include "menu.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "den.h"
#include "fb.h"
#include "host.h"

#define JOIN "join a room"
#define NEW "new room"
// the most items shown, and the longest name
#define ROWS 6
#define LONGEST 24

// an item a paired den added: its name, the den (its node), the ask done when it's picked
typedef struct item {
	char name[LONGEST + 1];
	char from[80];
	op_value *handler;
	struct item *next;
} item;

static struct {
	api *a;
	int open;
	// what shows: the list; a code being typed; a new room's code; going to a room
	enum { LIST, JOINING, MADE, GOING } mode;
	int at;
	char typed[5], made[5];
	item *items;
	// the names in the order shown (the den's two, then the rest by name), from the folder
	char names[16][LONGEST + 1];
	int n;
} m;

static void again(void) { frame_again(); }

// ---- the handlers: methods at /system/menu/<name> ----

static int join(api *a, const op_value *const *args, size_t nargs, op_value **out, void *ctx) {
	(void)a, (void)args, (void)nargs, (void)ctx;
	m.mode = JOINING, m.typed[0] = 0;
	*out = NULL;
	return 0;
}

// a code: four of DEN_LETTERS at random, not the room's now
static void code_new(char out[5]) {
	do {
		uint8_t r[4];
		den_random(r, 4);
		for (int i = 0; i < 4; i++) out[i] = DEN_LETTERS[r[i] % 16];
		out[4] = 0;
	} while (strcmp(out, den_room()) == 0);
}

static int fresh(api *a, const op_value *const *args, size_t nargs, op_value **out, void *ctx) {
	(void)a, (void)args, (void)nargs, (void)ctx;
	code_new(m.made);
	m.mode = MADE;
	*out = NULL;
	return 0;
}

// a paired den's: its ask done as if asked now (den.c checks it is still paired)
static int theirs(api *a, const op_value *const *args, size_t nargs, op_value **out, void *ctx) {
	(void)a, (void)args, (void)nargs;
	item *it = ctx;
	*out = den_do(it->from, it->name, it->handler);
	m.open = 0;
	return 0;
}

static int menu_program(api *a) {
	api_node n;
	int code = api_method(a, JOIN, join, NULL, &n);
	if (!code) api_node_free(&n), code = api_method(a, NEW, fresh, NULL, &n);
	if (!code) api_node_free(&n);
	return code;
}

void menu_start(void) { m.a = host_start_at("menu", "system", menu_program); }

// ---- what it holds, from the folder ----

static int by_name(const void *x, const void *y) { return strcmp(x, y); }

// the folder's names: the den's two first, the rest by name
static void list(void) {
	m.n = 0;
	const nd_entry *e = tb_get(host_get().table, tb_string("children"), tb_string("proc:menu"));
	const op_value *kids = e ? e->value : NULL;
	strcpy(m.names[m.n++], JOIN), strcpy(m.names[m.n++], NEW);
	int rest = m.n;
	for (size_t i = 0; kids && kids->type == OP_MAP && i < kids->count && m.n < 16; i++) {
		if (kids->items[i] == NULL || strcmp(kids->keys[i], JOIN) == 0 || strcmp(kids->keys[i], NEW) == 0) continue;
		snprintf(m.names[m.n++], LONGEST + 1, "%s", kids->keys[i]);
	}
	qsort(m.names[rest], (size_t)(m.n - rest), sizeof m.names[0], by_name);
	if (m.at >= m.n) m.at = m.n - 1;
}

static item *find(const char *name) {
	for (item *it = m.items; it; it = it->next)
		if (strcmp(it->name, name) == 0) return it;
	return NULL;
}

// ---- open, shut, keys ----

int menu_open(void) { return m.open; }

void menu_toggle(void) {
	m.open = !m.open;
	if (m.open) m.mode = LIST, m.at = 0, list();
	again();
}

static void pick(void) {
	char path[64];
	snprintf(path, sizeof path, "/system/menu/%s", m.names[m.at]);
	op_value *out = NULL;
	int code = api_send(m.a, api_at(path), NULL, 0, &out);
	if (out) op_free(out);
	host_settle();
	if (code) {
		char why[64];
		snprintf(why, sizeof why, "%s: %s", api_code_name(code), api_why(m.a));
		den_say(1, "that item didn't run:", why);
	}
}

int menu_key(const char *k) {
	if (!m.open || m.mode == GOING) return m.open;
	int esc = strcmp(k, "esc") == 0, enter = strcmp(k, "enter") == 0;
	// tab is the pair ask's yes, still
	if (strcmp(k, "tab") == 0) return 0;
	if (m.mode == LIST) {
		if (esc) m.open = 0;
		else if (enter) pick();
		else if (strcmp(k, "up") == 0 || strcmp(k, ";") == 0) m.at = (m.at + m.n - 1) % m.n;
		else if (strcmp(k, "down") == 0 || strcmp(k, ".") == 0) m.at = (m.at + 1) % m.n;
		else if (k[0] >= '1' && k[0] <= '9' && !k[1] && k[0] - '1' < m.n) m.at = k[0] - '1', pick();
	} else if (m.mode == JOINING) {
		size_t n = strlen(m.typed);
		if (esc) m.mode = LIST;
		else if (strcmp(k, "backspace") == 0) {
			if (n) m.typed[n - 1] = 0;
		} else if (enter) {
			if (n < 4) den_say(1, "a room's code is 4 letters", "type the rest, then enter");
			else if (strcmp(m.typed, den_room()) == 0) den_say(0, "you're in that room now", "esc: back");
			else m.mode = GOING, again(), room_go(m.typed);
		} else if (!k[1]) {
			char c = k[0] >= 'a' && k[0] <= 'z' ? (char)(k[0] - 32) : k[0];
			if (strchr(DEN_LETTERS, c) == NULL || c == 0) {
				char one[40];
				snprintf(one, sizeof one, "no %c in a room's code:", k[0]);
				den_say(1, one, "only the letters shown");
			} else if (n < 4) m.typed[n] = c, m.typed[n + 1] = 0;
		}
	} else if (m.mode == MADE) {
		if (esc) m.mode = LIST;
		else if (enter) m.mode = GOING, again(), room_go(m.made);
	}
	if (m.open && m.mode == LIST) list();
	again();
	return 1;
}

// ---- a paired den's items ----

op_value *menu_ask(const char *from, const char *name, const op_value *handler) {
	op_value *r = op_map();
	size_t n = strlen(name);
	int ok = n > 0 && n <= LONGEST && pl_is_name(name) && strchr(name, '/') == NULL;
	for (size_t i = 0; ok && i < n; i++) ok = name[i] >= ' ' && name[i] <= '~';
	if (!ok) {
		op_set(r, "error", op_str("a menu item's name: 1 to 24 letters, no /"));
		return r;
	}
	item *it = find(name);
	if (strcmp(name, JOIN) == 0 || strcmp(name, NEW) == 0 || (it && strcmp(it->from, from) != 0)) {
		op_set(r, "refused", op_str("taken"));
		op_set(r, "name", op_str(name));
		return r;
	}
	if (handler == NULL) {
		// out: its node let go
		if (it) {
			char path[64];
			snprintf(path, sizeof path, "/system/menu/%s", name);
			int code = api_remove(m.a, api_at(path));
			if (code) fprintf(stderr, "menu: %s not taken out: %s\n", name, api_code_name(code));
			item **p = &m.items;
			while (*p != it) p = &(*p)->next;
			*p = it->next;
			op_free(it->handler);
			free(it);
		}
	} else if (it) {
		op_free(it->handler);
		it->handler = op_ref((op_value *)handler);
	} else {
		it = calloc(1, sizeof *it);
		if (it == NULL) abort();
		snprintf(it->name, sizeof it->name, "%s", name);
		snprintf(it->from, sizeof it->from, "%s", from);
		it->handler = op_ref((op_value *)handler);
		api_node node;
		int code = api_method(m.a, name, theirs, it, &node);
		if (code) {
			op_free(it->handler);
			free(it);
			op_free(r);
			char why[64];
			snprintf(why, sizeof why, "not added: %s", api_code_name(code));
			return map_error(why);
		}
		api_node_free(&node);
		it->next = m.items, m.items = it;
	}
	host_settle();
	if (m.open) list(), again();
	return r;
}

// ---- the screen ----

static void tag(const char *code) {
	fb_rect(FB_W - 44, 1, 42, 11, FB_WHITE);
	fb_text(FB_W - 39, 3, code, FB_CHERRY, 1);
}

static void head(const char *title) {
	fb_clear(FB_CREAM);
	fb_rect(0, 0, FB_W, 13, FB_CHERRY);
	fb_text(4, 3, title, FB_WHITE, 1);
	tag(den_room());
}

static void hint(const char *s) { fb_text(4, FB_H - 34, s, FB_GREY, 1); }

// four boxes, the letters big in them
static void boxes(const char *code, int y) {
	for (int i = 0; i < 4; i++) {
		int x = 32 + i * 46;
		fb_rect(x, y, 38, 46, FB_WHITE);
		fb_rect(x, y + 44, 38, 2, code[i] ? FB_INK : FB_GREY);
		if (code[i]) {
			char one[2] = {code[i], 0};
			fb_text(x + 4, y + 6, one, FB_INK, 4);
		}
	}
}

void menu_paint(void) {
	if (m.mode == LIST) {
		head("menu");
		for (int i = 0; i < m.n && i < ROWS; i++) {
			int y = 17 + i * 13, on = i == m.at;
			if (on) fb_rect(2, y - 2, FB_W - 4, 12, FB_INK);
			char row[32];
			snprintf(row, sizeof row, "%d %s", i + 1, m.names[i]);
			fb_text(6, y, row, on ? FB_WHITE : FB_INK, 1);
			item *it = find(m.names[i]);
			if (it) {
				char from[16], w[20];
				den_short_name(it->from, from, sizeof from);
				snprintf(w, sizeof w, "%.10s", from);
				fb_text(FB_W - 6 - fb_text_width(w, 1), y, w, on ? FB_LILAC : FB_GREY, 1);
			}
		}
		hint(";/. move  enter pick  esc shut");
	} else if (m.mode == JOINING) {
		head("join a room");
		fb_text(4, 17, "type its code:", FB_INK, 1);
		boxes(m.typed, 28);
		fb_text(4, 80, "ACDEFHJKMNPRTWXY", FB_GREY, 1);
		hint("enter go  esc back  del undo");
	} else if (m.mode == MADE) {
		head("new room");
		fb_text(4, 17, "its code, to read off:", FB_INK, 1);
		boxes(m.made, 28);
		hint("enter go there  esc stay here");
	} else {
		fb_clear(FB_LEMON);
		fb_text(4, 20, "going to room", FB_INK, 2);
		fb_text(4, 50, m.typed[0] && m.made[0] == 0 ? m.typed : m.mode == GOING && m.typed[0] ? m.typed : m.made,
			FB_CHERRY, 5);
		return;
	}
	den_band();
}
