#ifndef EINK_ANIM_STORAGE_H
#define EINK_ANIM_STORAGE_H
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include "protocol.h"
#include "anim_codec.h"

namespace eink { namespace anim {

// Flash reservation 0xB0000..0xCC000 (exclusive): two metadata sectors, then two
// copy-on-write data banks of thirteen 4 KiB sectors each (0xD000 bytes per bank).
// The page reservation (0xCC000..), the welcome sector (0xEC000..) and the core
// InternalFS are outside this range and are never touched.
static constexpr uint32_t BASE = 0xB0000u, SECTOR = 4096u;
static constexpr unsigned BANK_SECTORS = 13;
static constexpr uint32_t BANK_SIZE = BANK_SECTORS * SECTOR;  // 0xD000
static constexpr uint32_t META_A = BASE, META_B = BASE + SECTOR;
static constexpr uint32_t DATA_A = BASE + 2u * SECTOR, DATA_B = DATA_A + BANK_SIZE;
static constexpr uint32_t END = DATA_B + BANK_SIZE;  // 0xCC000
static_assert(END == 0xCC000u, "animation region must end at the pages reservation");
static constexpr uint32_t MAGIC = 0x414E494Du, MARKER = 0x434F4D54u;
static constexpr uint16_t FLAG_LOOP = 1;
// Playback hint stored with the animation: skip the scene-change and periodic full
// refreshes and always use a partial window after the first frame. Removes the inversion
// flash on full-screen animations at the cost of slower ghost accumulation.
static constexpr uint16_t FLAG_FAST_PARTIAL = 2;
// Frame count, kind values, blob header size, delay bounds and the 0xD000 per-bank
// capacity are the codec contract's constants; these aliases keep this file readable.
static constexpr uint32_t BLOB_HEADER = BLOB_HEADER_BYTES;
static_assert(BANK_SIZE == DATA_BANK_BYTES, "storage bank must match the codec's data bank");
static_assert(MAX_FRAMES == eink::anim::MAX_FRAMES, "frame count bound comes from the codec");

// Metadata sector image, little endian, explicitly serialized (never struct padding):
//   0  magic u32 0x414E494D      4  version u8 = 1     5  reserved u8 = 0
//   6  frameCount u16            8  flags u16          10  dataBytes u32
//   14 animationCrc u32          18  generation u32     22  frameCount * 16-byte entries
//   22 + 16*n  crc u32 (IEEE CRC32 over bytes [0, 22+16*n))   26 + 16*n  marker u32
// Entry: offset u32, encLen u16, kind u8, reserved u8 = 0, crc u32, delayMs u16, pad u16 = 0.
static constexpr uint32_t M_MAGIC = 0, M_VERSION = 4, M_RESERVED = 5, M_FRAMECOUNT = 6,
                          M_FLAGS = 8, M_DATABYTES = 10, M_ANIMCRC = 14, M_GENERATION = 18,
                          M_ENTRIES = 22, M_ENTRY = 16;
// The sector image ends with the marker at 26+16*n. 26+16*n is never word aligned, so the
// flash image is rounded up to a whole word: the last program (marker, or marker's low
// half) always fits inside this buffer.
static constexpr uint32_t META_BYTES = M_ENTRIES + M_ENTRY * MAX_FRAMES + 8;  // 1054
static constexpr uint32_t META_IMAGE = (META_BYTES + 3u) & ~3u;               // 1056

// Playback-state tail. The active metadata sector has ~3 KiB of erased space after the
// `30 + 16n` prefix. A position record is APPENDED there by programming only (never erasing),
// so saving a position costs ZERO erase cycles: the sector is erased by the next metadata
// commit, which also resolves the record (see the generation field). Records live strictly
// outside the crc-covered prefix and outside every validation rule, so loadBank() and
// begin() behave exactly as before and `revision` never moves because of a save.
//
// Record, exactly 16 bytes, little endian, packed:
//   0  magic u32 = 0x504C4159 ("YALP"; on flash 59 41 4C 50)
//   4  version u8 = 1
//   5  reserved u8 = 0
//   6  index u16
//   8  generation u32   (the active metadata generation this record belongs to)
//  12  crc u32          (CRC32 over record bytes [0, 12))
// 64 records fit in the 3040-byte tail (64 * 16 = 1024 bytes).
static constexpr uint32_t POSITION_MAGIC = 0x504C4159u;
static constexpr uint32_t POSITION_START = META_IMAGE;  // 1056: just past the metadata prefix
static constexpr uint32_t POSITION_END = SECTOR;        // records never leave the sector
static constexpr uint32_t POSITION_RECORD = 16;
static constexpr uint32_t POSITION_MAX = 64;
static_assert(POSITION_START + POSITION_MAX * POSITION_RECORD <= POSITION_END,
              "the playback tail must fit inside the metadata sector");
static constexpr uint32_t P_MAGIC = 0, P_VERSION = 4, P_RESERVED = 5, P_INDEX = 6,
                          P_GENERATION = 8, P_CRC = 12;

// Numeric values are the frozen wire error codes (status byte 2).
enum Result : uint8_t {
  OK = 0, MALFORMED = 1, BUSY = 2, NOT_FOUND = 3, CONFLICT = 4, FULL = 5,
  BAD_CRC = 6, STORAGE = 7, BAD_OFFSET = 8, BAD_PADDING = 9, CODEC = 10, LIMIT = 11,
  // Player-only code, never sent on the wire (the wire table stops at 11). It reports that
  // playback ended because a COMMIT replaced the animation under it: a different count or a
  // different animation CRC. Distinct from CODEC so a caller can say "the animation changed"
  // rather than "the animation is corrupt".
  ANIM_CHANGED = 12
};

inline uint32_t align4(uint32_t n) { return (n + 3u) & ~3u; }
// Incremental IEEE CRC32 (0xEDB88320): the animation CRC accumulates one decoded
// frame at a time and is compared with BEGIN's declared value at COMMIT.
inline uint32_t crcUpdate(uint32_t state, const uint8_t* p, size_t n) {
  while (n--) { state ^= *p++; for (unsigned i = 0; i < 8; ++i) state = (state >> 1) ^ (0xedb88320u & (0u - (state & 1u))); }
  return state;
}

// One monotonic u32 counter, `generation`, is stored in the metadata. Every metadata
// write increments it, and the only metadata writes are COMMIT and DELETE, so the wire
// `revision` field is exactly that counter (the frozen layout has no second counter).
//
// The Flash interface uses absolute addresses; every program address and length is word
// aligned, and a successful program/erase can be read back immediately.
template<class Flash> class Storage {
 public:
  explicit Storage(Flash& flash) : flash_(flash), active_(-1), healthy_(false), readFailed_(false),
      uploading_(false), uploadBank_(0), eraseSector_(0), uploaded_(0), nextOffset_(0),
      declaredCount_(0), declaredFlags_(0), declaredCrc_(0), frameOpen_(false), frameWritten_(0),
      frameEncoded_(0), positionFill_(0), positionDirty_(false),
      pendingLen_(0), programmed_(0), encCrc_(0xffffffffu) {
    memset(image_, 0xff, sizeof(image_));
    memset(pending_, 0, sizeof(pending_));
    memset(bulk_, 0, sizeof(bulk_));
  }

  // Recovery: choose the newest bank whose CRC, marker, entry bounds and per-frame blob
  // headers are intact. Frame payload CRCs are deliberately NOT recomputed here: that
  // would read both banks (2 x 52 KiB) on every boot. Instead COMMIT re-verifies every
  // frame while it is written (read back + CRC), and the player verifies each frame CRC
  // while it decodes, so a damaged payload surfaces as a codec error at PLAY, not as a
  // silent corrupt animation.
  bool begin() {
    readFailed_ = false;
    uploading_ = false;
    frameOpen_ = false;
    bool valid[2];
    for (unsigned i = 0; i < 2; ++i) valid[i] = loadBank(i);
    if (readFailed_) { healthy_ = false; return false; }
    if (valid[0] || valid[1]) {
      active_ = (valid[1] && (!valid[0] || get32(image_[1] + M_GENERATION) > get32(image_[0] + M_GENERATION))) ? 1 : 0;
      healthy_ = true;
      scanPositionTail();
      return true;
    }
    // Both banks unusable: only a factory-fresh device (both metadata sectors erased) is
    // a usable empty animation. Anything else is corruption and must not be overwritten.
    if (!erased(META_A) || !erased(META_B) || readFailed_) { healthy_ = false; return false; }
    memset(image_[0], 0xff, sizeof(image_[0]));
    buildEmpty(image_[0], 0);
    active_ = 0;
    healthy_ = true;
    return true;
  }

  bool healthy() const { return healthy_; }
  // Revision and generation share the single stored counter (see above).
  uint32_t revision() const { return healthy_ ? get32(image_[active_] + M_GENERATION) : 0u; }
  uint32_t generation() const { return revision(); }
  unsigned count() const { return healthy_ ? get16(image_[active_] + M_FRAMECOUNT) : 0u; }
  uint16_t flags() const { return healthy_ ? get16(image_[active_] + M_FLAGS) : 0u; }
  uint32_t dataBytes() const { return healthy_ ? get32(image_[active_] + M_DATABYTES) : 0u; }
  uint32_t animationCrc() const { return healthy_ ? get32(image_[active_] + M_ANIMCRC) : 0u; }

  // Absolute flash address of the bank the active metadata references. Exposed so tests
  // and diagnostics can reason about the physical layout without duplicating the mapping.
  uint32_t activeDataAddress() const { return dataAddress(unsigned(active_ < 0 ? 0 : active_)); }
  // Absolute address of the active metadata sector (the playback tail lives inside it).
  uint32_t activeMetaAddress() const { return metaAddress(unsigned(active_ < 0 ? 0 : active_)); }
  uint32_t frameOffset(unsigned i) const { return get32(entry(i) + 0); }
  uint16_t frameEncLen(unsigned i) const { return get16(entry(i) + 4); }
  uint8_t frameKind(unsigned i) const { return entry(i)[6]; }
  uint32_t frameCrc(unsigned i) const { return get32(entry(i) + 8); }
  uint16_t frameDelay(unsigned i) const { return get16(entry(i) + 12); }
  uint32_t blobLength(unsigned i) const { return BLOB_HEADER + frameEncLen(i); }
  uint32_t payloadLength(unsigned i) const { return frameEncLen(i); }

  // Stored bytes of one blob, 8-byte header included (READ opcode streams this).
  Result readBlob(unsigned index, uint32_t offset, void* out, size_t len) {
    if (!healthy_) return STORAGE;
    if (index >= count()) return NOT_FOUND;
    uint32_t total = blobLength(index);
    if (offset > total || len > size_t(total - offset)) return BAD_OFFSET;
    if (!len) return OK;
    return readFlash(dataAddress(active_) + frameOffset(index) + offset, out, len) ? OK : STORAGE;
  }
  // Encoded payload bytes only (player and delta decoding).
  Result readPayload(unsigned index, uint32_t offset, void* out, size_t len) {
    if (!healthy_) return STORAGE;
    if (index >= count()) return NOT_FOUND;
    if (offset > payloadLength(index) || len > size_t(payloadLength(index) - offset)) return BAD_OFFSET;
    if (!len) return OK;
    return readFlash(dataAddress(active_) + frameOffset(index) + BLOB_HEADER + offset, out, len) ? OK : STORAGE;
  }

  // ---- upload ----
  bool uploading() const { return uploading_; }
  bool erasePending() const { return uploading_ && eraseSector_ < BANK_SECTORS; }
  unsigned eraseSectorsDone() const { return eraseSector_; }
  unsigned uploadedFrames() const { return uploaded_; }
  uint32_t uploadBytes() const { return nextOffset_; }

  // BEGIN: reserve a new animation into the inactive bank. Nothing is erased here; the
  // caller drains eraseStep() one sector per poll() so BLE stays responsive.
  Result beginUpload(uint16_t declaredCount, uint16_t uploadFlags, uint32_t crc) {
    if (!healthy_) return STORAGE;
    if (uploading_ || frameOpen_) return BUSY;
    if (!declaredCount || declaredCount > MAX_FRAMES) return LIMIT;
    if (uploadFlags & ~(FLAG_LOOP | FLAG_FAST_PARTIAL)) return MALFORMED;
    if (revision() == UINT32_MAX || generation() == UINT32_MAX) return FULL;
    uploading_ = true;
    // Never reuse the bank the active metadata references.
    uploadBank_ = active_ == 0 ? 1u : 0u;
    eraseSector_ = 0;
    uploaded_ = 0;
    nextOffset_ = 0;
    declaredCount_ = declaredCount;
    declaredFlags_ = uploadFlags;
    declaredCrc_ = crc;
    return OK;
  }
  // One 4 KiB sector per call: resumable across poll() calls.
  Result eraseStep() {
    if (!uploading_) return BUSY;
    if (eraseSector_ >= BANK_SECTORS) return OK;
    uint32_t addr = dataAddress(uploadBank_) + eraseSector_ * SECTOR;
    if (!flash_.erase(addr) || !erased(addr)) { uploading_ = false; frameOpen_ = false; return STORAGE; }
    ++eraseSector_;
    return OK;
  }

  // FRAME: validate the declared frame against the frozen bounds, then program the
  // 8-byte blob header at the current append offset.
  Result beginFrame(uint8_t kind, uint16_t encLen, uint32_t crc, uint16_t delayMs) {
    if (!healthy_) return STORAGE;
    if (!uploading_) return BUSY;
    if (frameOpen_) return BUSY;
    if (eraseSector_ < BANK_SECTORS) return BUSY;
    if (uploaded_ >= declaredCount_) return LIMIT;
    if (kind > KIND_DELTA) return MALFORMED;
    if (kind == KIND_FULL ? encLen != FRAME_BYTES : (!encLen || encLen > FRAME_BYTES)) return MALFORMED;
    if (delayMs < DELAY_MIN_MS || delayMs > DELAY_MAX_MS) return LIMIT;
    // The padded blob (header + payload rounded to a word) must fit inside one bank.
    if (nextOffset_ + BLOB_HEADER + align4(encLen) > BANK_SIZE) return FULL;
    frameKind_ = kind;
    frameEncoded_ = encLen;
    frameCrc_ = crc;
    frameDelay_ = delayMs;
    frameWritten_ = 0;
    programmed_ = 0;
    pendingLen_ = 0;
    encCrc_ = 0xffffffffu;
    // Flash program sources must be word aligned on the real driver, so every buffer that
    // is handed to program() is declared alignas(4).
    alignas(4) uint8_t header[BLOB_HEADER];
    header[0] = kind; header[1] = 0;
    eink::put16(header + 2, encLen);
    eink::put32(header + 4, crc);
    if (!flash_.program(frameAddress(), header, BLOB_HEADER)) { uploading_ = false; return STORAGE; }
    alignas(4) uint8_t check[BLOB_HEADER];
    if (!readFlash(frameAddress(), check, sizeof(check)) || memcmp(check, header, sizeof(check)) != 0) {
      uploading_ = false; return STORAGE;
    }
    frameOpen_ = true;
    return OK;
  }

  // DATA: stream encoded bytes. Whole words are programmed as soon as four bytes are
  // available; 0..3 trailing bytes wait in pending_ for the next call or commitFrame().
  // Every program source is word aligned (the caller's pointer need not be), and the CRC
  // is accumulated over the accepted bytes so commitFrame() can compare it with a
  // read-back of what actually reached flash.
  Result writePayload(const uint8_t* p, size_t n) {
    if (!frameOpen_) return BUSY;
    if (n > size_t(frameEncoded_ - frameWritten_)) return LIMIT;
    encCrc_ = crcUpdate(encCrc_, p, n);
    while (n) {
      if (pendingLen_) {
        while (pendingLen_ < 4 && n) { pending_[pendingLen_++] = *p++; --n; ++frameWritten_; }
        if (pendingLen_ < 4) return OK;  // input ended mid-word: keep it for the next call
        if (!programPayload(pending_, 4)) return frameFailure();
        programmed_ += 4;
        pendingLen_ = 0;
        continue;
      }
      size_t words = n & ~size_t(3);
      if (words) {
        size_t done = 0;
        while (done < words) {
          size_t chunk = words - done;
          if (chunk > sizeof(bulk_)) chunk = sizeof(bulk_);
          memcpy(bulk_, p + done, chunk);
          if (!programPayload(bulk_, chunk)) return frameFailure();
          programmed_ += chunk;
          done += chunk;
        }
        p += words;
        n -= words;
        frameWritten_ += words;
      }
      while (n) { pending_[pendingLen_++] = *p++; --n; ++frameWritten_; }
    }
    return OK;
  }

  // FRAME_COMMIT: demand exactly encLen bytes, pad the final partial word with erased
  // bytes, read the payload back and compare its CRC, then record the entry in the
  // inactive bank's RAM image (nothing durable changes yet).
  Result commitFrame() {
    if (!frameOpen_) return BUSY;
    if (frameWritten_ != frameEncoded_) return LIMIT;
    if (pendingLen_) {
      for (unsigned i = pendingLen_; i < 4; ++i) pending_[i] = 0xff;
      if (!programPayload(pending_, 4)) return frameFailure();
      programmed_ += 4;
      pendingLen_ = 0;
    }
    uint32_t stored = 0xffffffffu;
    uint8_t buf[128];
    for (uint32_t off = 0; off < frameEncoded_;) {
      size_t n = frameEncoded_ - off;
      if (n > sizeof(buf)) n = sizeof(buf);
      if (!readFlash(frameAddress() + BLOB_HEADER + off, buf, n)) return frameFailure();
      stored = crcUpdate(stored, buf, n);
      off += uint32_t(n);
    }
    if (stored != encCrc_) return frameFailure();
    uint8_t* e = image_[uploadBank_] + M_ENTRIES + M_ENTRY * uploaded_;
    eink::put32(e + 0, nextOffset_);
    eink::put16(e + 4, frameEncoded_);
    e[6] = frameKind_;
    e[7] = 0;
    eink::put32(e + 8, frameCrc_);
    eink::put16(e + 12, frameDelay_);
    eink::put16(e + 14, 0);
    nextOffset_ += BLOB_HEADER + align4(frameEncoded_);
    ++uploaded_;
    frameOpen_ = false;
    return OK;
  }

  // Reads payload bytes of the frame currently open (used by FRAME_COMMIT to decode from
  // flash, so no 4000-byte encoded staging buffer is needed).
  Result readOpenPayload(uint32_t offset, void* out, size_t len) {
    if (!frameOpen_) return BUSY;
    if (offset > frameEncoded_ || len > size_t(frameEncoded_ - offset)) return BAD_OFFSET;
    if (!len) return OK;
    return readFlash(frameAddress() + BLOB_HEADER + offset, out, len) ? OK : STORAGE;
  }

  // Discards the most recently appended frame so it can be re-uploaded at the same index
  // (the client may retry a frame whose FRAME_COMMIT response was lost). Only the last
  // entry is removable: an earlier index would break the delta chain.
  Result reopenLastFrame() {
    if (!healthy_) return STORAGE;
    if (!uploading_ || frameOpen_) return BUSY;
    if (!uploaded_) return CONFLICT;
    const uint8_t* e = image_[uploadBank_] + M_ENTRIES + M_ENTRY * (uploaded_ - 1);
    nextOffset_ = get32(e + 0);
    memset(image_[uploadBank_] + M_ENTRIES + M_ENTRY * (uploaded_ - 1), 0xff, M_ENTRY);
    --uploaded_;
    return OK;
  }

  // ABORT of a frame in progress: the bank is unreachable until a later commit, so the
  // committed animation is untouched; only the in-RAM append cursor is discarded.
  void cancelFrame() { frameOpen_ = false; pendingLen_ = 0; }

  // COMMIT: verify count and the running animation CRC, write the alternate metadata
  // bank (marker last) and switch to it. `animationCrc` is the IEEE CRC32 over the
  // concatenation of the decoded 4000-byte frames in index order.
  Result commit(uint32_t animationCrc) {
    if (!healthy_) return STORAGE;
    if (!uploading_) return BUSY;
    if (frameOpen_) return BUSY;
    if (eraseSector_ < BANK_SECTORS) return BUSY;
    if (uploaded_ != declaredCount_) return LIMIT;
    if (animationCrc != declaredCrc_) return BAD_CRC;
    Result r = writeMetadata(uploadBank_, uploaded_, declaredFlags_, nextOffset_, animationCrc);
    if (r != OK) { healthy_ = false; return r; }
    active_ = int(uploadBank_);
    uploading_ = false;
    return OK;
  }
  void abortUpload() { uploading_ = false; frameOpen_ = false; pendingLen_ = 0; }

  // DELETE: commit an empty animation into the alternate bank.
  Result remove() {
    if (!healthy_) return STORAGE;
    if (uploading_ || frameOpen_) return BUSY;
    unsigned target = active_ == 0 ? 1u : 0u;
    Result r = writeMetadata(target, 0, 0, 0, 0);
    if (r != OK) { healthy_ = false; return r; }
    active_ = int(target);
    resetPosition();
    return OK;
  }

  // ---- playback position (append-only, zero erase cost) ----
  // Appends a 16-byte record to the active metadata sector's erased tail. Programming only:
  // no erase, so a save can never wear the sector or invalidate the metadata (the record is
  // outside the crc-covered prefix). FULL means the 64-record tail is exhausted; the caller
  // must treat that as non-fatal and simply stop saving until the next metadata commit.
  Result savePosition(uint16_t index) {
    if (!healthy_) return STORAGE;
    if (uploading_ || frameOpen_) return BUSY;
    if (positionFill_ >= POSITION_MAX) return FULL;
    // Two records fill one 4-byte-aligned 32-byte slot pair; the tail is written in 4-byte
    // words, so an odd record count leaves that word half-programmed until the next save.
    alignas(4) uint8_t record[POSITION_RECORD] = {0};
    eink::put32(record + P_MAGIC, POSITION_MAGIC);
    record[P_VERSION] = 1;
    record[P_RESERVED] = 0;
    eink::put16(record + P_INDEX, index);
    eink::put32(record + P_GENERATION, generation());
    eink::put32(record + P_CRC, eink::crc32(record, P_CRC));
    const uint32_t addr = metaAddress(unsigned(active_ < 0 ? 0 : active_)) +
                          POSITION_START + positionFill_ * POSITION_RECORD;
    if (!flash_.program(addr, record, POSITION_RECORD)) return STORAGE;
    ++positionFill_;
    return OK;
  }

  // Reads the newest valid record that belongs to the ACTIVE metadata generation. A record
  // from an older generation (i.e. before the last commit) or with a bad crc is ignored.
  bool loadPosition(uint16_t& index) const {
    if (!healthy_) return false;
    for (unsigned i = positionFill_; i > 0; --i) {
      uint8_t record[POSITION_RECORD];
      const uint32_t addr = metaAddress(unsigned(active_ < 0 ? 0 : active_)) +
                            POSITION_START + (i - 1) * POSITION_RECORD;
      if (!const_cast<Storage*>(this)->readFlash(addr, record, sizeof(record))) return false;
      if (eink::get32(record + P_MAGIC) != POSITION_MAGIC || record[P_VERSION] != 1 ||
          record[P_RESERVED] != 0) continue;
      if (eink::get32(record + P_CRC) != eink::crc32(record, P_CRC)) continue;
      if (eink::get32(record + P_GENERATION) != generation()) continue;
      index = eink::get16(record + P_INDEX);
      return true;
    }
    return false;
  }

  // Forgets the position in RAM only (the records stay on flash but no longer count).
  void resetPosition() { positionFill_ = 0; positionDirty_ = true; }
  unsigned positionRecords() const { return positionFill_; }

 private:
  static uint32_t metaAddress(unsigned bank) { return bank ? META_B : META_A; }
  static uint32_t dataAddress(unsigned bank) { return bank ? DATA_B : DATA_A; }
  uint32_t frameAddress() const { return dataAddress(uploadBank_) + nextOffset_; }
  // Flash program sources must be word aligned; `programmed_` is the payload byte offset
  // already written, so the address below is always header(8) + a multiple of 4.
  bool programPayload(const void* src, size_t len) {
    return flash_.program(frameAddress() + BLOB_HEADER + programmed_, src, len);
  }
  Result frameFailure() { uploading_ = false; frameOpen_ = false; return STORAGE; }
  const uint8_t* entry(unsigned i) const { return image_[active_] + M_ENTRIES + M_ENTRY * i; }
  static void buildEmpty(uint8_t* img, uint32_t generation) {
    eink::put32(img + M_MAGIC, MAGIC);
    img[M_VERSION] = 1; img[M_RESERVED] = 0;
    eink::put16(img + M_FRAMECOUNT, 0);
    eink::put16(img + M_FLAGS, 0);
    eink::put32(img + M_DATABYTES, 0);
    eink::put32(img + M_ANIMCRC, 0);
    eink::put32(img + M_GENERATION, generation);
    eink::put32(img + M_ENTRIES, eink::crc32(img, M_ENTRIES));
    eink::put32(img + M_ENTRIES + 4, MARKER);
  }
  bool readFlash(uint32_t addr, void* out, size_t len) {
    if (flash_.read(addr, out, len)) return true;
    readFailed_ = true;
    return false;
  }
  bool erased(uint32_t addr) {
    uint32_t words[32];
    for (unsigned off = 0; off < SECTOR; off += sizeof(words)) {
      if (!readFlash(addr + off, words, sizeof(words))) return false;
      for (unsigned i = 0; i < sizeof(words) / sizeof(words[0]); ++i) if (words[i] != 0xffffffffu) return false;
    }
    return true;
  }
  // Counts the contiguous valid-prefix length of the append-only playback tail. A record is
  // "in use" if any of its 16 bytes is programmed; a torn record therefore still consumes
  // its slot, which keeps the append cursor monotonic without ever reusing a half-written
  // word. Validation (magic/crc/generation) happens per record in loadPosition(), so a torn
  // or stale record is simply skipped rather than truncating the search.
  void scanPositionTail() {
    positionFill_ = 0;
    positionDirty_ = false;
    const uint32_t base = metaAddress(unsigned(active_ < 0 ? 0 : active_));
    for (unsigned i = 0; i < POSITION_MAX; ++i) {
      uint32_t words[POSITION_RECORD / 4];
      if (!readFlash(base + POSITION_START + i * POSITION_RECORD, words, sizeof(words))) return;
      bool used = false;
      for (unsigned w = 0; w < POSITION_RECORD / 4; ++w)
        if (words[w] != 0xffffffffu) used = true;
      if (!used) break;
      positionFill_ = uint16_t(i + 1);
    }
  }
  bool loadBank(unsigned bank) {
    uint8_t* img = image_[bank];
    if (!readFlash(metaAddress(bank), img, META_IMAGE)) return false;
    if (get32(img + M_MAGIC) != MAGIC || img[M_VERSION] != 1 || img[M_RESERVED] != 0) return false;
    unsigned frames = get16(img + M_FRAMECOUNT);
    if (frames > MAX_FRAMES) return false;
    if (get16(img + M_FLAGS) & ~(FLAG_LOOP | FLAG_FAST_PARTIAL)) return false;
    uint32_t bytes = get32(img + M_DATABYTES);
    if (bytes > BANK_SIZE) return false;
    uint32_t crcOff = M_ENTRIES + M_ENTRY * frames;
    if (get32(img + crcOff) != eink::crc32(img, crcOff)) return false;
    if (get32(img + crcOff + 4) != MARKER) return false;
    uint32_t previous = 0;
    for (unsigned i = 0; i < frames; ++i) {
      const uint8_t* e = img + M_ENTRIES + M_ENTRY * i;
      uint32_t off = get32(e + 0);
      uint16_t len = get16(e + 4);
      uint8_t kind = e[6];
      uint16_t delay = get16(e + 12);
      if (kind > KIND_DELTA || e[7] || get16(e + 14)) return false;
      if (kind == KIND_FULL ? len != FRAME_BYTES : (!len || len > FRAME_BYTES)) return false;
      if (delay < DELAY_MIN_MS || delay > DELAY_MAX_MS) return false;
      if ((off & 3u) || off < previous || off + BLOB_HEADER + align4(len) > bytes) return false;
      previous = off + BLOB_HEADER + align4(len);
      uint8_t h[BLOB_HEADER];
      if (!readFlash(dataAddress(bank) + off, h, sizeof(h))) return false;
      if (h[0] != kind || h[1] != 0 || get16(h + 2) != len || get32(h + 4) != get32(e + 8)) return false;
    }
    if (frames && previous > bytes) return false;
    return true;
  }
  Result writeMetadata(unsigned bank, unsigned frames, uint16_t metaFlags, uint32_t bytes, uint32_t animCrc) {
    uint8_t* img = image_[bank];
    uint32_t generation = get32(image_[active_] + M_GENERATION) + 1;
    if (!generation) return FULL;
    eink::put32(img + M_MAGIC, MAGIC);
    img[M_VERSION] = 1; img[M_RESERVED] = 0;
    eink::put16(img + M_FRAMECOUNT, uint16_t(frames));
    eink::put16(img + M_FLAGS, metaFlags);
    eink::put32(img + M_DATABYTES, bytes);
    eink::put32(img + M_ANIMCRC, animCrc);
    eink::put32(img + M_GENERATION, generation);
    uint32_t crcOff = M_ENTRIES + M_ENTRY * frames;
    eink::put32(img + crcOff, eink::crc32(img, crcOff));
    eink::put32(img + crcOff + 4, MARKER);
    uint32_t addr = metaAddress(bank);
    // crcOff = 22 + 16n is always 2 mod 4, so the crc and the marker each straddle a word
    // boundary. Three aligned programs, in order:
    //   [0, crcOff+2)         everything up to and including crc bytes 0..1
    //   [crcOff+2, crcOff+6)  crc bytes 2..3, then marker bytes 0..1
    //   [crcOff+6, crcOff+10) marker bytes 2..3 (padded to a word): this final write
    //                         completes the marker and is what makes the bank valid, so a
    //                         torn commit always leaves the alternate bank invalid.
    if (!flash_.erase(addr) || !erased(addr)) return STORAGE;
    // The erase wipes the playback tail with the prefix, so the new generation starts with
    // no stored position and a fresh 64-record budget.
    positionFill_ = 0;
    positionDirty_ = false;
    if (!flash_.program(addr, img, crcOff + 2)) return STORAGE;
    alignas(4) uint8_t crcTail[4] = {img[crcOff + 2], img[crcOff + 3], img[crcOff + 4], img[crcOff + 5]};
    if (!flash_.program(addr + crcOff + 2, crcTail, sizeof(crcTail))) return STORAGE;
    alignas(4) uint8_t markerTail[4] = {img[crcOff + 6], img[crcOff + 7], 0xff, 0xff};
    if (!flash_.program(addr + crcOff + 6, markerTail, sizeof(markerTail))) return STORAGE;
    if (!loadBank(bank)) return STORAGE;
    return OK;
  }

  Flash& flash_;
  // Both metadata images and the payload staging buffers are program sources, so they are
  // word aligned for a driver that requires it.
  alignas(4) uint8_t image_[2][META_IMAGE];
  int active_;
  bool healthy_, readFailed_;
  bool uploading_;
  unsigned uploadBank_, eraseSector_, uploaded_;
  uint32_t nextOffset_;
  uint16_t declaredCount_, declaredFlags_;
  uint32_t declaredCrc_;
  bool frameOpen_;
  uint32_t frameWritten_, frameEncoded_, frameCrc_;
  uint16_t frameDelay_;
  uint8_t frameKind_;
  // Playback tail cursor: number of 16-byte records already appended to the active sector.
  uint16_t positionFill_;
  bool positionDirty_;
  alignas(4) uint8_t pending_[4];  // <4 trailing payload bytes not yet programmed
  alignas(4) uint8_t bulk_[64];    // staging, so every program source is word aligned
  unsigned pendingLen_;
  uint32_t programmed_;  // payload bytes already programmed for the open frame
  uint32_t encCrc_;  // running CRC of what was programmed; compared with a read-back
};
} }
#endif
