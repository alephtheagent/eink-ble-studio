# BLE frame protocol v2

V1 remains available unchanged at command `7b1e0002-6ba2-4f25-8ac7-1d54e91a1000` and status `…0003…`; see [protocol.md](protocol.md). The shared service is `7b1e0001-6ba2-4f25-8ac7-1d54e91a1000`.
Persistent multi-page synchronization uses separate endpoints and does not change this protocol; see [pages protocol](protocol-pages.md) and [storage map](storage.md). Back up pages before firmware updates because update retention is not verified.

| Endpoint | UUID suffix | Properties / maximum value |
| --- | --- | --- |
| Command2 | `0004` | WRITE with response, variable 244 bytes |
| Status2 | `0005` | READ, fixed 20 bytes |
| Capabilities | `0006` | READ authorized synchronously, fixed 20 bytes |

Suffix replaces the four final digits of the first UUID group, not the final UUID group. All integers below are little-endian. One command per ordinary ATT Write Request, ATT offset zero. Neither write-without-response nor PREP/EXEC long writes are supported.

## MTU and capabilities

Firmware configures a peripheral MTU ceiling of 247 before `Bluefruit.begin()`, retaining the default event length and queue sizes. Negotiation is performed by the BLE stack/central, not JavaScript. No exchange means MTU23. Command2 maxlen244 does not imply any particular negotiated MTU.

Every capabilities READ computes `safeWrite = min(connection.getMtu() - 3, 244)`; missing/disconnected/invalid connection falls back to20. Capabilities bytes:

| Offset | Field |
| --- | --- |
| 0 | ASCII `EBL2` (4 bytes) |
| 4 | major2, minor0 (two u8) |
| 6 | codec mask3, flags1 (two u8; flag1 means status-read stop-and-wait ACK) |
| 8 | safeWrite:u16, range20..244 |
| 10 | decodedMax:u16=4000 |
| 12 | encodedMax:u16=4000 |
| 14 | idleTimeoutMs:u16=15000 |
| 16 | reserved:u32=0 |

Client rereads capabilities at every transfer and fixes its ceiling for that transfer. `force20: true` limits writes to20 even if the server reports more. After a failed enlarged write, disconnect and restart with a new ID and force20; never resize an uncertain outstanding packet. Reconnect waits for prior native operations to settle. No automatic retry loop or overlapping GATT operations in v2.

Web Bluetooth has no standard MTU getter/setter. Its [write algorithm](https://webbluetoothcg.github.io/web-bluetooth/#dom-bluetoothremotegattcharacteristic-writevaluewithresponse) rejects values over512, but this is not an atomic-write guarantee. Its [connection procedure](https://webbluetoothcg.github.io/web-bluetooth/#dom-bluetoothremotegattserver-connect) attempts MTU exchange and permits failure. Server-reported write ceiling is not measured throughput, PHY or LL Data Length.

## Commands and stream

| Command | Wire layout |
| --- | --- |
| START2 | `11 id:u32 codec:u8 decodedLen:u16 encodedLen:u16 crc32:u32` (14 bytes) |
| DATA2 | `12 id:u32 encodedOffset:u16 payload` (8..safeWrite bytes) |
| COMMIT2 | `13 id:u32` (5 bytes) |
| ABORT2 | `14 id:u32` (5 bytes) |
| RESET_WELCOME2 | `15` (1 byte) |
| ENTER_DFU2 | `16` (1 byte) |

Decoded length is strictly4000; encoded length1..4000. Codec0 is raw (encoded length must4000); codec1 is PackBits subset. Encoder selects PackBits only if strictly shorter than4000; otherwise raw. Last DATA is not padded.

PackBits controls0..127 copy the following control+1 literal bytes;129..255 repeat the next byte257−control times. Control128/NOP is forbidden. Encoder starts repeats at3; decoder also accepts run2. Tokens may span DATA boundaries. Decode streams into one4000-byte receiver frame; it never stores a second encoded4000-byte frame. Every output is bounded. Malformed stream invalidates the whole transfer; it cannot resume.

START with identical metadata while receiving returns the current offset. Different START while receiving/queued/refreshing is BUSY. One dialect and connection own the shared receiver; the other dialect/connection cannot replace its frame. V1 keeps raw-prefix duplicate handling. V2 accepts only an exact repeat of the last complete DATA packet (up to244 bytes retained), without decoding twice. Gap, overlap, wrong ID, conflicting/older duplicate and length errors do not advance accepted offset.

COMMIT requires all declared input, exactly4000 produced bytes, no pending literal/repeat, CRC32 IEEE over decoded4000 bytes and zero low6 row-padding bits. Only then QUEUED. Incomplete or corrupt frames never reach the display driver. Repeated COMMIT for the same owner/id is idempotent in queued/refreshing/done. ABORT cannot cancel committed refresh. Disconnect/15s inactivity invalidates receiving; committed refresh completes independently in loop. DONE/generation means driver returned, not an optical check or proof of healthy panel wiring.

## Status and ACK

Status2 is20 bytes: `version:u8=2 state:u8 error:u8 codecOrAction:u8 id:u32 receivedEncoded:u16 totalEncoded:u16 expectedRawCRC:u32 generation:u32`. Byte 3 is the codec for frame transfers; after an accepted RESET_WELCOME2 or ENTER_DFU2 it is the pending action (1 or 2), until that action is consumed. See [v1 action semantics](protocol.md#commands). States0 idle,1 receiving,2 queued,3 refreshing,4 done,5 error. Errors0 none,1 malformed,2 busy,3 ID,4 offset/conflict,5 length,6 CRC,7 padding,8 timeout,9 disconnected,10 codec stream,11 state storage failure. Idle transfer fields are zero; generation is shared. Error preserves ID/last accepted offset.

After every write, client reads status2 and checks version, ID, codec, total, CRC, error, expected state and **exact next encoded offset**. ATT success alone is not acceptance. Status is published under the protocol mutex before authorize reply; successful S140 WRITE reply still uses `update=1`, offset, length and data. The existing authorize fix is not replaced by MTU tuning.

## Core-layer long-write policy

Pinned Bluefruit intercepts PREP before the application authorizer and normally allocates1024 bytes. The project build middleware compiles private patched copies of `BLECharacteristic.cpp` and `BLEGatt.cpp` under the project scratch build directory; the shared installed core is not edited. Characteristic dispatch rejects non-WRITE_REQ before that allocator. GATT dispatch rejects handle-less EXEC NOW/CANCEL once, before broadcasting to characteristics. No ordinary write callback is registered as an alternate parser. Build fails if expected pinned source anchors change. These guards are necessary: the application opcode guard alone cannot prove PREP rejection.

## Client integration and compatibility

To integrate into another editor, copy `web/ble.js`, `web/image.js`, `web/i18n.js`, and `web/locales/en.js` plus `web/locales/ru.js`, preserving their relative paths and ES module imports. `image.js` supplies `FRAME_BYTES=4000` and `crc32(Uint8Array)`; `i18n.js` and the two catalogs supply localized transport errors. Preserve the secure-context/user-gesture connection flow. Existing `new BleTransport({onProgress,onStatus,onDiagnostic})`, `connect()`, `send(frame)`, `readStatus()`, `disconnect()` remain available. `onProgress(offset,total)` counts encoded bytes in v2, raw bytes in v1. Status version and codec distinguish dialects. Diagnostic `{stage:'transfer',event:'info',codec,rawBytes,wireBytes,serverCeiling,writeCeiling}` supplies honest transfer metadata to UI. No changes to the other editor are made by this project.

New web chooses v1 only when capabilities discovery reports `NotFoundError`. Discovery transport errors, malformed/unknown capabilities or a partial v2 service fail explicitly; they do not silently fall back. Old web/new firmware uses original v1 endpoints. New web cannot repair the old firmware's WRITE authorization defect. No authentication/pairing/encryption is added; CRC detects corruption, not hostile access. Boot welcome is the exact approved asset, drawn before advertising only for a new build or invalid/reset state; see [persistence](protocol.md#security-and-persistence).
