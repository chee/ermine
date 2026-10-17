// drv_vram.c
// drv_vram.c: /drivers/vram, video memory a program draws into directly: a
// plane of w × h pixels, 0x00RRGGBB as a layer's, that the compositor shows
// without the pixels going through the graph.
//
//   /dev/vram/planes/<name>   {w, h}: placed (ephemeral) by the program that wants one;
//                             the driver makes its plane and says it there, {w, h, id,
//                             stride, shm}, shm the POSIX shared memory's name (host.h's
//                             HostPlaneSaid); the plane goes when the node does
//   /dev/vram/driver/on/put   (id, x, y, w, h, pixels): pixels copied in, rows of w, for
//                             a program with no way to the memory (deno's runner)
//
// A call answers nothing (SCHEDULER.tex), so the plane is said in the node:
// a program reads it there once the driver has run.
//
// A program shows its plane in a layer of its own: {..., plane: {source:
// "vram", id, serial, dirty?: {x, y, w, h}}}. Each time it has drawn, it
// writes serial one more, and dirty, the rectangle it drew (none: all of
// it); the compositor (drv_display.c) copies that rectangle out of the plane
// in its next compose, on the OS's thread, and draws and flips only it.
//
// Who may write when: the program, any time, as into a frame buffer. A
// program in the OS (JavaScriptCore's) runs on the compositor's thread, so
// its pixels are never read half drawn; an exec program, a Mac process of
// its own, drawing while a compose copies may tear that frame, and its next
// serial copies the rectangle again. One wanting no tearing keeps two
// planes and points its layer at the one it finished.
//
// Who reads it finds it by its node: the compositor and the JavaScript
// runner read /dev/vram/planes for the plane with the layer's id and map
// what it says (host.h's hostPlaneSaid, hostPlaneMap); an exec program maps
// the shm name itself (libermine's ermPlane). The name is unlinked once the
// node goes, each mapping lasting until its holder lets go.

#include "drivers.h"
#include "drv.h"

#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#define MOST 8192 // the widest and tallest a plane may be

typedef struct Plane {
	int64_t id;
	char *name;    // its node's, in /dev/vram/planes
	char shm[32];
	uint32_t *bits;
	int w, h;
	size_t bytes;
} Plane;

static ERM_LIST(Plane *) planes; // on the OS's thread only
static int64_t ids;

static void drop(Plane *p) {
	munmap(p->bits, p->bytes);
	free(p->name);
	free(p);
}

static Plane *planeOf(int64_t id) {
	for (int i = 0; i < planes.count; i++) if (planes.items[i]->id == id) return planes.items[i];
	return NULL;
}

/** a plane for /dev/vram/planes/<name>, w × h; NULL when there is no shared memory */
static Plane *make(Host *host, const char *name, int w, int h) {
	Plane *p = calloc(1, sizeof *p);
	p->id = ++ids;
	p->w = w, p->h = h;
	p->bytes = (size_t)w * (size_t)h * 4;
	snprintf(p->shm, sizeof p->shm, "/ermvram.%d.%lld", (int)getpid(), (long long)p->id);
	shm_unlink(p->shm); // a crashed run's, of the same pid
	int fd = shm_open(p->shm, O_RDWR | O_CREAT | O_EXCL, 0600);
	void *bits = MAP_FAILED;
	if (fd >= 0 && !ftruncate(fd, (off_t)p->bytes)) bits = mmap(NULL, p->bytes, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	if (fd >= 0) close(fd);
	if (bits == MAP_FAILED) {
		hostSay(host, "vram: no shared memory for %s (%d × %d)", name, w, h);
		if (fd >= 0) shm_unlink(p->shm);
		free(p);
		return NULL;
	}
	p->bits = bits; // zeroed: black
	p->name = copyString(name);
	ERM_PUSH(planes, p);
	return p;
}

/** on/put (id, x, y, w, h, pixels): pixels copied into the plane, clipped to it */
static ErmErr onPut(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	*out = jsonNull();
	int64_t a[5] = { -1, 0, 0, 0, 0 };
	for (int i = 0; i < 5; i++)
		if (!g->args || g->args->array.count <= i || !jsonIsWhole(g->args->array.items[i], &a[i])) return ermDetail(ermInvalid("no-plane"), "text", jsonString("put takes id, x, y, w, h, pixels"));
	Json *px = g->args->array.count > 5 ? g->args->array.items[5] : NULL;
	Plane *p = planeOf(a[0]);
	if (!p) return ermDetail(ermInvalid("no-plane"), "text", jsonString("no such plane"));
	if (!px || px->type != JSON_TYPED || (px->typed.kind != JSON_UINT32 && px->typed.kind != JSON_INT32) || a[3] < 0 || a[4] < 0 || px->typed.count < (size_t)(a[3] * a[4]))
		return ermDetail(ermInvalid("no-plane"), "text", jsonString("put's pixels are a Uint32Array of w × h"));
	const uint32_t *src = px->typed.data;
	for (int64_t y = 0; y < a[4]; y++) {
		int64_t py = a[2] + y;
		if (py < 0 || py >= p->h) continue;
		int64_t x0 = a[1] < 0 ? -a[1] : 0, x1 = a[1] + a[3] > p->w ? p->w - a[1] : a[3];
		if (x1 > x0) memcpy(p->bits + py * p->w + a[1] + x0, src + y * a[3] + x0, (size_t)(x1 - x0) * 4);
	}
	return ermOk();
}

/** the planes asked for: each node's name and size, read tracked */
static ErmErr planesCompute(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	Json *names = drvNames(g->api, drvPath("/", "dev", "vram", "planes", NULL));
	*out = jsonArray();
	for (int i = 0; names && i < names->array.count; i++) {
		const char *name = jsonText(names->array.items[i]);
		Json *v = drvRead(g->api, drvPath("/", "dev", "vram", "planes", name, NULL));
		jsonPush(*out, jsonRef(drvMap("name", jsonString(name), "w", jsonGet(v, "w") ? jsonShallow(jsonGet(v, "w")) : jsonNull(),
		                              "h", jsonGet(v, "h") ? jsonShallow(jsonGet(v, "h")) : jsonNull(), NULL)));
	}
	return ermOk();
}

/**
 * a node new: its plane made, and said in it, {w, h, id, stride, shm}; a
 * node gone: its plane's name unlinked, its memory let go once no one holds
 * it
 */
static ErmErr planesEffect(void *data, const ErmGiven *g, Json **out) {
	Host *host = data;
	*out = jsonNull();
	const Json *list = g->value;
	int k = 0;
	for (int i = 0; i < planes.count; i++) {
		Plane *p = planes.items[i];
		bool here = false;
		for (int n = 0; jsonIsArray(list) && n < list->array.count && !here; n++) here = !strcmp(jsonText(jsonGet(list->array.items[n], "name")), p->name);
		if (here) {
			planes.items[k++] = p;
			continue;
		}
		shm_unlink(p->shm);
		drop(p);
	}
	planes.count = k;
	for (int n = 0; jsonIsArray(list) && n < list->array.count; n++) {
		const char *name = jsonText(jsonGet(list->array.items[n], "name"));
		bool had = false;
		for (int i = 0; i < planes.count && !had; i++) had = !strcmp(planes.items[i]->name, name);
		int64_t w = 0, h = 0;
		jsonIsWhole(jsonGet(list->array.items[n], "w"), &w);
		jsonIsWhole(jsonGet(list->array.items[n], "h"), &h);
		if (had || w < 1 || h < 1 || w > MOST || h > MOST) continue;
		Plane *p = make(host, name, (int)w, (int)h);
		if (!p) continue;
		Json *patches = jsonArray();
		const char *keys[] = { "id", "stride", "shm" };
		Json *values[] = { jsonInteger(p->id), jsonInteger(p->w), jsonString(p->shm) };
		for (int i = 0; i < 3; i++) jsonPush(patches, jsonRef(drvMap("type", jsonString("set"), "path", jsonArray(), "key", jsonString(keys[i]), "value", values[i], NULL)));
		drvOp(g->api, "write", drvMap("address", drvPath("/", "dev", "vram", "planes", name, NULL), "patches", patches, NULL));
	}
	return ermOk();
}

ErmErr driverVram(void *data, const ErmGiven *g, Json **out) {
	Host *host = data;
	*out = jsonNull();
	drvMake(g->api, drvPath("/", "dev", "vram", NULL), "planes", "vram/planes", jsonNull());
	Json *here = drvHere(g);
	drvHandler(g, here, "put", (ErmFn){ onPut, host });
	drvChild(g, here, "planes", (ErmFn){ planesCompute, NULL }, (ErmFn){ planesEffect, host });
	return ermOk();
}

void vramStop(void) {
	for (int i = 0; i < planes.count; i++) {
		shm_unlink(planes.items[i]->shm);
		drop(planes.items[i]);
	}
	planes.count = 0;
}
