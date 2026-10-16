// Walking (walk.h), line for line with program.ts's pathOf, fold and walk
#include "walk.h"

#include <math.h>

static const double X0 = 0.06, X1 = 0.94, Y0 = 0.22, Y1 = 0.96;

uint32_t pig_hash(const char *s) {
	uint32_t h = 2166136261u;
	for (; *s; s++) h = (h ^ (uint8_t)*s) * 16777619u;
	return h;
}

double pig_draw(pig_random *r) {
	r->a += 0x6d2b79f5u;
	uint32_t t = r->a;
	t = (t ^ (t >> 15)) * (t | 1u);
	t ^= t + (t ^ (t >> 7)) * (t | 61u);
	return (double)(t ^ (t >> 14)) / 4294967296.0;
}

static double clamp(double v, double lo, double hi) { return v < lo ? lo : v > hi ? hi : v; }

pig_path pig_path_of(double x, double y, uint32_t seed) {
	pig_random n = pig_random_of(seed);
#define RANGE(lo, hi) ((lo) + ((hi) - (lo)) * pig_draw(&n))
	double angle = RANGE(0, 2 * M_PI);
	double V = RANGE(0.012, 0.022);
	double k[4], T[4], q[4];
	static const double lo[4][2] = {{0.5, 0.9}, {0.3, 0.6}, {0.35, 0.6}, {0.2, 0.4}};
	static const double Tlo[4][2] = {{14, 30}, {6, 12}, {12, 26}, {5, 10}};
	for (int i = 0; i < 4; i++) {
		k[i] = RANGE(lo[i][0], lo[i][1]);
		T[i] = RANGE(Tlo[i][0], Tlo[i][1]);
		q[i] = RANGE(0, 2 * M_PI);
	}
	double Tp = RANGE(7, 13), pp = RANGE(0, 2 * M_PI);
#undef RANGE
	pig_path p = {.x0 = clamp(x, X0, X1), .y0 = clamp(y, Y0, Y1), .V = V, .dx = cos(angle), .dy = sin(angle) * 0.7,
		.wp = (2 * M_PI) / Tp, .pp = pp};
	for (int i = 0; i < 4; i++) {
		double w = (2 * M_PI) / T[i];
		pig_wave wave = {k[i] / w, w, q[i]};
		if (i < 2) p.wx[i] = wave;
		else p.wy[i - 2] = wave;
	}
	return p;
}

// v folded into [lo, hi], and which way it goes there (1, or -1 coming back); % in JavaScript is fmod
static double fold(double v, double lo, double hi, double *way) {
	double L = hi - lo, m = fmod(fmod(v - lo, 2 * L) + 2 * L, 2 * L);
	if (m < L) return *way = 1, lo + m;
	return *way = -1, hi - (m - L);
}

// a point inside the corner of shame folded back out across its nearer inner edge (the left, or the
// bottom); which way x goes then (1, or -1 if folded)
static double avoid(double *x, double *y) {
	if (*x <= PIG_SHAME_X || *y >= PIG_SHAME_Y) return 1;
	double left = *x - PIG_SHAME_X, bottom = PIG_SHAME_Y - *y;
	if (left < bottom) return *x = PIG_SHAME_X - left, -1;
	return *y = PIG_SHAME_Y + bottom, 1;
}

pig_walked pig_walk(const pig_path *p, double at, double now, bool open) {
	double t = (now - at) / 1000;
	if (!(t > 0)) t = 0;
	double th = p->wp * t + p->pp;
	double s = t + (2 * (sin(th) - sin(p->pp)) + (sin(2 * th) - sin(2 * p->pp)) / 4) / (1.5 * p->wp);
	double g = pow(1 + cos(th), 2) / 1.5;
	double ux = p->dx * s, uy = p->dy * s, vx = p->dx, vy = p->dy;
	for (int i = 0; i < 2; i++) {
		const pig_wave *w = &p->wx[i];
		ux += w->a * (sin(w->w * s + w->p) - sin(w->p)), vx += w->a * w->w * cos(w->w * s + w->p);
	}
	for (int i = 0; i < 2; i++) {
		const pig_wave *w = &p->wy[i];
		uy += w->a * (sin(w->w * s + w->p) - sin(w->p)), vy += w->a * w->w * cos(w->w * s + w->p);
	}
	double fx, fy;
	pig_walked out;
	out.x = fold(p->x0 + p->V * ux, X0, X1, &fx);
	out.y = fold(p->y0 + p->V * uy, Y0, Y1, &fy);
	double ax = open ? avoid(&out.x, &out.y) : 1;
	out.vx = p->V * vx * g * fx * ax;
	out.phase = 2 * M_PI * 1.6 * s;
	double stride = (g * hypot(vx, vy)) / 0.7;
	out.stride = stride < 1 ? stride : 1;
	return out;
}
