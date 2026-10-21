// the heap a step of the loop takes at its worst: free before it, less the least free while it ran
// (ESP-IDF's local minimum), the most seen for each step since boot. one step at a time (no nesting).
// other tasks' (WiFi, the HTTP poster's) allocations in that time count too
#ifndef CARD_PEAK_H
#define CARD_PEAK_H

#include <stdio.h>

#include "esp_heap_caps.h"

typedef struct {
	const char *name;
	size_t most, last, times;
} peak_step;

#define PEAK(step, ...) \
	do { \
		size_t peak_before = heap_caps_get_free_size(MALLOC_CAP_8BIT); \
		heap_caps_monitor_local_minimum_free_size_start(); \
		__VA_ARGS__; \
		size_t peak_least = heap_caps_get_minimum_free_size(MALLOC_CAP_8BIT); \
		heap_caps_monitor_local_minimum_free_size_stop(); \
		size_t peak_took = peak_before > peak_least ? peak_before - peak_least : 0; \
		(step)->last = peak_took, (step)->times++; \
		if (peak_took > (step)->most) (step)->most = peak_took; \
	} while (0)

static inline void peak_print(peak_step *steps, int n) {
	printf("peak:");
	for (int i = 0; i < n; i++) printf(" %s %u (x%u)", steps[i].name, (unsigned)steps[i].most, (unsigned)steps[i].times);
	printf("\n");
}

#endif
