// primes: the primes below a number, counted by a sieve, run native: its node's
// ermine.programs.loader is /loaders/clang-native, so it is compiled for this
// machine and run with dlopen, not as wasm (CLOADER.md, Native). The same
// source runs as wasm without the pin, slower. What it found is in ./found,
// a node beside the program; each call of on/more counts below ten times as
// many, up to ten million.
#include <ermine.h>

#define MOST 10000000

static unsigned char composite[MOST];
static long long below = 1000000;

static long long count(long long n) {
	long long found = 0;
	for (long long i = 2; i < n; i++) composite[i] = 0;
	for (long long i = 2; i < n; i++) {
		if (composite[i]) continue;
		found++;
		for (long long k = i * i; k < n; k += i) composite[k] = 1;
	}
	return found;
}

static void show(void) {
	long long found = count(below);
	er_write(ER_AT("found"), er_put(er_put(er_map(), "below", er_int(below)), "count", er_int(found)));
	er_say("%lld primes below %lld", found, below);
}

static void more(er_args a) {
	(void)a;
	if (below < MOST) below *= 10;
	show();
}

er_value setup(void) {
	show();
	er_handler("more", more); // <process>/on/more
	return er_none();
}
