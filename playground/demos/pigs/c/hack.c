// The NetHack look (ermine-pigs --look nethack): the field as a lit room, walls - and |, floor ., you
// the @, each pig a q in its tint, other people @s in their colours. The top line is the message line,
// the bottom two the status lines. Part of pigs.c (included by it, before main): the same world, the
// same nodes and the same writes as the pixel look; only the drawing and the keys differ.
//
// The room's floor is the field: each floor cell a piece of it, a pig drawn in the cell its feet are
// in, so walking (the shared formula) moves it cell by cell. You are a cell: your pointer (presence)
// is its middle, a pig you carry is there too (drawn as a q above you). The corner of shame is a
// closet in the top right, walled off with an open door, there while it is open (or while you carry a
// pig near it); its walls stop you, as walls do. Its door lets you in, never out: in it you are stuck
// (your presence row says so), until someone on a page drags you out. A drag goes through walls. The bin, _, comes out at the bottom right when you
// are near it.

// the hack's own: where you are (a cell), where you travel to, the help on show, the mouse
typedef struct {
	int col, row;
	bool placed;
	int to_col, to_row;
	bool travelling;
	bool help;
	// the mouse: pressed at a cell, on a pig (not taken until it is dragged), dragged since
	bool pressed, dragged;
	int press_col, press_row;
	char press_pig[DV_ID];
	unsigned long turns;
	char here[DV_ID];
	bool closet;
	// someone on a page dragging you: their name and key, when they last moved you
	char dragged_by[64], dragger[65];
	double dragged_at;
	// stuck in the corner of shame: in the closet, by its door or by a drag; out only by a page's drag
	// (stuck when it began, the last door-is-stuck told)
	bool stuck, was_stuck;
	double stuck_told;
} hack_t;
static hack_t H;

// the room: walls on the map's edge (rows 1 to rows - 3); the floor inside, the field
static int h_iw(void) { return w.s.cols - 2; }
static int h_ih(void) { return w.s.rows - 5; }
static int h_col(double x) {
	int c = (int)floor(x * h_iw());
	return 1 + (c < 0 ? 0 : c >= h_iw() ? h_iw() - 1 : c);
}
static int h_row(double y) {
	int r = (int)floor(y * h_ih());
	return 2 + (r < 0 ? 0 : r >= h_ih() ? h_ih() - 1 : r);
}
static double h_x(int col) { return (col - 1 + 0.5) / h_iw(); }
static double h_y(int row) { return (row - 2 + 0.5) / h_ih(); }
static bool h_floor(int col, int row) { return col >= 1 && col <= h_iw() && row >= 2 && row < 2 + h_ih(); }

// the closet: its left wall the column x = 0.78 is in, its bottom wall the row y = 0.45 is in, an open
// door in the bottom wall's middle
static int h_wall_col(void) { return h_col(PIG_SHAME_X); }
static int h_wall_row(void) { return h_row(PIG_SHAME_Y); }
static int h_door_col(void) { return h_wall_col() + (w.s.cols - 2 - h_wall_col()) / 2 + 1; }
static bool h_closet_wall(int col, int row) {
	if (!H.closet) return false;
	int wc = h_wall_col(), wr = h_wall_row();
	if (col == wc && row >= 2 && row <= wr) return true;
	return row == wr && col >= wc && col <= w.s.cols - 2 && col != h_door_col();
}
// inside the closet (its floor, within its walls)
static bool h_inside(int col, int row) {
	return col > h_wall_col() && col <= h_iw() && row >= 2 && row < h_wall_row();
}
// where you can go by yourself: the floor, not the closet's walls; stuck, only the closet's floor
static bool h_open_cell(int col, int row) {
	if (H.stuck && !h_inside(col, row)) return false;
	return h_floor(col, row) && !h_closet_wall(col, row);
}
static void h_stuck(bool stuck) {
	if (H.stuck == stuck) return;
	H.stuck = hack_stuck = stuck;
	// told to the others now (presence)
	w.pointer_due = true;
}
static void h_door_stuck(void) {
	if (mono() - H.stuck_told < 1500) return;
	H.stuck_told = mono();
	tell("The door is stuck. You feel ashamed.");
}

// where a pig is now (shared walking), as the pixel look works it out
static void h_place(pig *p, double clock) {
	if (!strcmp(w.holding, p->id)) return;
	if (p->held || p->shame || p->binned) p->gx = p->x, p->gy = p->y;
	else {
		pig_walked m = pig_walk(&p->path, p->at, clock, w.open);
		p->gx = m.x, p->gy = m.y;
	}
}

// you moved: your pointer there, a pig you carry with you, what is here told
static void h_moved(void) {
	H.turns++;
	double x = h_x(H.col), y = h_y(H.row);
	pointer_at(x, y);
	pig *held = pig_find(w.holding);
	if (held) {
		if (held->gx != x || held->gy != y) carry_to(held, x, y);
		return;
	}
	for (size_t i = 0; i < npigs; i++) {
		pig *p = &pigs[i];
		if (!shown(p) || h_col(p->gx) != H.col || h_row(p->gy) != H.row) continue;
		if (strcmp(H.here, p->id)) tell("You see here a pig (%s).", pig_name(p->id));
		snprintf(H.here, DV_ID, "%s", p->id);
		return;
	}
	H.here[0] = 0;
}

static bool h_step(int dc, int dr) {
	int c = H.col + dc, r = H.row + dr;
	if (!h_open_cell(c, r)) {
		if (H.stuck && h_floor(c, r)) h_door_stuck();
		return false;
	}
	H.col = c, H.row = r;
	// in by the door: it shuts behind you
	if (!H.stuck && H.closet && h_inside(c, r)) h_stuck(true), tell("The door swings shut behind you. You feel ashamed.");
	h_moved();
	return true;
}

// the pig under you, else the nearest next to you; NULL: none
static pig *h_pig_near(int col, int row) {
	pig *best = NULL;
	double d = 1e9;
	for (size_t i = 0; i < npigs; i++) {
		pig *p = &pigs[i];
		if (!shown(p) || p->held) continue;
		int dc = h_col(p->gx) - col, dr = h_row(p->gy) - row;
		if (abs(dc) > 1 || abs(dr) > 1) continue;
		double e = hypot(dc, dr * 2);
		if (e < d) d = e, best = p;
	}
	return best;
}

static void h_pick_up(void) {
	if (w.holding[0]) {
		tell("You are already carrying a pig.");
		return;
	}
	pig *p = h_pig_near(H.col, H.row);
	if (!p) {
		tell("There is nothing here to pick up.");
		return;
	}
	grab(p, false, 0, 0);
	pointer_at(h_x(H.col), h_y(H.row));
	carry_to(p, h_x(H.col), h_y(H.row));
}

static void h_drop(void) {
	if (!w.holding[0]) {
		tell("You don't have anything to drop.");
		return;
	}
	pointer_at(h_x(H.col), h_y(H.row));
	drop();
}

// running: on until a wall, or (carrying nothing) until next to a pig
static void h_run(int dc, int dr) {
	for (int i = 0; i < 400 && h_step(dc, dr); i++)
		if (!w.holding[0] && h_pig_near(H.col, H.row)) break;
}

// travel: one step a frame along the shortest way round the walls (a search over the floor)
static void h_travel(void) {
	if (!H.travelling) return;
	if (H.col == H.to_col && H.row == H.to_row) {
		H.travelling = false;
		return;
	}
	int cols = w.s.cols, rows = w.s.rows, n = cols * rows;
	int *from = malloc((size_t)n * sizeof *from), *queue = malloc((size_t)n * sizeof *queue);
	if (!from || !queue) abort();
	for (int i = 0; i < n; i++) from[i] = -1;
	int head = 0, tail = 0, goal = H.to_row * cols + H.to_col, start = H.row * cols + H.col;
	from[goal] = goal, queue[tail++] = goal;
	// from the goal back, so each cell knows its next step towards it
	while (head < tail && from[start] < 0) {
		int at = queue[head++], c = at % cols, r = at / cols;
		for (int dr = -1; dr <= 1; dr++)
			for (int dc = -1; dc <= 1; dc++) {
				int nc = c + dc, nr = r + dr, k = nr * cols + nc;
				if ((dc || dr) && (h_open_cell(nc, nr) || k == start) && nc >= 0 && nr >= 0 && nc < cols && nr < rows && from[k] < 0)
					from[k] = at, queue[tail++] = k;
			}
	}
	int next = from[start];
	free(from), free(queue);
	if (next < 0 || next == start) {
		if (H.stuck) h_door_stuck();
		H.travelling = false;
		return;
	}
	h_step(next % cols - H.col, next / cols - H.row);
}

// ---- dragged by someone on a page

// let go of: stuck if left in the closet, free if pulled out of it
static void h_let_go(void) {
	tell("%s lets go of you.", H.dragged_by);
	bool inside = (H.closet || H.was_stuck) && h_inside(H.col, H.row);
	if (H.was_stuck && !inside) tell("%s pulls you out of the corner of shame!", H.dragged_by);
	if (!H.was_stuck && inside) tell("%s leaves you in the corner of shame. You feel ashamed.", H.dragged_by);
	h_stuck(inside);
	H.dragged_by[0] = 0;
}

// a request on the room's move topic: {to: a key, x, y (field units), by: their name, who: their key},
// or {to, by, who, done: true} when they let go. To me: my @ goes towards there along the line, as far
// as the floor goes (a wall stops it: no one is dragged through the closet's wall, only by its door);
// a pig I carry comes along, and my presence row follows (h_moved)
static void hack_moved(void *context, const char *from, const uint8_t *bytes, size_t n) {
	(void)context;
	char *why = NULL;
	Json *m = jsonParse((const char *)bytes, n, &why);
	free(why);
	const char *to = jsonText(jsonGet(m, "to")), *by = jsonText(jsonGet(m, "by"));
	if (!m || !to || strcmp(to, w.me) || !H.placed) {
		jsonFree(m);
		return;
	}
	char name[64];
	snprintf(name, sizeof name, "%s", by ? by : "Someone");
	const char *who = jsonText(jsonGet(m, "who"));
	if (!who) who = from ? from : "";
	if (jsonGet(m, "done")) {
		if (H.dragged_by[0] && !strcmp(H.dragger, who)) h_let_go();
		jsonFree(m);
		return;
	}
	Json *x = jsonGet(m, "x"), *y = jsonGet(m, "y");
	if (!x || !y || !jsonIsNumber(x) || !jsonIsNumber(y)) {
		jsonFree(m);
		return;
	}
	if (!H.dragged_by[0]) H.was_stuck = H.stuck;
	if (!H.dragged_by[0] || strcmp(H.dragger, who)) tell("You are dragged by %s!", name);
	snprintf(H.dragged_by, sizeof H.dragged_by, "%s", name);
	snprintf(H.dragger, sizeof H.dragger, "%s", who);
	H.dragged_at = mono();
	H.travelling = false;
	// through walls (a drag is how you leave the closet), to the floor nearest where it is
	int c1 = h_col(clampd(x->number, 0, 1)), r1 = h_row(clampd(y->number, 0, 1)), c0 = H.col, r0 = H.row;
	for (int d = 0; h_closet_wall(c1, r1) && d < 4; d++) {
		int best = -1;
		double e = 1e9;
		for (int dr = -d - 1; dr <= d + 1; dr++)
			for (int dc = -d - 1; dc <= d + 1; dc++) {
				int c = c1 + dc, r = r1 + dr;
				double f = hypot(dc, dr * 2);
				if (h_floor(c, r) && !h_closet_wall(c, r) && f < e) e = f, best = r * w.s.cols + c;
			}
		if (best >= 0) c1 = best % w.s.cols, r1 = best / w.s.cols;
	}
	H.col = c1, H.row = r1;
	if (H.col != c0 || H.row != r0) h_moved();
	jsonFree(m);
}

// ---- the keys and the mouse

static void hack_key(const key *k) {
	if (H.help) {
		H.help = false;
		return;
	}
	bool held = w.holding[0];
	int ch = k->kind == K_CHAR ? k->ch : 0;
	static const char *walk = "hjklyubn", *run = "HJKLYUBN";
	static const int dirs[8][2] = {{-1, 0}, {0, 1}, {0, -1}, {1, 0}, {-1, -1}, {1, -1}, {-1, 1}, {1, 1}};
	const char *wk = ch ? strchr(walk, ch) : NULL, *rk = ch ? strchr(run, ch) : NULL;
	H.travelling = H.travelling && k->kind == K_MOUSE;
	if (wk) h_step(dirs[wk - walk][0], dirs[wk - walk][1]);
	else if (rk) h_run(dirs[rk - run][0], dirs[rk - run][1]);
	else if (k->kind == K_LEFT) k->shift ? h_run(-1, 0) : (void)h_step(-1, 0);
	else if (k->kind == K_RIGHT) k->shift ? h_run(1, 0) : (void)h_step(1, 0);
	else if (k->kind == K_UP) k->shift ? h_run(0, -1) : (void)h_step(0, -1);
	else if (k->kind == K_DOWN) k->shift ? h_run(0, 1) : (void)h_step(0, 1);
	else if (ch == ',') h_pick_up();
	else if (ch == ' ') held ? h_drop() : h_pick_up();
	else if (ch == 'd') h_drop();
	else if (ch == 'a') add_pig();
	else if (ch == 's') settle_all(), tell("You settle the versions.");
	else if (ch == '?') H.help = true;
	else if (ch == 'q' || ch == 3) quit = 1;
	else if (k->kind == K_MOUSE) {
		if (k->wheel || k->button == 3) return;
		int c = k->col, r = k->row;
		if (k->press && !k->motion) {
			// pressed: on a pig (taken if dragged), or a cell to travel to (on letting go)
			H.pressed = true, H.dragged = false, H.press_col = c, H.press_row = r;
			pig *p = held ? NULL : h_pig_near(c, r);
			snprintf(H.press_pig, DV_ID, "%s", p ? p->id : "");
		} else if (k->press && k->motion && H.pressed) {
			if (!H.dragged && H.press_pig[0] && !held) {
				pig *p = pig_find(H.press_pig);
				if (p && shown(p) && !p->held) {
					if (h_open_cell(H.press_col, H.press_row)) H.col = H.press_col, H.row = H.press_row;
					grab(p, true, 0, 0);
				}
			}
			H.dragged = true;
			if (w.holding[0] && w.by_mouse && h_open_cell(c, r)) H.col = c, H.row = r, h_moved();
		} else if (!k->press) {
			if (w.holding[0] && w.by_mouse && H.dragged) h_drop();
			else if (!H.dragged && h_floor(c, r)) H.to_col = c, H.to_row = r, H.travelling = true;
			H.pressed = H.dragged = false;
		}
	}
}

// ---- drawing

static const rgb H_BLACK = {0, 0, 0}, H_GREY = {0xaa, 0xaa, 0xaa};
static const rgb H_WHITE = {0xff, 0xff, 0xff}, H_DOOR = {0xc2, 0x7c, 0x0e}, H_GOLD = {0xff, 0xe0, 0x66};

static void h_put(int row, int col, const char *ch, rgb fg, bool bold) {
	cell *c = screen_at(&w.s, row, col);
	if (!c) return;
	*c = (cell){.fg = fg, .bg = H_BLACK, .bold = bold};
	snprintf(c->ch, sizeof c->ch, "%s", ch);
}

// a pig's q: its tint, a little deeper so it reads on black
static rgb h_tint(const pig *p) {
	pig_random t = pig_random_of(pig_hash(p->id) ^ 0x9e3779b9u);
	double hue = 333 + 20 * pig_draw(&t), light = 81 + 6 * pig_draw(&t);
	return hsl(hue - 18, 90, light - 16);
}

static void hack_draw(double now, double clock, double dt) {
	(void)dt;
	screen *s = &w.s;
	// the field in field units here (bin_rect, over_bin)
	w.fw = 1, w.fh = 1, w.k = 1.0 / PAGE_W;
	if (!H.placed || !h_floor(H.col, H.row)) {
		H.col = 1 + h_iw() / 2, H.row = 2 + h_ih() / 2, H.placed = true;
		pointer_at(h_x(H.col), h_y(H.row));
	}
	h_travel();
	// a drag that went quiet (its let-go lost): let go
	if (H.dragged_by[0] && now - H.dragged_at > 3000) h_let_go();
	pig *held = pig_find(w.holding);
	if (held && (held->gx != h_x(H.col) || held->gy != h_y(H.row))) carry_to(held, h_x(H.col), h_y(H.row));
	H.closet = w.open || H.stuck || (held && near_shame(h_x(H.col), h_y(H.row)));
	for (int r = 0; r < s->rows; r++)
		for (int c = 0; c < s->cols; c++) h_put(r, c, " ", H_GREY, false);
	// the room: corners and walls -, |; the floor
	int top = 1, bottom = s->rows - 3, right = s->cols - 1;
	for (int c = 0; c <= right; c++) h_put(top, c, "-", H_GREY, false), h_put(bottom, c, "-", H_GREY, false);
	for (int r = top + 1; r < bottom; r++) h_put(r, 0, "|", H_GREY, false), h_put(r, right, "|", H_GREY, false);
	for (int r = 2; r < 2 + h_ih(); r++)
		for (int c = 1; c <= h_iw(); c++) h_put(r, c, ".", H_GREY, false);
	if (H.closet) {
		int wc = h_wall_col(), wr = h_wall_row();
		for (int r = 2; r < wr; r++) h_put(r, wc, "|", H_GREY, false);
		for (int c = wc; c <= h_iw(); c++) h_put(wr, c, "-", H_GREY, false);
		h_put(wr, h_door_col(), "|", H_DOOR, false);
		h_put(top, wc, "-", H_GREY, false);
		h_put(wr, right, "|", H_GREY, false);
	}
	// the bin, out while you are near it (or swallowing)
	double bx0, by0, bx1, by1;
	bin_rect(&bx0, &by0, &bx1, &by1);
	bool near = near_bin(h_x(H.col), h_y(H.row)) || now < w.gulp_until;
	if (near) h_put(h_row((by0 + by1) / 2), h_col((bx0 + bx1) / 2), "_", H_GOLD, true);
	// the pigs: each a q where its feet are; one carried, a q above its holder's @
	const op_value *room = room_value();
	for (size_t i = 0; i < npigs; i++) pigs[i].drawn = false;
	for (int pass = 0; pass < 2; pass++)
		for (size_t i = 0; i < npigs; i++) {
			pig *p = &pigs[i];
			if (!p->known || !in_room(room, p->id)) continue;
			if (pass == 0) h_place(p, clock);
			bool mine = !strcmp(w.holding, p->id), carried = mine || p->held;
			if (p->binned && !carried) continue;
			// the resting first, then the carried (on top)
			if (carried != (pass == 1)) continue;
			int c = h_col(p->gx), r = h_row(p->gy);
			p->drawn = true;
			rgb tint = h_tint(p);
			if (!carried) {
				bool dim = p->shame;
				h_put(r, c, "q", dim ? mix(tint, H_BLACK, 0.55) : tint, !dim);
				continue;
			}
			h_put(r - 1, c, "q", tint, true);
			if (!mine) h_put(r, c, "@", p->colour, true);
		}
	// the others: their @s where their pointers are (not those carrying: they are under their pig)
	for (size_t i = 0; i < w.nrows; i++) {
		row_t *o = &w.rows[i];
		if (!o->pointer || !strcmp(o->who, w.me) || o->until <= now) continue;
		bool carrying = false;
		for (size_t j = 0; j < npigs; j++)
			if (pigs[j].held && !strcmp(pigs[j].who, o->who)) carrying = true;
		if (!carrying) h_put(h_row(o->y), h_col(o->x), "@", o->colour, true);
	}
	h_put(H.row, H.col, "@", H_WHITE, true);

	// the message line: what happened lately
	char line[1024] = "";
	for (int i = 0; i < nsaid; i++) {
		if (now - said[i].at > 6000) continue;
		if (line[0]) strncat(line, "  ", sizeof line - strlen(line) - 1);
		strncat(line, said[i].text, sizeof line - strlen(line) - 1);
	}
	size_t room_for = (size_t)s->cols;
	if (strlen(line) > room_for) {
		// the latest whole, the older cut
		const char *at = line + strlen(line) - room_for + 9;
		char cut[1024];
		snprintf(cut, sizeof cut, "--More-- %s", at);
		screen_text(s, 0, 0, cut, H_WHITE, &H_BLACK, false);
	} else screen_text(s, 0, 0, line, H_WHITE, &H_BLACK, false);

	// the status lines
	int count = 0;
	for (size_t i = 0; i < npigs; i++)
		if (in_room(room, pigs[i].id)) count++;
	char status[512];
	snprintf(status, sizeof status, "%s the Swineherd   Room:%.8s   Pigs:%d   Carrying:%s", w.name, ROOM + 9, count,
		held ? pig_name(held->id) : "nothing");
	int col = screen_text(s, s->rows - 2, 0, status, H_GREY, &H_BLACK, false);
	(void)col;
	screen_text(s, s->rows - 2, 0, w.name, w.colour, &H_BLACK, true);
	snprintf(status, sizeof status, "Dlvl:%s  %s%s  T:%lu  Here:",  w.server ? "galaxy" : "home", !w.server ? "Offline" : w.online ? "Online" : "Joining",
		H.stuck ? "  Ashamed" : "", H.turns);
	col = screen_text(s, s->rows - 1, 0, status, H_GREY, &H_BLACK, false);
	for (size_t i = 0; i < w.nrows && col < s->cols - 2; i++) {
		if (!strcmp(w.rows[i].who, w.me) || w.rows[i].until <= now) continue;
		col += 1 + screen_text(s, s->rows - 1, col + 1, w.rows[i].name, w.rows[i].colour, &H_BLACK, true);
	}
	if (w.conflicts) {
		snprintf(status, sizeof status, "  Versions:%d (s)", w.conflicts);
		screen_text(s, s->rows - 1, col, status, H_DOOR, &H_BLACK, false);
	}

	if (H.help) {
		static const char *help[] = {
			"ermine-pigs, the NetHack way",
			"",
			"y k u    move one step (arrows too); shift: run",
			" \\|/",
			"h-@-l    , or space   pick up the pig here or next to you",
			" /|\\     space or d   put it down",
			"b j n    click        travel there; drag a pig: carry it",
			"",
			"a  add a pig     s  settle versions     q  quit",
			"",
			"the bin (_) comes out at the bottom right; the closet in",
			"the top right is the corner of shame. q a pig, @ a person.",
			"",
			"(any key to go back)",
		};
		int n = sizeof help / sizeof *help, r0 = (s->rows - n - 2) / 2, c0 = (s->cols - 64) / 2;
		rgb box = {0x22, 0x22, 0x44};
		for (int i = -1; i <= n; i++) {
			char line[80];
			snprintf(line, sizeof line, "  %-60s  ", i < 0 || i == n ? "" : help[i]);
			screen_text(s, r0 + 1 + i, c0 < 0 ? 0 : c0, line, H_WHITE, &box, i == 0);
		}
	}
}
