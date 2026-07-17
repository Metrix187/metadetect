/*
 * signatures.h — device fingerprints for the ESP32 detector.
 *
 * same idea as the web app's signatures.js, just in C. the reliable signal is
 * the BLE manufacturer company id (2 bytes, little-endian, at the front of the
 * manufacturer-specific advert field). MACs get randomized; company ids don't.
 *
 * when you sniff a new gadget in the wild, add a line. that's the whole point.
 */

#ifndef MD_SIGNATURES_H
#define MD_SIGNATURES_H

#include <stdint.h>

// confidence buckets, mirrors the web app
enum md_conf { MD_LOW = 0, MD_MEDIUM = 1, MD_HIGH = 2 };

typedef struct {
  uint16_t    company_id;   // Bluetooth SIG assigned number
  const char* product;      // human label
  md_conf     conf;         // how much to trust a bare id match
} md_company_t;

typedef struct {
  const char* needle;       // case-insensitive substring of the advertised name
  const char* product;
  md_conf     conf;
} md_name_t;

typedef struct {
  uint16_t    uuid16;       // 16-bit service uuid (the 0000XXXX-... short form)
  const char* product;
  md_conf     conf;
} md_uuid_t;

/* ---- BLE company ids ---------------------------------------------------- */
static const md_company_t MD_COMPANIES[] = {
  { 0x01AB, "Meta / Ray-Ban (Facebook id)",        MD_HIGH   },
  { 0x0D53, "Ray-Ban Meta (Luxottica frames)",     MD_HIGH   },
  { 0x058E, "Meta Reality Labs (Quest/glasses)",   MD_HIGH   },
  { 0x03C2, "Snap Spectacles",                     MD_HIGH   },
  { 0x05D6, "Budget AI cam-glasses (Jieli chip)",  MD_MEDIUM }, // also in junk earbuds
  { 0x0171, "Amazon Echo Frames/Buds",             MD_MEDIUM },
  { 0x00E0, "Google / Android XR",                 MD_LOW    },
  // 0x004C (Apple) deliberately omitted — every iPhone/AirPod screams it.
};
static const int MD_COMPANIES_N = sizeof(MD_COMPANIES) / sizeof(MD_COMPANIES[0]);

/* ---- advertised name substrings ---------------------------------------- */
static const md_name_t MD_NAMES[] = {
  { "ray-ban",    "Ray-Ban Meta",              MD_HIGH   },
  { "rayban",     "Ray-Ban Meta",              MD_HIGH   },
  { "meta view",  "Meta View glasses",         MD_HIGH   },
  { "spectacles", "Snap Spectacles",           MD_HIGH   },
  { "heycyan",    "HeyCyan AI cam-glasses",    MD_HIGH   },
  { "echo frames","Amazon Echo Frames",        MD_MEDIUM },
  { "even realit","Even Realities G1",         MD_MEDIUM },
  { "xreal",      "XREAL glasses",             MD_MEDIUM },
  { "rokid",      "Rokid glasses",             MD_MEDIUM },
  { "vuzix",      "Vuzix glasses",             MD_MEDIUM },
  { "limitless",  "Limitless Pendant",         MD_MEDIUM },
  { "plaud",      "Plaud recorder",            MD_MEDIUM },
  { "gopro",      "GoPro",                     MD_LOW    },
};
static const int MD_NAMES_N = sizeof(MD_NAMES) / sizeof(MD_NAMES[0]);

/* ---- service uuids (16-bit short form) ---------------------------------- */
static const md_uuid_t MD_UUIDS[] = {
  { 0xFD5F, "Meta service uuid (Ray-Ban)",     MD_HIGH },
  // 0xFEAA is Eddystone — too common to trust, left out on purpose.
};
static const int MD_UUIDS_N = sizeof(MD_UUIDS) / sizeof(MD_UUIDS[0]);

/* ---- WiFi OUIs (first 3 MAC bytes) -------------------------------------
 * OPTIONAL / EXPERIMENTAL. glasses only bring WiFi up while offloading media,
 * and often with a randomized MAC, so this is opportunistic at best.
 *
 * these are NOT pre-filled with guesses — populate them yourself from the IEEE
 * registry (search "Meta Platforms" / "Facebook") or from your own sniffing,
 * so you're matching real values instead of something i made up. format is
 * {0xAA,0xBB,0xCC}. leave empty to disable WiFi matching entirely.
 */
typedef struct { uint8_t oui[3]; const char* product; } md_oui_t;
static const md_oui_t MD_OUIS[] = {
  // { {0x00,0x00,0x00}, "Meta (verify me!)" },
};
static const int MD_OUIS_N = sizeof(MD_OUIS) / sizeof(MD_OUIS[0]);

#endif // MD_SIGNATURES_H
