// maths.h: floor, xclock's Round, sin and cos, by hand: wasm has no libm.

#include <stdint.h>

#define PI 3.14159265358979323846

static double fl(double x) {
	double t = (double)(int64_t)x;
	return t > x ? t - 1 : t;
}

static int round_(double x) {
	return x >= 0.0 ? (int)(x + 0.5) : (int)(x - 0.5);
}

static int iabs(int x) {
	return x < 0 ? -x : x;
}

/** sin and cos of x, reduced to a quarter turn about 0 (Cody and Waite), then Taylor's series */
static void sincos_(double x, double *s, double *c) {
	const double pio2hi = 1.57079632673412561417e+00, pio2lo = 6.07710050650619224932e-11;
	double n = fl(x / (PI / 2) + 0.5);
	double r = (x - n * pio2hi) - n * pio2lo, r2 = r * r;
	double sr = r * (1 + r2 * (-1 / 6. + r2 * (1 / 120. + r2 * (-1 / 5040. + r2 * (1 / 362880. + r2 * (-1 / 39916800. + r2 * (1 / 6227020800. + r2 * (-1 / 1307674368000.))))))));
	double cr = 1 + r2 * (-1 / 2. + r2 * (1 / 24. + r2 * (-1 / 720. + r2 * (1 / 40320. + r2 * (-1 / 3628800. + r2 * (1 / 479001600. + r2 * (-1 / 87178291200.)))))));
	switch ((int)(n - 4 * fl(n / 4))) {
	case 0: *s = sr, *c = cr; break;
	case 1: *s = cr, *c = -sr; break;
	case 2: *s = -sr, *c = -cr; break;
	default: *s = -cr, *c = sr; break;
	}
}

static double sin_(double x) {
	double s, c;
	sincos_(x, &s, &c);
	return s;
}

static double cos_(double x) {
	double s, c;
	sincos_(x, &s, &c);
	return c;
}
