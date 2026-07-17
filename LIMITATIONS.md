# Limitations, read this before you trust MetaDetect

This thing is genuinely handy for *awareness*. It is not a guarantee of privacy,
and pretending it is would be worse than useless, because false confidence is how
you get caught out. So here's the honest list of what it can't do and why.

## the big one: quiet doesn't mean safe

Most recording wearables only send a loud, identifiable BLE advert when they
power on, go into pairing, or come out of the charging case. Once a device is
paired and settled into a connection it can go quiet, or fold into directed
traffic that a passive scanner won't flag.

So "0 detected" means "nothing is advertising a known signature right now." It
does not mean "nobody near me is recording." A clear screen is mildly reassuring
at best. Don't treat it as a green light.

## stuff it flat out can't see

- Wired or offline cameras. A hidden cam recording to an SD card with its radios
  off gives off nothing. Same for old camcorders and someone just holding up a
  phone.
- Anything with no known signature. Something brand new, custom, or deliberately
  obfuscated won't match. It only knows what it's been taught.
- Devices that fully randomize their identity. If a vendor ever randomizes the
  manufacturer company id (rare, but possible) the reliable signal is gone.
- Non-radio recording. A mic'd gadget sending nothing over the air, an analog
  bug, or a person with a good memory.

## platform limits (web app)

- iPhone and iPad get nothing. Apple doesn't implement Web Bluetooth in any iOS
  browser, and Safari, Chrome and Firefox on iOS all run on WebKit, which lacks
  it. There's no web workaround. Use Android or the ESP32.
- Android needs a flag. The passive-scan API (`requestLEScan`) is experimental,
  so you have to enable `chrome://flags` → "Experimental Web Platform features"
  once per device.
- No MAC access. Web Bluetooth hides hardware MACs on purpose, so the web app
  can't do WiFi-OUI matching at all. The ESP32 can.
- Backgrounding. A tab that's backgrounded or screen-locked may get throttled or
  suspended. Keep it in the foreground for a live sweep.

## accuracy caveats

- False positives happen. Some ids we match are shared. The Jieli chipset
  (`0x05D6`) is in cheap AI glasses *and* a mountain of no-name earbuds, so a
  "medium" hit there is a maybe, not a gotcha. Broad vendor ids like Amazon and
  Google are weak on their own.
- False negatives happen too. See the whole top half of this file.
- RSSI isn't real distance. Signal strength is a rough proximity hint. Walls,
  bodies, pockets and antenna angle all throw it off. "Very close" might be
  through a wall, "far" might be pocketed and right next to you.
- Confidence is a heuristic, not a measurement. It just reflects how specific the
  matched signals were.

## signatures go stale

New recording gadgets ship constantly and vendors change their assigned ids. The
signature lists ([`signatures.js`](signatures.js),
[`signatures.h`](esp32/metadetect-esp32/signatures.h)) are a snapshot in time.
They need upkeep to stay useful, and an out-of-date list quietly misses things.

## ethics, and this cuts both ways

The point is your awareness of being recorded, not surveilling other people.

- Finding a device isn't identifying a person, and the proximity is fuzzy. Don't
  accuse, confront, or harass anyone over a blip.
- Don't log or track individuals over time. That's the exact behavior this exists
  to push back on.
- Recording laws, and what you're allowed to do about being recorded, vary a lot
  by place. Know yours.

## bottom line

Use it like a smoke detector. A useful heads up that's worth having, that you
never bet your life on, and that needs its batteries (the signatures) kept fresh.
If you need real guarantees, the only ones that exist are physical: leave, cover
up, or don't say it near glass.
