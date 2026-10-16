// Walking, as lab-pig's program.ts says it at its top ("walking, exactly"): where a resting pig is at
// a time, from where and when it was set down and its seed; the same on every device, up to clocks
#ifndef PIGS_WALK_H
#define PIGS_WALK_H

#include <stdbool.h>
#include <stdint.h>

// FNV-1a, 32 bits, over the id's characters (an id is ASCII: a character is a byte)
uint32_t pig_hash(const char *s);

// mulberry32
typedef struct {
	uint32_t a;
} pig_random;
static inline pig_random pig_random_of(uint32_t seed) { return (pig_random){seed}; }
double pig_draw(pig_random *r);

typedef struct {
	double a, w, p;
} pig_wave;

typedef struct {
	double x0, y0, V, dx, dy;
	pig_wave wx[2], wy[2];
	double wp, pp;
} pig_path;

pig_path pig_path_of(double x, double y, uint32_t seed);

typedef struct {
	double x, y;
	// fractions of the field a second, as walked; a step a pig-second; how hard it steps (0 to 1)
	double vx, phase, stride;
} pig_walked;

// the corner of shame, in field units (a pig's feet): x from 0.78 to 1, y from 0 to 0.45
#define PIG_SHAME_X 0.78
#define PIG_SHAME_Y 0.45

// at the time now (ms since 1970), set down at at (ms); open: the corner of shame is open (some pig
// in the room was last stored ashamed), and a walked point inside it is folded back out
pig_walked pig_walk(const pig_path *p, double at, double now, bool open);

#endif
