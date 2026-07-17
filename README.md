# MetaDetect

Find out if a Ray-Ban Meta (or some other camera/mic gadget) is recording you in
public. It listens for the Bluetooth those devices leak and flags the ones that
are known recorders, so you get a heads up instead of finding out later.

Two versions live here:

- the web app in this folder, runs on your phone, installable
- an ESP32 build in [`esp32/`](esp32/) that does the job better and fits on a keychain

One thing before you trust it: treat it like a smoke alarm, not a force field. If
it finds nothing, that does *not* mean nobody's filming. It means nothing nearby
is currently broadcasting a signature it recognizes. The caveats in
[LIMITATIONS.md](LIMITATIONS.md) are real, please read them. And don't be weird
with it. The point is your own privacy, not tracking strangers.

## how it works

Recording wearables talk over Bluetooth Low Energy, and every advert they send
carries a manufacturer "company id" handed out by the Bluetooth SIG. Phones
randomize their MAC address every few minutes, but that company id doesn't move,
so it's the thing worth watching. MetaDetect keeps an ear out for the company
ids, service UUIDs and names that belong to known recorders. Ray-Ban Meta is
`0x01AB` / `0x0D53`, Snap Spectacles is `0x03C2`, plus a pile of cheap AI
cam-glasses and recorder pendants. When one turns up you get a card, a buzz, and
a log line with a rough idea of how close it is.

All the fingerprints sit in [`signatures.js`](signatures.js) for the web app and
[`signatures.h`](esp32/metadetect-esp32/signatures.h) for the hardware. Spotting
a new gadget in the wild is a one-line add.

## what it does

- live BLE scan with a high/medium/low confidence call and a "why'd you flag this" breakdown
- rough distance off the signal strength, from arm's reach out to faint and far
- a real pause button that stops scanning *and* logging until you hit resume, plus an optional auto-resume timer
- alerts you can mix and match: screen flash, beep, vibrate
- a sensitivity slider so it only nags about things that are actually close
- detection log with timestamps and CSV export
- runs offline and installs to your home screen, since it's a PWA

## running the web app

Web Bluetooth only runs in a secure context, so it needs https or localhost.
Double-clicking `index.html` (a `file://` path) won't work.

Quick local look:

```bash
python -m http.server 8137
# windows, if it can't find python:
py -m http.server 8137
# then open http://localhost:8137 in Chrome or Edge
```

Any static server is fine (`npx serve`, `php -S localhost:8137`, VS Code Live
Server, take your pick). Just not `file://`.

Actually using it on your phone means hosting the folder somewhere with https.
GitHub Pages is the easy path: push the repo, go to Settings → Pages, deploy from
`main` / root, then open the github.io link on your phone and Add to Home Screen.
Netlify, Vercel and Cloudflare Pages all work the same way.

### the android catch

The passive-scan API (`requestLEScan`) is still experimental, so once per device
you have to switch it on:

1. open `chrome://flags`
2. enable "Experimental Web Platform features"
3. restart Chrome

Then hit Start scanning and allow the Bluetooth prompt.

### where it actually works

| Platform | Works? | Notes |
|---|---|---|
| Android Chrome/Edge | yes | once you flip that flag. this is the good case. |
| Desktop Chrome/Edge | yes | with the flag, if the machine has Bluetooth. |
| iPhone / iPad | no | Apple doesn't ship Web Bluetooth in any iOS browser and there's no way around it. use Android or the ESP32. |
| Firefox / Safari | no | no Web Bluetooth there either. |
| anything else | sort of | you'll land in demo mode, which is clearly-fake data so the UI isn't blank. not a real scan. |

## the esp32 version

Got an iPhone, or you just want the version that works all the time without
babysitting a browser tab? Build the hardware one. An ESP32 sniffs BLE passively
around the clock (and WiFi too if you enable it), costs about a fiver, and rides
on a keychain. Parts, wiring and flashing steps are in
[esp32/README.md](esp32/README.md), and the firmware's ready to flash.

## limits (short version, the full one is in [LIMITATIONS.md](LIMITATIONS.md))

- most gear only broadcasts loudly when it powers on, pairs, or leaves its case, not the whole time it films. quiet is not the same as safe.
- it can't see wired or fully-offline cameras that keep their radios dark.
- iPhones can't run the web app, full stop.
- signatures go stale as new gadgets ship, so keep them fresh.
- finding a device isn't the same as knowing whose it is. be decent about it.

## adding signatures

Caught a recorder it doesn't know yet? Add a line:

- web: [`signatures.js`](signatures.js) under `COMPANY_IDS`, `SERVICE_UUIDS` or `NAME_PATTERNS`
- esp32: [`signatures.h`](esp32/metadetect-esp32/signatures.h)

Say how you caught it (the id/uuid/name and which device) so the next person can
trust the entry.

## credit

Built by sky ([@Metrix187](https://github.com/Metrix187)).

The fingerprint list leans on a few open detectors that did the sniffing first:
[NullPxl/banrays](https://github.com/NullPxl/banrays),
[yjeanrenaud/yj_nearbyglasses](https://github.com/yjeanrenaud/yj_nearbyglasses),
and the "Spectacle" glasses-detecting keychain. Thanks to everyone who
reverse-engineered these things so the rest of us know what to look for.

## license

MIT. Do whatever, no warranty. See [LICENSE](LICENSE).
