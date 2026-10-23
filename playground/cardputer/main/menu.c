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
#define ROOMS "rooms"
// the most items shown, and the longest name
#define ROWS 6
// the rooms shown at once
#define ROOM_ROWS 6
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
	// what shows: the list; a code being typed; a new room's code; going to a room; the rooms kept
	// here; a room to delete, asked
	enum { LIST, JOINING, MADE, GOING, ROOMING, DELETING } mode;
	int at;
	char typed[5], made[5], going[5];
	// the rooms kept here, the one picked, the first shown
	menu_room rooms[32];
	int nrooms, rat, rtop;
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
	printf("menu: new room %s\n", m.made);
	*out = NULL;
	return 0;
}

// every room kept here, by code
static int by_code(const void *x, const void *y) { return strcmp(((const menu_room *)x)->code, ((const menu_room *)y)->code); }
static void rooms_again(void) {
	m.nrooms = rooms_list(m.rooms, 32);
	qsort(m.rooms, (size_t)m.nrooms, sizeof *m.rooms, by_code);
	if (m.rat >= m.nrooms) m.rat = m.nrooms ? m.nrooms - 1 : 0;
}

static int rooms(api *a, const op_value *const *args, size_t nargs, op_value **out, void *ctx) {
	(void)a, (void)args, (void)nargs, (void)ctx;
	m.mode = ROOMING, m.rat = m.rtop = 0;
	rooms_again();
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
	if (!code) api_node_free(&n), code = api_method(a, ROOMS, rooms, NULL, &n);
	if (!code) api_node_free(&n);
	return code;
}

void menu_start(void) { m.a = host_start_at("menu", "system", menu_program); }

// ---- what it holds, from the folder ----

static int by_name(const void *x, const void *y) { return strcmp(x, y); }

static int own(const char *name) { return !strcmp(name, JOIN) || !strcmp(name, NEW) || !strcmp(name, ROOMS); }

// the folder's names: the den's three first, the rest by name
static void list(void) {
	m.n = 0;
	const nd_entry *e = tb_get(host_get().table, tb_string("children"), tb_string("proc:menu"));
	const op_value *kids = e ? e->value : NULL;
	strcpy(m.names[m.n++], JOIN), strcpy(m.names[m.n++], NEW), strcpy(m.names[m.n++], ROOMS);
	int rest = m.n;
	for (size_t i = 0; kids && kids->type == OP_MAP && i < kids->count && m.n < 16; i++) {
		if (kids->items[i] == NULL || own(kids->keys[i])) continue;
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

// to a room: said on the screen, then the platform's room_go (a restart)
static void go(const char *code) {
	snprintf(m.going, sizeof m.going, "%s", code);
	printf("menu: going to room %s\n", code);
	m.mode = GOING;
	again();
	room_go(code);
}

int menu_key(const char *k) {
	if (!m.open || m.mode == GOING) return m.open;
	int esc = strcmp(k, "esc") == 0, enter = strcmp(k, "enter") == 0;
	// tab is the pair ask's yes, still, but where a room's delete is asked
	if (strcmp(k, "tab") == 0 && m.mode != DELETING) return 0;
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
			else go(m.typed);
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
		else if (enter) go(m.made);
	} else if (m.mode == ROOMING) {
		if (esc) m.mode = LIST;
		else if (m.nrooms == 0) {
		} else if (strcmp(k, "up") == 0 || strcmp(k, ";") == 0) m.rat = (m.rat + m.nrooms - 1) % m.nrooms;
		else if (strcmp(k, "down") == 0 || strcmp(k, ".") == 0) m.rat = (m.rat + 1) % m.nrooms;
		else if (enter && strcmp(m.rooms[m.rat].code, den_room()) == 0) {
			char one[40];
			snprintf(one, sizeof one, "%s is the room you're in:", m.rooms[m.rat].code);
			den_say(1, one, "join another to delete it");
		} else if (enter) m.mode = DELETING;
		// the one picked always among those shown
		if (m.rat < m.rtop) m.rtop = m.rat;
		if (m.rat >= m.rtop + ROOM_ROWS) m.rtop = m.rat - ROOM_ROWS + 1;
	} else if (m.mode == DELETING) {
		const menu_room *r = &m.rooms[m.rat];
		if (esc) m.mode = ROOMING;
		else if (strcmp(k, "tab") == 0) {
			char code[5], fs[4], why[48], one[48], two[48];
			unsigned kb = r->kb, left = 0;
			snprintf(code, sizeof code, "%s", r->code), snprintf(fs, sizeof fs, "%s", r->fs);
			if (room_delete(code, &left, why, sizeof why) == 0) {
				printf("menu: room %s deleted, %uK freed; %s has %uK free\n", code, kb, fs, left);
				snprintf(one, sizeof one, "%s deleted: %uK freed", code, kb);
				snprintf(two, sizeof two, "%s has %uK free now", fs, left);
				den_say(0, one, two);
			} else {
				printf("menu: room %s not deleted: %s\n", code, why);
				snprintf(one, sizeof one, "%s not deleted:", code);
				den_say(1, one, why);
			}
			m.mode = ROOMING;
			rooms_again();
			if (m.rtop > m.rat) m.rtop = m.rat;
		}
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
	if (own(name) || (it && strcmp(it->from, from) != 0)) {
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
			r = op_map();
			op_set(r, "error", op_str(why));
			return r;
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
		hint(";. move  enter pick  esc shut");
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
	} else if (m.mode == ROOMING) {
		head("rooms kept here");
		if (m.nrooms == 0) fb_text(6, 17, "none", FB_GREY, 1);
		for (int i = m.rtop; i < m.nrooms && i < m.rtop + ROOM_ROWS; i++) {
			const menu_room *r = &m.rooms[i];
			int y = 17 + (i - m.rtop) * 13, on = i == m.rat, here = strcmp(r->code, den_room()) == 0;
			if (on) fb_rect(2, y - 2, FB_W - 4, 12, FB_INK);
			char row[32];
			snprintf(row, sizeof row, "%s %5uK %s%s", r->code, r->kb, r->fs, here ? "  here" : "");
			fb_text(6, y, row, on ? FB_WHITE : here ? FB_CHERRY : FB_INK, 1);
		}
		if (m.rtop > 0) fb_text(FB_W - 14, 17, "^", FB_GREY, 1);
		if (m.rtop + ROOM_ROWS < m.nrooms) fb_text(FB_W - 14, 17 + (ROOM_ROWS - 1) * 13, "v", FB_GREY, 1);
		hint(";. move enter delete esc back");
	} else if (m.mode == DELETING) {
		const menu_room *r = &m.rooms[m.rat];
		head("delete a room?");
		char line[40];
		snprintf(line, sizeof line, "delete %s (%uK on %s)?", r->code, r->kb, r->fs);
		fb_text(4, 17, line, FB_INK, 1);
		boxes(r->code, 28);
		fb_text(4, 80, "its log and all, for good", FB_CHERRY, 1);
		hint("tab yes  esc no");
	} else {
		fb_clear(FB_LEMON);
		fb_text(4, 20, "going to room", FB_INK, 2);
		fb_text(4, 50, m.going, FB_CHERRY, 5);
		return;
	}
	den_band();
}
