# MetaDetect ESP32, the version that actually works all the time

The web app is boxed in by what a browser will let a web page do. An ESP32 isn't.
It'll sniff BLE adverts passively all day (and WiFi too if you want), so this is
the one worth carrying around.

The firmware is in [`metadetect-esp32/`](metadetect-esp32/). It scans BLE
continuously, matches against the same signature set the web app uses, and blinks
an LED, buzzes, and prints to serial when a likely recorder shows up. The BOOT
button pauses it.

## why the ESP32 beats the phone

| | web app (phone) | ESP32 |
|---|---|---|
| passive BLE advert scan | Android Chrome only, behind a flag | yes, always |
| iPhone support | none (Apple blocks Web Bluetooth) | doesn't care what phone you own |
| raw manufacturer data | limited | full |
| WiFi OUI / probe sniffing | impossible from a browser | yes (experimental) |
| runs in your pocket, no browser tab | no | yes, on a battery |
| cost | free | about $6 to $15 |

Same core idea in both: the BLE company id baked into the advertisement. Phones
randomize their MAC every few minutes so OUI matching is dead on BLE, but that
company id stays put. It's the reliable tell.

## bill of materials

Bare minimum, breadboard, ~$6:

- 1x ESP32 devkit. An ESP32-WROOM-32 DevKitC is the safe default. C3 or S3 work
  too, you just fix the pin numbers in the sketch, since their onboard LED isn't
  on GPIO2.
- 1x USB cable that actually carries data, not a charge-only one.

Nice to have:

- 1x active buzzer module (the kind that beeps on a plain HIGH, no tone needed), wired to GPIO4
- 1x 0.96" SSD1306 OLED (I2C, 128x64) if you'd rather have a screen than the serial monitor
- 1x LiPo + charger board (a TP4056, say) or a small power bank to make it portable
- a little enclosure and a lanyard. it's a keychain-sized privacy gadget, have fun with it.

## wiring

The minimum build needs zero wiring. The onboard LED and BOOT button are enough,
just watch the serial monitor. Add parts as you like:

| part | ESP32 pin | notes |
|---|---|---|
| onboard LED | GPIO2 | already there on WROOM devkits |
| BOOT button | GPIO0 | already there, this is the pause toggle |
| active buzzer (+) | GPIO4 | set `BUZZER_PIN -1` in the sketch to skip it |
| buzzer (-) | GND | |
| OLED VCC | 3V3 | only if `USE_OLED 1` |
| OLED GND | GND | |
| OLED SDA | GPIO21 | default I2C on WROOM |
| OLED SCL | GPIO22 | |

## flashing (Arduino IDE)

1. Install the Arduino IDE (2.x is fine).
2. In File → Preferences → Additional boards manager URLs, add:
   ```
   https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
   ```
3. Tools → Board → Boards Manager, install "esp32" by Espressif.
4. Tools → Manage Libraries, install NimBLE-Arduino. The sketch targets the 1.4.x
   API. If you're on NimBLE 2.x the callback class changed to `NimBLEScanCallbacks`
   with a `const` argument, which is a 3-line tweak noted in the sketch. If you set
   `USE_OLED 1`, also grab Adafruit SSD1306 and Adafruit GFX.
5. Open [`metadetect-esp32/metadetect-esp32.ino`](metadetect-esp32/metadetect-esp32.ino).
6. Tools → Board, pick your board (e.g. "ESP32 Dev Module").
7. Plug in, pick the Port, hit Upload.
8. Open Serial Monitor at 115200 baud. Hits scroll by as they come. Wave a
   Ray-Ban Meta near it, or trigger pairing on any target device, to test.

Prefer the command line? `arduino-cli` or PlatformIO both work, the `.ino` and
`.h` drop straight in.

## what you'll see

```
MetaDetect ESP32 — watching the airwaves. BOOT button = pause.

[!] Meta / Ray-Ban (Facebook id)        HIGH  -58dBm  via company id
[!] Snap Spectacles                      HIGH  -71dBm  via name   Spectacles 3
[!] Budget AI cam-glasses (Jieli chip)   MED   -77dBm  via company id
== PAUSED ==
```

The LED blinks 3x for a HIGH-confidence hit, once otherwise. The buzzer
double-beeps on HIGH. Press BOOT to pause (scan fully stops), press again to
resume.

## knobs to turn (top of the .ino)

- `RSSI_ALERT` (default -85). Raise it toward -60 to only fire on stuff basically
  on top of you, lower toward -95 to catch faint and far things (and more noise).
- `REALERT_MS`. How long before the same device is allowed to alert again.
- `USE_OLED`. Flip to 1 if you wired a screen.
- `ENABLE_WIFI_SNIFF`. See below.

## the WiFi sniffing bit (experimental, off by default)

Smart glasses spin up WiFi to offload photos and video to the phone. Catch that
and the source MAC's OUI can out the vendor. Two honest problems:

1. The WiFi radio is only up during transfer, not while filming.
2. Modern devices often randomize that MAC too.

So it's opportunistic. It's also why [`signatures.h`](metadetect-esp32/signatures.h)
ships with an empty OUI table instead of made-up values. Fill in `MD_OUIS`
yourself from the [IEEE OUI registry](https://standards-oui.ieee.org/) (search
"Meta Platforms" or "Facebook") or from your own captures, then set
`ENABLE_WIFI_SNIFF 1`. That way you're matching real values, not something I
guessed.

Coexistence note: a BLE scan and WiFi promiscuous mode share one 2.4GHz radio and
time-slice it. It works, but you'll drop some packets on both sides. If you want
serious WiFi hunting, throw a second ESP32 at it.

## ideas / roadmap

- [ ] Direction finding. Turn the RSSI into a hot/cold "which way is it" readout, or bolt on a directional antenna.
- [ ] Logging. Dump hits to an SD card or flash with timestamps (add an RTC).
- [ ] Companion BLE. Have the ESP32 relay hits to the phone web app over BLE, so you get the nice UI plus the good radio.
- [ ] Battery and enclosure. TP4056 + a 500mAh LiPo + a printed case gets you the real keychain form factor.
- [ ] Signature auto-update. Pull the latest list over WiFi on boot.

## legal / ethics

This is a passive listener. It only receives the adverts devices are already
shouting into the air, which is fine to do. Keep it that way:

- Don't add jamming, deauth, or anything that transmits to interfere. It's
  illegal in most countries and it turns a privacy tool into a menace.
- Detecting a device isn't identifying a person. Don't use this to harass anyone.
- The whole point is your awareness, not surveilling other people.
