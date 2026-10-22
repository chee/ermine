// the network on the Cardputer: esp_wifi as a station (the network menuconfig names), and poll.h's
// workers (POLL_WORKERS: one, for the heap), each a task with an esp_http_client of its own, kept alive between requests: http,
// or https checked against ESP-IDF's certificate bundle (sdkconfig.defaults' common CAs)
#include "wifi.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_crt_bundle.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "poll.h"
#include "sdkconfig.h"

static const char *TAG = "wifi";

// an answer after the wait (recv's: about 25 s) and this, or the request failed
#define RECV_MS 35000
#define SEND_MS 15000

static volatile int joined;
// why the last join failed (wifi_err_reason_t), 0 for none yet
static volatile int why;
static TaskHandle_t tasks[2];
static esp_http_client_handle_t clients[2];
static poll_request *volatile jobs[2];
static UBaseType_t stack_left[2];

int poll_up(void) { return joined; }

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
	(void)arg;
	if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) esp_wifi_connect();
	else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
		joined = 0, why = ((wifi_event_sta_disconnected_t *)data)->reason;
		esp_wifi_connect();
	} else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) joined = 1;
}

// the answer's body, all of it, into a new buffer (at most POLL_MOST): 0, or -1
static int body(esp_http_client_handle_t c, int64_t size, poll_request *r) {
	size_t room = size > 0 ? (size_t)size : 512, got = 0;
	if (size > POLL_MOST) return -1;
	uint8_t *b = malloc(room);
	if (b == NULL) return -1;
	for (;;) {
		if (got == room) {
			if (room >= POLL_MOST) return free(b), -1;
			room = room * 2 > POLL_MOST ? POLL_MOST : room * 2;
			uint8_t *more = realloc(b, room);
			if (more == NULL) return free(b), -1;
			b = more;
		}
		int n = esp_http_client_read(c, (char *)b + got, (int)(room - got));
		if (n < 0) return free(b), -1;
		if (n == 0) break;
		got += (size_t)n;
		if (size > 0 && got == (size_t)size) break;
	}
	r->answer = b, r->length = got;
	return 0;
}

// one request on worker i's kept connection. a kept connection the server let go: once more on a
// new one
static void request(int i, poll_request *r) {
	r->status = -1;
	if (!joined) return;
	if (clients[i] == NULL) {
		esp_http_client_config_t config = {
			.url = r->url,
			.timeout_ms = RECV_MS,
			.disable_auto_redirect = true,
			.crt_bundle_attach = strncmp(r->url, "https://", 8) == 0 ? esp_crt_bundle_attach : NULL,
		};
		clients[i] = esp_http_client_init(&config);
		if (clients[i] == NULL) return;
	}
	esp_http_client_handle_t c = clients[i];
	for (int tries = 0; tries < 2; tries++) {
		int kept = esp_http_client_get_state(c) >= HTTP_STATE_CONNECTED;
		esp_http_client_set_url(c, r->url);
		esp_http_client_set_method(c, r->post ? HTTP_METHOD_POST : HTTP_METHOD_GET);
		esp_http_client_set_timeout_ms(c, r->post ? SEND_MS : RECV_MS);
		if (r->post) esp_http_client_set_header(c, "Content-Type", "application/octet-stream");
		else esp_http_client_delete_header(c, "Content-Type");
		int ok = esp_http_client_open(c, r->post ? (int)r->n : 0) == ESP_OK;
		if (ok && r->post && r->n) ok = esp_http_client_write(c, (const char *)r->body, (int)r->n) == (int)r->n;
		int64_t size = ok ? esp_http_client_fetch_headers(c) : -1;
		if (size < 0) {
			esp_http_client_close(c);
			if (kept) continue;
			return;
		}
		int status = esp_http_client_get_status_code(c);
		if (body(c, size, r)) {
			esp_http_client_close(c);
			return;
		}
		r->status = status;
		if (!esp_http_client_is_persistent_connection(c)) esp_http_client_close(c);
		return;
	}
}

static void worker(void *arg) {
	int i = (int)(intptr_t)arg;
	for (;;) {
		ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
		poll_request *r = jobs[i];
		request(i, r);
		stack_left[i] = uxTaskGetStackHighWaterMark(NULL);
		__atomic_store_n(&r->done, 1, __ATOMIC_RELEASE);
	}
}

void poll_do(int i, poll_request *r) {
	jobs[i] = r;
	xTaskNotifyGive(tasks[i]);
}

int wifi_start(void) {
	if (CONFIG_CARDPUTER_WIFI_SSID[0] == 0) return 0;
	esp_netif_init();
	esp_event_loop_create_default();
	esp_netif_create_default_wifi_sta();
	wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
	if (esp_wifi_init(&init) != ESP_OK) return 0;
	esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, NULL, NULL);
	esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_event, NULL, NULL);
	wifi_config_t w = {0};
	snprintf((char *)w.sta.ssid, sizeof w.sta.ssid, "%s", CONFIG_CARDPUTER_WIFI_SSID);
	snprintf((char *)w.sta.password, sizeof w.sta.password, "%s", CONFIG_CARDPUTER_WIFI_PASSWORD);
	w.sta.threshold.authmode = CONFIG_CARDPUTER_WIFI_PASSWORD[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
	esp_wifi_set_mode(WIFI_MODE_STA);
	esp_wifi_set_config(WIFI_IF_STA, &w);
	esp_wifi_start();
	// a TLS handshake (mbedtls on the worker's task) wants more stack than plain http
	for (int i = 0; i < POLL_WORKERS; i++)
		xTaskCreate(worker, i ? "tippet send" : "tippet poll", WIFI_STACK, (void *)(intptr_t)i, 5, &tasks[i]);
	ESP_LOGI(TAG, "wifi %s", CONFIG_CARDPUTER_WIFI_SSID);
	return 1;
}

const char *wifi_status(void) {
	static char s[96];
	char joining[24] = "joined";
	if (!joined) snprintf(joining, sizeof joining, why ? "not joined (%d)" : "not joined", why);
	snprintf(s, sizeof s, "wifi %s %s, workers' stack left %u %u", CONFIG_CARDPUTER_WIFI_SSID, joining,
		(unsigned)stack_left[0], (unsigned)stack_left[1]);
	return s;
}
