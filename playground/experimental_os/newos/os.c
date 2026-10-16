// os.c: the OS's thread (os.h): the metal posts records from any thread into
// a queue; the thread hands the host every record queued since its last turn,
// then sleeps until another comes or the host's wait is up.

#include "os.h"
#include "host.h"

#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t wake = PTHREAD_COND_INITIALIZER;
/** records posted and not yet taken, oldest first: copies, ours to free */
static char **queue;
static int queued, room;
/** ermosStop was called, or the OS ended by itself: records are dropped */
static bool stopping, ended;

/** held across a start or a stop, so a second stop waits for the first */
static pthread_mutex_t starting = PTHREAD_MUTEX_INITIALIZER;
static pthread_t thread;
static bool started;
/** true on the OS's thread */
static _Thread_local bool inside;
/** the config as given, its strings and its planes copied */
static ErmosConfig config;

static char *copy(const char *text) {
	return text ? strdup(text) : NULL;
}

static void forget(void) {
	free((char *)config.dt);
	free((char *)config.sd);
	free((char *)config.image);
	free((char *)config.runner);
	free(config.planes);
	memset(&config, 0, sizeof config);
}

static int64_t clockUs(void) {
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return (int64_t)t.tv_sec * 1000000 + t.tv_nsec / 1000;
}

/** waits, holding the lock, until a record comes, a stop, or `us` pass (-1: no end) */
static void sleepFor(int64_t us) {
	int64_t until = us < 0 ? 0 : clockUs() + us;
	while (queued == 0 && !stopping) {
		if (us < 0) {
			pthread_cond_wait(&wake, &lock);
			continue;
		}
		int64_t left = until - clockUs();
		if (left <= 0) return;
#ifdef __APPLE__
		struct timespec t = {left / 1000000, (left % 1000000) * 1000};
		pthread_cond_timedwait_relative_np(&wake, &lock, &t);
#else
		struct timespec t;
		clock_gettime(CLOCK_REALTIME, &t);
		int64_t ns = t.tv_nsec + (left % 1000000) * 1000;
		t.tv_sec += left / 1000000 + ns / 1000000000;
		t.tv_nsec = ns % 1000000000;
		pthread_cond_timedwait(&wake, &lock, &t);
#endif
	}
}

static void *run(void *unused) {
	(void)unused;
	inside = true;
	Host *host = hostBoot(&config);
	bool asked = false;
	while (host) {
		pthread_mutex_lock(&lock);
		char **records = queue;
		int count = queued;
		queue = NULL;
		queued = room = 0;
		asked = stopping;
		pthread_mutex_unlock(&lock);

		// the records posted before a stop still get their turn
		hostTurn(host, (const char *const *)records, count);
		for (int i = 0; i < count; i++) free(records[i]);
		free(records);
		if (asked || !hostRunning(host)) break;

		int64_t wait = hostWait(host);
		pthread_mutex_lock(&lock);
		if (wait != 0) sleepFor(wait);
		pthread_mutex_unlock(&lock);
	}
	if (host) hostOff(host);

	pthread_mutex_lock(&lock);
	ended = true;
	for (int i = 0; i < queued; i++) free(queue[i]);
	free(queue);
	queue = NULL;
	queued = room = 0;
	pthread_mutex_unlock(&lock);
	// The OS powered off by itself, or could not boot: the metal exits once
	// the OS does, as when a child OS exits.
	if (!asked && config.command) config.command(config.data, "{\"op\":\"quit\"}");
	return NULL;
}

void ermosStart(const ErmosConfig *given) {
	pthread_mutex_lock(&starting);
	if (started) {
		pthread_mutex_unlock(&starting);
		return;
	}
	forget();
	config = *given;
	config.dt = copy(given->dt);
	config.sd = copy(given->sd);
	config.image = copy(given->image);
	config.runner = copy(given->runner);
	config.planes = NULL;
	if (given->nplanes > 0 && given->planes) {
		config.planes = malloc(sizeof(uint32_t *) * (size_t)given->nplanes);
		memcpy(config.planes, given->planes, sizeof(uint32_t *) * (size_t)given->nplanes);
	} else {
		config.nplanes = 0;
	}

	pthread_mutex_lock(&lock);
	stopping = ended = false;
	pthread_mutex_unlock(&lock);
	// a stack as a main thread's and more: the sync layer takes in recursively, a level for each
	// document it comes to follow (layers/subduction/c/sync.c, takeIn and followHeld), so a mount of
	// a large tree goes deep; a thread's own 512 KB ran out at about 700
	pthread_attr_t attr;
	pthread_attr_init(&attr);
	pthread_attr_setstacksize(&attr, (size_t)256 << 20);
	started = pthread_create(&thread, &attr, run, NULL) == 0;
	pthread_attr_destroy(&attr);
	pthread_mutex_unlock(&starting);
}

void ermosPost(const char *json) {
	if (!json) return;
	pthread_mutex_lock(&lock);
	if (!stopping && !ended) {
		if (queued == room) {
			room = room ? room * 2 : 64;
			queue = realloc(queue, sizeof(char *) * (size_t)room);
		}
		queue[queued++] = strdup(json);
		pthread_cond_signal(&wake);
	}
	pthread_mutex_unlock(&lock);
}

void ermosStop(void) {
	pthread_mutex_lock(&lock);
	stopping = true;
	pthread_cond_signal(&wake);
	pthread_mutex_unlock(&lock);
	// From the OS's own thread (a command it sent), the loop ends after this turn.
	if (inside) return;

	pthread_mutex_lock(&starting);
	if (started) {
		pthread_join(thread, NULL);
		started = false;
	}
	pthread_mutex_unlock(&starting);
}
