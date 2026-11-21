# BLE frame protocol v1

## GATT

| Endpoint | UUID | Properties |
| --- | --- | --- |
| Service | `7b1e0001-6ba2-4f25-8ac7-1d54e91a1000` | Primary |
| Command | `7b1e0002-6ba2-4f25-8ac7-1d54e91a1000` | Write with response |
| Status | `7b1e0003-6ba2-4f25-8ac7-1d54e91a1000` | Read |

All integers little-endian. One complete command per GATT write, at most 20 bytes: no MTU negotiation required, ATT MTU 23 sufficient. Never use write-without-response. A completed ATT write confirms delivery, **not application acceptance**. Read status after every command and validate transfer ID, error, state and received offset. This firmware uses authoritative status reads, not notifications; no notification subscription or delivery assumption is needed. One central/transfer at a time.

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

Transfer IDs distinguish commands within the connection; they are not authentication or durable identifiers. START length must be 4000. DATA offset must equal the next expected offset. Exact duplicate DATA wholly inside the acknowledged prefix is accepted only if all bytes match. Gaps, conflicting duplicates, partial overlaps and out-of-range fragments do not advance progress. Same START ID/length/CRC while receiving returns current offset without erasing data. Different START cannot replace a queued/refreshing frame. COMMIT is idempotent for the same queued/refreshing/completed transfer. ABORT cannot cancel an already committed display update.

COMMIT accepts only a complete frame with valid CRC and zero padding; otherwise the display is not touched. It queues the frame. Physical refresh executes in the main loop outside the BLE callback. Status distinguishes queued, refreshing and done. Generation increments after refresh completion; CRC acceptance alone is not display completion.

## Status: fixed 20 bytes

| Offset | Field |
| --- | --- |
| 0 | version:u8 = 1 |
| 1 | state:u8 |
| 2 | error:u8 |
| 3 | reserved:u8 = 0 |
| 4 | transfer ID:u32 |
| 8 | received:u16 |
| 10 | total:u16 |
| 12 | expected CRC:u32 |
| 16 | completed generation:u32 |

States: 0 idle, 1 receiving, 2 queued, 3 refreshing, 4 done, 5 error.

Errors: 0 none, 1 malformed, 2 busy, 3 wrong ID, 4 offset/conflicting duplicate, 5 length, 6 CRC, 7 padding, 8 timeout, 9 disconnected. Recoverable command errors retain the receiving buffer and offset. A subsequent valid command clears the command error. CRC/padding failure does not display the frame.

Receiving expires after 15 seconds without accepted activity. Disconnect discards incomplete reception; queued/refreshing updates complete independently. The client must reconnect and restart an interrupted transfer; it must not treat stale status as completion. Finite operation/refresh timeouts prevent endless waiting. A timed-out GATT operation leaves completion uncertain: disconnect rather than issue overlapping operations on the same connection. Explicit protocol rejection is distinct from transport failure; never blindly advance offset after either.

## Security and persistence

No application authentication, BLE pairing requirement, encryption requirement or signing is implemented. A nearby BLE client can discover this service and replace the screen. CRC detects corruption, **not malicious modification**. Do not advertise this as a secure/private display protocol. Web Bluetooth's chooser controls the browser's access only; it does not authenticate a central to the board. Disconnect/timeout and strict bounds reduce correctness risks, not RF denial of service.

No received image is written to flash. E-ink retains the last physical image while powered down; the firmware does **not** promise recovery of the bitmap after reset. A reset during physical refresh can leave an incomplete screen. UICR NFC configuration is a separate core-level hardware setting, not frame persistence.
