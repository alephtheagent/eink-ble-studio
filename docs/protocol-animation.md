# BLE animation protocol v1

Stored, looping frame animations for the 122×250 panel. This document is the
normative contract: the firmware (`firmware/include/anim_codec.h`, `anim_wire.h`,
`anim_storage.h`, `anim_player.h`) and the site (`web/anim-codec.js`, `web/anim.js`,
`web/anim-gif.js`) implement against it, and the shared vectors in
`tests/vectors-animation.json` pin the bytes. The legacy [v1](protocol.md) and
[v2](protocol-v2.md) frame endpoints, the [pages protocol](protocol-pages.md), DFU
and welcome handling are unchanged and remain fully available.

Animations live in their own flash reservation (`0xB0000..0xCC000`), so they
survive reset and do not disturb pages. See the [storage map](storage.md).

## GATT

| Endpoint | UUID | Properties / limit |
| --- | --- | --- |
| Service | `7b1e0010-6ba2-4f25-8ac7-1d54e91a1000` | Primary |
| Command | `7b1e0011-6ba2-4f25-8ac7-1d54e91a1000` | WRITE with response, maxLen 244 |
| Status | `7b1e0012-6ba2-4f25-8ac7-1d54e91a1000` | READ, fixed 20 bytes |
| Data | `7b1e0013-6ba2-4f25-8ac7-1d54e91a1000` | READ, maxLen 20 bytes |

All integers are little-endian. One GATT operation at a time; no write-without-response,
no PREP/EXEC long writes, no notifications. Minimum ATT MTU 23 is supported.

Every command is a single write. `safeWrite = min(negotiated MTU − 3, 244)`, so a
DATA payload is `1..safeWrite−3` bytes (at MTU 23 that is 1..17). The command
characteristic accepts up to 244 bytes regardless of the negotiated MTU; a larger
value is malformed.

**A successful ATT write means the bytes were delivered, not that the command was
accepted.** After every write, read Status and check `op`, `error`, `flags` and the
command-specific acknowledgement described below. If `flags` bit 0 (pending) is set,
no new command is accepted (error 2) until it clears: poll Status until then. This
is the same status-polling discipline as the pages protocol; there are no
notifications.

## Status: fixed 20 bytes

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | `version` = 1 |
| 1 | 1 | `op`: opcode of the last command |
| 2 | 1 | `error`: error table value |
| 3 | 1 | `flags`: bit 0 pending, bit 1 playing, all other bits 0 |
| 4 | 4 | `revision` u32: durable metadata generation |
| 8 | 2 | `count` u16: durable frame count |
| 10 | 2 | `index` u16: see below |
| 12 | 4 | `dataBytes` u32: see below |
| 16 | 4 | `animCrc` u32: see below |

`index` per command: INFO = the playing frame index, or `0xFFFF` when not playing
(including right after a STOP or DELETE restore, when `flags` bit 1 is clear);
FRAME = the frame index of that command; DATA = the next expected encoded offset of
the current frame; READ = the requested frame index; otherwise 0.

`dataBytes` per command: INFO = encoded bytes used in the active data bank (the sum
of `8 + encLen` over all stored frames); READ = the `blobLen` of the requested frame;
otherwise 0.

`animCrc` per command: INFO = the durable animation CRC; otherwise 0.

`revision` is the durable metadata generation. It advances by exactly 1 for each
durable metadata write — a successful COMMIT or DELETE, and nothing else — and is
reported in every status. It is 0 when no animation is stored.

## Errors

| Value | Name | Meaning |
| --- | --- | --- |
| 0 | OK | accepted |
| 1 | malformed | bad length, unknown opcode, reserved field or flag bit set, out-of-range field |
| 2 | busy | another operation owns the state; retry after pending clears |
| 3 | not found | no such frame, or no animation to play |
| 4 | conflict | revision mismatch, wrong upload phase, missing prerequisite frame |
| 5 | full | data bank or frame/entry capacity exhausted |
| 6 | CRC | frame CRC or animation CRC mismatch |
| 7 | storage | flash erase/program/verify failure |
| 8 | offset | DATA or READ offset is not the expected one |
| 9 | padding | decoded frame has non-zero low six bits in a row's last byte |
| 10 | codec stream | PackBits stream is invalid or does not produce exactly 4000 bytes |
| 11 | range/limit | index, delay, encLen, payload or bank bound violated |

Errors 0..9 keep the numeric values used by the pages protocol so one client table
serves both. A failed command never alters the durable animation and never changes
`revision`. The wire table ends at 11: the firmware also defines a player-only result
code 12 internally ("a COMMIT replaced the animation under playback"), which is never
placed in a status byte and must never be interpreted by a client.

## Commands

| Opcode | Name | Length |
| --- | --- | --- |
| `01` | INFO | 1 |
| `02` | BEGIN | 13 |
| `03` | FRAME | 13 |
| `04` | DATA | 3 + payload |
| `05` | FRAME_COMMIT | 1 |
| `06` | COMMIT | 1 |
| `07` | PLAY | 3 |
| `08` | STOP | 1 |
| `09` | DELETE | 5 |
| `0A` | READ | 5 |
| `0C` | ABORT | 1 |

Opcode `0B` and every opcode above `0C` are malformed (1).

### 01 INFO (1 byte)

| Off | Field |
| --- | --- |
| 0 | `01` |

Reports durable state without mutating anything: `count`, `revision`, `dataBytes`,
`animCrc`, `index` (playing index or `0xFFFF`), `flags` bit 1 for playback. With no
stored animation: `count` 0, `revision` 0, `dataBytes` 0, `animCrc` 0, `index`
`0xFFFF`, `error` 0. INFO is accepted during an upload and during playback.

### 02 BEGIN (13 bytes)

| Off | Size | Field |
| --- | --- | --- |
| 0 | 1 | `02` |
| 1 | 4 | `expectedRev` u32 |
| 5 | 2 | `count` u16, 1..64 |
| 7 | 2 | `flags` u16, bit 0 = loop |
| 9 | 4 | `crc` u32 |

`expectedRev` must equal the current durable `revision`, else error 4 (conflict).
`count` outside 1..64, or any `flags` bit other than bit 0 set, is error 1. `crc` is
the animation CRC of the frames that will be uploaded (see [Codec](#codec)).

BEGIN opens an upload into the inactive metadata/data bank pair, erases that data
bank and records `expectedRev`, `count`, `flags` and `crc` in RAM. It does not touch
the active animation. The result is `error` 0, `index` 0 (the next index that must be
committed), `dataBytes` 0.

BEGIN is idempotent only for an identical repeat (same `expectedRev`, `count`,
`flags`, `crc`) while an upload is open; that returns the current `index` and
`error` 0 without erasing. A different BEGIN while an upload is open is error 2.
BEGIN while a frame is open is error 2 unless it is identical.

### 03 FRAME (13 bytes)

| Off | Size | Field |
| --- | --- | --- |
| 0 | 1 | `03` |
| 1 | 2 | `index` u16 |
| 3 | 1 | `kind` u8: 0 full, 1 delta |
| 4 | 1 | `reserved` u8 = 0 |
| 5 | 2 | `encLen` u16: payload length, excluding the 8-byte blob header |
| 7 | 4 | `crc` u32: CRC32 of the 4000 decoded bytes |
| 11 | 2 | `delayMs` u16, 100..60000 inclusive |

`reserved` must be 0. `kind` 0 requires `encLen == 4000`; `kind` 1 requires
`1 <= encLen <= 4000`. `delayMs` outside 100..60000 is error 11; `index` outside
0..count−1 is error 11; `reserved != 0`, `kind > 1` or a wrong `encLen` range is
error 1.

Frames must be committed in ascending order: the frame at `index` may only be
started when indices `0..index−1` are already committed in this upload, and index 0
must be kind 0 (a delta has nothing to reference). Violating that is error 4. The
one exception is the most recently committed index: it may be re-uploaded (for
example after a lost FRAME_COMMIT response), and its previous blob is discarded;
any earlier index requires ABORT and a new BEGIN. This keeps the delta chain
consistent and still makes the last-frame retry cheap.

A FRAME starts (or restarts) that frame's encoded stream at offset 0. Result:
`error` 0, `index` = the frame index, `dataBytes` 0. While a frame is open, only
DATA, FRAME_COMMIT, ABORT, INFO, READ, PLAY and STOP are accepted; BEGIN with
different parameters, FRAME for a different index and DELETE are error 2. A FRAME
identical to the open frame is idempotent: `error` 0 and the received offset is
preserved.

### 04 DATA (3 + payload bytes)

| Off | Size | Field |
| --- | --- | --- |
| 0 | 1 | `04` |
| 1 | 2 | `offset` u16 |
| 3 | n | payload, 1..safeWrite−3 bytes |

`offset` addresses the **payload only**: it runs 0..`encLen` and never includes the
8-byte blob header. The first DATA of a frame uses offset 0; the header is not sent
on DATA because FRAME already carries `kind`, `reserved`, `encLen` and `crc`, and the
device synthesizes the stored header at FRAME_COMMIT. (READ, by contrast, streams the
whole stored blob — see [0A READ](#0a-read-5-bytes).)

`offset` must equal the next expected payload offset of the current frame. Anything
else is error 8, with `index` reporting the expected offset. `offset + n > encLen`
is error 11. DATA without an open frame is error 4.

Bytes are opaque: kind-0 payload is the raw frame, kind-1 payload is PackBits. They
are not decoded until FRAME_COMMIT, so a partially received frame is never
half-decoded and a malformed stream cannot strand the receiver. On success `error`
0 and `index` = the exact next expected offset.

### 05 FRAME_COMMIT (1 byte)

| Off | Field |
| --- | --- |
| 0 | `05` |

Requires an open frame with all `encLen` bytes received; otherwise error 4 (and
`index` reports the expected offset). The device decodes the payload (kind 1 XORs
the previously committed decoded frame), checks that exactly 4000 bytes were
produced, verifies the frame CRC from the FRAME header, verifies the six low
padding bits of each row's last byte, then appends the blob to the inactive data
bank. Failure maps to: codec stream 10, CRC 6, padding 9, storage 7, bank full 5.
Success is reported as `error` 0 with `index` = the next index that must be
committed (`0xFFFF` when all `count` frames are committed).

This is a durable metadata-free write: the blob bytes land in the inactive data
bank, but the animation is not durable until COMMIT. FRAME_COMMIT may be pending
(`flags` bit 0) while flash is programmed; the final `error` is only meaningful
once pending clears.

### 06 COMMIT (1 byte)

| Off | Field |
| --- | --- |
| 0 | `06` |

Requires no open frame, every index `0..count−1` committed at least once, and the
animation CRC over the committed decoded frames equal to the BEGIN `crc`; otherwise
error 4 (missing frame), 6 (CRC) or 2 (frame still open). On success the device
writes the alternate metadata bank and programs its tail last, making the new
animation durable, and reports the new `revision`, `count`, `dataBytes`, `animCrc`.
Pending while the metadata write runs.

A lost COMMIT response is recoverable: reconnect, read INFO and compare `revision`
and `animCrc` against the intended result. A COMMIT for an animation that is already
the durable one is idempotent (error 0, same revision) — the client must not retry a
COMMIT whose outcome it cannot determine without reading INFO first.

### 07 PLAY (3 bytes)

| Off | Size | Field |
| --- | --- | --- |
| 0 | 1 | `07` |
| 1 | 2 | `start` u16 |

Starts playback at `start`, stopping any playback already in progress. `start` >=
durable `count` is error 11. With no stored animation (or `count` 0) it is error 3.
PLAY is accepted during an upload (the upload is unaffected; the *previously
durable* animation plays until COMMIT). Result: `error` 0, `index` = the index
actually used and `flags` bit 1 set. Playback itself runs in the main loop;
acceptance is not an optical confirmation.

**RESUME, `start == 0xFFFF`.** This value is not an index: it asks the device to
continue where the animation was last left. The device uses the last saved playback
position when that position belongs to the currently durable animation, and frame 0
otherwise — including when no position was ever saved, when the record belongs to a
superseded metadata generation, when its CRC fails, or when the stored index is no
longer inside `count`. The ack `index` is always the position actually used, so a
client never needs to know whether a record existed: it reads `index` and that is
what plays. `0xFFFF` is never error 11 even though it is >= `count` — it either resumes
or, with no stored animation at all, returns error 3 like any other PLAY; every other
`start` value keeps the exact behaviour above. This is additive inside opcode `07`:
no field, length or status bit changed, and a client that never sends `0xFFFF` sees
byte-identical responses to before.

### 08 STOP (1 byte)

| Off | Field |
| --- | --- |
| 0 | `08` |

Stops playback after the frame currently being refreshed completes and then
**returns the panel to static content**. Idempotent: error 0 when nothing is playing.
Accepted during an upload and during READ.

The restore is best effort and runs in the main loop, one frame deep, so it never
blocks BLE. Its documented order is:

1. if the page collection is non-empty and the first stored page can be read, that
   page's exact 4000 bytes are drawn with a full refresh (`RESTORE_PAGE`);
2. if the collection is empty, the panel is cleared white (`RESTORE_EMPTY`);
3. if the collection is non-empty but the read fails, the panel is cleared white
   (`RESTORE_FAILED`) and one diagnostic line per boot is emitted.

The restore is skipped rather than drawing the wrong picture when another owner
already holds the panel — a pending pages operation, an active display copy, or a
legacy receiver that is receiving, queued or refreshing — because that owner draws its
own content. It is also skipped if the player's scratch buffer is unavailable; that is
a defensive guard, since playback is stopped before the restore runs, so a third
4000-byte buffer is never allocated. A **one-shot** animation that reaches its last
frame is *not* routed through STOP: it keeps its last frame on the panel and simply
hibernates.

Preemption by a legacy v1/v2 frame COMMIT, a pages SHOW, ENTER_DFU or RESET_WELCOME
is unchanged: those paths stop playback, and each draws its own content instead of
using the restore above.

### 09 DELETE (5 bytes)

| Off | Size | Field |
| --- | --- | --- |
| 0 | 1 | `09` |
| 1 | 4 | `expectedRev` u32 |

Deletes the stored animation. `expectedRev` must equal the current durable
`revision` (error 4 otherwise); error 2 while an upload or a frame is open. On
success playback stops and the panel returns to static content through the same
restore as STOP (first stored page, else cleared white), the alternate metadata bank
is written with `frameCount` 0 and its tail programmed last, `revision` advances by 1,
and INFO reports `count` 0.
The data banks are not erased by DELETE; the next BEGIN erases the inactive one.
Pending while the metadata write runs. Deleting when nothing is stored is error 4
unless `expectedRev` is 0, in which case it is an idempotent no-op with `error` 0.

### 0A READ (5 bytes)

| Off | Size | Field |
| --- | --- | --- |
| 0 | 1 | `0A` |
| 1 | 2 | `index` u16 |
| 3 | 2 | `offset` u16 |

Streams the **stored blob bytes** — the 8-byte header and the payload, i.e.
`blobLen = 8 + encLen` bytes — through the Data characteristic. `index` >= durable
`count` is error 3; `offset > blobLen` is error 8. On success `error` 0, `index` =
the requested index, `dataBytes` = `blobLen`.

The following Data read returns `offset:u16` followed by up to 18 blob bytes
(20 bytes total, `offset` first). When `offset == blobLen` it returns only the
2-byte offset, which is EOF. A read selects the shared Data characteristic, so it
must be completed before the next command. READ is accepted during playback and
during an upload (it always reads the durable animation).

### 0C ABORT (1 byte)

| Off | Field |
| --- | --- |
| 0 | `0C` |

Discards the open upload: the open frame, the staged blobs and the upload state are
forgotten. The active animation and `revision` are untouched. Idempotent (error 0
when nothing is open). ABORT does not stop playback.

## Upload state machine

```
IDLE ──BEGIN──▶ UPLOADING ──FRAME──▶ FRAME_OPEN ──DATA*──▶ FRAME_OPEN
                     ▲                    │
                     └──FRAME_COMMIT──────┘   (index advances; repeat for each frame)
UPLOADING ──COMMIT──▶ IDLE (durable, revision+1)
any upload state ──ABORT──▶ IDLE
IDLE ──PLAY──▶ PLAYING ──STOP──▶ IDLE        (PLAY restarts at any index or resumes)
IDLE/UPLOADING/PLAYING ──READ──▶ (unchanged state, Data characteristic selected)
IDLE ──DELETE──▶ IDLE (durable, revision+1)
```

Rules that follow from the state machine:

- Exactly one upload at a time, owned by the connection that issued BEGIN. Other
  connections' commands are error 2 until it ends or that connection disconnects.
- While `flags` bit 0 is set the state is frozen; every command is error 2.
- A disconnect or 15 s without accepted upload activity discards the open upload
  (`revision` unchanged, active animation intact). A metadata write that was already
  pending completes durably.
- Playback is independent of the connection and of any upload.
- STOP and DELETE both leave the PLAYING state and restore static content via the
  full refresh described under [STOP](#08-stop-1-byte). A one-shot animation reaching
  its last frame leaves PLAYING without a restore, keeping that frame visible.
- The playback position saved for RESUME belongs to the current metadata generation;
  the next COMMIT or DELETE invalidates it, so RESUME after a new upload starts at
  frame 0 unless a record was written for the new generation.

## Pending, polling and acknowledgement

For every command: write, then read Status. Accept only when `op` equals the opcode
just sent, `error` is 0 and the command-specific fields match:

| Command | Acknowledgement to verify |
| --- | --- |
| INFO | `count`, `revision`, `dataBytes`, `animCrc` |
| BEGIN | `index` 0 (or the current next index for an identical repeat) |
| FRAME | `index` = frame index |
| DATA | `index` = exact next encoded offset (`offset + payloadLen`) |
| FRAME_COMMIT | `index` = next index to commit, or `0xFFFF` |
| COMMIT | `revision` advanced by exactly 1, `count`/`animCrc` as intended |
| PLAY | `flags` bit 1 set, `index` = the start that was actually used (`start`, or the resumed position for `0xFFFF`) |
| STOP | `flags` bit 1 clear; the panel is back on static content |
| DELETE | `revision` advanced by exactly 1, `count` 0 |
| READ | `dataBytes` = `blobLen`, then the Data read's returned offset |
| ABORT | `error` 0 |

While pending, poll Status (a 30 s deadline, matching the pages client, is
recommended). A timed-out GATT operation leaves the outcome uncertain: disconnect
rather than issue overlapping operations, then re-read INFO. Never advance an offset
or a revision from an assumption.

## Storage, copy-on-write and interruption

Reservation: `0xB0000..0xCC000` (exclusive end), `0x1C000` = 114688 bytes = 28
erase sectors of 4096.

| Range | Use |
| --- | --- |
| `0xB0000..0xB1000` | metadata bank A |
| `0xB1000..0xB2000` | metadata bank B |
| `0xB2000..0xBF000` | data bank A, 13 sectors = 53248 bytes |
| `0xBF000..0xCC000` | data bank B, 13 sectors = 53248 bytes |

Metadata bank A describes data bank A; metadata bank B describes data bank B. The
newest valid metadata bank is active and its paired data bank holds the animation.
Each data bank is `0xD000` = 53248 bytes; `0x1A000` = 106496 is both banks together
and is never a per-bank bound. Every blob, and the sum of all blobs, must fit one
`0xD000` bank.

An upload always targets the **inactive pair**: BEGIN erases that data bank, blobs
are appended there at ascending 4-byte-aligned offsets, and COMMIT writes that
metadata bank. The active animation's bytes are never erased or overwritten during
an upload.

Metadata bank layout (sector-local, all integers little-endian):

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 4 | `magic` u32 = `0x414E494D`; stored little-endian the flash bytes are `4D 49 4E 41`, i.e. `ANIM` reversed, following the same reversed-ASCII convention as the pages magic `0x50414745` |
| 4 | 1 | `version` = 1 |
| 5 | 1 | `reserved` = 0 |
| 6 | 2 | `frameCount` u16, 0..64 |
| 8 | 2 | `flags` u16, bit 0 loop, other bits 0 |
| 10 | 4 | `dataBytes` u32 = sum of `8 + encLen` over all entries |
| 14 | 4 | `animationCrc` u32 |
| 18 | 4 | `generation` u32 = the wire `revision` |
| 22 | 16·n | frame entries, `n = frameCount` |
| 22+16·n | 4 | `crc` u32 over bytes `[0, 22+16·n)` |
| 26+16·n | 4 | `marker` u32 = `0x434F4D54`; stored little-endian the flash bytes are `54 4D 4F 43`, i.e. `COMT` reversed, matching `page_storage.h` |

Frame entry, 16 bytes:

| Offset | Size | Field |
| --- | --- | --- |
| +0 | 4 | `offset` u32: byte offset of the blob in the paired data bank |
| +4 | 2 | `encLen` u16 |
| +6 | 1 | `kind` u8 |
| +7 | 1 | `reserved` = 0 |
| +8 | 4 | `crc` u32: decoded-frame CRC32 |
| +12 | 2 | `delayMs` u16 |
| +14 | 2 | `pad` u16 = 0 |

The used prefix is `30 + 16·n` bytes, at most 1054 for 64 frames, so a metadata
sector is never full. Unused bytes stay erased (0xFF). Both `crc` (at `22+16·n`) and
`marker` (at `26+16·n`) are generally not word-aligned. The final program is the
word-aligned tail write that covers the trailing bytes of the metadata CRC and the
marker; the bank becomes valid only when that last write lands. A standalone 4-byte
marker write at `26+16·n` is neither required nor possible on a word-programmed
flash interface — the guarantee is the same: the bank fails validation until the
last write is present.

A metadata bank is valid only if: `magic`, `version` 1, `reserved` 0, unknown flag
bits 0, `frameCount` 0..64, `generation` matching its stored `crc`, the `crc`
matching bytes `[0, 22+16·n)`, the marker present, every entry with `kind` 0/1,
`encLen` in range for its kind, `delayMs` 100..60000, `offset` 4-byte aligned with
`offset + 8 + encLen <= 0xD000`, entries non-overlapping, `dataBytes` equal to the
sum, and every referenced blob's stored header agreeing with its entry and its
payload decoding to the entry `crc`. Recovery selects the valid bank with the larger
`generation`; a tie or two invalid banks means "no animation".

Interruption outcomes (the device must behave this way; the host tests model it):

| Interrupted at | Result |
| --- | --- |
| BEGIN erase, any DATA, any FRAME_COMMIT | old animation intact; the half-written inactive bank is invalid and ignored |
| metadata erase/program before the tail write | old animation intact (the alternate bank fails validation) |
| after the tail write | new animation, complete |
| DELETE before its tail write | old animation intact |
| DELETE after its tail write | no animation (`count` 0) |

### Playback-position records and wear

The playback position is kept in the **active metadata sector** itself, appended by
programming only, so saving a position costs no erase cycle and never moves
`revision`.

Records start at offset 1056 of the sector — immediately after the metadata prefix,
whose largest possible size is `30 + 16 x 64 = 1054` bytes rounded up to a whole
word. The tail therefore begins outside the CRC-covered prefix and outside every
metadata validation rule, so `revision`, recovery and `INFO` are unaffected by a
save. Records are only ever programmed into still-erased bytes, never erased
individually, and never rewritten: the append cursor moves forward and the whole
tail is cleared only when the next metadata commit erases that sector.

One record is exactly 16 bytes, little-endian:

| Offset | Size | Field |
| --- | --- | --- |
| +0 | 4 | `magic` u32 = `0x504C4159`; on flash the bytes are `59 41 4C 50` (`YALP` reversed, the same reversed-ASCII convention as the other magics) |
| +4 | 1 | `version` = 1 |
| +5 | 1 | `reserved` = 0 |
| +6 | 2 | `index` u16: the frame to resume at |
| +8 | 4 | `generation` u32: the metadata generation this record belongs to |
| +12 | 4 | `crc` u32 over record bytes `[0, 12)` |

At most **64** records fit (`64 x 16 = 1024` bytes inside a 4096-byte sector), so a
metadata generation can absorb at most 64 saves before the tail is exhausted. The
record count is derived from how many 16-byte slots contain any programmed byte, so a
torn write still consumes its slot and the cursor never reuses a half-written word.

A record is honoured only when all of these hold: `magic` and `version` match,
`reserved` is 0, its own CRC over `[0, 12)` verifies, and `generation` equals the
active metadata generation. Anything else is skipped, and the newest valid record
wins. Consequently a position saved before the last COMMIT or DELETE is
automatically stale and ignored — the generation check is what makes RESUME safe
without a separate cleanup step. A stale index that is still within the new
animation's `count` is nonetheless rejected by the generation mismatch, not by the
range check alone.

Wear is bounded by two independent caps:

- **At most 64 program operations per metadata generation** — the tail length. One
  save is one aligned 16-byte program (four words) at a 4-byte-aligned address, and no
  save erases anything, so position persistence adds at most 64 programs and zero
  erases between two metadata erases.
- **The firmware's save policy** — at most one save per 10 seconds during playback
  (`PERSIST_MS`), plus exactly one forced save when playback stops or is preempted.
  Saves are skipped while an upload or another flash operation owns the flash
  driver, and a full tail or a failed program is non-fatal: playback continues and
  the reported status is unchanged.

Only the next metadata write (COMMIT or DELETE) erases the sector and thereby resets
the tail to zero records. Between metadata commits the animation's frames and its
metadata CRC are never touched by a save.

A corrupt, empty or absent animation never blocks the device: INFO reports `count`
0, PLAY returns not found, and boot with invalid metadata behaves as "no
animation". Repeated uploads consume endurance (13 sector erases per upload plus
one metadata sector); avoid re-uploading unchanged animations.

## Codec

A frame blob is:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | `kind`: 0 full, 1 delta |
| 1 | 1 | `reserved` = 0 |
| 2 | 2 | `encLen` u16 |
| 4 | 4 | `crc` u32: CRC32 of the 4000 decoded bytes |
| 8 | `encLen` | payload |

`blobLen = 8 + encLen`, at most 4008 bytes; a single blob must fit the 0xD000-byte
data bank. **`encLen` is the payload length only** — never the whole blob length.

Kind 0 payload is the 4000 decoded bytes verbatim (122×250, 16-byte stride, bit
`7−(x%8)` of byte `16y + ⌊x/8⌋`, 1 = black, low six bits of each row's last byte
zero). Kind 1 payload is PackBits of `frame XOR previous decoded frame`, byte for
byte over all 4000 bytes, where "previous" is the frame at `index − 1`.

PackBits, identical to the [v2 subset](protocol-v2.md):

| Control | Meaning |
| --- | --- |
| 0..127 | literal run: copy the next `control + 1` bytes |
| 128 | reserved and forbidden; a stream containing it is invalid |
| 129..255 | repeat: copy the next byte `257 − control` times |

The encoder starts repeats at length 3, caps literals at 128 bytes and repeats at
128 copies; the decoder also accepts a repeat of 2. A stream that overruns the
input, overruns the 4000-byte output, contains control 128, or does not produce
exactly 4000 bytes is a codec-stream error (10) and invalidates the frame.

Selection rule, normative for both codecs: `encodeFrame(prev, frame)` emits kind 0
when `prev` is null **or** when the PackBits delta payload is 4000 bytes or longer;
otherwise kind 1. An incompressible delta encodes to 4032 bytes, so it is always
sent as kind 0.

The codec API keeps the previous frame and the destination as separate arguments:
`decodeBlob(blob, len, prev, out)`, `decodePayload(kind, payload, n, prev, out)` and
`StreamDecoder::push(encoded, n, out)` with the reference fixed by
`begin(kind, prev)`. Nothing in the codec requires `prev` and `out` to be different
buffers, and both firmware consumers deliberately pass the same buffer, decoding a
delta **in place**.

Decoding in place is safe because the decoder produces bytes in strictly increasing
order and reads `prev[p]` before it writes `out[p]`, so with `prev == out` every XOR
input is still the old value when it is consumed.

The player additionally needs the *changed-pixel bounding box*, which means comparing
each produced byte against the value that byte had before the frame. That original
value is gone once the decoder writes it, so the player keeps a rolling 128-byte
window of the destination's pre-decode contents and refills it as decoding advances.
128 bytes is exactly the maximum a single encoded PackBits byte can expand to (a
repeat of 128), so the window always covers the bytes one step can touch. The bbox is
accumulated during the same pass, which is why no second full frame is needed.

Concretely, the shipped firmware uses exactly **two** static 4000-byte frame buffers
in total (8000 bytes), with zero heap allocation per frame:

- the player (`anim_player.h`) holds **one** frame. It decodes the stored delta in
  place, using the rolling 128-byte window for the bounding-box comparison,
  accumulates that box during the same pass, and verifies the frame CRC over that one
  buffer after decoding. There is no separate "previous frame" buffer.
- the wire endpoint (`anim_wire.h`) holds **one** separate decoded frame, because
  FRAME_COMMIT verifies the CRC of the decoded frame and, per the compatibility
  rules, an upload may run while an animation is playing. Sharing the player's
  buffer would corrupt the frame on the panel.

Neither consumer ever materializes a 4000-byte encoded buffer. The player reads the
stored payload from flash in 64-byte chunks and pushes them through the streaming
decoder; the wire endpoint decodes each accepted DATA payload as it arrives, before
the bytes are written to flash, so a codec error can never leave programmed bytes
claiming to be a frame. Encoded bytes are consumed where they are read or received.

CRC32 is IEEE reflected polynomial `0xEDB88320`, initial value `0xFFFFFFFF`, final
XOR `0xFFFFFFFF`. Check value: `123456789` → `0xCBF43926`. The same CRC is used for
the frame CRC, the metadata CRC and the animation CRC.

`animationCrc` is that CRC over the concatenation of all 4000-byte **decoded**
frames in index order, frame 0 first, computed incrementally. It is independent of
the wire encoding, of `kind` and of delays. The encoder computes it before BEGIN;
COMMIT re-derives it from the committed frames and rejects a mismatch with error 6.

## Playback, refresh and ghosting

- Playback runs in the main loop, never in a BLE callback.
- **Partial presentation is the shipped default.** The firmware constructs the player
  with `partialPresentation(true)` and `configure(10, 60)`; there is no wire field and
  no client command that selects or forbids a refresh mode, and the wire format is
  identical either way.
- The first frame of a playback is always a full-window refresh
  (`setFullWindow`, `fillScreen(white)`, `drawBitmap`, `nextPage` until done).
- Every later frame is presented with a partial refresh restricted to the bounding
  box of pixels that actually changed:

  ```
  x0 = min x, y0 = min y, x1 = max x, y1 = max y   over all pixels where
       previous_decoded_frame differs from next_decoded_frame
  present(x0, y0, x1 - x0 + 1, y1 - y0 + 1, next_frame)
  ```

  The comparison is bit-exact over real pixels only: the six low bits of each row's
  last byte are padding and are never compared. The player reports the exact pixel
  box; the panel adapter widens it to whole byte columns (`x0 & ~7`, width rounded up
  to a multiple of 8) because the controller addresses columns in bytes. The widened
  box may extend up to 7 pixels past column 121 into the hidden columns 122..127; the
  controller accepts them and the next full refresh clears them white. A frame whose
  box is empty (identical to the previous frame) is not refreshed at all, and its
  `delayMs` still elapses.
- A full-window refresh with `fillScreen(white)` replaces the partial refresh when
  any of these holds:
  1. it is the first frame of this playback;
  2. every N presented frames, counted from the start of playback: **N = 10** by
     default (`DEFAULT_LOOP_REFRESH`), a firmware constant. The counter advances only
     for frames actually presented (an unchanged frame is not counted). Presented
     frames 1, 10, 20, 30, ... are full refreshes, so at most 9 partial refreshes
     ever occur in a row;
  3. the changed bounding box covers **60% or more of the panel**:
     `area * 100 >= WIDTH * HEIGHT * 60`, i.e. 18 300 of the 30 500 real pixels. The
     test uses real pixels, never the 32 000 bits of the 4000-byte buffer, so padding
     bits cannot influence it;
  4. the frame is kind 0 (a self-contained full frame is treated as a scene change);
  5. playback ends. STOP and DELETE restore static content with a full refresh (see
     [STOP](#08-stop-1-byte)); a legacy v1/v2 frame COMMIT, a pages SHOW, ENTER_DFU or
     RESET_WELCOME preempt playback and each draws its own content with a full
     refresh. A one-shot animation reaching its last frame keeps that frame and
     hibernates instead. The next playback always starts with a full refresh.
- Ghosting accumulation is therefore bounded by two independent mechanisms: at most
  N−1 = 9 consecutive partial refreshes, and at most 59% changed area in any partial
  refresh. Either limit forces a clearing full refresh. Ghosting is bounded, not
  proven absent: partial-refresh optical behaviour on this panel is not verified on
  hardware, which is a hardware-verification gap, not a reason to skip the feature
  (see [limitations](#limitations-and-unverified-behaviour)).
- The panel hooks are `present(x, y, w, h, frame)` for a partial window,
  `presentFull(frame)` for a clearing full refresh and `clear()` for a white panel
  with no bitmap; the player derives the bounding box from its single decoded frame
  and never reads the panel back. The panel is hibernated when playback ends.
- `delayMs` is the hold time between the end of one refresh and the start of the
  next, floored at 100 ms. A refresh that takes longer than the delay simply delays
  the animation; frames are never skipped.
- Metadata `flags` bit 0 controls looping: with it set, playback continues at frame 0
  after the last frame until STOP, PLAY or another owner takes the panel; without it,
  playback stops after the last frame and `index` becomes `0xFFFF`.
- A ghost or incomplete image left by a reset during playback is repaired by the
  next full refresh (playback start, a scene change, or the N-frame cadence); no
  stored state is corrupted.
- While a frame is refreshing, a command that would replace the displayed frame
  waits or is error 2; STOP, INFO, READ and ABORT remain accepted.

## Limitations and unverified behaviour

- Partial-refresh optical behaviour — ghost residue, contrast drift, temperature
  dependence, differences from a full-refresh waveform — is not verified on
  hardware. The bounding box, the N-frame cadence and the 60% threshold are
  deterministic and host-tested, but the optical result of a partial refresh on the
  installed panel is unmeasured. The firmware still implements partial presentation
  by default; the cadence and the area threshold bound the risk.
- Refresh duration, panel busy timing and hibernation between frames are not
  measured on hardware. `delayMs` is honoured as a hold time, not as a promise about
  the achieved animation frame rate.
- Flash endurance for repeated uploads and for periodic playback-index persistence is
  not measured; avoid unchanged re-uploads.
- The playback position is a convenience, not durable state the client may rely on:
  it is not authenticated, it can be stale after an interrupted save or superseded by
  a metadata commit, and a full tail simply stops further saves. It never affects the
  stored frames, which are validated independently by their own CRC.
- STOP restoring static content depends on the page collection being readable; when
  the page store is unhealthy the panel is cleared white instead, and that fallback
  (like the restore itself) is not optically verified on hardware.
- Whether the installed bootloader preserves `0xB0000..0xCC000` through UF2 or BLE
  OTA is not established. Back up animations before updating.

## Compatibility

| Situation | Behaviour |
| --- | --- |
| Old client (knows only `0001`..`0009`), new firmware | Unchanged behaviour. Animation endpoints are additional; nothing in v1/v2/pages changes. |
| New client, old firmware | Animation service discovery raises `NotFoundError`; fall back to the legacy endpoints, as the v2 capabilities fallback already does. |
| Legacy v1/v2 START/DATA/COMMIT while an animation plays | Accepted, never rejected merely because an animation is playing. A legacy COMMIT stops playback and takes the panel. |
| Pages SHOW while an animation plays | Accepted; stops playback and takes the panel. |
| ENTER_DFU / RESET_WELCOME while an animation plays | Accepted subject to their own existing idle rules; stop playback first, then act. |
| Animation PLAY/BEGIN while a legacy frame is queued or refreshing | PLAY/BEGIN stop playback but never corrupt the legacy receiver; if a display copy owns the shared frame buffer they return error 2 and the client retries. |
| Animation upload while playing | Allowed; the current animation keeps playing until COMMIT succeeds. |
| Animation READ during playback or upload | Allowed; always reads the durable animation. |
| Corrupt/absent animation | INFO `count` 0, PLAY not found, boot treats it as no animation. |
| Two connections | One central only, as before. The upload belongs to the connection that issued BEGIN; others get error 2. |
| Old client that never sends `start == 0xFFFF` | Byte-identical PLAY responses to before: `0xFFFF` is the only additive value, and every other `start` still means "play from this index". |
| Old client that ignores the STOP restore | Sees `error` 0 and `flags` bit 1 clear, exactly as before; only the panel content afterwards differs, and it is static content the client already knows how to draw. |
| STOP or DELETE while another owner holds the panel | Accepted; playback stops and the restore is skipped, because the other owner draws its own content. |

Stopping playback is the only interaction: the panel is a single resource, so
whoever takes it last wins. Playback never blocks a legacy transfer, and a legacy
transfer never leaves playback half-updated — the animation simply stops and the
panel returns to static content (or to whatever the preempting owner drew).

## Security

There is no authentication, pairing requirement, encryption or signature. CRC32
detects accidental corruption and truncated writes; it is **not** authentication and
is not resistant to tampering. Any nearby BLE client that can reach the service can
replace the stored animation, read it back (READ streams the blobs) or delete it,
exactly as it can replace the displayed frame today. The stored animation is not
secret. Do not advertise this as a secure or private feature; bound checks and CRC
reduce correctness risk, not hostile access.

## Test vectors

`tests/vectors-animation.json` is generated by
`tests/fixtures/animation/make-vectors.mjs` from independent reference
implementations and is consumed by both `tests/anim-codec.test.js` and
`tests/anim_codec.cpp`, so JavaScript and C++ must agree byte for byte. Schema:

| Key | Contents |
| --- | --- |
| `crc` | `{name, hex, value}` shared CRC32 vectors (the same ones `tests/vectors.json` pins) |
| `frames` | `{name, hex, crc}` 4000-byte decoded frames |
| `blobs` | `{name, prev, frame, kind, encLen, crc, blobHex}` — `prev`/`frame` index into `frames`, `prev: null` means kind 0 |
| `animations` | `{name, frames, crc}` animation CRC over the listed frame indices |
| `packbits` | `{name, rawHex, encodedHex}` encoder cases |
| `packbitsFrames` | `{name, deltaHex, encodedHex}` full 4000-byte delta cases (kind selection + payload) |
| `packbitsDecode` | `{name, encodedHex, rawHex}` decoder cases, including a repeat of 2 |
| `rejects` | `{name, prev, blobHex, error, stage}`; `stage` `header` means `parseBlobHeader` fails, `decode` means the header parses and `decodeBlob` fails with `error` |

`tests/anim-e2e.test.js` and `tests/anim_e2e.cpp` additionally prove the whole
pipeline on a real fixture: `tests/fixtures/animation/sample.gif` (4 frames,
delays 120/100/250/330 ms, disposal 1 and 2, one interlaced frame, transparent
regions, generated by `make-gif.mjs` with a real GIF89a LZW encoder) → 1-bit frames
→ blobs → the firmware C++ decoder → byte-identical frames and a matching animation
CRC. `tests/fixtures/animation/unsupported.gif` is a truncated copy of the same GIF
and must be rejected. `tests/fixtures/animation/frames.json` records the decoded
ground truth so a client without a GIF decoder can still be tested.

Frozen by contract agent 2026-11-24; firmware and site implement against this file;
changing it requires updating tests/vectors-animation.json and both codec modules.
