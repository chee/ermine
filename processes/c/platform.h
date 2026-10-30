// What ermine's C asks of a platform: random bytes and the clock. Define PF_RANDOM / PF_NOW_MS to override.
#ifndef PLATFORM_H
#define PLATFORM_H

#include <stddef.h>
#include <stdint.h>

#ifndef PF_RANDOM
#ifdef ESP_PLATFORM
#include "esp_random.h"
#define PF_RANDOM(bytes, n) esp_fill_random((bytes), (n))
#else
#include <stdlib.h>
#define PF_RANDOM(bytes, n) arc4random_buf((bytes), (n))
#endif
#endif

#ifndef PF_NOW_MS
#include <time.h>
static inline double pf_now_ms(void) {
	struct timespec t;
	clock_gettime(CLOCK_REALTIME, &t);
	return (double)t.tv_sec * 1e3 + (double)t.tv_nsec / 1e6;
}
#define PF_NOW_MS() pf_now_ms()
#endif

#endif
