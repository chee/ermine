// littlesync over WiFi (net.h): esp_wifi as a station, esp_http_client posting to the gateway (http, or
// https checked against ESP-IDF's certificate bundle)
#include "net.h"

#include "http.h"

#include <stdio.h>
#include <string.h>

#include "esp_crt_bundle.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

static const char *TAG = "net";

// the answer's bytes at most: half the gateway's default, room in the heap
#define MOST 8192
// an answer after the wait and this, or the post failed
#define SLACK_MS 10000

static volatile int joined;
static struct ls_link *gate;
static ls_http *http;
static esp_http_client_handle_t client;
static TaskHandle_t poster;
static QueueHandle_t done;
static ls_http_request request;
static int busy;
static char status[96];

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
	(void)arg, (void)data;
	if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) esp_wifi_connect();
	else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) joined = 0, esp_wifi_connect();
	else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) joined = 1;
}

// one POST on the kept connection (http.h's ls_http_post). A kept connection the gateway let go: once
// more on a new one
static long post(const ls_http_request *r) {
	if (!joined) return -1;
	for (int tries = 0; tries < 2; tries++) {
		int kept = esp_http_client_get_state(client) >= HTTP_STATE_CONNECTED;
		esp_http_client_set_url(client, r->url);
		esp_http_client_set_timeout_ms(client, (int)(r->wait_ms + SLACK_MS));
		int64_t size = -1;
		// the length first, then the body's pieces as they are (the link's frames, never gathered)
		int ok = esp_http_client_open(client, (int)r->length) == ESP_OK;
		for (size_t i = 0; ok && i < r->pieces; i++)
			ok = esp_http_client_write(client, (const char *)r->body[i].bytes, (int)r->body[i].length) == (int)r->body[i].length;
		if (ok) size = esp_http_client_fetch_headers(client);
		if (size < 0) {
			esp_http_client_close(client);
			if (kept) continue;
			return -1;
		}
		if (esp_http_client_get_status_code(client) != 200 || (size_t)size > r->room) break;
		size_t got = 0;
		while (got < (size_t)size) {
			int n = esp_http_client_read(client, (char *)r->answer + got, (int)((size_t)size - got));
			if (n <= 0) break;
			got += (size_t)n;
		}
		if (got < (size_t)size) break;
		if (!esp_http_client_is_persistent_connection(client)) esp_http_client_close(client);
		return (long)got;
	}
	esp_http_client_close(client);
	return -1;
}

static void posting(void *arg) {
	(void)arg;
	for (;;) {
		ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
		long n = post(&request);
		xQueueSend(done, &n, portMAX_DELAY);
	}
}

// a start that failed: nothing left
static int stop(void) {
	if (client) esp_http_client_cleanup(client), client = NULL;
	ls_http_close(http), http = NULL;
	if (gate) ls_unlink(gate), gate = NULL;
	return 0;
}

int net_start(ls_dev *dev, void (*random)(void *, uint8_t *, size_t)) {
	if (dev == NULL || CONFIG_CARDPUTER_WIFI_SSID[0] == 0 || CONFIG_CARDPUTER_GATEWAY[0] == 0) return 0;
	int secure = strncmp(CONFIG_CARDPUTER_GATEWAY, "https://", 8) == 0;
	if (!secure && strncmp(CONFIG_CARDPUTER_GATEWAY, "http://", 7) != 0) {
		ESP_LOGE(TAG, "the gateway is http://host:port or https://host: %s", CONFIG_CARDPUTER_GATEWAY);
		return 0;
	}
	gate = ls_link(dev);
	if (gate == NULL) return 0;
	http = ls_http_open(gate, &(ls_http_options){.url = CONFIG_CARDPUTER_GATEWAY, .random = random, .most = MOST});
	done = xQueueCreate(1, sizeof(long));
	// the first url: the handle's host and port, the same for every post
	esp_http_client_config_t c = {
		.url = CONFIG_CARDPUTER_GATEWAY,
		.method = HTTP_METHOD_POST,
		.timeout_ms = LS_HTTP_IDLE_MS + SLACK_MS,
		.disable_auto_redirect = true,
		// https: the server's certificate checked against the bundle (CONFIG_MBEDTLS_CERTIFICATE_BUNDLE)
		.crt_bundle_attach = secure ? esp_crt_bundle_attach : NULL,
	};
	client = http && done ? esp_http_client_init(&c) : NULL;
	if (client == NULL) return stop();
	esp_http_client_set_header(client, "Content-Type", "application/octet-stream");

	esp_netif_init();
	esp_event_loop_create_default();
	esp_netif_create_default_wifi_sta();
	wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
	if (esp_wifi_init(&init) != ESP_OK) return stop();
	esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, NULL, NULL);
	esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_event, NULL, NULL);
	wifi_config_t w = {0};
	snprintf((char *)w.sta.ssid, sizeof w.sta.ssid, "%s", CONFIG_CARDPUTER_WIFI_SSID);
	snprintf((char *)w.sta.password, sizeof w.sta.password, "%s", CONFIG_CARDPUTER_WIFI_PASSWORD);
	w.sta.threshold.authmode = CONFIG_CARDPUTER_WIFI_PASSWORD[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
	esp_wifi_set_mode(WIFI_MODE_STA);
	esp_wifi_set_config(WIFI_IF_STA, &w);
	esp_wifi_start();
	// a TLS handshake (mbedtls on this task) wants more stack than plain http
	xTaskCreate(posting, "littlesync http", secure ? 8192 : 6144, NULL, 5, &poster);
	ESP_LOGI(TAG, "wifi %s, gateway %s, session %s", CONFIG_CARDPUTER_WIFI_SSID, CONFIG_CARDPUTER_GATEWAY,
		ls_http_session(http));
	return 1;
}

void net_turn(int64_t now) {
	if (http == NULL) return;
	long n;
	if (busy && xQueueReceive(done, &n, 0) == pdTRUE) busy = 0, ls_http_end(http, now, n);
	if (!busy && joined && ls_http_begin(http, now, &request)) busy = 1, xTaskNotifyGive(poster);
}

const char *net_status(void) {
	if (http == NULL) return NULL;
	const ls_http_stats *s = ls_http_stats_of(http);
	snprintf(status, sizeof status, "wifi %s %s, session %s, posts %u failed %u%s", CONFIG_CARDPUTER_WIFI_SSID,
		joined ? "joined" : "not joined", ls_http_session(http), (unsigned)s->posts, (unsigned)s->failed,
		s->failing ? " (failing)" : "");
	return status;
}

struct ls_link *net_link(void) { return gate; }
