// frame.c: one frame of the cat, natively, to a .ppm, to look at.
//
//   build/frame out.ppm [ms [tz [w h]]]
//
// ms: milliseconds since 1970 UTC (now, if not given); tz: minutes east of
// UTC (this Mac's, if not given); w × h: the buffer (150 × 300).

#define _DEFAULT_SOURCE
#define _DARWIN_C_SOURCE

#include "catclock.h"

#include <stdio.h>
#include <stdlib.h>
#include <sys/time.h>
#include <time.h>

int main(int argc, char *argv[]) {
	if (argc < 2) {
		fprintf(stderr, "usage: %s out.ppm [ms [tz [w h]]]\n", argv[0]);
		return 1;
	}
	struct timeval tv;
	gettimeofday(&tv, NULL);
	double ms = argc > 2 ? atof(argv[2]) : tv.tv_sec * 1000.0 + tv.tv_usec / 1000;
	time_t secs = (time_t)(ms / 1000);
	struct tm tm;
	localtime_r(&secs, &tm);
	int tz = argc > 3 ? atoi(argv[3]) : (int)(tm.tm_gmtoff / 60);
	int w = argc > 5 ? atoi(argv[4]) : 150, h = argc > 5 ? atoi(argv[5]) : 300;
	uint32_t *px = cc_init(w, h, CC_XRGB);
	if (!px) {
		fprintf(stderr, "%d × %d: too many pixels\n", w, h);
		return 1;
	}
	cc_frame(ms, tz);
	FILE *f = fopen(argv[1], "wb");
	if (!f) {
		perror(argv[1]);
		return 1;
	}
	fprintf(f, "P6\n%d %d\n255\n", w, h);
	for (int i = 0; i < w * h; i++) {
		unsigned char rgb[3] = { px[i] >> 16 & 255, px[i] >> 8 & 255, px[i] & 255 };
		fwrite(rgb, 1, 3, f);
	}
	fclose(f);
	return 0;
}
