// ermine on the Cardputer ADV: the host, its keyboard and display drivers, the shell, and a den
// (den.h): keys, screen and pigs as things other dens can wire into. two modes, esc between them:
// the den's (the screen thing's framebuffer, keys to /work/keys) and the shell's (text rows)
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
#include "net.h"
#include "screen.h"
#include "shell.h"
#include "room.h"
#include "net.h"
#include "lschannel.h"
#include "peak.h"
extern peak_step *lschannel_steps;
#include "sdkconfig.h"
#include "den.h"
#include "fb.h"
#include "things.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "nvs_flash.h"
#include "nvs.h"

#define LEMON RGB(0xff, 0xf6, 0x8f)
#define INK RGB(0x10, 0x10, 0x10)
#define CHERRY RGB(0xd2, 0x04, 0x2d)
#define WHITE RGB(0xff, 0xff, 0xff)

// littlesync and its USB link, for print
static ls_dev *ls_now;
static struct ls_link *line;

// the last screen drawn, printed on the serial line after a line typed there
static op_value *last;
// 1: the den's framebuffer shows, keys go to /work/keys; 0: the shell's text rows
static int dens_mode = 1;

// the picture the den's screen shows, drawn again on the way back from the shell
static void (*shown)(void);

void frame_show(void (*paint)(void)) {
	shown = paint;
	if (dens_mode) screen_frame(paint);
}

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
		if (net_status()) {
			const ls_traffic *nt = ls_traffic_of(net_link());
			printf("%s, in %u out %u\n", net_status(), (unsigned)nt->frames_in, (unsigned)nt->frames_out);
		}
	}
	den_print();
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

static void draw_text(const op_value *screen);
void show(const op_value *screen) {
	if (last) op_free(last);
	last = op_ref((op_value *)screen);
	if (!dens_mode) draw_text(screen);
}

static void draw_text(const op_value *screen) {
	if (screen == NULL) return;
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

static const int shell_on = CONFIG_CARDPUTER_WIFI_SSID[0] == 0;
// lab-pig's room on littlesync (room.c): followed without WiFi; with it, not for now, as its whole
// history comes in from galaxy and littlesync's save of it runs the heap out. 1: followed anyway
#define PIG_ROOM_OVER_WIFI 0
static const int pig_room_on = shell_on || PIG_ROOM_OVER_WIFI;

// a key from the keyboard: esc turns the mode (with the shell on); else to the shell, or to /work/keys
static void pressed(api *keyboard_api, const char *k) {
	if (strcmp(k, "esc") == 0) {
		if (!shell_on) return;
		dens_mode = !dens_mode;
		if (dens_mode) {
			if (shown) screen_frame(shown);
		} else draw_text(last);
		return;
	}
	if (!dens_mode) {
		keyboard_press(keyboard_api, k);
		return;
	}
	if (strcmp(k, "backspace") == 0) things_key("del");
	else if (strlen(k) == 1) things_key(k);
}

// the channel to the other dens: littlesync's messages, sealed by this device's key (lschannel.h).
// away sends its row on "dens:<room id>", asks on "dens:<room id>/ask/<to>", answers on
// "dens:<room id>/answer/<from>"; over USB to a Mac peer, or WiFi to the gateway and on to galaxy

// the den's id: this device's littlesync key (a multikey) as hex, as the page's den id is its
// device key's; no littlesync: a made-up one
static char den_id[2 * LS_KEY_LEN + 1];
static void id_of(ls_dev *ls) {
	const uint8_t *key = ls ? ls_key(ls) : NULL;
	if (key == NULL) {
		strcpy(den_id, "cardputer-no-key");
		return;
	}
	for (int i = 0; i < LS_KEY_LEN; i++) sprintf(den_id + 2 * i, "%02x", key[i]);
}

// the room's code: made once (four of DEN_LETTERS, at random), kept in NVS, the same after a restart
static void room_code_of(char out[5]) {
	nvs_handle_t h;
	size_t n = 5;
	if (nvs_open("dens", NVS_READWRITE, &h) != ESP_OK) {
		strcpy(out, "ACDE");
		return;
	}
	if (nvs_get_str(h, "room", out, &n) != ESP_OK || strlen(out) != 4) {
		for (int i = 0; i < 4; i++) out[i] = DEN_LETTERS[esp_random() % 16];
		out[4] = 0;
		nvs_set_str(h, "room", out);
		nvs_commit(h);
	}
	nvs_close(h);
}

void app_main(void) {
	// room for a littlesync frame or two between loops
	usb_serial_jtag_driver_config_t usb = {.rx_buffer_size = 8192, .tx_buffer_size = 4096};
	usb_serial_jtag_driver_install(&usb);
	usb_serial_jtag_vfs_use_driver();
	screen_init();
	keys_init();
	host_init();
	api *keyboard_api = host_start("keyboard", keyboard);
	// the shell and its display (a memo of the whole tree as text, made again at every change) only
	// without WiFi: with it, the den, WiFi and a TLS handshake need all the heap there is
	if (shell_on) {
		host_start("shell", shell);
		host_start("display", display);
	}
	// littlesync: its key and nodes in NVS, its frames on the USB line among the text
	if (nvs_flash_init() != ESP_OK) nvs_flash_erase(), nvs_flash_init();
	ls_dev *ls = ls_open(&(ls_options){.store = ls_store_nvs("littlesync"), .random = randoms, .heard = lschannel_heard});
	room_device(ls);
	ls_now = ls;
	// the USB line is one link; another line would be another
	line = ls ? ls_link(ls) : NULL;
	// and the gateway over WiFi, a second link, when menuconfig names a network and a gateway (net.h)
	int wifi = net_start(ls, randoms);
	api *room_api = pig_room_on ? host_start("room", room) : NULL;
	id_of(ls);
	size_t before = heap_caps_get_free_size(MALLOC_CAP_8BIT);
	char code[5];
	room_code_of(code);
	if (den_boot(den_id, code) == 0) {
		chn_channel *channel = lschannel(ls);
		if (channel == NULL || den_connect(channel) == NULL) printf("den: link refused\n");
	}
	printf("den: room %s\n", code);
	printf("den: %s up, %u bytes of heap\n", den_id, (unsigned)(before - heap_caps_get_free_size(MALLOC_CAP_8BIT)));
	printf("ermine: up, %u bytes free%s%s\n", (unsigned)heap_caps_get_free_size(MALLOC_CAP_8BIT),
		ls ? ", littlesync on" : ", no littlesync", wifi ? ", and over WiFi" : "");
	// keys: a key and what it set off; beat: the den's row set again and the sweep; send: a row sealed
	// and framed; in: an HTTP answer fed in (seals checked, rows heard, mirrored); settle: what that set off
	static peak_step steps[5] = {{"keys", 0, 0, 0}, {"beat", 0, 0, 0}, {"send", 0, 0, 0}, {"heard", 0, 0, 0}, {"settle", 0, 0, 0}};
	lschannel_steps = &steps[3];
	for (;;) {
		const char *k;
		while ((k = keys_next())) PEAK(&steps[0], pressed(keyboard_api, k); host_settle());
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
			// typed on the serial line: the shell's, and the den's keys' too
			keyboard_press(keyboard_api, k);
			PEAK(&steps[0], if (strlen(k) == 1) things_key(k); else if (strcmp(k, "backspace") == 0) things_key("del");
				host_settle());
			if (typed[i] == '\r' || typed[i] == '\n') print();
		}
		}
		if (ls) {
			ls_tick(ls, esp_timer_get_time() / 1000);
			const uint8_t *out;
			size_t m = ls_next(line, &out);
			// only while a peer is heard: the line also carries the log, and nobody needs hellos
			if (m && ls_up(line)) usb_serial_jtag_write_bytes(out, m, portMAX_DELAY);
			net_turn(esp_timer_get_time() / 1000);
			if (room_api) room_mirror(room_api);
			PEAK(&steps[4], host_settle());
		}
		PEAK(&steps[1], den_tick(esp_timer_get_time() / 1000));
		PEAK(&steps[2], lschannel_tick(esp_timer_get_time() / 1000));
		// the heap on the log every 10 s: what's free, the least yet, the biggest block (a frame needs one)
		static int64_t heap_said;
		int64_t now_ms = esp_timer_get_time() / 1000;
		if (now_ms - heap_said >= 10000) {
			heap_said = now_ms;
			printf("heap: %u free, %u least, %u biggest\n", (unsigned)heap_caps_get_free_size(MALLOC_CAP_8BIT),
				(unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_8BIT),
				(unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
			peak_print(steps, 5);
		}
		vTaskDelay(pdMS_TO_TICKS(10));
	}
}
