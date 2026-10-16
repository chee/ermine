// draw.h: the cat's window, 150 × 300, and drawing on it as X draws: a
// pixel is drawn when its centre is inside a shape, or on its left or top
// edge; a thin line is Bresenham's, both ends drawn.

#include <stdint.h>

#define CAT_W 150 // DEF_CAT_WIDTH
#define CAT_H 300 // DEF_CAT_HEIGHT
#define EPS (1.0 / 1024) // past a pixel's centre: on an edge, the pixel right and below of it is out

static uint32_t cat[CAT_H][CAT_W]; // the window, 0xRRGGBB

typedef struct {
	int x, y;
} Point;

/** a rectangle of the window drawn into, its own corner 0, 0, what falls outside it not drawn */
typedef struct {
	int x, y, w, h;
} View;

static const View WHOLE = { 0, 0, CAT_W, CAT_H };

static void plot(View v, int x, int y, uint32_t color) {
	if (x >= 0 && y >= 0 && x < v.w && y < v.h) cat[v.y + y][v.x + x] = color;
}

/** a bitmap's pixel, XBM's way: the leftmost in a byte's low bit */
static int bit(const uint8_t *row, int x) {
	return row[x >> 3] >> (x & 7) & 1;
}

/** a bitmap over v: set bits on, the rest off (XCopyPlane) */
static void stamp(View v, const uint8_t *bits, int stride, uint32_t on, uint32_t off) {
	for (int y = 0; y < v.h; y++)
		for (int x = 0; x < v.w; x++) plot(v, x, y, bit(bits + y * stride, x) ? on : off);
}

/** a thin line, both ends drawn (XDrawLine, width 0) */
static void line(View v, Point a, Point b, uint32_t color) {
	int dx = iabs(b.x - a.x), sx = a.x < b.x ? 1 : -1, dy = -iabs(b.y - a.y), sy = a.y < b.y ? 1 : -1, err = dx + dy;
	for (;;) {
		plot(v, a.x, a.y, color);
		if (a.x == b.x && a.y == b.y) break;
		int e2 = 2 * err;
		if (e2 >= dy) err += dy, a.x += sx;
		if (e2 <= dx) err += dx, a.y += sy;
	}
}

/** a filled polygon, even-odd (XFillPolygon); at most 32 points */
static void fillpoly(View v, const Point *p, int n, uint32_t color) {
	if (n < 3 || n > 32) return;
	int y0 = p[0].y, y1 = p[0].y;
	for (int i = 1; i < n; i++) {
		if (p[i].y < y0) y0 = p[i].y;
		if (p[i].y > y1) y1 = p[i].y;
	}
	for (int y = y0 - 1; y <= y1; y++) {
		double sy = y + 0.5 + EPS, xs[32];
		int k = 0;
		for (int i = 0; i < n; i++) {
			Point a = p[i], b = p[(i + 1) % n];
			if ((a.y < sy) != (b.y < sy)) xs[k++] = a.x + (sy - a.y) * (b.x - a.x) / (double)(b.y - a.y);
		}
		for (int i = 1; i < k; i++) // in order, left to right
			for (int j = i; j > 0 && xs[j - 1] > xs[j]; j--) {
				double t = xs[j];
				xs[j] = xs[j - 1], xs[j - 1] = t;
			}
		for (int i = 0; i + 1 < k; i += 2) {
			int from = -(int)fl(-(xs[i] - 0.5 - EPS)), to = (int)fl(xs[i + 1] - 0.5 - EPS);
			for (int x = from; x <= to; x++) plot(v, x, y, color);
		}
	}
}

/** a wide line through the points, round caps and joins (XDrawLines, CapRound, JoinRound) */
static void wide(View v, const Point *p, int n, int width, uint32_t color) {
	double r2 = (width / 2.0) * (width / 2.0);
	int pad = width / 2 + 1, x0 = p[0].x, x1 = p[0].x, y0 = p[0].y, y1 = p[0].y;
	for (int i = 1; i < n; i++) {
		if (p[i].x < x0) x0 = p[i].x;
		if (p[i].x > x1) x1 = p[i].x;
		if (p[i].y < y0) y0 = p[i].y;
		if (p[i].y > y1) y1 = p[i].y;
	}
	for (int y = y0 - pad; y <= y1 + pad; y++)
		for (int x = x0 - pad; x <= x1 + pad; x++) {
			double px = x + 0.5 + EPS, py = y + 0.5 + EPS;
			for (int i = 0; i + 1 < n; i++) {
				double ax = p[i].x, ay = p[i].y, dx = p[i + 1].x - ax, dy = p[i + 1].y - ay, len2 = dx * dx + dy * dy;
				double t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
				t = t < 0 ? 0 : t > 1 ? 1 : t;
				double ex = ax + t * dx - px, ey = ay + t * dy - py;
				if (ex * ex + ey * ey <= r2) {
					plot(v, x, y, color);
					break;
				}
			}
		}
}
