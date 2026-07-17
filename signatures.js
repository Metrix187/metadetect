/*
 * signatures.js — the "who's probably filming me" lookup tables.
 *
 * everything here is data, no logic. app.js reads these to score a BLE
 * advertisement. keep it easy to extend: when someone in the wild sniffs a
 * new gadget, they add a line here and the whole app knows about it.
 *
 * the important honest bit: the reliable signal is the Bluetooth SIG company id
 * baked into the manufacturer-specific data. phones randomize their MAC every
 * few minutes so OUI matching is basically dead on BLE, but the company id in
 * the advert payload is not randomized. that's why we lean on it.
 *
 * sources for these ids: field-tested open detectors (NullPxl/banrays,
 * yjeanrenaud/yj_nearbyglasses, the "Spectacle" keychain) + the Bluetooth SIG
 * assigned-numbers list. anything i wasn't sure of is flagged in `note`.
 */

(function (global) {
  'use strict';

  // how many points each kind of match is worth. tuned so a single strong
  // signal (specific company id, or a name that literally says "ray-ban")
  // clears the "high confidence" bar on its own, but a broad vendor id like
  // Google/Amazon needs a second signal before we bother you.
  const SIGNAL_WEIGHTS = {
    specific: 55,   // an id/uuid basically only these recorders use
    socVendor: 30,  // a chip maker whose parts show up in cheap cam-glasses AND junk earbuds
    broad: 15,      // a megacorp id that covers a zillion unrelated gadgets
    name: 45,       // the advertised name literally names the product
    ignore: 0,      // labeled for context, never counts as a threat (e.g. every iPhone)
  };

  // score -> label thresholds. also the alert gate: we only buzz for medium+.
  const CONFIDENCE = {
    high: 55,
    medium: 30,
    // anything > 0 and < medium is "low" — shown but never alerts
  };

  // helper: expand a 16-bit shorthand like 0xfd5f into the full 128-bit uuid
  // string Web Bluetooth hands us, so we can compare apples to apples.
  function uuid16(hex) {
    const h = hex.toString(16).padStart(4, '0');
    return `0000${h}-0000-1000-8000-00805f9b34fb`;
  }

  /*
   * COMPANY_IDS — keyed by the numeric Bluetooth SIG company identifier.
   * these come out of adv.manufacturerData as Map<companyId, DataView>.
   * `kind` picks the weight above. `category`/`risk` drive the UI copy.
   */
  const COMPANY_IDS = {
    0x01ab: { // 427
      brand: 'Meta',
      product: 'Ray-Ban Meta / Ray-Ban Stories',
      category: 'camera-glasses',
      risk: 'records photo, video + audio',
      kind: 'specific',
      note: 'Facebook/Meta company id. strongest tell for Ray-Ban Meta.',
    },
    0x058e: { // 1422
      brand: 'Meta',
      product: 'Meta Reality Labs (Quest / future glasses)',
      category: 'xr-headset',
      risk: 'cameras + mics, mostly stationary though',
      kind: 'specific',
      note: 'Meta Platforms Technologies LLC — Quest line and Reality Labs hardware.',
    },
    0x0d53: { // 3411
      brand: 'Luxottica',
      product: 'Ray-Ban Meta (Luxottica frames)',
      category: 'camera-glasses',
      risk: 'records photo, video + audio',
      kind: 'specific',
      note: 'Luxottica actually builds the Ray-Ban Meta frames.',
    },
    0x03c2: { // 962
      brand: 'Snap',
      product: 'Snap Spectacles',
      category: 'camera-glasses',
      risk: 'records photo + video',
      kind: 'specific',
      note: 'Snapchat Inc. company id.',
    },
    0x05d6: { // 1494
      brand: 'Jieli',
      product: 'budget AI camera glasses (Jieli chipset)',
      category: 'camera-glasses',
      risk: 'usually a hidden cam + mic',
      kind: 'socVendor',
      note: 'Zhuhai Jieli — cheap SoC in no-name cam glasses AND tons of junk earbuds/gadgets, so expect false positives.',
    },
    0x0171: { // 369
      brand: 'Amazon',
      product: 'Amazon Echo Frames / Echo Buds',
      category: 'audio-glasses',
      risk: 'always-listening mics (no camera)',
      kind: 'broad',
      note: 'Amazon company id — covers all Echo gear, not just the audio glasses.',
    },
    0x00e0: { // 224
      brand: 'Google',
      product: 'Google / Android XR device',
      category: 'other',
      risk: 'varies',
      kind: 'broad',
      note: 'Google company id — huge range of devices, weak signal on its own.',
    },
    0x004c: { // 76
      brand: 'Apple',
      product: 'Apple device (iPhone, AirPods, Watch…)',
      category: 'other',
      risk: 'not a known street recorder',
      kind: 'ignore',
      note: 'here only so we can label the noise. every Apple thing screams this id — never treat it as a threat by itself.',
    },
  };

  /*
   * SERVICE_UUIDS — 128-bit lowercase. matched against adv.uuids and the keys
   * of adv.serviceData.
   */
  const SERVICE_UUIDS = {
    [uuid16(0xfd5f)]: {
      brand: 'Meta',
      product: 'Ray-Ban Meta (Meta service uuid)',
      category: 'camera-glasses',
      risk: 'records photo, video + audio',
      kind: 'specific',
      note: 'Meta-assigned service uuid 0xFD5F.',
    },
    [uuid16(0xfeaa)]: {
      brand: 'unknown',
      product: 'Eddystone beacon (also seen in some Meta frames)',
      category: 'other',
      risk: 'ambiguous',
      kind: 'ignore',
      note: '0xFEAA is Google Eddystone — every retail beacon uses it, so it is basically useless alone. context only.',
    },
    '7905fff0-b5ce-4e99-a40f-4b1e122d00d0': {
      brand: 'HeyCyan',
      product: 'HeyCyan-SDK AI camera glasses (Nilox, Rollme, etc.)',
      category: 'camera-glasses',
      risk: 'hidden cam + mic',
      kind: 'specific',
      note: 'shared SDK uuid across a bunch of rebranded budget cam-glasses.',
    },
  };

  /*
   * NAME_PATTERNS — when a device is polite enough to advertise a local name.
   * curated hard to avoid dumb false positives (no bare "bee" or "friend").
   */
  const NAME_PATTERNS = [
    { re: /ray[\s._-]?ban/i,       brand: 'Meta',        product: 'Ray-Ban Meta',                 category: 'camera-glasses', risk: 'records photo, video + audio' },
    { re: /meta[\s._-]?view/i,     brand: 'Meta',        product: 'Meta View glasses',            category: 'camera-glasses', risk: 'records photo, video + audio' },
    { re: /spectacles/i,           brand: 'Snap',        product: 'Snap Spectacles',              category: 'camera-glasses', risk: 'records photo + video' },
    { re: /heycyan/i,              brand: 'HeyCyan',     product: 'HeyCyan AI camera glasses',    category: 'camera-glasses', risk: 'hidden cam + mic' },
    { re: /even[\s._-]?realities/i,brand: 'Even Realities', product: 'Even Realities G1',         category: 'audio-glasses',  risk: 'display + mic (no camera)' },
    { re: /\bxreal\b/i,            brand: 'XREAL',       product: 'XREAL glasses',                category: 'audio-glasses',  risk: 'display + mic, some models have a cam' },
    { re: /\brokid\b/i,            brand: 'Rokid',       product: 'Rokid glasses',                category: 'audio-glasses',  risk: 'display + mic, some have a cam' },
    { re: /\bvuzix\b/i,            brand: 'Vuzix',       product: 'Vuzix smart glasses',          category: 'camera-glasses', risk: 'enterprise cam glasses' },
    { re: /echo[\s._-]?frames/i,   brand: 'Amazon',      product: 'Amazon Echo Frames',           category: 'audio-glasses',  risk: 'always-listening mics' },
    { re: /\blimitless\b/i,        brand: 'Limitless',   product: 'Limitless Pendant',            category: 'ai-wearable',    risk: 'records your conversations' },
    { re: /\bplaud\b/i,            brand: 'Plaud',       product: 'Plaud Note / NotePin',         category: 'ai-wearable',    risk: 'records your conversations' },
    { re: /\bomi\b/i,              brand: 'Omi',         product: 'Omi / Based Hardware pendant', category: 'ai-wearable',    risk: 'records your conversations' },
    { re: /\bbee\s?ai\b/i,         brand: 'Bee',         product: 'Bee AI wearable',              category: 'ai-wearable',    risk: 'records your conversations' },
    { re: /gopro/i,                brand: 'GoPro',       product: 'GoPro action cam',             category: 'action-cam',     risk: 'video + audio, not exactly subtle' },
    { re: /insta360/i,            brand: 'Insta360',    product: 'Insta360 camera',              category: 'action-cam',     risk: 'video + audio' },
  ];

  // pretty labels + one-liners for the "what this detects" info screen.
  const CATEGORY_INFO = {
    'camera-glasses': { label: 'Camera glasses',  blurb: 'Glasses that shoot photo/video and record audio. The main event.' },
    'audio-glasses':  { label: 'Audio glasses',   blurb: 'Glasses with mics (and often a display) but no camera.' },
    'ai-wearable':    { label: 'AI recorder',     blurb: 'Pendants/pins that quietly record and transcribe conversations.' },
    'xr-headset':     { label: 'XR headset',      blurb: 'Cameras + mics, but usually sitting on a couch, not walking around.' },
    'action-cam':     { label: 'Action cam',      blurb: 'GoPro-style cameras. Records, but hard to hide.' },
    'other':          { label: 'Other / vendor',  blurb: 'Big-vendor ids we show for context — not a threat on their own.' },
  };

  global.MD_DB = {
    SIGNAL_WEIGHTS,
    CONFIDENCE,
    COMPANY_IDS,
    SERVICE_UUIDS,
    NAME_PATTERNS,
    CATEGORY_INFO,
    uuid16,
  };
})(typeof window !== 'undefined' ? window : this);
