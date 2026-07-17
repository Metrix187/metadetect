/*
 * MetaDetect ESP32 — pocket recorder-glasses sniffer
 * ---------------------------------------------------
 * scans BLE adverts continuously and yells when something that looks like a
 * Ray-Ban Meta / Snap Spectacles / AI recorder shows up nearby. this is the
 * "real" version — an ESP32 can passively sniff BLE all day, which a phone
 * browser mostly can't.
 *
 * hardware: any ESP32 devkit (ESP32-WROOM, C3, S3…). onboard LED + optional
 * active buzzer + the BOOT button for pause. that's it.
 *
 * libraries (Arduino IDE -> Library Manager):
 *   - NimBLE-Arduino  (this sketch targets the 1.4.x API)
 *   - Adafruit SSD1306 + Adafruit GFX  (ONLY if you set USE_OLED 1)
 *
 * board: "ESP32 Dev Module" (or your exact board) via the espressif board URL:
 *   https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
 *
 * read esp32/README.md for wiring + the honest caveats. tl;dr: glasses mostly
 * shout on power-on / pairing / case-open, not continuously while filming, so
 * silence is not proof you're unrecorded.
 */

#include <NimBLEDevice.h>
#include "signatures.h"

// ---- pins + tuning (change to match your board) -------------------------
#define LED_PIN        2      // onboard LED on most WROOM devkits. C3/S3 differ.
#define BUZZER_PIN     4      // active buzzer module (+ to this pin). set -1 to disable.
#define BUTTON_PIN     0      // BOOT button = pause toggle
#define RSSI_ALERT   -85      // ignore matches fainter than this (dBm). higher = closer only.
#define REALERT_MS  15000     // don't re-alert the same device for this long

#define USE_OLED       0      // 1 if you wired a 128x64 SSD1306 on I2C
#define ENABLE_WIFI_SNIFF 0   // 1 to also sniff WiFi OUIs (experimental, see README)

#if USE_OLED
  #include <Adafruit_SSD1306.h>
  Adafruit_SSD1306 oled(128, 64, &Wire, -1);
#endif

// ---- state --------------------------------------------------------------
volatile bool  g_paused = false;
NimBLEScan*    g_scan   = nullptr;
uint32_t       g_hits   = 0;

// tiny recent-address cache so we don't spam on every single advert
struct Seen { NimBLEAddress addr; uint32_t at; bool used; };
static Seen g_recent[16];

static bool recentlyAlerted(const NimBLEAddress& a) {
  uint32_t nowms = millis();
  for (auto& s : g_recent) {
    if (s.used && s.addr == a) {
      if (nowms - s.at < REALERT_MS) return true;
      s.at = nowms; return false;
    }
  }
  // not found — claim the oldest slot
  int oldest = 0; uint32_t oldestAt = 0xFFFFFFFF;
  for (int i = 0; i < 16; i++) {
    if (!g_recent[i].used) { oldest = i; break; }
    if (g_recent[i].at < oldestAt) { oldestAt = g_recent[i].at; oldest = i; }
  }
  g_recent[oldest] = { a, nowms, true };
  return false;
}

// case-insensitive substring, because device names are a free-for-all
static bool icontains(const std::string& hay, const char* needle) {
  std::string h = hay; for (auto& c : h) c = tolower(c);
  std::string n = needle; for (auto& c : n) c = tolower(c);
  return h.find(n) != std::string::npos;
}

// ---- the match: does this advert smell like a recorder? -----------------
struct Match { bool hit; const char* product; md_conf conf; const char* via; };

static Match classify(NimBLEAdvertisedDevice* d) {
  Match best = { false, nullptr, MD_LOW, "" };
  auto better = [&](const char* p, md_conf c, const char* via) {
    if (!best.hit || c > best.conf) { best = { true, p, c, via }; }
  };

  // 1) manufacturer company id — the trustworthy one
  if (d->haveManufacturerData()) {
    std::string md = d->getManufacturerData();
    if (md.size() >= 2) {
      uint16_t cid = (uint8_t)md[0] | ((uint8_t)md[1] << 8); // little-endian
      for (int i = 0; i < MD_COMPANIES_N; i++)
        if (MD_COMPANIES[i].company_id == cid)
          better(MD_COMPANIES[i].product, MD_COMPANIES[i].conf, "company id");
    }
  }

  // 2) service uuids
  for (int i = 0; i < d->getServiceUUIDCount(); i++) {
    NimBLEUUID u = d->getServiceUUID(i);
    for (int j = 0; j < MD_UUIDS_N; j++)
      if (u == NimBLEUUID((uint16_t)MD_UUIDS[j].uuid16))
        better(MD_UUIDS[j].product, MD_UUIDS[j].conf, "service uuid");
  }

  // 3) advertised name
  if (d->haveName()) {
    std::string name = d->getName();
    for (int i = 0; i < MD_NAMES_N; i++)
      if (icontains(name, MD_NAMES[i].needle))
        better(MD_NAMES[i].product, MD_NAMES[i].conf, "name");
  }

  return best;
}

static const char* confName(md_conf c) {
  return c == MD_HIGH ? "HIGH" : c == MD_MEDIUM ? "MED" : "LOW";
}

// ---- alert outputs ------------------------------------------------------
static void buzz(int times) {
  if (BUZZER_PIN < 0) return;
  for (int i = 0; i < times; i++) {
    digitalWrite(BUZZER_PIN, HIGH); delay(70);
    digitalWrite(BUZZER_PIN, LOW);  delay(60);
  }
}

static void showAlert(const Match& m, int rssi, const std::string& name) {
  g_hits++;
  Serial.printf("[!] %-32s  %s  %ddBm  via %s  %s\n",
                m.product, confName(m.conf), rssi, m.via, name.c_str());

  // LED: 3 blinks for HIGH, 1 for lower
  int blinks = (m.conf == MD_HIGH) ? 3 : 1;
  for (int i = 0; i < blinks; i++) {
    digitalWrite(LED_PIN, HIGH); delay(90);
    digitalWrite(LED_PIN, LOW);  delay(70);
  }
  buzz(m.conf == MD_HIGH ? 2 : 1);

#if USE_OLED
  oled.clearDisplay();
  oled.setCursor(0, 0);
  oled.setTextSize(1);
  oled.printf("RECORDER NEARBY\n\n%s\n\n%s  %ddBm\ntotal hits: %lu",
              m.product, confName(m.conf), rssi, (unsigned long)g_hits);
  oled.display();
#endif
}

// ---- BLE scan callback (NimBLE 1.4.x style) -----------------------------
class ScanCB : public NimBLEAdvertisedDeviceCallbacks {
  void onResult(NimBLEAdvertisedDevice* d) override {
    if (g_paused) return;
    int rssi = d->getRSSI();
    if (rssi < RSSI_ALERT) return;

    Match m = classify(d);
    if (!m.hit) return;
    if (recentlyAlerted(d->getAddress())) return;

    std::string name = d->haveName() ? d->getName() : "";
    showAlert(m, rssi, name);
  }
};

// ---- optional WiFi OUI sniff (experimental) -----------------------------
#if ENABLE_WIFI_SNIFF
#include "esp_wifi.h"
static void wifiSniffCb(void* buf, wifi_promiscuous_pkt_type_t type) {
  if (g_paused || MD_OUIS_N == 0) return;
  const wifi_promiscuous_pkt_t* p = (wifi_promiscuous_pkt_t*)buf;
  const uint8_t* mac = p->payload + 10; // source addr in most mgmt/data frames
  for (int i = 0; i < MD_OUIS_N; i++) {
    if (mac[0] == MD_OUIS[i].oui[0] && mac[1] == MD_OUIS[i].oui[1] && mac[2] == MD_OUIS[i].oui[2]) {
      Serial.printf("[wifi] %s  %02X:%02X:%02X:%02X:%02X:%02X  ch%d\n",
                    MD_OUIS[i].product, mac[0],mac[1],mac[2],mac[3],mac[4],mac[5],
                    p->rx_ctrl.channel);
      digitalWrite(LED_PIN, HIGH); delay(60); digitalWrite(LED_PIN, LOW);
    }
  }
}
static void wifiSniffInit() {
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_promiscuous_rx_cb(&wifiSniffCb);
}
#endif

// ---- pause button -------------------------------------------------------
static void checkButton() {
  static bool last = HIGH;
  static uint32_t lastChange = 0;
  bool now = digitalRead(BUTTON_PIN);
  if (now != last && millis() - lastChange > 250) {
    lastChange = millis();
    if (now == LOW) { // pressed
      g_paused = !g_paused;
      Serial.println(g_paused ? "== PAUSED ==" : "== RESUMED ==");
      if (g_paused) { g_scan->stop(); digitalWrite(LED_PIN, LOW); }
      else          { g_scan->start(0, nullptr, false); }
#if USE_OLED
      oled.clearDisplay(); oled.setCursor(0, 24);
      oled.println(g_paused ? "   PAUSED" : "  scanning..."); oled.display();
#endif
    }
    last = now;
  }
}

// ---- setup / loop -------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(200);
  pinMode(LED_PIN, OUTPUT);
  if (BUZZER_PIN >= 0) pinMode(BUZZER_PIN, OUTPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP);

#if USE_OLED
  Wire.begin();
  oled.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  oled.setTextColor(SSD1306_WHITE);
  oled.clearDisplay(); oled.setCursor(0, 0);
  oled.println("MetaDetect\nscanning..."); oled.display();
#endif

  Serial.println("\nMetaDetect ESP32 — watching the airwaves. BOOT button = pause.\n");

  NimBLEDevice::init("");
  g_scan = NimBLEDevice::getScan();
  g_scan->setAdvertisedDeviceCallbacks(new ScanCB(), /*wantDuplicates=*/true);
  g_scan->setActiveScan(true);   // grabs scan-response names too (costs a bit of power)
  g_scan->setInterval(100);
  g_scan->setWindow(99);
  g_scan->start(0, nullptr, false); // 0 = run forever

#if ENABLE_WIFI_SNIFF
  wifiSniffInit();
#endif
}

void loop() {
  checkButton();

#if ENABLE_WIFI_SNIFF
  // hop channels so we actually hear more than one. crude but works.
  static uint32_t lastHop = 0; static uint8_t ch = 1;
  if (!g_paused && millis() - lastHop > 300) {
    lastHop = millis();
    ch = (ch % 13) + 1;
    esp_wifi_set_channel(ch, WIFI_SECOND_CHAN_NONE);
  }
#endif

  delay(20);
}
