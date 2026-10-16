// walk-test: hash, the draws and walking for the cases on stdin, one a line, "id x y at seed now open",
// the answers one a line as JSON (walk_check.ts asks program.ts's own functions the same)
#include "walk.h"

#include <stdio.h>
#include <string.h>

int main(void) {
	char id[128];
	double x, y, at, now, seed;
	int open;
	while (scanf("%127s %lf %lf %lf %lf %lf %d", id, &x, &y, &at, &seed, &now, &open) == 7) {
		pig_path p = pig_path_of(x, y, (uint32_t)seed);
		pig_walked m = pig_walk(&p, at, now, open);
		pig_random r = pig_random_of(pig_hash(id));
		double size = 0.86 + 0.24 * pig_draw(&r);
		printf("{\"hash\":%u,\"size\":%.17g,\"x\":%.17g,\"y\":%.17g,\"vx\":%.17g,\"phase\":%.17g,\"stride\":%.17g}\n",
			pig_hash(id), size, m.x, m.y, m.vx, m.phase, m.stride);
	}
	return 0;
}
