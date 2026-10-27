# BLE Keyboard Bridge

**Live web app:** <https://b4f8abbb24dbf56a7d0280f296e16eeb.github.io/flipper_keyboard_bridge/>

A tiny two-part bridge:

```
Chrome (Web Bluetooth, keyboard capture / paste box)
        │  BLE serial: 9-byte HID states + HKB1 keepalive pings
        ▼
Flipper Zero FAP
        │  USB HID keyboard
        ▼
Target host
```

The Flipper stays plugged into the target host as a USB keyboard. A second
device (phone, tablet, or another computer) runs Chrome, connects to the
Flipper over BLE, and forwards physical key presses. The Flipper types them
into the target host.

This is useful for using a phone/tablet as a wireless keyboard, or for typing
from one computer into another without switching input devices.

## What is in this repo

| Path | Purpose |
| --- | --- |
| `main.c` | Flipper FAP: BLE serial receive, key-state diffing, USB HID output |
| `application.fam` | FAP manifest |
| `dist/ble_kb_bridge.fap` | Prebuilt FAP (official firmware SDK 1.5.1, API 88.2) |
| `web/index.html` | Web Bluetooth UI |
| `web/app.js` | Connection, keepalive verification, keyboard capture, paste typing |
| `web/hid.js` | `KeyboardEvent.code` → USB HID usage mapping |
| `web/hid.test.mjs` | Mapping/protocol unit tests |
| `.github/workflows/pages.yml` | Publishes `web/` to GitHub Pages |

## Requirements

- Flipper Zero with **official firmware 1.5.x** (built against 1.5.1 / API 88.2).
  Recent 1.4.x/Unleashed/Momentum builds may work, but the FAP is only built
  against the official 1.5.1 SDK here.
- Chrome or Edge with Web Bluetooth. On desktop/laptop, Chrome. On mobile,
  Chrome on Android. Safari/Firefox do not support Web Bluetooth.
- USB cable from the Flipper to the **target** host.
- For **live keyboard** capture, Chrome must run on a **different device** from
  the target host. **Paste & type** can be used on the same computer. See
  [Paste mode vs live mode](#paste-mode-vs-live-mode).

The target host does not need any software. It sees a standard USB keyboard.

## Build the FAP

The build uses [ufbt](https://github.com/flipperdevices/flipperzero-ufbt).

```bash
python3 -m venv .venv
.venv/bin/pip install ufbt
.venv/bin/ufbt update
.venv/bin/ufbt
```

The FAP is written to `dist/ble_kb_bridge.fap`. To launch it directly with the
Flipper connected over USB:

```bash
.venv/bin/ufbt launch
```

> When the app starts it switches the Flipper's USB mode from CDC to HID, so
> the qFlipper/`ufbt` serial connection will disappear. That is expected.

You can also copy `dist/ble_kb_bridge.fap` to the Flipper SD card under
`/ext/apps/Tools/` and launch it from **Apps → Tools → BLE Keyboard Bridge**.

## Publish the web app to GitHub Pages

The web app is fully static and is served from `web/`. No backend, local
server, or build step is needed. Web Bluetooth requires HTTPS; GitHub Pages
provides it.

1. Push this repository to GitHub.
2. In **Settings → Pages → Build and deployment**, set **Source** to
   **GitHub Actions**.
3. Push to `main` (or run the **Deploy web app to GitHub Pages** workflow
   manually).
4. Open <https://b4f8abbb24dbf56a7d0280f296e16eeb.github.io/flipper_keyboard_bridge/>
   in Chrome.

The included workflow uploads only `web/`, so the page is at the Pages root.
All asset imports are relative, so it works under the repository subpath.

For **Chrome on Android**, open the same GitHub Pages URL on the phone. Do not
use a plain `http://<LAN-IP>` URL; Android Chrome will not expose Web Bluetooth
outside a secure context.

## Use

1. On the Flipper: turn **Bluetooth on** in Settings, then launch
   **BLE Keyboard Bridge**.
2. Plug the Flipper into the **target host** via USB. The Flipper screen should
   show `USB READY`. On macOS, accept the keyboard setup dialog if it appears.
3. On the Chrome device, open the web app and press **Connect Flipper**.
4. Choose the device whose name starts with `Flipper` (the advertised name is
   usually `Flipper <name>`).
5. Confirm the pairing PIN shown on the Flipper in the OS pairing dialog.
6. Wait for **Verified BLE Keyboard Bridge** in the web app. This is the HKB1
   handshake, not just a successful BLE connection.
7. Use either mode:
   - **Paste & type:** paste text, press **Type text**, and switch to the target
     window during the 3-second head start.
   - **Live keyboard:** click the capture pad and type.
8. Press **Release all**, **Stop**, or **Disconnect** when done.

The Flipper screen shows BLE/USB state and a count of forwarded keys.

### Pairing notes

The Flipper serial profile uses authenticated writes and PIN pairing. The first
connection must be bonded. Web Bluetooth does not expose a pairing API; Chrome
delegates the PIN dialog to the OS.

If the PIN prompt never appears:

- Remove any old pairing for that Flipper.
- Relaunch the FAP.
- Pair the Flipper once from the OS Bluetooth settings while the app is
  running, then press **Reconnect** in the web app.
- On Linux, check that your BlueZ pairing agent is running. On Windows, remove
  the old device in Bluetooth settings and retry.

## Paste mode vs live mode

**Paste & type** is the safe mode for using Chrome on the same computer as the
USB host:

1. Paste or type text into the box.
2. Keep **3s head start** checked.
3. Press **Type text**.
4. Switch to the target app/window during the countdown.

The page sends acknowledged HID key states with a deliberate hold/release gap,
so the host sees real keystrokes. Only printable ASCII, newline, and tab are
supported. Emoji, smart quotes, IME text, and other non-ASCII characters are
rejected. The target host layout still applies.

**Live keyboard** streams physical key positions as they happen. It requires
Chrome to stay focused, so if Chrome and the USB host are the same computer,
injected keys can land back in the page and be captured again. Use a second
device for live capture, or use paste mode.

## Keyboard semantics

Live mode maps `KeyboardEvent.code` (physical key position) to USB HID usage
IDs. Paste mode maps printable ASCII to US-layout HID positions. The **target
host's** keyboard layout determines the resulting character:

- On a QWERTY host, the physical `A` key produces `a`.
- On an AZERTY host, the same physical position produces `q`.

That is the same behavior as plugging a QWERTY keyboard into an AZERTY machine.
Modifiers, arrows, function keys, navigation keys, numpad, and common editing
keys are mapped. Standalone media/consumer keys are not forwarded in this
version. Some OS/browser shortcuts (for example `Cmd+Tab`, `Ctrl+W`) cannot be
intercepted by a web page and are handled locally.

Caps Lock and Num Lock are forwarded as key presses; their LED state belongs to
the target host.

## Protocol

The browser sends one full keyboard state per GATT write:

```
byte 0     0xA5 magic
byte 1     HID modifier bits (bit 0 = left Ctrl, bit 7 = right GUI)
bytes 2-7  up to six HID keyboard usage IDs, zero-padded
byte 8     XOR of bytes 0..7
```

The Flipper diffs the new state against its current state and emits only the
necessary `furi_hal_hid_kb_press` / `furi_hal_hid_kb_release` calls. This makes
lost/duplicated key-up packets self-heal on the next state packet.

A second 9-byte packet type is used for the proprietary keepalive:

```
byte 0     0x48 'H'
byte 1     0x4B 'K'
byte 2     0x42 'B'
byte 3     protocol version (1)
byte 4     command (1 = PING)
bytes 5-6  16-bit session id, little-endian
byte 7     8-bit sequence
byte 8     XOR of bytes 0..7
```

The FAP answers with a status line on the serial TX characteristic:

```
HKB1 PONG <session-hex> <sequence> USB=<0|1>
```

The web page sends a PING on connect, requires a matching PONG before enabling
either input mode, and repeats it every two seconds. This verifies that the
connected serial profile belongs to the BLE Keyboard Bridge FAP, not another
Flipper app. Missing replies for seven seconds disable input and show a
“bridge not responding” state.

The BLE serial service uses Flipper's proprietary service/characteristics:

| Item | UUID |
| --- | --- |
| Service | `8fe5b3d5-2e7f-4a98-2a48-7acc60fe0000` |
| Browser → Flipper RX | `19ed82ae-ed21-4c9d-4145-228e62fe0000` |
| Flipper → browser TX | `19ed82ae-ed21-4c9d-4145-228e61fe0000` |
| Flow control | `19ed82ae-ed21-4c9d-4145-228e63fe0000` |

The serial flow-control window is 486 bytes. A 9-byte packet was chosen so the
window is exactly 54 packets; the web client tracks the flow-control
characteristic and waits for a reset when credit runs out.

The FAP re-registers its serial callback after every connection because the
firmware BT service installs its RPC callback on connect. It also disables RPC
mode so writes reach the app. This behavior is documented in the source and is
required with current firmware.

## FAP behavior

- Advertises the normal Flipper BLE serial profile. The device name comes from
  the Flipper settings, not the app name.
- Configures the USB interface as HID with product name
  `BLE Keyboard Bridge` (VID/PID `046D:C529`).
- Releases all keys on BLE disconnect, USB disconnect, app exit, or after five
  seconds without a state heartbeat while keys are held.
- Answers HKB1 PING packets and reports USB readiness on the serial TX
  characteristic.
- Only calls the BLE link “active” after a recent HKB1 ping. The screen shows
  `WAITING`, `LINK ONLY`, or `WEB OK`; a connection from the Flipper mobile app,
  OS Bluetooth, or another client shows `LINK ONLY` and cannot inject keys.
- Press **Back** to exit. Press **OK** to release all keys; if Bluetooth was off
  at launch, OK also retries starting the BLE profile.

## Testing done

- FAP compiles cleanly with ufbt against official SDK 1.5.1 / API 88.2.
- Web unit tests: `cd web && node --test hid.test.mjs` (12 tests, all passing),
  including ASCII→HID mapping and the HKB1 packet.
- JavaScript syntax checks for `web/app.js` and `web/hid.js`.
- End-to-end BLE + USB HID testing on physical hardware is still pending in
  this workspace; the local Flipper CDC port was busy at the time of
  packaging. The code follows the current firmware serial-profile API and the
  flow-control quirks used by working BLE→USB-HID FAPs.

## Troubleshooting

**The Flipper is not in the chooser**
: Use **Show all BLE devices** in the footer. Make sure Bluetooth is on, the FAP
  is running, and no other BLE client is connected. The advertised name is
  normally `Flipper <name>`.

**Connected but no typing**
: Check the Flipper screen for `USB READY`. Close qFlipper if USB mode switching
  is stuck. Click the capture pad so it has focus. Confirm the target host sees
  a new USB keyboard.

**Bridge not verified / not responding**
: The BLE serial profile connected, but the BLE Keyboard Bridge FAP did not
  answer the HKB1 handshake. Launch the FAP on the Flipper and reconnect. This
  can also happen if the Flipper mobile app or qFlipper is holding the BLE
  connection.

**Flipper says `LINK ONLY`**
: Some BLE central is connected, but it is not the web page (or the page is not
  sending pings). Close the Flipper mobile app/other Bluetooth clients, open the
  page, and connect there. The Flipper only shows `WEB OK` after the handshake.

**Wrong characters**
: The target host's layout is being applied. Paste mode sends US-layout ASCII
  key positions; live mode sends physical key positions. Switch the host layout
  or expect QWERTY-position output.

**Stuck keys**
: Press **Release all** or click outside the capture pad. The FAP also releases
  everything after five seconds without a heartbeat while keys are down.

**BLE connects but writes fail**
: Pairing/bonding was not completed. Remove the old pairing, relaunch the app,
  and confirm the PIN. The serial RX characteristic requires an authenticated
  link.

## Security

This is a remote keyboard injection tool. Anyone who can bond to the Flipper's
serial profile can type on the USB host. Only run it with devices you trust, and
remove the Flipper pairing when you are done. The web page itself does not send
data anywhere.

## Prior art / references

- [Chrome Web Bluetooth documentation](https://developer.chrome.com/docs/capabilities/bluetooth)
- Flipper firmware BLE serial profile/services (`ble_profile_serial`)
- The BLE serial callback/RPC workaround is the same behavior used by
  community BLE→USB-HID apps such as DuckerTheFlipper/TransTheFlip.
