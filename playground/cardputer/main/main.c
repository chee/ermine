// ermine on the Cardputer ADV: the host, its keyboard and display drivers, and a den (den.h) on
// tippet: keys, screen and pigs as things other dens can wire into, in the room whose code the
// screen shows, its log on flash (flash.h), linked to the server over WiFi by long-poll (poll.h,
// wifi.h). tab trusts the den the last ask came from. without WiFi, the shell too, esc between the
// den's screen and the shell's text rows
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "den.h"
#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#include "drivers.h"
#include "esp_heap_caps.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "fb.h"
#include "flash.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "host.h"
#include "keys.h"
#include "menu.h"
#include "driver/gpio.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "poll.h"
#include "screen.h"
#include "sdkconfig.h"
#include "shell.h"
#include "things.h"
#include "wifi.h"
#include "ws.h"

// the carrier to the server, menuconfig's: a websocket (ws.h) or http long-poll (poll.h)
#ifdef CONFIG_CARDPUTER_CARRIER_WEBSOCKET
#define WEBSOCKET 1
#define carry_start ws_start
#define carry_turn ws_turn
#define carry_state ws_state
#define carry_joined ws_joined
#else
#define WEBSOCKET 0
#define carry_start poll_start
#define carry_turn poll_turn
#define carry_state poll_state
#define carry_joined poll_joined
#endif

#define LEMON RGB(0xff, 0xf6, 0x8f)
#define INK RGB(0x10, 0x10, 0x10)
#define CHERRY RGB(0xd2, 0x04, 0x2d)
#define WHITE RGB(0xff, 0xff, 0xff)

// the last screen the shell drew, printed on the serial line after a line typed there
static op_value *last;
// 1: the den's framebuffer shows, keys go to /home/keys; 0: the shell's text rows
static int dens_mode = 1;
static int wifi;

// the picture the den's screen shows, drawn again on the way back from the shell
static void (*shown)(void);

// the menu (G0) over whatever the den shows, while it is open
void frame_show(void (*paint)(void)) {
	shown = paint;
	if (dens_mode) screen_frame(menu_open() ? menu_paint : paint);
}

void frame_again(void) {
	if (dens_mode && (shown || menu_open())) screen_frame(menu_open() ? menu_paint : shown);
}

void den_random(uint8_t *out, size_t n) { esp_fill_random(out, n); }

static size_t free_now(void) { return heap_caps_get_free_size(MALLOC_CAP_8BIT); }
static size_t least(void) { return heap_caps_get_minimum_free_size(MALLOC_CAP_8BIT); }

size_t den_free(void) { return free_now(); }
int64_t den_clock(void) { return esp_timer_get_time() / 1000; }

void den_mark(const char *what) {
	printf("heap: %s: %u free, tippet %u\n", what, (unsigned)free_now(), (unsigned)den_heap(NULL));
}

static void print(void) {
	const op_value *lines = last ? op_get(last, "lines") : NULL;
	printf("---\n");
	for (size_t i = 0; lines && i < lines->count; i++) printf("%s\n", lines->items[i]->str);
	den_print();
	if (wifi) {
		unsigned requests, failed, in, out;
#if WEBSOCKET
		ws_counts(&requests, &in, &out);
		failed = 0;
#else
		poll_counts(&requests, &failed, &in, &out);
#endif
		printf("%s; %s: %s %u failed %u, messages in %u out %u\n", wifi_status(), carry_state(),
			WEBSOCKET ? "links" : "requests", requests, failed, in, out);
	}
	printf("--- %u bytes free, %u least, stack %u left\n", (unsigned)free_now(), (unsigned)least(),
		(unsigned)uxTaskGetStackHighWaterMark(NULL));
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
	char top[64];
	snprintf(top, sizeof top, "ermine %-21.21s%4uK", den_room(), (unsigned)(free_now() / 1024));
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

static int shell_on;

// a den that isn't up: why, in words, on the screen
static char not_up[128];
static void paint_not_up(void) {
	fb_clear(FB_LEMON);
	fb_rect(0, 0, FB_W, 12, FB_CHERRY);
	fb_text(4, 2, "chee's cardputer", FB_WHITE, 1);
	fb_text(4, 20, "the den isn't up:", FB_INK, 1);
	// the words, 29 a row
	char row[30];
	const char *w = not_up;
	for (int y = 34; *w && y + 8 <= FB_H - 24; y += 10) {
		size_t n = strlen(w) < 29 ? strlen(w) : 29;
		memcpy(row, w, n);
		row[n] = 0;
		fb_text(4, y, row, FB_CHERRY, 1);
		w += n;
	}
	fb_text(4, FB_H - 20, "its log is kept as it is:", FB_GREY, 1);
	fb_text(4, FB_H - 10, "nothing joins the room", FB_GREY, 1);
}

// a key from the keyboard: tab says yes to a pair ask waiting, esc no; esc else turns the mode
// (with the shell on); else to the shell, or to /home/keys
static void pressed(api *keyboard_api, const char *k) {
	// the menu, open, takes the keys (not tab: a pair ask's yes)
	if (dens_mode && menu_key(k)) return;
	if (strcmp(k, "tab") == 0) {
		den_trust_last();
		return;
	}
	if (strcmp(k, "esc") == 0) {
		// a pair ask waiting: no to it
		if (den_pair_waiting()) {
			den_pair_answer(0);
			return;
		}
		if (!shell_on) return;
		dens_mode = !dens_mode;
		if (dens_mode) frame_again();
		else draw_text(last);
		return;
	}
	if (!dens_mode) {
		keyboard_press(keyboard_api, k);
		return;
	}
	if (strcmp(k, "backspace") == 0) things_key("del");
	else if (strlen(k) == 1) things_key(k);
}

// whether a code is a room's: 4 of DEN_LETTERS
static int is_code(const char *c) {
	if (strlen(c) != 4) return 0;
	for (int i = 0; i < 4; i++)
		if (strchr(DEN_LETTERS, c[i]) == NULL) return 0;
	return 1;
}

// the room's code, kept in NVS ("dens"/"room"): the one there, else menuconfig's
// (CONFIG_CARDPUTER_ROOM), else four of DEN_LETTERS at random; kept from then on. the menu's join
// and new room change it (room_go)
static void room_code_of(char out[5]) {
	nvs_handle_t h;
	size_t n = 5;
	if (nvs_open("dens", NVS_READWRITE, &h) != ESP_OK) {
		strcpy(out, "ACDE");
		return;
	}
	if (nvs_get_str(h, "room", out, &n) != ESP_OK || !is_code(out)) {
		if (is_code(CONFIG_CARDPUTER_ROOM)) snprintf(out, 5, "%s", CONFIG_CARDPUTER_ROOM);
		else {
			for (int i = 0; i < 4; i++) out[i] = DEN_LETTERS[esp_random() % 16];
			out[4] = 0;
		}
		nvs_set_str(h, "room", out);
		nvs_commit(h);
	}
	nvs_close(h);
}

// to another room: kept in NVS, the den's bye said and its log synced, a moment for the bye to go,
// then a restart, which boots the den in it (its own folder, /f/t2<code>: a room it was in before
// goes on from its last step)
void room_go(const char *code) {
	nvs_handle_t h;
	int kept = 0;
	if (is_code(code) && nvs_open("dens", NVS_READWRITE, &h) == ESP_OK) {
		kept = nvs_set_str(h, "room", code) == ESP_OK && nvs_commit(h) == ESP_OK;
		nvs_close(h);
	}
	if (!kept) {
		den_say(1, "the room wasn't kept", "so this den stays here");
		return;
	}
	printf("den: to room %s: restarting\n", code);
	den_leave();
	for (int i = 0; i < 40; i++) {
		if (wifi) carry_turn(esp_timer_get_time() / 1000);
		vTaskDelay(pdMS_TO_TICKS(10));
	}
	fflush(stdout);
	esp_restart();
}

// the heap's least yet, said at a stage of the den's life
static void stage(const char *what) {
	printf("heap: %s: %u free, %u least yet, %u biggest; tippet %u\n", what, (unsigned)free_now(), (unsigned)least(),
		(unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT), (unsigned)den_heap(NULL));
}

void app_main(void) {
	usb_serial_jtag_driver_config_t usb = {.rx_buffer_size = 1024, .tx_buffer_size = 4096};
	usb_serial_jtag_driver_install(&usb);
	usb_serial_jtag_vfs_use_driver();
	shell_on = CONFIG_CARDPUTER_WIFI_SSID[0] == 0;
	screen_init();
	keys_init();
	// G0, the BOOT button: the menu (low when pressed)
	gpio_config_t g0 = {.pin_bit_mask = 1ULL << 0, .mode = GPIO_MODE_INPUT, .pull_up_en = GPIO_PULLUP_ENABLE};
	gpio_config(&g0);
	host_init();
	// the keyboard's process (/keyboard) is the shell's only: with WiFi, keys go to the den's keys thing
	api *keyboard_api = shell_on ? host_start("keyboard", keyboard) : NULL;
	// the shell and its display (a memo of the whole tree as text, made again at every change) only
	// without WiFi: with it, the den, WiFi and a TLS handshake need all the heap there is
	if (shell_on) {
		host_start("shell", shell);
		host_start("display", display);
	}
	if (nvs_flash_init() != ESP_OK) nvs_flash_erase(), nvs_flash_init();
	inst_install me;
	int code = flash_install(&me);
	if (code != INST_OK) printf("install: %s\n", inst_error(code));
	int mounted = flash_mount();
	if (mounted) flash_sweep();
	char room[5], dir[16];
	room_code_of(room);
	// t2: tippet's packed-run store (its files from before are another format: never read)
	snprintf(dir, sizeof dir, "%s/t2%s", FLASH_DIR, room);
#ifdef CONFIG_CARDPUTER_FORGETS
	den_forgets(1);
#endif
	stage("before the den");
	size_t before = free_now();
	int up = code == INST_OK && den_boot(&me, room, mounted ? dir : "/nowhere", esp_timer_get_time() / 1000) == 0;
	if (!up) {
		// said on the screen, in words; nothing joins the room (no den, no sync)
		snprintf(not_up, sizeof not_up, "%s", code != INST_OK ? inst_error(code)
			: !mounted ? "the flash isn't mounted" : den_why()[0] ? den_why() : "it didn't start");
		printf("den: not up: %s\n", not_up);
		frame_show(paint_not_up);
		if (den_again()) {
			vTaskDelay(pdMS_TO_TICKS(4000));
			esp_restart();
		}
		for (;;) {
			char typed[64];
			if (usb_serial_jtag_read_bytes(typed, sizeof typed, 0) > 0) printf("den: not up: %s\n", not_up);
			vTaskDelay(pdMS_TO_TICKS(100));
		}
	}
	printf("den: %s in room %s, up, %u bytes of heap\n", me.id, room, (unsigned)(before - free_now()));
	stage("den up");
	wifi = wifi_start(WEBSOCKET ? 0 : POLL_WORKERS);
	if (wifi) {
		char url[160];
		snprintf(url, sizeof url, "%s/littlesync/tippet/dens-%s", CONFIG_CARDPUTER_SERVER, room);
		carry_start(den_sync(), url);
		printf("%s: %s\n", WEBSOCKET ? "ws" : "poll", url);
	}
	printf("ermine: up, %u bytes free%s\n", (unsigned)free_now(), wifi ? ", and over WiFi" : ", no WiFi");
	// the lowest the heap went (every task's: the workers' TLS too) in each stage of the den's life,
	// a loop at a time: joining the room (WiFi, the TLS handshakes, the first answer), catching up
	// (the room's runs landing, till none come for 3 s), an ask answered, and steady after
	enum { JOINING, CATCHING, ASK, STEADY };
	static const char *const STAGES[4] = {"joining", "catching up", "an ask", "steady"};
	size_t lowest[4] = {SIZE_MAX, SIZE_MAX, SIZE_MAX, SIZE_MAX};
	int was_up = 0, was_joined = 0, caught = 0;
	unsigned was_asks = 0;
	uint64_t was_steps = 0;
	int64_t heap_said = 0, quiet_since = 0;
	for (;;) {
		heap_caps_monitor_local_minimum_free_size_start();
		const char *k;
		while ((k = keys_next())) pressed(keyboard_api, k), host_settle();
		// G0 pressed (down for 2 loops): the menu opened or shut
		static int g0_low, g0_was;
		g0_low = gpio_get_level(0) == 0 ? g0_low + 1 : 0;
		if (g0_low == 2 && !g0_was && dens_mode) menu_toggle();
		g0_was = g0_low >= 2;
		char typed[256];
		int n;
		while ((n = usb_serial_jtag_read_bytes(typed, sizeof typed, 0)) > 0) {
			for (int i = 0; i < n; i++) {
				// \r\n is one enter
				if (typed[i] == '\n' && i && typed[i - 1] == '\r') continue;
				if (typed[i] == '\t') {
					den_trust_last();
					continue;
				}
				// ctrl-g: G0, the menu
				if (typed[i] == 0x07) {
					menu_toggle();
					continue;
				}
				if (menu_open() && (k = serial_key(typed[i])) != NULL && menu_key(k)) {
					host_settle();
					continue;
				}
				if (typed[i] == 0x1b && den_pair_waiting()) {
					den_pair_answer(0);
					continue;
				}
				if ((k = serial_key(typed[i])) == NULL) continue;
				// typed on the serial line: the shell's, and the den's keys' too
				if (shell_on) keyboard_press(keyboard_api, k);
				if (strlen(k) == 1) things_key(k);
				else if (strcmp(k, "backspace") == 0) things_key("del");
				host_settle();
				if (typed[i] == '\r' || typed[i] == '\n') print();
			}
		}
		int64_t now = esp_timer_get_time() / 1000;
		if (wifi) {
			carry_turn(now);
			host_settle();
			den_net(carry_state());
			if (poll_up() && !was_up) stage("wifi joined");
			if (carry_joined() && !was_joined) stage("room joined"), quiet_since = now;
			was_up = poll_up(), was_joined = carry_joined();
		}
		den_tick(now);
		vTaskDelay(pdMS_TO_TICKS(10));
		size_t low = heap_caps_get_minimum_free_size(MALLOC_CAP_8BIT);
		heap_caps_monitor_local_minimum_free_size_stop();
		// which stage this loop was in
		int asked = den_asks() != was_asks;
		was_asks = den_asks();
		// catching up: the log's steps growing; caught up once they stand still 3 s
		if (den_steps() != was_steps) was_steps = den_steps(), quiet_since = now;
		else if (was_joined && !caught && quiet_since && now - quiet_since > 3000) caught = 1, stage("caught up");
		int st = asked ? ASK : !was_joined ? JOINING : !caught ? CATCHING : STEADY;
		if (low < lowest[st]) lowest[st] = low;
		if (asked) stage("an ask answered");
		// the heap on the log every 10 s: what's free, the least yet, the biggest block, and the
		// lowest in each stage
		if (now - heap_said >= 10000) {
			heap_said = now;
			stage("now");
			printf("stack: main %u left; %s\n", (unsigned)uxTaskGetStackHighWaterMark(NULL), wifi ? wifi_status() : "");
			printf("heap: lowest free");
			for (int i = 0; i < 4; i++)
				if (lowest[i] != SIZE_MAX) printf(", %s %u", STAGES[i], (unsigned)lowest[i]);
			printf("\n");
		}
	}
}
