// ermine on the Cardputer ADV: the host, its keyboard and display drivers, the shell
#include <stdio.h>
#include <string.h>

#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#include "drivers.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "host.h"
#include "keys.h"
#include "screen.h"
#include "shell.h"
#include "room.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "nvs_flash.h"

#define LEMON RGB(0xff, 0xf6, 0x8f)
#define INK RGB(0x10, 0x10, 0x10)
#define CHERRY RGB(0xd2, 0x04, 0x2d)
#define WHITE RGB(0xff, 0xff, 0xff)

// littlesync and its USB link, for print
static ls_dev *ls_now;
static struct ls_link *line;

// the last screen drawn, printed on the serial line after a line typed there
static op_value *last;

static void print(void) {
	const op_value *lines = last ? op_get(last, "lines") : NULL;
	printf("---\n");
	for (size_t i = 0; lines && i < lines->count; i++) printf("%s\n", lines->items[i]->str);
	if (ls_now) {
		const ls_stats *st = ls_stats_of(ls_now);
		const ls_traffic *tr = ls_traffic_of(line);
		printf("littlesync: in %u out %u junk %u refused %u bad seals %u commits %u applied %u (%s)\n",
			(unsigned)tr->frames_in, (unsigned)tr->frames_out, (unsigned)tr->junk, (unsigned)st->refused,
			(unsigned)st->bad_seals, (unsigned)st->commits_in, (unsigned)st->applied, ls_reason(ls_now));
	}
	printf("--- %u bytes free, %u least, stack %u left\n", (unsigned)heap_caps_get_free_size(MALLOC_CAP_8BIT),
		(unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_8BIT), (unsigned)uxTaskGetStackHighWaterMark(NULL));
	fflush(stdout);
}

// a byte typed on the serial line, as a key
static const char *serial_key(char c) {
	static char one[2];
	if (c == '\r' || c == '\n') return "enter";
	if (c == 0x7f || c == 0x08) return "backspace";
	if (c == 0x1b) return "esc";
	if (c < ' ' || c > '~') return NULL;
	one[0] = c;
	return one;
}

void show(const op_value *screen) {
	if (last) op_free(last);
	last = op_ref((op_value *)screen);
	const op_value *lines = op_get(screen, "lines"), *prompt = op_get(screen, "prompt");
	screen_edges(LEMON);
	// the free heap; and the pig that changed last: its id's first 4 hex, stored bytes, commits, parents
	char top[64], pig[24] = "";
	const ls_node *last_pig = room_last();
	if (last_pig) {
		ls_cost c = ls_cost_of(last_pig);
		snprintf(pig, sizeof pig, "%.4s %uB %uc %up", ls_id(last_pig) + 9, (unsigned)c.stored, (unsigned)c.commits,
			(unsigned)c.newest.parents);
	}
	snprintf(top, sizeof top, "ermine %-17.17s%4uK", pig, (unsigned)(heap_caps_get_free_size(MALLOC_CAP_8BIT) / 1024));
	screen_line(0, top, WHITE, CHERRY);
	size_t n = lines ? lines->count : 0;
	for (int row = 1; row < SCREEN_ROWS - 1; row++)
		screen_line(row, (size_t)row - 1 < n ? lines->items[row - 1]->str : "", INK, LEMON);
	char line[SCREEN_COLUMNS + 1];
	const char *p = prompt && prompt->type == OP_STR ? prompt->str : "";
	size_t len = strlen(p);
	// the end of a long line shown
	snprintf(line, sizeof line, "> %s_", len > SCREEN_COLUMNS - 3 ? p + len - (SCREEN_COLUMNS - 3) : p);
	screen_line(SCREEN_ROWS - 1, line, LEMON, INK);
}

static void randoms(void *ctx, uint8_t *out, size_t n) {
	(void)ctx;
	esp_fill_random(out, n);
}

// whether the USB line is inside a littlesync frame
static int framed;

void app_main(void) {
	// room for a littlesync frame or two between loops
	usb_serial_jtag_driver_config_t usb = {.rx_buffer_size = 8192, .tx_buffer_size = 4096};
	usb_serial_jtag_driver_install(&usb);
	usb_serial_jtag_vfs_use_driver();
	screen_init();
	keys_init();
	host_init();
	api *keyboard_api = host_start("keyboard", keyboard);
	host_start("shell", shell);
	host_start("display", display);
	// littlesync: its key and nodes in NVS, its frames on the USB line among the text
	if (nvs_flash_init() != ESP_OK) nvs_flash_erase(), nvs_flash_init();
	ls_dev *ls = ls_open(&(ls_options){.store = ls_store_nvs("littlesync"), .random = randoms});
	room_device(ls);
	ls_now = ls;
	// the USB line is one link; another line would be another
	line = ls ? ls_link(ls) : NULL;
	api *room_api = host_start("room", room);
	printf("ermine: up, %u bytes free%s\n", (unsigned)heap_caps_get_free_size(MALLOC_CAP_8BIT),
		ls ? ", littlesync on" : ", no littlesync");
	for (;;) {
		const char *k;
		while ((k = keys_next())) {
			keyboard_press(keyboard_api, k);
			host_settle();
		}
		char typed[512];
		int n;
		while ((n = usb_serial_jtag_read_bytes(typed, sizeof typed, 0)) > 0) {
		if (line) ls_feed(line, (const uint8_t *)typed, n);
		for (int i = 0; i < n; i++) {
			// a frame is littlesync's (0x00 to 0x00); the text between is typing
			if (typed[i] == 0) framed = !framed;
			if (framed || typed[i] == 0) continue;
			// \r\n is one enter
			if (typed[i] == '\n' && i && typed[i - 1] == '\r') continue;
			if ((k = serial_key(typed[i])) == NULL) continue;
			keyboard_press(keyboard_api, k);
			host_settle();
			if (typed[i] == '\r' || typed[i] == '\n') print();
		}
		}
		if (ls) {
			ls_tick(ls, esp_timer_get_time() / 1000);
			const uint8_t *out;
			size_t m = ls_next(line, &out);
			// only while a peer is heard: the line also carries the log, and nobody needs hellos
			if (m && ls_up(line)) usb_serial_jtag_write_bytes(out, m, portMAX_DELAY);
			room_mirror(room_api);
			host_settle();
		}
		vTaskDelay(pdMS_TO_TICKS(10));
	}
}
