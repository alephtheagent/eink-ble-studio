# BLE frame protocol v1

This is the retained legacy endpoint contract. New clients prefer [v2 capabilities, MTU-aware packets and PackBits](protocol-v2.md); v1 packet sizes remain unchanged even on a larger negotiated MTU.

## GATT

| Endpoint | UUID | Properties |
| --- | --- | --- |
| Service | `7b1e0001-6ba2-4f25-8ac7-1d54e91a1000` | Primary |
| Command | `7b1e0002-6ba2-4f25-8ac7-1d54e91a1000` | Write with response |
| Status | `7b1e0003-6ba2-4f25-8ac7-1d54e91a1000` | Read |

All integers little-endian. One complete command per GATT write, at most 20 bytes: no MTU negotiation required, ATT MTU 23 sufficient. Never use write-without-response. A completed ATT write confirms delivery, **not application acceptance**. Read status after every command and validate transfer ID, error, state and received offset. This firmware uses authoritative status reads, not notifications; no notification subscription or delivery assumption is needed. One central/transfer at a time.

Firmware authorization is synchronous on Bluefruit's BLE event task (`setWriteAuthorizeCallback(..., false)`), not the deferred AdaCallback queue. Status is published before the ATT response. S140 6.1.1 requires successful WRITE authorization to include `update=1`, the request offset, length and data pointer; accepting with an empty, zero-initialized reply violates that SDK contract. Firmware checks the authorization return code and status write length; a failure disconnects the uncertain connection rather than acknowledging progress. The protocol mutex is never held during SPI/display refresh. Lock acquisition in the write callback is bounded to 50 ms; failure rejects the ATT request without applying it.

## Frame

Native portrait width 122, height 250. Row-major, 16 bytes/row, exactly 4000 bytes. Pixel `(x,y)` is bit `7-(x%8)` in byte `16*y+floor(x/8)`. **1 = black**, 0 = white (Adafruit GFX drawBitmap polarity). Last byte of each row uses bits 7 and 6 only; low six bits must be zero. No image/file header, compression or red plane. Screen is cleared white before drawing the bitmap, including hidden controller columns.

CRC32: IEEE reflected polynomial `0xEDB88320`, initial `0xFFFFFFFF`, final XOR `0xFFFFFFFF`, over all 4000 bytes including padding. `123456789` → `0xCBF43926`. Shared executable vectors: `tests/vectors.json`; approved native reference and packed frame: `tests/fixtures/`.

## Commands

| Command | Bytes |
| --- | --- |
| START | `01 id:u32 length:u16 crc:u32` (11 bytes) |
| DATA | `02 id:u32 offset:u16 payload:1..13` (8–20 bytes) |
| COMMIT | `03 id:u32` (5 bytes) |
| ABORT | `04 id:u32` (5 bytes) |
| ENTER_DFU | `05` (1 byte) |
| RESET_WELCOME | `06` (1 byte) |

Transfer IDs distinguish commands within the connection; they are not authentication or durable identifiers. START length must be 4000. DATA offset must equal the next expected offset. Exact duplicate DATA wholly inside the acknowledged prefix is accepted only if all bytes match. Gaps, conflicting duplicates, partial overlaps and out-of-range fragments do not advance progress. Same START ID/length/CRC while receiving returns current offset without erasing data. Different START cannot replace a queued/refreshing frame. COMMIT is idempotent for the same queued/refreshing/completed transfer. ABORT cannot cancel an already committed display update.

COMMIT accepts only a complete frame with valid CRC and zero padding; otherwise the display is not touched. It queues the frame. Physical refresh executes in the main loop outside the BLE callback. Status distinguishes queued, refreshing and done. Generation increments after refresh completion; CRC acceptance alone is not display completion.
RESET_WELCOME and ENTER_DFU are accepted only when no frame is receiving, queued or refreshing. The status action byte is respectively 1 or 2 after acceptance. After publishing status and a successful ATT authorization reply, the firmware waits 1.5 seconds before acting; this gives the central time to read the status but is not proof that the radio delivered it. Other writes are rejected during that interval. RESET_WELCOME erases and verifies the state page while BLE continues; it does not reboot or redraw. After completion action returns to 0; error 11 reports erase failure. Reset the board to show welcome again. ENTER_DFU resets the device, so disconnect is expected. Failed status publication or ATT authorization does not execute the action.

The core's `enterOTADfu()` is used: pinned Adafruit core `cores/nRF5/wiring.c` defines `DFU_MAGIC_OTA_RESET` as `0xA8`, and disables the SoftDevice before writing GPREGRET and resetting. The Adafruit bootloader uses `0x57` for UF2/USB DFU and `0xA8` for OTA BLE DFU; the site's Nordic DFU client connects over BLE, so `0xA8` is required. The actual installed bootloader and its supported modes have not been verified on hardware.


## Status: fixed 20 bytes

| Offset | Field |
| --- | --- |
| 0 | version:u8 = 1 |
| 1 | state:u8 |
| 2 | error:u8 |
| 3 | action:u8 = 0 normally, 1 reset welcome, 2 enter DFU |
| 4 | transfer ID:u32 |
| 8 | received:u16 |
| 10 | total:u16 |
| 12 | expected CRC:u32 |
| 16 | completed generation:u32 |

States: 0 idle, 1 receiving, 2 queued, 3 refreshing, 4 done, 5 error.

Errors: 0 none, 1 malformed, 2 busy, 3 wrong ID, 4 offset/conflicting duplicate, 5 length, 6 CRC, 7 padding, 8 timeout, 9 disconnected, 10 codec stream, 11 state storage failure. Recoverable command errors retain the receiving buffer and offset. A subsequent valid command clears the command error. CRC/padding failure does not display the frame.

Receiving expires after 15 seconds without accepted activity. Disconnect discards incomplete reception; queued/refreshing updates complete independently. The client must reconnect and restart an interrupted transfer; it must not treat stale status as completion. Finite operation/refresh timeouts prevent endless waiting. A timed-out GATT operation leaves completion uncertain: disconnect rather than issue overlapping operations on the same connection. Explicit protocol rejection is distinct from transport failure; never blindly advance offset after either.

### Diagnostics (no wire-format change)

`web/ble.js` retains the 5 s GATT-operation timeout and 45 s refresh deadline. Errors name `request device`, `connect`, `discovery service`, `discovery command`, `discovery status`, `write START`, `write DATA offset N`, `write COMMIT`, `read ack <packet>`, `read status`, `refresh read status` or `refresh`. The user-controlled chooser has no GATT timer. Browser console logs the error and its cause; optional constructor callback `onDiagnostic({stage, event, error})` receives GATT-operation errors. Protocol error messages name the device error. `connect`, `send` and public `readStatus` reject concurrent entry. Disconnect cancels the active call; late results cannot install stale characteristics. Reconnection to the same device is refused while its previous native GATT promise remains pending; if the browser never settles it after disconnect, reload the page.

Firmware USB serial (115200) emits `BLE t=<millis> stage=N conn=N op=N offset=N len=N state=N error=N sdk=0xNNNNNNNN`. Stages: **1** authorization reply (START/COMMIT, protocol error or SDK failure); **2** status attribute write failed (SDK field still reports the authorization reply result); **3** ATT request rejected or mutex acquisition failed; **4** owner disconnect; **5** receiver timeout/refresh state transition; **6** display driver returned, protocol DONE. State/error numbers are the tables above; 255 means no safe locked snapshot was available. The 16-record nonblocking queue is drained in `loop`; bursts during display refresh can drop diagnostic records. Logging never waits for a USB host in the BLE callback. `sdk=0` means the API accepted the reply, not proof of physical display output.

For a failed physical attempt report the full browser error/console cause, last progress offset, firmware BLE lines and any GxEPD2 `Busy Timeout!` output. A `write` timeout and `read ack` timeout are different observations; neither establishes a radio, power, OS or panel fault by itself.

## Animation

Looping stored animations use a separate service `7b1e0010-6ba2-4f25-8ac7-1d54e91a1000`
(command `0011`, status `0012`, data `0013`) and the flash region `0xB0000..0xCC000`;
the application image must end below `0xB0000`. The complete contract, including the
codec, storage layout and compatibility rules, is
[protocol-animation.md](protocol-animation.md). Playback never rejects legacy v1/v2,
pages or DFU commands: those commands stop playback and take the panel.

## Security and persistence

No application authentication, BLE pairing requirement, encryption requirement or signing is implemented. A nearby BLE client can discover this service and replace the screen. CRC detects corruption, **not malicious modification**. Do not advertise this as a secure/private display protocol. Web Bluetooth's chooser controls the browser's access only; it does not authenticate a central to the board. Disconnect/timeout and strict bounds reduce correctness risks, not RF denial of service.

The legacy v1/v2 single-frame transfer does not save the received frame to flash. The separate [pages protocol](protocol-pages.md) stores pages in the reserved region `0xCC000..0xEC000`, and the [animation protocol](protocol-animation.md) stores looping frame sequences in `0xB0000..0xCC000`; both use copy-on-write with recovery, and the application image must end below `0xB0000`. See the complete [storage map](storage.md). Back up pages and animations before UF2 or OTA updates: retention by the installed bootloader is not established. Animation playback never rejects legacy v1/v2, pages or DFU commands; those commands stop playback and take the panel.

The approved welcome is drawn and the panel hibernated before advertising only when the 4 KiB state page at `0xEC000` is erased, corrupt, or has a different firmware build ID. A valid magic/build-ID/CRC record skips SPI and panel initialization entirely; uploaded images remain physically visible across resets. Each PlatformIO build invocation generates a fresh 32-bit build ID, including incremental builds (a random collision is possible). Record erase/write is checked; failure is logged and welcome is retried on the next boot. A frame transfer initializes the panel, refreshes it and hibernates it. A reset during refresh may leave an incomplete image. UICR NFC configuration is separate. DONE means the display driver returned, not optical verification.
