// cat.h: what moves: the hands, the tail and the eyes (xclock.c's DrawHand,
// CreateTailPixmap and CreateEyePixmap). t, the swing, goes 0 to pi and back.

#define CAT_BOTTOM 210 // DEF_CAT_BOTTOM: the tail's strip starts one below
#define EYES_X 49
#define EYES_Y 30

/** a hand, filled, then outlined; fraction of a turn clockwise from noon */
static void hand(int length, int width, double fraction) {
	double s, c;
	sincos_(2 * PI * fraction, &s, &c);
	double wc = width * c, ws = width * s;
	int cx = CAT_W / 2, cy = CAT_H / 2;
	Point p[4] = {
		{ cx + round_(length * s), cy - round_(length * c) },
		{ cx - round_(ws + wc), cy + round_(wc - ws) },
		{ cx - round_(ws - wc), cy + round_(wc + ws) },
	};
	p[3] = p[0];
	fillpoly(WHOLE, p, 3, HAND);
	for (int i = 0; i < 3; i++) line(WHOLE, p[i], p[i + 1], HIGHLIGHT);
}

/** the tail's strip at swing t: a pendulum, hanging a little left for its hook */
static void tail(double t) {
	static const Point shape[7] = { { 0, 0 }, { 0, 76 }, { 3, 82 }, { 10, 84 }, { 18, 82 }, { 21, 76 }, { 21, 70 } };
	View v = { 0, CAT_BOTTOM + 1, TAIL_W, TAIL_H };
	stamp(v, &tail_bits[0][0], sizeof tail_bits[0], CAT, BG);
	Point off[7], now[7];
	double s = sin_(-0.08), c = cos_(-0.08);
	for (int i = 0; i < 7; i++) off[i] = (Point){ (int)(shape[i].x * c + shape[i].y * s), (int)(-shape[i].x * s + shape[i].y * c) };
	double angle = 0.4 * sin_(1.0 * t + 3 * PI / 2);
	s = sin_(angle), c = cos_(angle);
	for (int i = 0; i < 7; i++) now[i] = (Point){ (int)(off[i].x * c + off[i].y * s) + 74, (int)(-off[i].x * s + off[i].y * c) - 15 };
	wide(v, now, 7, 15, CAT);
}

/** the eyes at swing t: each pupil a sphere's front, looking along the pendulum */
static void eyes(double t) {
	View v = { EYES_X, EYES_Y, EYES_W, EYES_H };
	stamp(v, &eyes_bits[0][0], sizeof eyes_bits[0], CAT, DETAIL);
	double angle = 0.7 * sin_(1.0 * t + 3 * PI / 2) + PI / 2;
	Point p[32];
	int n = 0;
	for (double u = -PI / 2; u < PI / 2; u += 0.25) {
		double x = cos_(u) * cos_(angle + PI / 7), z = 2 + cos_(u) * sin_(angle + PI / 7), y = sin_(u);
		p[n++] = (Point){ (int)((z == 0 ? x : x / z) * 23 + 12), (int)((z == 0 ? y : y / z) * 23 + 11) };
	}
	for (double u = PI / 2; u > -PI / 2; u -= 0.25) {
		double x = cos_(u) * cos_(angle - PI / 7), z = 2 + cos_(u) * sin_(angle - PI / 7), y = sin_(u);
		p[n++] = (Point){ (int)((z == 0 ? x : x / z) * 23 + 12), (int)((z == 0 ? y : y / z) * 23 + 11) };
	}
	fillpoly(v, p, n, CAT);
	for (int i = 0; i < n; i++) p[i].x += 31;
	fillpoly(v, p, n, CAT);
}
