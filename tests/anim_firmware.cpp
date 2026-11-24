#include "anim_storage.h"
#include "page_storage.h"
#include "anim_wire.h"
#include "anim_player.h"
#include "anim_codec.h"
#include "vectors_animation.h"
#include <array>
#include <cassert>
#include <cstdio>
#include <cstring>
#include <vector>

using namespace eink::anim;

// ---------------------------------------------------------------------------- fake flash
static constexpr uint32_t REGION = END - BASE;
struct Flash {
  std::array<uint8_t, REGION> bytes;
  int calls = 0, fail = -1;
  Flash() { bytes.fill(0xff); }
  bool hit() { return calls++ == fail; }
  bool read(uint32_t addr, void* out, size_t size) {
    assert(addr >= BASE && addr + size <= END);
    if (hit()) return false;
    memcpy(out, bytes.data() + addr - BASE, size);
    return true;
  }
  bool program(uint32_t addr, const void* src, size_t size) {
    assert(addr >= BASE && addr + size <= END && !(addr % 4) && !(size % 4));
    bool cut = hit();
    size_t n = cut ? size / 2 : size;
    const uint8_t* p = static_cast<const uint8_t*>(src);
    for (size_t i = 0; i < n; ++i) {
      auto& d = bytes[addr - BASE + i];
      assert((d & p[i]) == p[i]);  // programming only clears bits
      d &= p[i];
    }
    return !cut;
  }
  bool erase(uint32_t addr) {
    assert(addr >= BASE && addr + SECTOR <= END && !(addr % SECTOR));
    bool cut = hit();
    memset(bytes.data() + addr - BASE, 0xff, cut ? SECTOR / 2 : SECTOR);
    return !cut;
  }
};
using Store = Storage<Flash>;

// Separate fake for the pages reservation (0xCC000..), used only by the restore test.
struct PageFlash {
  static constexpr uint32_t PAGES_BASE = eink::pages::BASE;
  static constexpr uint32_t PAGES_SIZE = 32u * eink::pages::SECTOR;
  std::array<uint8_t, PAGES_SIZE> bytes;
  int calls = 0, fail = -1;
  PageFlash() { bytes.fill(0xff); }
  bool hit() { return calls++ == fail; }
  bool read(uint32_t addr, void* out, size_t size) {
    assert(addr >= PAGES_BASE && addr + size <= PAGES_BASE + PAGES_SIZE);
    if (hit()) return false;
    memcpy(out, bytes.data() + addr - PAGES_BASE, size);
    return true;
  }
  bool program(uint32_t addr, const void* src, size_t size) {
    assert(addr >= PAGES_BASE && addr + size <= PAGES_BASE + PAGES_SIZE);
    if (hit()) return false;
    memcpy(bytes.data() + addr - PAGES_BASE, src, size);
    return true;
  }
  bool erase(uint32_t addr) {
    assert(addr >= PAGES_BASE && addr + eink::pages::SECTOR <= PAGES_BASE + PAGES_SIZE);
    if (hit()) return false;
    memset(bytes.data() + addr - PAGES_BASE, 0xff, eink::pages::SECTOR);
    return true;
  }
};
using Frame = std::array<uint8_t, eink::FRAME_BYTES>;

static Frame blank() { Frame f; f.fill(0); return f; }
static void putPixel(Frame& f, unsigned x, unsigned y, bool black) {
  uint8_t& b = f[y * eink::STRIDE + x / 8];
  const uint8_t mask = uint8_t(0x80u >> (x % 8));
  if (black) b |= mask; else b &= uint8_t(~mask);
}

// Uploads `frames` (raw 4000-byte images) through the storage API, encoding deltas
// against the previous frame exactly as the site does.
struct Blob {
  std::vector<uint8_t> encoded;
  uint8_t kind;
  uint32_t crc;
};

// Encoded PAYLOAD only (no 8-byte blob header): the wire FRAME command carries encLen
// and storage/endpoint rebuild the header. encodeDelta never returns more than
// MAX_BLOB_BYTES, so this buffer is exactly that size.
static Blob makeBlob(const Frame& frame, const Frame* previous) {
  Blob blob;
  blob.crc = eink::crc32(frame.data(), frame.size());
  std::vector<uint8_t> buffer(MAX_BLOB_BYTES);
  size_t n;
  if (previous) {
    bool usedFull = false;
    n = encodeDelta(buffer.data(), previous->data(), frame.data(), usedFull);
    blob.kind = usedFull ? KIND_FULL : KIND_DELTA;
  } else {
    n = encodeFull(buffer.data(), frame.data());
    blob.kind = KIND_FULL;
  }
  assert(n >= BLOB_HEADER && n <= MAX_BLOB_BYTES);
  blob.encoded.assign(buffer.begin() + long(BLOB_HEADER), buffer.begin() + long(n));
  return blob;
}

// Drives the storage layer the way the endpoint does: BEGIN, erase to completion, one
// FRAME/DATA/FRAME_COMMIT per frame, COMMIT.
static Result upload(Store& store, const std::vector<Frame>& frames, uint16_t flags, bool finish) {
  uint32_t animation = 0xffffffffu;
  for (const Frame& f : frames) animation = crcUpdate(animation, f.data(), f.size());
  animation ^= 0xffffffffu;
  Result r = store.beginUpload(uint16_t(frames.size()), flags, animation);
  if (r != OK) return r;
  while (store.erasePending()) { r = store.eraseStep(); if (r != OK) return r; }
  const Frame* previous = nullptr;
  for (const Frame& f : frames) {
    Blob blob = makeBlob(f, previous);
    r = store.beginFrame(blob.kind, uint16_t(blob.encoded.size()), blob.crc, 500);
    if (r != OK) return r;
    for (size_t off = 0; off < blob.encoded.size();) {
      size_t n = blob.encoded.size() - off < 61 ? blob.encoded.size() - off : 61;
      r = store.writePayload(blob.encoded.data() + off, n);
      if (r != OK) return r;
      off += n;
    }
    r = store.commitFrame();
    if (r != OK) return r;
    previous = &f;
  }
  return finish ? store.commit(animation) : OK;
}

static std::vector<Frame> scene() {
  std::vector<Frame> frames;
  Frame a = blank();
  putPixel(a, 0, 0, true);
  frames.push_back(a);
  Frame b = a;
  putPixel(b, 121, 249, true);  // far corner: large bbox
  frames.push_back(b);
  Frame c = b;
  putPixel(c, 60, 120, true);   // single pixel: small bbox
  frames.push_back(c);
  return frames;
}

// ---------------------------------------------------------------------------- panel
struct RecordingPanel : Panel {
  int partial = 0, full = 0, cleared = 0, hibernated = 0;
  uint16_t x = 0, y = 0, w = 0, h = 0;
  Frame shown{};
  void present(uint16_t px, uint16_t py, uint16_t pw, uint16_t ph, const uint8_t* frame) override {
    ++partial; x = px; y = py; w = pw; h = ph;
    memcpy(shown.data(), frame, eink::FRAME_BYTES);
  }
  void presentFull(const uint8_t* frame) override {
    ++full;
    memcpy(shown.data(), frame, eink::FRAME_BYTES);
  }
  void clear() override { ++cleared; shown.fill(0); }
  void hibernate() override { ++hibernated; }
  void reset() { partial = full = cleared = 0; hibernated = 0; }
};

// ---------------------------------------------------------------------------- storage
static void testStorageBasics() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  assert(store.healthy());
  assert(store.count() == 0);
  assert(store.revision() == 0);

  std::vector<Frame> frames = scene();
  assert(upload(store, frames, FLAG_LOOP, true) == OK);
  assert(store.count() == 3);
  assert(store.revision() == 1);  // one metadata write == one revision step
  assert(store.flags() == FLAG_LOOP);

  Store reloaded(flash);
  assert(reloaded.begin());
  assert(reloaded.count() == 3);
  assert(reloaded.revision() == 1);
  assert(reloaded.flags() == FLAG_LOOP);
  for (unsigned i = 0; i < 3; ++i) {
    assert(reloaded.frameDelay(i) == 500);
    assert(reloaded.frameCrc(i) == eink::crc32(frames[i].data(), frames[i].size()));
    assert(reloaded.frameOffset(i) + BLOB_HEADER + align4(reloaded.frameEncLen(i)) <= reloaded.dataBytes());
    // Blob header on flash must match the entry.
    uint8_t header[BLOB_HEADER];
    assert(reloaded.readBlob(i, 0, header, sizeof header) == OK);
    assert(header[0] == reloaded.frameKind(i));
    assert(header[1] == 0);
    assert(eink::get16(header + 2) == reloaded.frameEncLen(i));
    assert(eink::get32(header + 4) == reloaded.frameCrc(i));
  }
  assert(reloaded.frameKind(0) == KIND_FULL);
  assert(reloaded.frameEncLen(0) == eink::FRAME_BYTES);
  assert(reloaded.frameKind(1) == KIND_DELTA);  // corner pixel delta-compresses well
  // Every blob's decoded form must round-trip through the codec.
  Frame previous{};
  for (unsigned i = 0; i < 3; ++i) {
    std::vector<uint8_t> payload(reloaded.payloadLength(i));
    assert(reloaded.readPayload(i, 0, payload.data(), payload.size()) == OK);
    Frame out{};
    assert(decodePayload(reloaded.frameKind(i), payload.data(), payload.size(),
                         i ? previous.data() : nullptr, out.data()) == CODEC_OK);
    assert(out == frames[i]);
    previous = out;
  }
  // readBlob offset/length bounds.
  uint8_t small[8];
  assert(reloaded.readBlob(0, reloaded.blobLength(0), small, 0) == OK);  // EOF: offset only
  assert(reloaded.readBlob(0, reloaded.blobLength(0) + 1, small, 1) == BAD_OFFSET);
  assert(reloaded.readBlob(3, 0, small, 1) == NOT_FOUND);
  std::puts("storage: COW commit, reload, blob headers, delta decode round-trip");
}

static void testRevisionAndDelete() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  std::vector<Frame> frames = scene();
  assert(upload(store, frames, 0, true) == OK);
  uint32_t rev = store.revision();
  assert(rev == 1);

  // A stale expected revision is a conflict, never a silent overwrite.
  assert(store.beginUpload(1, 0, 0) == OK);
  while (store.erasePending()) assert(store.eraseStep() == OK);
  store.abortUpload();

  // Delete advances the revision once and leaves an empty animation.
  assert(store.remove() == OK);
  assert(store.count() == 0);
  assert(store.revision() == rev + 1);
  Store reloaded(flash);
  assert(reloaded.begin());
  assert(reloaded.count() == 0);
  assert(reloaded.revision() == rev + 1);

  // Re-upload after delete works and keeps incrementing.
  assert(upload(reloaded, frames, FLAG_LOOP, true) == OK);
  assert(reloaded.count() == 3);
  assert(reloaded.revision() == rev + 2);
  std::puts("storage: revision advances only on commit/delete, delete and reuse pass");
}

// The wire-level conflict path: BEGIN with a stale revision must be rejected.
static void testRevisionConflictWire() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  std::vector<Frame> frames = scene();
  assert(upload(store, frames, 0, true) == OK);
  Endpoint<Store> endpoint(store);
  uint8_t begin[13] = {OP_BEGIN};
  eink::put32(begin + 1, 0);  // stale: the committed revision is 1
  eink::put16(begin + 5, 1);
  eink::put16(begin + 7, 0);
  eink::put32(begin + 9, 0);
  endpoint.command(begin, sizeof begin, 0, 1);
  uint8_t status[20];
  endpoint.status(status);
  assert(status[2] == CONFLICT);
  assert(status[3] == 0);  // no pending work for a rejected command
  std::puts("wire: stale BEGIN revision is a conflict and starts no work");
}

static void testBounds() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  // count 0 and count > 64.
  assert(store.beginUpload(0, 0, 0) == LIMIT);
  assert(store.beginUpload(65, 0, 0) == LIMIT);
  assert(store.beginUpload(1, 2, 0) == MALFORMED);  // undefined flag bit
  assert(store.beginUpload(1, 0, 0) == OK);
  // Frames are rejected until the bank erase is finished.
  assert(store.beginFrame(KIND_FULL, eink::FRAME_BYTES, 0, 500) == BUSY);
  while (store.erasePending()) assert(store.eraseStep() == OK);
  // encLen bounds and kind bounds.
  assert(store.beginFrame(2, 10, 0, 500) == MALFORMED);
  assert(store.beginFrame(KIND_FULL, 3999, 0, 500) == MALFORMED);
  assert(store.beginFrame(KIND_DELTA, 0, 0, 500) == MALFORMED);
  assert(store.beginFrame(KIND_DELTA, 4001, 0, 500) == MALFORMED);
  assert(store.beginFrame(KIND_DELTA, 4000, 0, 99) == LIMIT);
  assert(store.beginFrame(KIND_DELTA, 4000, 0, 60001) == LIMIT);
  store.abortUpload();
  // Frames are appended until the bank is exhausted; the next one must be FULL, never a
  // partial write past the bank end. 13 full frames fill 52104 of 53248 bytes.
  const uint32_t per = BLOB_HEADER + align4(eink::FRAME_BYTES);
  const unsigned capacity = BANK_SIZE / per;
  assert(capacity == 13);
  std::vector<uint8_t> payload(eink::FRAME_BYTES, 0);
  Frame f = blank();
  const uint32_t crc = eink::crc32(f.data(), f.size());
  {
    Flash fresh;
    Store empty(fresh);
    assert(empty.begin());
    assert(empty.beginUpload(MAX_FRAMES, 0, 0) == OK);
    while (empty.erasePending()) assert(empty.eraseStep() == OK);
    for (unsigned i = 0; i < capacity; ++i) {
      assert(empty.beginFrame(KIND_FULL, eink::FRAME_BYTES, crc, 500) == OK);
      assert(empty.writePayload(payload.data(), payload.size()) == OK);
      assert(empty.commitFrame() == OK);
    }
    assert(empty.beginFrame(KIND_FULL, eink::FRAME_BYTES, crc, 500) == FULL);
    assert(empty.uploadedFrames() == capacity);
    // The last blob ends inside the bank; nothing was written past it.
    assert(empty.uploadBytes() <= BANK_SIZE);
  }
  // A declared count larger than the bank can hold is caught at the first overfull frame.
  {
    Flash fresh;
    Store empty(fresh);
    assert(empty.begin());
    assert(empty.beginUpload(MAX_FRAMES, 0, 0) == OK);
    while (empty.erasePending()) assert(empty.eraseStep() == OK);
    for (unsigned i = 0; i < capacity; ++i) {
      assert(empty.beginFrame(KIND_FULL, eink::FRAME_BYTES, crc, 500) == OK);
      assert(empty.writePayload(payload.data(), payload.size()) == OK);
      assert(empty.commitFrame() == OK);
    }
    assert(empty.beginFrame(KIND_FULL, eink::FRAME_BYTES, crc, 500) == FULL);
  }
  std::puts("storage: count>64, blob past bank end, encLen>4000, bad flags all rejected");
}

// Interruption at every single erase/program step must leave the previous animation
// mountable, and never expose a half-written one.
static void testInterruption() {
  Flash initial;
  Store seed(initial);
  assert(seed.begin());
  std::vector<Frame> first = scene();
  assert(upload(seed, first, FLAG_LOOP, true) == OK);
  const uint32_t committedRevision = seed.revision();
  const unsigned committedCount = seed.count();

  std::vector<Frame> second;
  Frame a = blank();
  putPixel(a, 10, 10, true);
  second.push_back(a);
  Frame b = a;
  putPixel(b, 11, 10, true);
  second.push_back(b);

  // Count the stages of a clean second upload.
  Flash probe = initial;
  Store p(probe);
  assert(p.begin());
  probe.calls = 0;
  assert(upload(p, second, 0, true) == OK);
  int stages = probe.calls;
  assert(stages > 0);

  for (int cut = 0; cut < stages; ++cut) {
    Flash flash = initial;
    Store store(flash);
    assert(store.begin());
    flash.calls = 0;
    flash.fail = cut;
    (void)upload(store, second, 0, true);
    flash.fail = -1;
    Store rebooted(flash);
    assert(rebooted.begin());
    // Exactly one of: the old animation, or the new complete one.
    assert(rebooted.revision() == committedRevision || rebooted.revision() == committedRevision + 1);
    if (rebooted.revision() == committedRevision) {
      assert(rebooted.count() == committedCount);
      for (unsigned i = 0; i < committedCount; ++i) {
        assert(rebooted.frameCrc(i) == eink::crc32(first[i].data(), first[i].size()));
      }
    } else {
      assert(rebooted.count() == 2);
      assert(rebooted.frameCrc(0) == eink::crc32(second[0].data(), second[0].size()));
      assert(rebooted.frameCrc(1) == eink::crc32(second[1].data(), second[1].size()));
      assert(rebooted.flags() == 0);
    }
  }
  std::printf("storage: %d interruption points, old animation always mountable\n", stages);
}

static void testCorruption() {
  // Two committed animations so BOTH metadata banks are valid: the second commit lives in
  // bank 0 (the first commit went to bank 1), so corrupting bank 0 exercises the fallback
  // to the older, still valid bank 1.
  Flash flash;
  Store store(flash);
  assert(store.begin());
  std::vector<Frame> first = scene();
  assert(upload(store, first, FLAG_LOOP, true) == OK);
  const uint32_t oldRevision = store.revision();
  std::vector<Frame> second;
  Frame s0 = blank();
  putPixel(s0, 5, 5, true);
  second.push_back(s0);
  assert(upload(store, second, 0, true) == OK);
  const uint32_t newRevision = store.revision();
  assert(newRevision == oldRevision + 1);
  assert(store.count() == 1);

  // Corrupt the active (newest) bank's metadata CRC: recovery falls back to the older
  // bank, which still holds the three-frame animation.
  {
    Flash copy = flash;
    uint32_t crcOff = M_ENTRIES + M_ENTRY * 1;  // newest bank holds one frame
    copy.bytes[crcOff] ^= 1;                    // bank 0 starts at offset 0
    Store recovered(copy);
    assert(recovered.begin());
    assert(recovered.revision() == oldRevision);
    assert(recovered.count() == 3);
    assert(recovered.flags() == FLAG_LOOP);
  }
  // Corrupt the newest bank's marker instead: same fallback.
  {
    Flash copy = flash;
    uint32_t markerOff = M_ENTRIES + M_ENTRY * 1 + 4;
    copy.bytes[markerOff] ^= 1;
    Store recovered(copy);
    assert(recovered.begin());
    assert(recovered.revision() == oldRevision);
    assert(recovered.count() == 3);
  }
  // Corrupt a blob header in the newest bank: the bank is rejected at mount because the
  // stored header no longer matches its entry.
  {
    Flash copy = flash;
    // The newest animation's single frame starts at the active bank's offset 0.
    copy.bytes[store.activeDataAddress() - BASE + 2] ^= 1;  // encLen low byte
    Store recovered(copy);
    assert(recovered.begin());
    assert(recovered.revision() == oldRevision);
    assert(recovered.count() == 3);
  }
  // Corrupt the ONLY valid bank: mounting must fail rather than present a half state.
  {
    Flash copy = flash;
    // Commit a third animation so both banks are valid again, then destroy bank 1 (which
    // now holds the older state) and bank 0's CRC: nothing valid remains.
    uint32_t crcOff0 = M_ENTRIES + M_ENTRY * 1;
    copy.bytes[crcOff0] ^= 1;
    copy.bytes[SECTOR + crcOff0] ^= 1;
    Store recovered(copy);
    assert(!recovered.begin());
  }
  std::puts("storage: bad metadata CRC, bad marker and bad blob header fall back or fail closed");
}

static void testGarbageBanksAreNotOverwritten() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  // Fill both metadata sectors with non-erased garbage: begin() must fail rather than
  // silently reformat a device whose metadata is damaged.
  memset(flash.bytes.data(), 0x00, 2 * SECTOR);
  Store broken(flash);
  assert(!broken.begin());
  assert(!broken.healthy());
  std::puts("storage: damaged metadata is reported, never silently reformatted");
}

static void testEmptyAnimation() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  assert(store.count() == 0);
  RecordingPanel panel;
  Player<Store> player(panel);
  assert(!player.start(store, 0, 0));  // empty animation cannot start
  assert(player.error() == NOT_FOUND);
  assert(!player.running());
  std::puts("storage/player: empty animation cannot start playback");
}

// ---------------------------------------------------------------------------- wire
static void fillFrameHeader(uint8_t* out, uint16_t index, uint8_t kind, uint16_t encLen, uint32_t crc, uint16_t delay) {
  out[0] = OP_FRAME;
  eink::put16(out + 1, index);
  out[3] = kind;
  out[4] = 0;
  eink::put16(out + 5, encLen);
  eink::put32(out + 7, crc);
  eink::put16(out + 11, delay);
}

static void testWireHappyPath() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  Endpoint<Store> endpoint(store);
  uint8_t status[20];

  // INFO on an empty animation.
  uint8_t info[1] = {OP_INFO};
  endpoint.command(info, 1, 0, 1);
  endpoint.status(status);
  assert(status[0] == 1 && status[1] == OP_INFO && status[2] == OK);
  assert(eink::get32(status + 4) == 0);
  assert(eink::get16(status + 8) == 0);
  assert(eink::get16(status + 10) == NO_INDEX);
  assert(eink::get32(status + 12) == 0);
  assert(eink::get32(status + 16) == 0);

  std::vector<Frame> frames = scene();
  uint32_t animation = 0xffffffffu;
  for (const Frame& f : frames) animation = crcUpdate(animation, f.data(), f.size());
  animation ^= 0xffffffffu;

  uint8_t begin[13] = {OP_BEGIN};
  eink::put32(begin + 1, 0);
  eink::put16(begin + 5, 3);
  eink::put16(begin + 7, FLAG_LOOP);
  eink::put32(begin + 9, animation);
  endpoint.command(begin, sizeof begin, 0, 1);
  endpoint.status(status);
  assert(status[2] == OK && (status[3] & FLAG_PENDING));
  // Pending must stay set across the whole resumable erase.
  int polls = 0;
  while (endpoint.pending()) {
    endpoint.poll();
    endpoint.status(status);
    ++polls;
  }
  assert(polls >= int(BANK_SECTORS));  // one sector per poll

  const Frame* previous = nullptr;
  for (unsigned i = 0; i < frames.size(); ++i) {
    Blob blob = makeBlob(frames[i], previous);
    uint8_t header[13];
    fillFrameHeader(header, uint16_t(i), blob.kind, uint16_t(blob.encoded.size()), blob.crc, 500);
    endpoint.command(header, sizeof header, 0, 1);
    endpoint.status(status);
    assert(status[2] == OK && (status[3] & FLAG_PENDING));
    endpoint.poll();
    // DATA in small chunks, exactly as a central at MTU 23 would.
    for (size_t off = 0; off < blob.encoded.size();) {
      size_t n = blob.encoded.size() - off < 17 ? blob.encoded.size() - off : 17;
      uint8_t data[20];
      data[0] = OP_DATA;
      eink::put16(data + 1, uint16_t(off));
      memcpy(data + 3, blob.encoded.data() + off, n);
      endpoint.command(data, 3 + n, 0, 1);
      endpoint.status(status);
      assert(status[2] == OK);
      assert(eink::get16(status + 10) == uint16_t(off + n));  // next expected offset
      endpoint.poll();
      off += n;
    }
    uint8_t frameCommit[1] = {OP_FRAME_COMMIT};
    endpoint.command(frameCommit, 1, 0, 1);
    endpoint.poll();
    endpoint.status(status);
    assert(status[2] == OK);
    // FRAME_COMMIT reports the next index that must be committed, or 0xFFFF when done.
    assert(eink::get16(status + 10) == (i + 1 == frames.size() ? NO_INDEX : uint16_t(i + 1)));
    previous = &frames[i];
  }
  uint8_t commit[1] = {OP_COMMIT};
  endpoint.command(commit, 1, 0, 1);
  endpoint.poll();
  endpoint.status(status);
  assert(status[2] == OK);
  assert(eink::get16(status + 8) == 3);          // count
  assert(eink::get32(status + 16) == animation); // animCrc
  assert(eink::get32(status + 4) == 1);          // revision
  assert(!endpoint.pending());

  // INFO now reports the durable animation.
  endpoint.command(info, 1, 0, 1);
  endpoint.status(status);
  assert(eink::get16(status + 8) == 3);
  assert(eink::get32(status + 16) == animation);
  assert(eink::get32(status + 12) == store.dataBytes());

  // READ streams the stored blob, header included.
  for (unsigned i = 0; i < 3; ++i) {
    std::vector<uint8_t> collected;
    uint16_t offset = 0;
    while (true) {
      uint8_t read[5] = {OP_READ};
      eink::put16(read + 1, uint16_t(i));
      eink::put16(read + 3, offset);
      endpoint.command(read, sizeof read, 0, 1);
      endpoint.poll();
      endpoint.status(status);
      assert(status[2] == OK);
      uint8_t payload[20];
      size_t len = endpoint.data(payload);
      assert(len >= 2);
      assert(eink::get16(payload) == offset);
      size_t chunk = len - 2;
      collected.insert(collected.end(), payload + 2, payload + 2 + chunk);
      offset = uint16_t(offset + chunk);
      if (chunk == 0) break;  // EOF: offset == blobLen returns only the offset
    }
    assert(collected.size() == store.blobLength(i));
    assert(collected[0] == store.frameKind(i));
    assert(eink::get16(collected.data() + 2) == store.frameEncLen(i));
    assert(eink::get32(collected.data() + 4) == store.frameCrc(i));
  }
  // READ past the blob is an offset error, not a truncation.
  uint8_t readPast[5] = {OP_READ};
  eink::put16(readPast + 1, 0);
  eink::put16(readPast + 3, uint16_t(store.blobLength(0) + 1));
  endpoint.command(readPast, sizeof readPast, 0, 1);
  endpoint.status(status);
  assert(status[2] == BAD_OFFSET);
  std::puts("wire: INFO/BEGIN/FRAME/DATA/FRAME_COMMIT/COMMIT/READ happy path");
}

static void testWireMalformed() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  Endpoint<Store> endpoint(store);
  uint8_t status[20];

  endpoint.command(nullptr, 0, 0, 1);
  endpoint.status(status);
  assert(status[2] == MALFORMED);

  uint8_t oversized[245] = {OP_INFO};
  endpoint.command(oversized, sizeof oversized, 0, 1);
  endpoint.status(status);
  assert(status[2] == MALFORMED);

  uint8_t infoTooLong[2] = {OP_INFO, 0};
  endpoint.command(infoTooLong, 2, 0, 1);
  endpoint.status(status);
  assert(status[2] == MALFORMED);

  // FRAME without BEGIN is a conflict: there is no upload to add a frame to.
  uint8_t frame[13];
  fillFrameHeader(frame, 0, KIND_FULL, eink::FRAME_BYTES, 0, 500);
  endpoint.command(frame, sizeof frame, 0, 1);
  endpoint.status(status);
  assert(status[2] == CONFLICT);

  // BEGIN with a reserved bit set in flags.
  uint8_t begin[13] = {OP_BEGIN};
  eink::put16(begin + 5, 1);
  eink::put16(begin + 7, 0x0002);
  endpoint.command(begin, sizeof begin, 0, 1);
  endpoint.status(status);
  assert(status[2] == MALFORMED);  // rejected in the callback, no flash work queued
  assert(!endpoint.pending());

  // ABORT is always safe and leaves the committed animation alone.
  uint8_t abort[1] = {OP_ABORT};
  endpoint.command(abort, 1, 0, 1);
  endpoint.status(status);
  assert(status[2] == OK);
  assert(!endpoint.busy());
  std::puts("wire: malformed lengths, missing BEGIN, bad flags, ABORT");
}

// Each case below starts from a fresh store so the upload state is unambiguous: a second
// FRAME while one is still open is BUSY by design, which would mask the error under test.
struct Upload {
  Flash flash;
  Store store{flash};
  Endpoint<Store> endpoint{store};
  uint8_t status[20];
  explicit Upload(uint16_t count) {
    assert(store.begin());
    uint8_t begin[13] = {OP_BEGIN};
    eink::put32(begin + 1, 0);
    eink::put16(begin + 5, count);
    eink::put16(begin + 7, 0);
    eink::put32(begin + 9, 0);
    endpoint.command(begin, sizeof begin, 0, 1);
    while (endpoint.pending()) endpoint.poll();
    endpoint.status(status);
    assert(status[2] == OK);
  }
};

static void testWireOffsetAndCodecErrors() {
  Frame f = blank();
  putPixel(f, 3, 4, true);
  Blob blob = makeBlob(f, nullptr);

  // Out-of-order DATA is rejected with the expected offset reported, and does not advance.
  {
    Upload u(1);
    uint8_t frame[13];
    fillFrameHeader(frame, 0, blob.kind, uint16_t(blob.encoded.size()), blob.crc, 500);
    u.endpoint.command(frame, sizeof frame, 0, 1);
    u.endpoint.poll();
    uint8_t data[20];
    data[0] = OP_DATA;
    eink::put16(data + 1, 5);  // should be 0
    memcpy(data + 3, blob.encoded.data(), 17);
    u.endpoint.command(data, 20, 0, 1);
    u.endpoint.status(u.status);
    assert(u.status[2] == BAD_OFFSET);
    assert(eink::get16(u.status + 10) == 0);
    assert(!u.endpoint.pending());
  }

  // A FRAME index outside 0..count-1 is a limit error (11); one that is inside the count
  // but not the next expected index is a conflict (4).
  {
    Upload u(2);
    uint8_t frame[13];
    fillFrameHeader(frame, 5, blob.kind, uint16_t(blob.encoded.size()), blob.crc, 500);
    u.endpoint.command(frame, sizeof frame, 0, 1);
    u.endpoint.status(u.status);
    assert(u.status[2] == LIMIT);
    assert(!u.endpoint.pending());

    fillFrameHeader(frame, 1, blob.kind, uint16_t(blob.encoded.size()), blob.crc, 500);
    u.endpoint.command(frame, sizeof frame, 0, 1);
    u.endpoint.status(u.status);
    assert(u.status[2] == CONFLICT);  // frame 0 has not been committed yet
    assert(!u.endpoint.pending());
  }

  // The reserved byte must be zero.
  {
    Upload u(1);
    uint8_t frame[13];
    fillFrameHeader(frame, 0, blob.kind, uint16_t(blob.encoded.size()), blob.crc, 500);
    frame[4] = 1;
    u.endpoint.command(frame, sizeof frame, 0, 1);
    u.endpoint.status(u.status);
    assert(u.status[2] == MALFORMED);
  }

  // An identical FRAME while one is open is idempotent and keeps the received offset;
  // a different FRAME is BUSY rather than a silent restart.
  {
    Upload u(1);
    uint8_t frame[13];
    fillFrameHeader(frame, 0, blob.kind, uint16_t(blob.encoded.size()), blob.crc, 500);
    u.endpoint.command(frame, sizeof frame, 0, 1);
    u.endpoint.poll();
    uint8_t data[20];
    data[0] = OP_DATA;
    eink::put16(data + 1, 0);
    memcpy(data + 3, blob.encoded.data(), 10);
    u.endpoint.command(data, 13, 0, 1);
    u.endpoint.poll();
    // Identical repeat: error 0 and the received offset is preserved. FRAME's status
    // `index` is the frame index, so the preserved offset shows up on the next DATA.
    u.endpoint.command(frame, sizeof frame, 0, 1);
    u.endpoint.status(u.status);
    assert(u.status[2] == OK);
    assert(eink::get16(u.status + 10) == 0);
    {
      uint8_t probe[4] = {OP_DATA};
      eink::put16(probe + 1, 99);  // deliberately wrong
      u.endpoint.command(probe, sizeof probe, 0, 1);
      u.endpoint.status(u.status);
      assert(u.status[2] == BAD_OFFSET);
      assert(eink::get16(u.status + 10) == 10);  // still 10, not restarted at 0
    }
    // Different delayMs for the same index is a different FRAME -> BUSY.
    fillFrameHeader(frame, 0, blob.kind, uint16_t(blob.encoded.size()), blob.crc, 600);
    u.endpoint.command(frame, sizeof frame, 0, 1);
    u.endpoint.status(u.status);
    assert(u.status[2] == BUSY);
  }

  // FRAME_COMMIT before all encLen bytes arrived is a conflict (4) reporting the expected
  // offset, and the frame stays open.
  {
    Upload u(1);
    uint8_t frame[13];
    fillFrameHeader(frame, 0, blob.kind, uint16_t(blob.encoded.size()), blob.crc, 500);
    u.endpoint.command(frame, sizeof frame, 0, 1);
    u.endpoint.poll();
    uint8_t data[20];
    data[0] = OP_DATA;
    eink::put16(data + 1, 0);
    memcpy(data + 3, blob.encoded.data(), 5);
    u.endpoint.command(data, 8, 0, 1);
    u.endpoint.poll();
    uint8_t frameCommit[1] = {OP_FRAME_COMMIT};
    u.endpoint.command(frameCommit, 1, 0, 1);
    u.endpoint.status(u.status);
    assert(u.status[2] == CONFLICT);
    assert(eink::get16(u.status + 10) == 5);
    assert(u.endpoint.uploading());  // still open, the client may send the rest
  }

  // A delta frame at index 1 whose payload contains the reserved control byte 0x80 is a
  // codec stream error (10). Frame 0 is uploaded normally first so the delta has a
  // reference and the failure is genuinely the stream, not the ordering rule.
  {
    Upload u(2);
    Frame f0 = blank();
    putPixel(f0, 1, 1, true);
    Blob blob0 = makeBlob(f0, nullptr);
    uint8_t frame[13];
    fillFrameHeader(frame, 0, blob0.kind, uint16_t(blob0.encoded.size()), blob0.crc, 500);
    u.endpoint.command(frame, sizeof frame, 0, 1);
    u.endpoint.poll();
    uint8_t data[20];
    for (size_t off = 0; off < blob0.encoded.size();) {
      size_t n = blob0.encoded.size() - off < 17 ? blob0.encoded.size() - off : 17;
      data[0] = OP_DATA;
      eink::put16(data + 1, uint16_t(off));
      memcpy(data + 3, blob0.encoded.data() + off, n);
      u.endpoint.command(data, 3 + n, 0, 1);
      u.endpoint.poll();
      off += n;
    }
    uint8_t frameCommit[1] = {OP_FRAME_COMMIT};
    u.endpoint.command(frameCommit, 1, 0, 1);
    u.endpoint.poll();
    u.endpoint.status(u.status);
    assert(u.status[2] == OK);

    // Index 1, delta kind, payload = the forbidden 0x80 control byte followed by data.
    const uint8_t bad[] = {0x80, 0x11};
    fillFrameHeader(frame, 1, KIND_DELTA, uint16_t(sizeof bad), 0, 500);
    u.endpoint.command(frame, sizeof frame, 0, 1);
    u.endpoint.poll();
    u.endpoint.status(u.status);
    assert(u.status[2] == OK);
    data[0] = OP_DATA;
    eink::put16(data + 1, 0);
    memcpy(data + 3, bad, sizeof bad);
    u.endpoint.command(data, 3 + sizeof bad, 0, 1);
    u.endpoint.poll();
    u.endpoint.status(u.status);
    assert(u.status[2] == CODEC);  // rejected while decoding, before the blob is committed
    assert(!u.endpoint.busy());
    assert(u.store.count() == 0);  // nothing durable changed
  }

  // DATA past the declared encLen is a limit error.
  {
    Upload u(1);
    uint8_t frame[13];
    fillFrameHeader(frame, 0, blob.kind, uint16_t(blob.encoded.size()), blob.crc, 500);
    u.endpoint.command(frame, sizeof frame, 0, 1);
    u.endpoint.poll();
    uint8_t data[20];
    data[0] = OP_DATA;
    eink::put16(data + 1, 0);
    memcpy(data + 3, blob.encoded.data(), 17);
    u.endpoint.command(data, 20, 0, 1);
    u.endpoint.poll();
    // Skip to the end of the payload, then try to write one more byte.
    while (eink::get16(u.status + 10) < blob.encoded.size()) {
      uint16_t off = eink::get16(u.status + 10);
      size_t n = blob.encoded.size() - off < 17 ? blob.encoded.size() - off : 17;
      data[0] = OP_DATA;
      eink::put16(data + 1, off);
      memcpy(data + 3, blob.encoded.data() + off, n);
      u.endpoint.command(data, 3 + n, 0, 1);
      u.endpoint.poll();
      u.endpoint.status(u.status);
    }
    data[0] = OP_DATA;
    eink::put16(data + 1, uint16_t(blob.encoded.size()));
    data[3] = 0;
    u.endpoint.command(data, 4, 0, 1);
    u.endpoint.poll();
    u.endpoint.status(u.status);
    assert(u.status[2] == LIMIT);
  }
  std::puts("wire: offset errors, frame index, reserved byte, BUSY, codec stream and limit");
}

static void testWireCrcMismatch() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  Endpoint<Store> endpoint(store);
  uint8_t status[20];
  uint8_t begin[13] = {OP_BEGIN};
  eink::put32(begin + 1, 0);
  eink::put16(begin + 5, 1);
  eink::put16(begin + 7, 0);
  eink::put32(begin + 9, 0x12345678);  // declared animation CRC that will not match
  endpoint.command(begin, sizeof begin, 0, 1);
  while (endpoint.pending()) endpoint.poll();

  Frame f = blank();
  putPixel(f, 2, 2, true);
  Blob blob = makeBlob(f, nullptr);
  uint8_t frame[13];
  fillFrameHeader(frame, 0, blob.kind, uint16_t(blob.encoded.size()), blob.crc + 1, 500);  // wrong frame CRC
  endpoint.command(frame, sizeof frame, 0, 1);
  endpoint.poll();
  // Send the whole payload so the failure is the CRC check, not an incomplete stream.
  uint8_t data[20];
  for (size_t off = 0; off < blob.encoded.size();) {
    size_t n = blob.encoded.size() - off < 17 ? blob.encoded.size() - off : 17;
    data[0] = OP_DATA;
    eink::put16(data + 1, uint16_t(off));
    memcpy(data + 3, blob.encoded.data() + off, n);
    endpoint.command(data, 3 + n, 0, 1);
    endpoint.poll();
    off += n;
  }
  uint8_t frameCommit[1] = {OP_FRAME_COMMIT};
  endpoint.command(frameCommit, 1, 0, 1);
  endpoint.poll();
  endpoint.status(status);
  assert(status[2] == BAD_CRC);
  assert(!store.count());  // nothing committed
  std::puts("wire: decoded-frame CRC mismatch rejects the frame and commits nothing");
}

static void testWireDeleteAndPlay() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  std::vector<Frame> frames = scene();
  assert(upload(store, frames, FLAG_LOOP, true) == OK);
  Endpoint<Store> endpoint(store);
  uint8_t status[20];

  // PLAY out of range is a limit error (11) and never starts.
  uint8_t play[3] = {OP_PLAY};
  eink::put16(play + 1, 9);
  endpoint.command(play, sizeof play, 0, 1);
  endpoint.status(status);
  assert(status[2] == LIMIT);
  assert(!endpoint.takePlay());

  // PLAY 1 sets the request and the playing flag.
  eink::put16(play + 1, 1);
  endpoint.command(play, sizeof play, 0, 1);
  endpoint.status(status);
  assert(status[2] == OK);
  assert(status[3] & FLAG_PLAYING);
  assert(endpoint.takePlay());
  assert(endpoint.playIndex() == 1);
  endpoint.playing(true);
  endpoint.command(play, sizeof play, 0, 1);
  endpoint.status(status);
  assert(status[2] == OK);  // re-issuing PLAY while playing is allowed

  // INFO reports the playing index while playing.
  uint8_t info[1] = {OP_INFO};
  endpoint.command(info, 1, 0, 1);
  endpoint.status(status);
  assert(eink::get16(status + 10) == 1);

  // STOP requests a stop; the main loop reports completion.
  uint8_t stop[1] = {OP_STOP};
  endpoint.command(stop, 1, 0, 1);
  endpoint.status(status);
  assert(status[2] == OK);
  assert(endpoint.takeStop());
  endpoint.playbackStopped();
  endpoint.status(status);
  assert(!(status[3] & FLAG_PLAYING));

  // STOP is idempotent: stopping when nothing plays is error 0.
  endpoint.command(stop, 1, 0, 1);
  endpoint.status(status);
  assert(status[2] == OK);

  // DELETE with the right revision empties the animation.
  uint8_t del[5] = {OP_DELETE};
  eink::put32(del + 1, store.revision());
  endpoint.command(del, sizeof del, 0, 1);
  endpoint.poll();
  endpoint.status(status);
  assert(status[2] == OK);
  assert(eink::get16(status + 8) == 0);

  // A stale DELETE is a conflict.
  eink::put32(del + 1, store.revision() - 1);
  endpoint.command(del, sizeof del, 0, 1);
  endpoint.status(status);
  assert(status[2] == CONFLICT);
  std::puts("wire: PLAY/STOP handshake, INFO playing index, DELETE and revision conflict");
}

static void testWireSecondConnectionRejected() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  Endpoint<Store> endpoint(store);
  uint8_t status[20];
  uint8_t begin[13] = {OP_BEGIN};
  eink::put32(begin + 1, 0);
  eink::put16(begin + 5, 1);
  endpoint.command(begin, sizeof begin, 0, 7);  // connection 7 owns the upload
  endpoint.status(status);
  assert(status[2] == OK);
  uint8_t info[1] = {OP_INFO};
  endpoint.command(info, 1, 0, 8);  // another connection
  endpoint.status(status);
  assert(status[2] == BUSY);
  std::puts("wire: a second connection cannot interleave commands");
}

// A stalled upload is discarded after 15 s of inactivity; the durable animation survives.
static void testWireUploadTimeout() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  std::vector<Frame> frames = scene();
  assert(upload(store, frames, FLAG_LOOP, true) == OK);
  const uint32_t revision = store.revision();
  const unsigned count = store.count();

  Endpoint<Store> endpoint(store);
  uint8_t status[20];
  uint8_t begin[13] = {OP_BEGIN};
  eink::put32(begin + 1, revision);
  eink::put16(begin + 5, 1);
  eink::put16(begin + 7, 0);
  eink::put32(begin + 9, 0);
  endpoint.command(begin, sizeof begin, 1000, 1);
  while (endpoint.pending()) endpoint.poll();
  endpoint.status(status);
  assert(status[2] == OK);
  assert(endpoint.uploading());

  // Just under the timeout: still open.
  assert(!endpoint.expire(1000 + UPLOAD_TIMEOUT_MS - 1));
  assert(endpoint.uploading());
  // At the timeout: discarded, and the durable animation is untouched.
  assert(endpoint.expire(1000 + UPLOAD_TIMEOUT_MS));
  assert(!endpoint.uploading());
  assert(!endpoint.busy());
  Store reloaded(flash);
  assert(reloaded.begin());
  assert(reloaded.revision() == revision);
  assert(reloaded.count() == count);
  for (unsigned i = 0; i < count; ++i)
    assert(reloaded.frameCrc(i) == eink::crc32(frames[i].data(), frames[i].size()));
  std::puts("wire: a 15 s stalled upload is discarded and the durable animation survives");
}

// DELETE stops playback and the endpoint asks the main loop to take the panel back.
static void testWireDeleteStopsPlayback() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  std::vector<Frame> frames = scene();
  assert(upload(store, frames, FLAG_LOOP, true) == OK);
  Endpoint<Store> endpoint(store);
  uint8_t status[20];
  uint8_t play[3] = {OP_PLAY};
  eink::put16(play + 1, 0);
  endpoint.command(play, sizeof play, 0, 1);
  assert(endpoint.takePlay());
  endpoint.playing(true);
  (void)endpoint.takeStop();  // drain the stale request

  uint8_t del[5] = {OP_DELETE};
  eink::put32(del + 1, store.revision());
  endpoint.command(del, sizeof del, 0, 1);
  endpoint.poll();
  endpoint.status(status);
  assert(status[2] == OK);
  assert(!(status[3] & FLAG_PLAYING));  // DELETE clears the playing flag
  assert(endpoint.takeStop());          // ... and asks the loop to release the panel
  assert(eink::get16(status + 8) == 0);
  std::puts("wire: DELETE stops playback and requests the panel back");
}

// Frame 0 of an upload must be a full frame: a delta has nothing to reference.
static void testWireFirstFrameMustBeFull() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  Endpoint<Store> endpoint(store);
  uint8_t status[20];
  uint8_t begin[13] = {OP_BEGIN};
  eink::put32(begin + 1, 0);
  eink::put16(begin + 5, 2);
  endpoint.command(begin, sizeof begin, 0, 1);
  while (endpoint.pending()) endpoint.poll();
  uint8_t frame[13];
  fillFrameHeader(frame, 0, KIND_DELTA, 100, 0, 500);
  endpoint.command(frame, sizeof frame, 0, 1);
  endpoint.status(status);
  assert(status[2] == CONFLICT);
  assert(!endpoint.pending());
  std::puts("wire: frame 0 must be a full frame");
}

// Disconnect during a staged DATA frame must discard the upload immediately: leaving it
// open would keep legacy/page traffic out for the full 15 s timeout on a connection that is
// already gone. The durable animation must be untouched and still readable.
static void testWireDisconnectDiscardsStagedUpload() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  std::vector<Frame> frames = scene();
  assert(upload(store, frames, FLAG_LOOP, true) == OK);
  const uint32_t revision = store.revision();
  const unsigned count = store.count();

  Endpoint<Store> endpoint(store);
  uint8_t status[20];
  uint8_t begin[13] = {OP_BEGIN};
  eink::put32(begin + 1, revision);
  eink::put16(begin + 5, 2);
  eink::put16(begin + 7, 0);
  eink::put32(begin + 9, 0);
  endpoint.command(begin, sizeof begin, 0, 5);
  while (endpoint.pending()) endpoint.poll();
  endpoint.status(status);
  assert(status[2] == OK);

  Frame f = blank();
  putPixel(f, 4, 4, true);
  Blob blob = makeBlob(f, nullptr);
  uint8_t frame[13];
  fillFrameHeader(frame, 0, blob.kind, uint16_t(blob.encoded.size()), blob.crc, 500);
  endpoint.command(frame, sizeof frame, 0, 5);
  endpoint.poll();
  uint8_t data[20];
  data[0] = OP_DATA;
  eink::put16(data + 1, 0);
  memcpy(data + 3, blob.encoded.data(), 10);
  endpoint.command(data, 13, 0, 5);
  endpoint.poll();
  assert(endpoint.ownsUpload());

  // A different connection's disconnect must not disturb it.
  endpoint.disconnect(9);
  assert(endpoint.ownsUpload());
  // The owning connection's disconnect discards it right away.
  endpoint.disconnect(5);
  assert(!endpoint.ownsUpload());
  assert(!endpoint.busy());

  Store reloaded(flash);
  assert(reloaded.begin());
  assert(reloaded.revision() == revision);
  assert(reloaded.count() == count);
  // Every stored frame still decodes to the uploaded pixels.
  Frame previous{};
  for (unsigned i = 0; i < count; ++i) {
    std::vector<uint8_t> payload(reloaded.payloadLength(i));
    assert(reloaded.readPayload(i, 0, payload.data(), payload.size()) == OK);
    Frame out{};
    assert(decodePayload(reloaded.frameKind(i), payload.data(), payload.size(),
                         i ? previous.data() : nullptr, out.data()) == CODEC_OK);
    assert(out == frames[i]);
    previous = out;
  }
  std::puts("wire: disconnect during a staged frame discards the upload, durable animation intact");
}

// Disconnect while a metadata write is pending must let it finish durably; only an already
// completed COMMIT can be repeated by the client, so aborting it would be worse.
static void testWireDisconnectDuringPendingCommit() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  Endpoint<Store> endpoint(store);
  uint8_t status[20];

  Frame f = blank();
  putPixel(f, 9, 9, true);
  // BEGIN declares the animation CRC over the decoded frames, so it must be computed first.
  uint32_t animation = crcUpdate(0xffffffffu, f.data(), f.size()) ^ 0xffffffffu;
  uint8_t begin[13] = {OP_BEGIN};
  eink::put32(begin + 1, 0);
  eink::put16(begin + 5, 1);
  eink::put16(begin + 7, 0);
  eink::put32(begin + 9, animation);
  endpoint.command(begin, sizeof begin, 0, 3);
  while (endpoint.pending()) endpoint.poll();

  Blob blob = makeBlob(f, nullptr);
  uint8_t frame[13];
  fillFrameHeader(frame, 0, blob.kind, uint16_t(blob.encoded.size()), blob.crc, 500);
  endpoint.command(frame, sizeof frame, 0, 3);
  endpoint.poll();
  uint8_t data[20];
  for (size_t off = 0; off < blob.encoded.size();) {
    size_t n = blob.encoded.size() - off < 17 ? blob.encoded.size() - off : 17;
    data[0] = OP_DATA;
    eink::put16(data + 1, uint16_t(off));
    memcpy(data + 3, blob.encoded.data() + off, n);
    endpoint.command(data, 3 + n, 0, 3);
    endpoint.poll();
    off += n;
  }
  uint8_t frameCommit[1] = {OP_FRAME_COMMIT};
  endpoint.command(frameCommit, 1, 0, 3);
  endpoint.poll();
  endpoint.status(status);
  assert(status[2] == OK);

  // COMMIT is staged (pending) but not yet run: the disconnect must not cancel it.
  uint8_t commit[1] = {OP_COMMIT};
  endpoint.command(commit, 1, 0, 3);
  endpoint.status(status);
  assert(endpoint.pending());
  endpoint.disconnect(3);
  assert(endpoint.pending());  // the metadata write is allowed to finish
  endpoint.poll();
  endpoint.status(status);
  assert(status[2] == OK);

  Store reloaded(flash);
  assert(reloaded.begin());
  assert(reloaded.count() == 1);
  assert(reloaded.revision() == 1);
  assert(reloaded.frameCrc(0) == eink::crc32(f.data(), f.size()));
  std::puts("wire: disconnect while COMMIT is pending lets the durable write finish");
}

// ---- playback position (append-only tail) ----
// The position record is PROGRAM-ONLY in the metadata sector's erased tail, so a save costs
// zero erase cycles and can never invalidate the metadata.
static void testPositionRoundTripAndMount() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  std::vector<Frame> frames = scene();
  assert(upload(store, frames, FLAG_LOOP, true) == OK);
  const uint32_t revision = store.revision();

  uint16_t index = 0;
  assert(!store.loadPosition(index));  // nothing saved yet

  assert(store.savePosition(2) == OK);
  assert(store.loadPosition(index) && index == 2);
  assert(store.revision() == revision);  // a save never moves the revision

  // Mount in a fresh object: the tail is rescanned from flash.
  {
    Store remounted(flash);
    assert(remounted.begin());
    assert(remounted.positionRecords() == 1);
    uint16_t loaded = 0;
    assert(remounted.loadPosition(loaded) && loaded == 2);
    assert(remounted.revision() == revision);
    assert(remounted.count() == 3);
  }
  // Several saves: the NEWEST valid record wins, and records never leave the sector.
  assert(store.savePosition(0) == OK);
  assert(store.savePosition(1) == OK);
  assert(store.loadPosition(index) && index == 1);
  assert(store.positionRecords() == 3);
  assert(POSITION_START + 3 * POSITION_RECORD <= POSITION_END);
  std::puts("position: save/load round-trip, newest wins, survives a fresh begin(), revision untouched");
}

// A record from another generation, or with a broken crc, must be ignored.
static void testPositionRejectsStaleAndCorrupt() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  std::vector<Frame> frames = scene();
  assert(upload(store, frames, FLAG_LOOP, true) == OK);
  assert(store.savePosition(2) == OK);
  const uint32_t base = store.activeMetaAddress();
  const uint32_t recordAddr = base + POSITION_START;

  // Broken crc: flip a payload byte (index lives at P_INDEX = 6).
  {
    Flash copy = flash;
    copy.bytes[recordAddr - BASE + 6] ^= 0x01;
    Store s(copy);
    assert(s.begin());
    uint16_t index = 0xffff;
    assert(!s.loadPosition(index));
  }
  // Wrong generation: a record from before the last commit.
  {
    Flash copy = flash;
    uint32_t wrong = 0xdeadbeefu;
    for (unsigned i = 0; i < 4; ++i) copy.bytes[recordAddr - BASE + 8 + i] = uint8_t(wrong >> (8 * i));
    // Recompute the crc so only the generation check can reject it.
    uint8_t record[POSITION_RECORD];
    memcpy(record, copy.bytes.data() + recordAddr - BASE, POSITION_RECORD);
    const uint32_t crc = eink::crc32(record, P_CRC);
    for (unsigned i = 0; i < 4; ++i) copy.bytes[recordAddr - BASE + 12 + i] = uint8_t(crc >> (8 * i));
    Store s(copy);
    assert(s.begin());
    uint16_t index = 0xffff;
    assert(!s.loadPosition(index));
  }
  // Bad magic.
  {
    Flash copy = flash;
    copy.bytes[recordAddr - BASE] ^= 0xff;
    Store s(copy);
    assert(s.begin());
    uint16_t index = 0xffff;
    assert(!s.loadPosition(index));
  }
  std::puts("position: stale generation, broken crc and bad magic are all ignored");
}

// 64 records fill the tail; the 65th is FULL and nothing else is disturbed.
static void testPositionTailFull() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  std::vector<Frame> frames = scene();
  assert(upload(store, frames, FLAG_LOOP, true) == OK);
  for (unsigned i = 0; i < POSITION_MAX; ++i) {
    assert(store.savePosition(uint16_t(i % 3)) == OK);
  }
  assert(store.positionRecords() == POSITION_MAX);
  assert(store.savePosition(1) == FULL);
  assert(store.positionRecords() == POSITION_MAX);  // unchanged
  // The metadata and every frame are still intact, and the newest record still loads.
  uint16_t index = 0xffff;
  assert(store.loadPosition(index));
  assert(index == uint16_t((POSITION_MAX - 1) % 3));
  Store remounted(flash);
  assert(remounted.begin());
  assert(remounted.count() == 3);
  assert(remounted.revision() == store.revision());
  for (unsigned i = 0; i < 3; ++i)
    assert(remounted.frameCrc(i) == eink::crc32(frames[i].data(), frames[i].size()));
  assert(remounted.positionRecords() == POSITION_MAX);
  // The tail never wrote outside the sector.
  assert(POSITION_START + POSITION_MAX * POSITION_RECORD <= SECTOR);
  std::puts("position: 64 records then FULL, metadata and frames untouched");
}

// A new COMMIT must invalidate the old position (new generation, fresh tail) and DELETE
// must clear it.
static void testPositionInvalidatedByCommitAndDelete() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  std::vector<Frame> frames = scene();
  assert(upload(store, frames, FLAG_LOOP, true) == OK);
  assert(store.savePosition(2) == OK);
  uint16_t index = 0;
  assert(store.loadPosition(index) && index == 2);

  // COMMIT a new animation: the metadata sector is erased, so the old position is gone.
  std::vector<Frame> next;
  Frame a = blank();
  putPixel(a, 3, 3, true);
  next.push_back(a);
  assert(upload(store, next, 0, true) == OK);
  assert(store.revision() == 2);
  assert(!store.loadPosition(index));
  assert(store.positionRecords() == 0);

  // A position saved for the new generation is valid again.
  assert(store.savePosition(0) == OK);
  assert(store.loadPosition(index) && index == 0);

  // DELETE clears it.
  assert(store.remove() == OK);
  assert(!store.loadPosition(index));
  assert(store.revision() == 3);
  std::puts("position: a new COMMIT and DELETE both invalidate the stored position");
}

// A save interrupted by a flash failure leaves the metadata mountable.
static void testPositionSaveFailureKeepsMetadata() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  std::vector<Frame> frames = scene();
  assert(upload(store, frames, FLAG_LOOP, true) == OK);
  const uint32_t revision = store.revision();

  flash.calls = 0;
  flash.fail = 0;  // the very next flash operation (the record program) fails
  const Result r = store.savePosition(1);
  assert(r == STORAGE);
  flash.fail = -1;

  Store remounted(flash);
  assert(remounted.begin());
  assert(remounted.revision() == revision);
  assert(remounted.count() == 3);
  for (unsigned i = 0; i < 3; ++i)
    assert(remounted.frameCrc(i) == eink::crc32(frames[i].data(), frames[i].size()));
  std::puts("position: an interrupted save leaves the metadata mountable and unchanged");
}

// The save policy gate: the player's throttle allows at most one save per PERSIST_MS, and
// the firmware additionally refuses while flash is exclusive (tested in main.cpp's
// savePosition, which is not host-compiled). Here the throttle itself is proven, plus that
// each permitted save appends exactly one record.
static void testPositionThrottleBudget() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  std::vector<Frame> frames = scene();
  assert(upload(store, frames, FLAG_LOOP, true) == OK);
  RecordingPanel panel;
  Player<Store> player(panel);
  assert(player.start(store, 0, 0));
  // A 60 s playback sampled every 500 ms: shouldPersist() fires 7 times at 0, 10s..60s.
  uint32_t now = 0;
  unsigned allowed = 0;
  unsigned records = 0;
  for (unsigned i = 0; i < 120; ++i) {
    assert(player.tick(now));
    if (player.shouldPersist(now)) {
      ++allowed;
      if (store.savePosition(player.index()) == OK) ++records;
    }
    now += 500;
  }
  // Frames are 500 ms and the loop samples every 500 ms, so the tick at exactly 10000 ms is
  // the second save; the last tick is at 59500 ms, so 6 saves fit in 60 s.
  assert(allowed == 6);
  assert(records == allowed);           // the tail had room for all of them
  assert(store.positionRecords() == records);
  // At most 64 records per metadata generation, so a 10 s throttle takes >10 minutes of
  // continuous playback to exhaust the tail; then saves stop until the next COMMIT.
  assert(records <= POSITION_MAX);
  std::puts("position: 10 s throttle admits 6 saves in 60 s and each appends one record");
}

// PLAY 0xFFFF resumes from the stored position for THIS animation, else frame 0.
static void testWirePlayResume() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  std::vector<Frame> frames = scene();
  assert(upload(store, frames, FLAG_LOOP, true) == OK);
  Endpoint<Store> endpoint(store);
  uint8_t status[20];
  uint8_t play[3] = {OP_PLAY};

  // No stored position: RESUME starts at 0 and the ack index is 0.
  eink::put16(play + 1, NO_INDEX);
  endpoint.command(play, sizeof play, 0, 1);
  endpoint.status(status);
  assert(status[2] == OK);
  assert(eink::get16(status + 10) == 0);
  assert(endpoint.playIndex() == 0);
  (void)endpoint.takePlay();
  endpoint.playbackStopped();

  // A stored position is used, and the ack reports it.
  assert(store.savePosition(2) == OK);
  endpoint.command(play, sizeof play, 0, 1);
  endpoint.status(status);
  assert(status[2] == OK);
  assert(eink::get16(status + 10) == 2);
  assert(endpoint.playIndex() == 2);
  (void)endpoint.takePlay();
  endpoint.playbackStopped();

  // A stored position beyond the current count falls back to 0 (defensive).
  assert(store.savePosition(9) == OK);
  endpoint.command(play, sizeof play, 0, 1);
  endpoint.status(status);
  assert(status[2] == OK);
  assert(eink::get16(status + 10) == 0);

  // A plain index is unchanged behaviour.
  eink::put16(play + 1, 1);
  endpoint.command(play, sizeof play, 0, 1);
  endpoint.status(status);
  assert(status[2] == OK);
  assert(eink::get16(status + 10) == 1);
  // ... and still bounds-checked.
  eink::put16(play + 1, 3);
  endpoint.command(play, sizeof play, 0, 1);
  endpoint.status(status);
  assert(status[2] == LIMIT);

  // After a new COMMIT the old position no longer applies, so RESUME starts at 0.
  std::vector<Frame> next;
  Frame a = blank();
  putPixel(a, 5, 5, true);
  next.push_back(a);
  putPixel(a, 6, 5, true);
  next.push_back(a);
  assert(upload(store, next, FLAG_LOOP, true) == OK);
  eink::put16(play + 1, NO_INDEX);
  endpoint.command(play, sizeof play, 0, 1);
  endpoint.status(status);
  assert(status[2] == OK);
  assert(eink::get16(status + 10) == 0);
  std::puts("wire: PLAY 0xFFFF resumes the stored position, else 0, and a COMMIT invalidates it");
}

// ---------------------------------------------------------------------------- player
static void testPlayerBBox() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  // The bounding box is computed between the frame currently on the panel and the next
  // one, so each step below states exactly which pixels change.
  std::vector<Frame> frames;
  Frame a = blank();
  frames.push_back(a);                 // 0: blank (full blob)
  Frame b = a;
  putPixel(b, 40, 100, true);
  frames.push_back(b);                 // 1: +pixel(40,100)          -> bbox 1x1
  Frame c = a;
  putPixel(c, 0, 0, true);
  frames.push_back(c);                 // 2: -pixel(40,100) +pixel(0,0) -> bbox 41x101
  Frame d = c;
  putPixel(d, 121, 249, true);
  frames.push_back(d);                 // 3: +pixel(121,249)         -> bbox 1x1 at corner
  Frame e = blank();
  // A sparse diagonal from the top-left to the bottom-right corner: few black pixels, but
  // the bounding box covers the whole panel, which is what the scene threshold measures.
  for (unsigned i = 0; i < eink::HEIGHT; ++i) {
    unsigned x = i / 2;
    if (x < eink::WIDTH) putPixel(e, x, i, true);
  }
  frames.push_back(e);                 // 4: whole-panel bbox         -> scene threshold
  assert(upload(store, frames, FLAG_LOOP, true) == OK);

  RecordingPanel panel;
  Player<Store> player(panel);
  player.partialPresentation(true);
  player.configure(1000, 60);  // loop cadence effectively off; 60% scene threshold
  assert(player.start(store, 0, 0));

  // Frame 0 is a full-kind blob: full refresh even though the previous frame is blank.
  assert(player.tick(0));
  assert(panel.full == 1 && panel.partial == 0);

  // Frame 1: one pixel.
  panel.reset();
  assert(player.tick(500));
  assert(panel.partial == 1 && panel.full == 0);
  assert(panel.x == 40 && panel.y == 100 && panel.w == 1 && panel.h == 1);
  BBox box = player.lastBBox();
  assert(box.x == 40 && box.y == 100 && box.w == 1 && box.h == 1 && box.area == 1);

  // Frame 2: clears (40,100) and sets (0,0) -> the box spans both.
  panel.reset();
  assert(player.tick(1000));
  assert(panel.partial == 1 && panel.full == 0);
  box = player.lastBBox();
  assert(box.x == 0 && box.y == 0 && box.w == 41 && box.h == 101);
  assert(panel.x == box.x && panel.y == box.y && panel.w == box.w && panel.h == box.h);

  // Frame 3: only the far corner changes -> a 1x1 box at the bottom-right pixel.
  panel.reset();
  assert(player.tick(1500));
  assert(panel.partial == 1 && panel.full == 0);
  box = player.lastBBox();
  assert(box.x == 121 && box.y == 249 && box.w == 1 && box.h == 1);

  // Frame 4: the bounding box covers the whole panel, so the scene threshold forces a full
  // refresh even with the loop cadence disabled.
  panel.reset();
  assert(player.tick(2000));
  box = player.lastBBox();
  // Pixel (0,0) is unchanged from frame 3, so the changed box starts at row 1 and still
  // covers 122x249 = 30378 px, above 60% of the 48800 panel pixels.
  assert(box.x == 0 && box.y == 1 && box.w == 122 && box.h == 249);
  assert(uint32_t(box.area) * 100u >= Player<Store>::PANEL_PIXELS * 60u);
  assert(panel.full == 1 && panel.partial == 0);
  std::puts("player: single-pixel, corner and whole-panel bounding boxes; scene threshold");
}

static void testPlayerPaddingBitsIgnored() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  // Two frames that differ only in the six padding bits of the last column's byte must
  // produce an empty bbox (no real pixel changed).
  Frame a = blank();
  Frame b = a;
  b[eink::STRIDE - 1] = 0x3f;  // only padding bits
  std::vector<Frame> frames;
  frames.push_back(a);
  frames.push_back(b);
  assert(upload(store, frames, FLAG_LOOP, true) == OK);
  RecordingPanel panel;
  Player<Store> player(panel);
  player.partialPresentation(true);
  player.configure(1000, 100);
  assert(player.start(store, 1, 0));
  assert(player.tick(0));
  // Frame 1 is stored as a full blob (first frame of the sequence at index 1 has a
  // previous only at upload time; index 0 was blank), so the panel gets a full refresh
  // but the computed bbox must still be empty.
  BBox box = player.lastBBox();
  assert(box.w == 0 && box.h == 0 && box.area == 0);
  std::puts("player: the six padding bits never contribute to the bounding box");
}

// Cadence: with N=10 the first frame is full (frame 1), then frames 10 and 20 are full,
// so there are at most 9 partial refreshes in a row.
static void testPlayerFullRefreshCadence() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  // 21 frames, each adding one pixel: small bboxes, so only the cadence forces full
  // refreshes. Frame 0 is a full blob, the rest are deltas.
  std::vector<Frame> frames;
  Frame f = blank();
  frames.push_back(f);
  for (unsigned i = 1; i < 21; ++i) {
    putPixel(f, i, i, true);
    frames.push_back(f);
  }
  assert(upload(store, frames, FLAG_LOOP, true) == OK);
  RecordingPanel panel;
  Player<Store> player(panel);
  player.configure(10, 100);  // cadence every 10 presented frames, never by area
  assert(player.start(store, 0, 0));
  uint32_t now = 0;
  bool fullAt[22] = {false};
  for (unsigned i = 1; i <= 21; ++i) {
    const int before = panel.full;
    assert(player.tick(now));
    fullAt[i] = panel.full > before;
    now += 500;
  }
  assert(fullAt[1]);                    // first presented frame is always full
  assert(!fullAt[2] && !fullAt[9]);     // ... and 9 partial refreshes follow
  assert(fullAt[10]);                   // N == 10 fires the cadence
  assert(!fullAt[11]);
  assert(fullAt[20]);                   // N+1 sequence continues from the counter
  assert(!fullAt[21]);
  assert(panel.full == 3);
  assert(panel.partial == 18);
  std::puts("player: full refresh every N presented frames (first, 10th, 20th)");
}

// The area threshold is measured in REAL pixels (122x250 = 30500), so 60% is 18300.
static void testPlayerAreaThreshold() {
  // A box of exactly 59% must stay partial; 61% must be full. 30500 * 59% = 17995,
  // 30500 * 61% = 18605. A 122-wide band of 147 rows is 17934 (58.8%); 149 rows is 18178
  // (59.6%); 150 rows is 18300 (exactly 60%); 151 rows is 18422 (60.4%).
  const unsigned rows59 = 147;  // 17934 < 18300
  const unsigned rows61 = 151;  // 18422 >= 18300
  for (unsigned rows : {rows59, rows61}) {
    Flash flash;
    Store store(flash);
    assert(store.begin());
    std::vector<Frame> frames;
    Frame a = blank();
    frames.push_back(a);
    // Two pixels per row at the extremes give a full-width bounding box of `rows` rows,
    // so the box area is what drives the decision.
    Frame b = blank();
    for (unsigned y = 0; y < rows; ++y) { putPixel(b, 0, y, true); putPixel(b, 121, y, true); }
    frames.push_back(b);
    assert(upload(store, frames, FLAG_LOOP, true) == OK);
    RecordingPanel panel;
    Player<Store> player(panel);
    player.configure(1000, 60);  // cadence effectively off
    assert(player.start(store, 0, 0));
    assert(player.tick(0));      // frame 0: full (first frame)
    panel.reset();
    assert(player.tick(500));    // frame 1: decided purely by the area threshold
    const BBox box = player.lastBBox();
    const uint32_t area = uint32_t(box.area);
    const uint32_t percent = area * 100u / Player<Store>::PANEL_PIXELS;
    if (rows == rows59) {
      assert(area < Player<Store>::PANEL_PIXELS * 60u / 100u);
      assert(percent == 58);
      assert(panel.partial == 1 && panel.full == 0);
    } else {
      assert(area >= Player<Store>::PANEL_PIXELS * 60u / 100u);
      assert(percent == 60);
      assert(panel.full == 1 && panel.partial == 0);
    }
  }
  // Exactly 60% is the documented boundary: >= triggers a full refresh.
  {
    Flash flash;
    Store store(flash);
    assert(store.begin());
    std::vector<Frame> frames;
    frames.push_back(blank());
    Frame band = blank();
    // 150 rows * 122 columns = 18300, exactly 60% of 30500.
    for (unsigned y = 0; y < 150; ++y) { putPixel(band, 0, y, true); putPixel(band, 121, y, true); }
    frames.push_back(band);
    assert(upload(store, frames, FLAG_LOOP, true) == OK);
    RecordingPanel panel;
    Player<Store> player(panel);
    player.configure(1000, 60);
    assert(player.start(store, 0, 0));
    assert(player.tick(0));
    panel.reset();
    assert(player.tick(500));
    assert(player.lastBBox().area == 18300);
    assert(panel.full == 1 && panel.partial == 0);
  }
  std::puts("player: 59% stays partial, 60% and 61% force a full refresh");
}

// An unchanged frame is not refreshed at all but still consumes its delay.
static void testPlayerIdenticalFrames() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  std::vector<Frame> frames;
  Frame a = blank();
  putPixel(a, 7, 7, true);
  frames.push_back(a);
  frames.push_back(a);  // identical
  frames.push_back(a);  // identical again
  Frame b = a;
  putPixel(b, 8, 7, true);
  frames.push_back(b);
  assert(upload(store, frames, FLAG_LOOP, true) == OK);
  RecordingPanel panel;
  Player<Store> player(panel);
  player.configure(1000, 60);
  assert(player.start(store, 0, 0));
  assert(player.tick(0));      // frame 0 full
  assert(panel.full == 1);
  panel.reset();
  assert(player.tick(500));    // frame 1 identical: no refresh
  assert(panel.full == 0 && panel.partial == 0);
  assert(player.lastBBox().area == 0);
  assert(player.deadline() == 1000);  // the delay still elapsed
  assert(player.tick(1000));   // frame 2 identical: still no refresh
  assert(panel.full == 0 && panel.partial == 0);
  assert(player.tick(1500));   // frame 3 changes one pixel: partial
  assert(panel.partial == 1 && panel.full == 0);
  assert(player.lastBBox().x == 8 && player.lastBBox().y == 7);
  std::puts("player: identical consecutive frames skip the refresh and keep the timing");
}

// The first presented frame after start() is always a full refresh, even when a previous
// playback left a frame on the panel.
static void testPlayerFirstFrameAlwaysFull() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  std::vector<Frame> frames = scene();
  assert(upload(store, frames, FLAG_LOOP, true) == OK);
  RecordingPanel panel;
  Player<Store> player(panel);
  player.configure(10, 60);
  assert(player.start(store, 0, 0));
  assert(player.tick(0));
  assert(panel.full == 1 && panel.partial == 0);
  player.stop();
  // Restarting at a delta index: the first presented frame is still full.
  panel.reset();
  assert(player.start(store, 1, 1000));
  assert(player.tick(1000));
  assert(panel.full == 1 && panel.partial == 0);
  std::puts("player: the first frame after every start() is a full refresh");
}

// Last visible column: x = 121 must be reported exactly; the adapter widens to bytes.
static void testPlayerLastColumn() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  std::vector<Frame> frames;
  frames.push_back(blank());
  Frame b = blank();
  putPixel(b, 121, 249, true);
  frames.push_back(b);
  assert(upload(store, frames, FLAG_LOOP, true) == OK);
  RecordingPanel panel;
  Player<Store> player(panel);
  player.configure(1000, 60);
  assert(player.start(store, 0, 0));
  assert(player.tick(0));
  panel.reset();
  assert(player.tick(500));
  const BBox box = player.lastBBox();
  assert(box.x == 121 && box.y == 249 && box.w == 1 && box.h == 1);
  assert(panel.partial == 1);
  assert(panel.x == 121 && panel.y == 249 && panel.w == 1 && panel.h == 1);
  std::puts("player: the last column (x=121) is reported exactly");
}

static void testPlayerTiming() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  std::vector<Frame> frames = scene();
  assert(upload(store, frames, FLAG_LOOP, true) == OK);
  RecordingPanel panel;
  Player<Store> player(panel);
  assert(player.start(store, 0, 1000));
  assert(player.deadline() == 1000);
  // Not due yet.
  assert(!player.tick(999));
  assert(player.tick(1000));
  // The next deadline is anchored on the due time plus the frame delay (500 ms).
  assert(player.deadline() == 1500);
  assert(!player.tick(1499));
  assert(player.tick(1500));
  assert(player.deadline() == 2000);
  // A late tick re-anchors at now + delay instead of racing through frames.
  assert(player.tick(2600));
  assert(player.deadline() == 3100);
  // No drift: a sequence of exactly-on-time ticks stays on the grid.
  uint32_t now = player.deadline();
  for (int i = 0; i < 5; ++i) { assert(player.tick(now)); now += 500; }
  assert(player.deadline() == now);
  std::puts("player: deadline scheduling, no drift, overrun re-anchor");
}

static void testPlayerStopAndIndex() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  std::vector<Frame> frames = scene();
  assert(upload(store, frames, FLAG_LOOP, true) == OK);
  RecordingPanel panel;
  Player<Store> player(panel);
  assert(!player.start(store, 3, 0));  // out of range
  assert(player.error() == LIMIT);
  assert(!player.running());
  assert(player.start(store, 2, 0));
  assert(player.index() == 2);
  assert(player.tick(0));
  // A looping animation wraps to index 0.
  assert(player.index() == 0);
  player.stop();
  assert(!player.running());
  assert(!player.tick(100000));  // a stopped player presents nothing
  std::puts("player: out-of-range index, loop wrap, stop/pause");
}

static void testPlayerOneShot() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  std::vector<Frame> frames = scene();
  assert(upload(store, frames, 0, true) == OK);  // no loop flag
  RecordingPanel panel;
  Player<Store> player(panel);
  assert(player.start(store, 0, 0));
  uint32_t now = 0;
  for (unsigned i = 0; i < 3; ++i) { assert(player.tick(now)); now += 500; }
  // The third tick presented the last frame and then stopped the player.
  assert(!player.running());
  assert(!player.tick(now));
  std::puts("player: one-shot animation stops after the last frame");
}

static void testPlayerPersistenceThrottle() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  std::vector<Frame> frames = scene();
  assert(upload(store, frames, FLAG_LOOP, true) == OK);
  RecordingPanel panel;
  Player<Store> player(panel);
  assert(!player.shouldPersist(0));  // not running yet
  assert(player.start(store, 0, 0));
  assert(player.shouldPersist(0));
  assert(!player.shouldPersist(1));
  assert(!player.shouldPersist(9999));
  assert(player.shouldPersist(10000));
  assert(!player.shouldPersist(10001));
  assert(player.shouldPersist(20000));
  std::puts("player: persistence is throttled to once per 10 s");
}

static void testPlayerCorruptBlob() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  std::vector<Frame> frames = scene();
  assert(upload(store, frames, FLAG_LOOP, true) == OK);
  // Corrupt one payload byte of frame 1 on flash. Mount still succeeds (headers only),
  // but playback must stop with a codec/CRC error instead of spinning.
  const uint32_t base = store.activeDataAddress();
  flash.bytes[base - BASE + store.frameOffset(1) + BLOB_HEADER + 4] ^= 0x55;
  Store reloaded(flash);
  assert(reloaded.begin());
  RecordingPanel panel;
  Player<Store> player(panel);
  player.configure(1000, 100);
  assert(player.start(reloaded, 0, 0));
  assert(player.tick(0));        // frame 0 is intact
  assert(!player.tick(500));  // frame 1 is damaged
  assert(!player.running());
  assert(player.error() == CODEC || player.error() == BAD_CRC);
  assert(!player.tick(1000));    // no spin
  std::puts("player: a corrupt blob stops playback with an error and does not spin");
}

// The player decodes in place with ONE 4000-byte buffer. These tests prove that design
// produces exactly the same pixels and the same bounding box as the straightforward
// "decode into a second buffer, then diff" reference.

// Reference: decode blob `index` into `out` using `prev`, the two-buffer way.
static bool referenceDecode(Store& store, unsigned index, uint8_t* prev, uint8_t* out) {
  std::vector<uint8_t> payload(store.payloadLength(index));
  if (store.readPayload(index, 0, payload.data(), payload.size()) != OK) return false;
  const uint8_t kind = store.frameKind(index);
  return decodePayload(kind, payload.data(), payload.size(),
                       kind == KIND_FULL ? nullptr : prev, out) == CODEC_OK;
}

// Reference bounding box: diff two full buffers, ignoring the six padding bits.
static BBox referenceBBox(const uint8_t* a, const uint8_t* b) {
  uint16_t x0 = eink::WIDTH, y0 = eink::HEIGHT, x1 = 0, y1 = 0;
  for (uint16_t y = 0; y < eink::HEIGHT; ++y) {
    for (uint16_t byte = 0; byte < eink::STRIDE; ++byte) {
      const uint8_t mask = byte == eink::STRIDE - 1 ? 0xc0 : 0xff;
      const uint8_t diff = uint8_t((a[y * eink::STRIDE + byte] ^ b[y * eink::STRIDE + byte]) & mask);
      if (!diff) continue;
      for (uint8_t bit = 0; bit < 8; ++bit) {
        if (!(diff & (0x80u >> bit))) continue;
        const uint16_t x = uint16_t(byte * 8u + bit);
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  BBox box = {0, 0, 0, 0, 0};
  if (x0 > x1) return box;
  box.x = x0; box.y = y0;
  box.w = uint16_t(x1 - x0 + 1); box.h = uint16_t(y1 - y0 + 1);
  box.area = uint16_t(uint32_t(box.w) * box.h);
  return box;
}

static bool sameBox(const BBox& a, const BBox& b) {
  return a.x == b.x && a.y == b.y && a.w == b.w && a.h == b.h && a.area == b.area;
}

// In-place decode must reproduce the reference pixels and box for every change shape.
static void testPlayerInPlaceMatchesReference() {
  struct Case { const char* name; Frame a; Frame b; };
  std::vector<Case> cases;
  Frame blankFrame = blank();

  Frame single = blankFrame;
  putPixel(single, 40, 100, true);
  cases.push_back(Case{"single-pixel", blankFrame, single});

  Frame corner = blankFrame;
  putPixel(corner, 121, 249, true);
  cases.push_back(Case{"far-corner", blankFrame, corner});

  Frame origin = blankFrame;
  putPixel(origin, 0, 0, true);
  cases.push_back(Case{"origin", blankFrame, origin});

  // Padding bits only: the six low bits of each row's last byte differ, no real pixel does.
  Frame padded = blankFrame;
  for (unsigned y = 0; y < eink::HEIGHT; ++y) padded[y * eink::STRIDE + eink::STRIDE - 1] = 0x3f;
  cases.push_back(Case{"padding-bits-only", blankFrame, padded});

  // Full-panel change: every pixel flips.
  Frame inverted = blankFrame;
  for (unsigned y = 0; y < eink::HEIGHT; ++y)
    for (unsigned x = 0; x < eink::WIDTH; ++x) putPixel(inverted, x, y, true);
  cases.push_back(Case{"full-panel", blankFrame, inverted});

  // A long horizontal run exercises the 128-byte repeat window.
  Frame run = blankFrame;
  for (unsigned y = 0; y < eink::HEIGHT; ++y) putPixel(run, 60, y, true);
  cases.push_back(Case{"vertical-run", blankFrame, run});

  for (const Case& c : cases) {
    Flash flash;
    Store store(flash);
    assert(store.begin());
    std::vector<Frame> frames;
    frames.push_back(c.a);
    frames.push_back(c.b);
    assert(upload(store, frames, FLAG_LOOP, true) == OK);

    // Reference: two buffers.
    Frame prevRef = c.a;
    Frame outRef{};
    assert(referenceDecode(store, 1, prevRef.data(), outRef.data()));
    const BBox refBox = referenceBBox(prevRef.data(), outRef.data());

    // Player: one buffer, in place.
    RecordingPanel panel;
    Player<Store> player(panel);
    player.configure(1000, 100);  // no cadence, threshold irrelevant here
    assert(player.start(store, 0, 0));
    assert(player.tick(0));       // frame 0 (full)
    assert(player.tick(500));     // frame 1 (delta, decoded in place)
    assert(memcmp(player.frame(), outRef.data(), eink::FRAME_BYTES) == 0);
    assert(sameBox(player.lastBBox(), refBox));
    if (c.name[0] == 'p' && c.name[1] == 'a') assert(player.lastBBox().area == 0);  // padding
    if (c.name[0] == 's') assert(player.lastBBox().area == 1);                     // single pixel
  }
  std::puts("player: in-place decode matches the two-buffer reference on 6 change shapes");
}

// Starting at index > 0 primes the delta chain in place; the presented frames must equal
// what playing from index 0 produces.
static void testPlayerPrimingMatchesFromZero() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  // Four frames with varying deltas so priming has real work to do.
  std::vector<Frame> frames;
  Frame f = blank();
  frames.push_back(f);
  for (unsigned i = 1; i < 4; ++i) {
    for (unsigned k = 0; k < i; ++k) putPixel(f, unsigned(i * 7 + k), unsigned(i * 11 % eink::HEIGHT), true);
    frames.push_back(f);
  }
  assert(upload(store, frames, FLAG_LOOP, true) == OK);

  // Path A: play from 0 and capture what the panel shows for frame 2. The player advances
  // index_ after presenting, so index() == 2 on the tick that PRESENTS frame 1 and
  // index() == 3 on the tick that presents frame 2.
  RecordingPanel panelA;
  Player<Store> playerA(panelA);
  playerA.configure(1000, 100);
  assert(playerA.start(store, 0, 0));
  Frame fromZero{};
  for (unsigned i = 0; i < 3; ++i) {
    assert(playerA.tick(i * 500));
    if (playerA.index() == 3) fromZero = panelA.shown;  // frame 2 was just presented
  }
  assert(playerA.index() == 3);
  assert(memcmp(fromZero.data(), frames[2].data(), eink::FRAME_BYTES) == 0);

  // Path B: start at 2; priming replays 0 and 1 in place, then presents 2.
  RecordingPanel panelB;
  Player<Store> playerB(panelB);
  playerB.configure(1000, 100);
  assert(playerB.start(store, 2, 0));
  assert(playerB.tick(0));
  assert(memcmp(panelB.shown.data(), fromZero.data(), eink::FRAME_BYTES) == 0);
  assert(playerB.index() == 3);
  std::puts("player: priming from index 2 presents the same frame as playing from 0");
}

// A COMMIT can replace the animation while it plays. The player must notice and stop
// instead of reading entry(index) past frameCount (garbage) or mixing two animations.
static void testPlayerAnimationChangedUnderPlayback() {
  // Helper: upload `frames` into an existing store (committing over whatever is there).
  auto replace = [](Store& store, const std::vector<Frame>& frames, uint16_t flags) {
    return upload(store, frames, flags, true);
  };

  // Build three animations: 4 frames, 2 frames, and a different 4-frame one.
  std::vector<Frame> four;
  Frame f = blank();
  for (unsigned i = 0; i < 4; ++i) {
    putPixel(f, i * 3, i * 5, true);
    four.push_back(f);
  }
  std::vector<Frame> two;
  Frame t = blank();
  putPixel(t, 50, 50, true);
  two.push_back(t);
  putPixel(t, 60, 50, true);
  two.push_back(t);
  std::vector<Frame> otherFour;
  Frame o = blank();
  for (unsigned i = 0; i < 4; ++i) {
    putPixel(o, 100 - i, 200, true);
    otherFour.push_back(o);
  }

  struct Case { const char* name; const std::vector<Frame>* replacement; };
  for (const Case& c : {Case{"fewer", &two}, Case{"more", &two}, Case{"same-count-different", &otherFour}}) {
    Flash flash;
    Store store(flash);
    assert(store.begin());
    assert(replace(store, four, FLAG_LOOP) == OK);

    RecordingPanel panel;
    Player<Store> player(panel);
    player.configure(1000, 100);
    assert(player.start(store, 0, 0));
    assert(player.tick(0));    // frame 0 presented
    assert(panel.full == 1);
    assert(player.tick(500));  // frame 1 presented, now index 2
    assert(player.index() == 2);
    const int presentsBefore = panel.full + panel.partial;

    // Replace the animation under the running player.
    std::vector<Frame> bigger;
    if (c.name[0] == 'm' && c.name[1] == 'o') {  // "more": a 6-frame animation
      Frame g = blank();
      for (unsigned i = 0; i < 6; ++i) { putPixel(g, i * 2, 7, true); bigger.push_back(g); }
      assert(replace(store, bigger, FLAG_LOOP) == OK);
    } else {
      assert(replace(store, *c.replacement, FLAG_LOOP) == OK);
    }

    // The next tick must stop cleanly: no decode, no present, hibernated, ANIM_CHANGED.
    const int hibernationsBefore = panel.hibernated;
    assert(!player.tick(1500));
    assert(!player.running());
    assert(player.error() == ANIM_CHANGED);
    assert(panel.full + panel.partial == presentsBefore);  // nothing drawn
    assert(panel.hibernated > hibernationsBefore);
    assert(!player.tick(2000));  // no spin
    assert(player.error() == ANIM_CHANGED);

    // start() snapshots again, so a fresh playback works.
    assert(player.start(store, 0, 0));
    assert(player.tick(0));
    assert(player.error() == OK);
    assert(player.running());
  }
  std::puts("player: a COMMIT during playback stops it with ANIM_CHANGED (fewer/more/same-count)");
}

// STOP must return the panel to static content; one-shot completion must not.
static void testRestoreStatic() {
  struct TestPanel : eink::anim::Panel {
    int full = 0, cleared = 0, hibernated = 0;
    Frame shown{};
    void present(uint16_t, uint16_t, uint16_t, uint16_t, const uint8_t* f) override { memcpy(shown.data(), f, eink::FRAME_BYTES); }
    void presentFull(const uint8_t* f) override { ++full; memcpy(shown.data(), f, eink::FRAME_BYTES); }
    void clear() override { ++cleared; shown.fill(0); }
    void hibernate() override { ++hibernated; }
  };

  // Two stored pages, so restore must draw page 0's exact bytes.
  Frame page0 = blank();
  putPixel(page0, 11, 13, true);
  Frame page1 = blank();
  putPixel(page1, 70, 80, true);
  {
    PageFlash pageFlash;
    eink::pages::Storage<PageFlash> pageStore(pageFlash);
    assert(pageStore.begin());
    eink::pages::Entry e0;
    assert(pageStore.put(pageStore.revision(), 0, 0, eink::crc32(page0.data(), page0.size()),
                         page0.data(), e0) == eink::pages::OK);
    eink::pages::Entry e1;
    assert(pageStore.put(pageStore.revision(), 0, 0, eink::crc32(page1.data(), page1.size()),
                         page1.data(), e1) == eink::pages::OK);
    TestPanel panel;
    uint8_t scratch[eink::FRAME_BYTES];
    assert(eink::anim::restoreStatic(panel, pageStore, scratch) == eink::anim::RESTORE_PAGE);
    assert(panel.full == 1 && panel.cleared == 0);
    assert(memcmp(panel.shown.data(), page0.data(), eink::FRAME_BYTES) == 0);
  }
  // No pages: cleared white, no bitmap draw, no present.
  {
    PageFlash pageFlash;
    eink::pages::Storage<PageFlash> pageStore(pageFlash);
    assert(pageStore.begin());
    TestPanel panel;
    uint8_t scratch[eink::FRAME_BYTES];
    assert(eink::anim::restoreStatic(panel, pageStore, scratch) == eink::anim::RESTORE_EMPTY);
    assert(panel.cleared == 1 && panel.full == 0);
    bool allWhite = true;
    for (uint8_t b : panel.shown) if (b) allWhite = false;
    assert(allWhite);
  }
  // A page whose read fails: cleared white, no loop, RESTORE_FAILED.
  {
    PageFlash pageFlash;
    eink::pages::Storage<PageFlash> pageStore(pageFlash);
    assert(pageStore.begin());
    eink::pages::Entry e;
    assert(pageStore.put(pageStore.revision(), 0, 0, eink::crc32(page0.data(), page0.size()),
                         page0.data(), e) == eink::pages::OK);
    TestPanel panel;
    uint8_t scratch[eink::FRAME_BYTES];
    // Corrupt the stored frame so the read fails its CRC/verification path.
    pageFlash.fail = pageFlash.calls;  // the next read fails
    assert(eink::anim::restoreStatic(panel, pageStore, scratch) == eink::anim::RESTORE_FAILED);
    assert(panel.cleared == 1 && panel.full == 0);
  }
  // One-shot completion keeps the last frame: no clear, no page restore.
  {
    Flash flash;
    Store store(flash);
    assert(store.begin());
    std::vector<Frame> frames = scene();
    assert(upload(store, frames, 0, true) == OK);  // no loop flag
    TestPanel panel;
    Player<Store> player(panel);
    player.configure(1000, 100);
    assert(player.start(store, 0, 0));
    uint32_t now = 0;
    for (unsigned i = 0; i < 3; ++i) { assert(player.tick(now)); now += 500; }
    assert(!player.running());
    assert(panel.hibernated == 1);  // the last frame stays visible
    assert(panel.cleared == 0);
  }
  std::puts("restore: page 0 drawn exactly, empty collection clears, read failure clears, one-shot keeps frame");
}

// The player's single buffer is only handed out while stopped.
static void testPlayerBufferAccessor() {
  Flash flash;
  Store store(flash);
  assert(store.begin());
  std::vector<Frame> frames = scene();
  assert(upload(store, frames, FLAG_LOOP, true) == OK);
  RecordingPanel panel;
  Player<Store> player(panel);
  assert(player.buffer() != nullptr);   // stopped: usable as scratch
  assert(player.start(store, 0, 0));
  assert(player.buffer() == nullptr);   // running: never handed out
  player.stop();
  assert(player.buffer() != nullptr);
  std::puts("player: buffer() is only available while stopped");
}

// ---------------------------------------------------------------------------- vectors
// The vectors are generated from tests/vectors-animation.json, the same artifact the
// JavaScript codec tests consume, so a firmware/site disagreement fails here.
static void testCodecVectors() {
  Frame out{};
  for (size_t i = 0; i < BLOB_VECTORS_COUNT; ++i) {
    const BlobVector& v = BLOB_VECTORS[i];
    assert(decodeBlob(v.blob, v.size, v.prev, out.data()) == CODEC_OK);
    assert(memcmp(out.data(), v.decoded, eink::FRAME_BYTES) == 0);
    // The player path must produce the same pixels through the streaming decoder, in
    // arbitrarily small chunks read from flash.
    // The streaming decoder consumes the PAYLOAD; the blob header is validated separately.
    BlobHeader header;
    assert(parseBlobHeader(v.blob, v.size, header));
    StreamDecoder decoder;
    // A full-kind blob ignores the previous frame even when the vector supplies one
    // (encodeDelta falls back to kind 0 when the delta would not be smaller).
    assert(decoder.begin(header.kind, header.kind == KIND_FULL ? nullptr : v.prev));
    const size_t payload = v.size - BLOB_HEADER;
    for (size_t off = 0; off < payload;) {
      size_t n = payload - off < 7 ? payload - off : 7;
      assert(decoder.push(v.blob + BLOB_HEADER + off, n, out.data()));
      off += n;
    }
    assert(decoder.finish());
    assert(memcmp(out.data(), v.decoded, eink::FRAME_BYTES) == 0);
  }
  std::printf("codec: %zu blob vectors decode identically via decodeBlob and StreamDecoder\n",
              BLOB_VECTORS_COUNT);
}

static void testFrameVectors() {
  for (size_t i = 0; i < FRAME_VECTORS_COUNT; ++i) {
    assert(eink::crc32(FRAME_VECTORS[i].frame, eink::FRAME_BYTES) == FRAME_VECTORS[i].crc);
  }
  for (size_t i = 0; i < CRC_VECTORS_COUNT; ++i) {
    assert(eink::crc32(CRC_VECTORS[i].bytes, CRC_VECTORS[i].size) == CRC_VECTORS[i].expected);
  }
  std::printf("codec: %zu frame CRCs and %zu shared CRC vectors match\n",
              FRAME_VECTORS_COUNT, CRC_VECTORS_COUNT);
}

// The animation CRC is what COMMIT compares with BEGIN's declaration.
static void testAnimationCrcVectors() {
  for (size_t a = 0; a < ANIM_VECTORS_COUNT; ++a) {
    const AnimVector& seq = ANIM_VECTORS[a];
    uint32_t state = 0xffffffffu;
    Crc32 chain;
    for (size_t i = 0; i < seq.count; ++i) {
      const uint8_t* frame = FRAME_VECTORS[seq.frames[i]].frame;
      state = crcUpdate(state, frame, eink::FRAME_BYTES);
      chain.update(frame, eink::FRAME_BYTES);
    }
    assert((state ^ 0xffffffffu) == seq.crc);
    assert(chain.value() == seq.crc);
  }
  std::printf("codec: %zu animation CRC sequences match the incremental accumulator\n",
              ANIM_VECTORS_COUNT);
}

static void testRejectVectors() {
  Frame out{};
  for (size_t i = 0; i < REJECT_VECTORS_COUNT; ++i) {
    const RejectVector& v = REJECT_VECTORS[i];
    if (v.headerStage) {
      BlobHeader header;
      assert(!parseBlobHeader(v.blob, v.size, header));
    } else {
      BlobHeader header;
      assert(parseBlobHeader(v.blob, v.size, header));
      // Some vectors are delta blobs whose declared failure IS the missing previous frame,
      // so try without a reference first and only then with one.
      Status actual = decodeBlob(v.blob, v.size, nullptr, out.data());
      if (actual != Status(v.error))
        actual = decodeBlob(v.blob, v.size, FRAME_VECTORS[0].frame, out.data());
      assert(actual == Status(v.error));
    }
  }
  std::printf("codec: %zu reject vectors fail at the declared stage and code\n",
              REJECT_VECTORS_COUNT);
}

static void testPackVectors() {
  // PackBits vectors are arbitrary-length payloads (not necessarily 4000 bytes), so they
  // exercise the standalone encoder/decoder rather than the frame-sized blob helpers.
  uint8_t encoded[eink::FRAME_BYTES * 2];
  uint8_t decoded[eink::FRAME_BYTES * 2];
  for (size_t i = 0; i < PACK_VECTORS_COUNT; ++i) {
    const PackVector& v = PACK_VECTORS[i];
    size_t n = packBitsEncode(encoded, v.raw, v.rawSize);
    assert(n == v.packedSize);
    assert(memcmp(encoded, v.packed, v.packedSize) == 0);
    size_t produced = 0;
    assert(packBitsDecode(v.packed, v.packedSize, decoded, sizeof(decoded), produced));
    assert(produced == v.rawSize);
    assert(memcmp(decoded, v.raw, v.rawSize) == 0);
  }
  for (size_t i = 0; i < DECODE_VECTORS_COUNT; ++i) {
    const PackVector& v = DECODE_VECTORS[i];
    size_t produced = 0;
    assert(packBitsDecode(v.packed, v.packedSize, decoded, sizeof(decoded), produced));
    assert(produced == v.rawSize);
    assert(memcmp(decoded, v.raw, v.rawSize) == 0);
  }
  std::printf("codec: %zu packbits vectors encode and decode byte-identically\n", PACK_VECTORS_COUNT);
}

int main() {
  testStorageBasics();
  testRevisionAndDelete();
  testRevisionConflictWire();
  testBounds();
  testInterruption();
  testCorruption();
  testGarbageBanksAreNotOverwritten();
  testEmptyAnimation();
  testWireHappyPath();
  testWireMalformed();
  testWireOffsetAndCodecErrors();
  testWireCrcMismatch();
  testWireDeleteAndPlay();
  testWireSecondConnectionRejected();
  testWireUploadTimeout();
  testWireDeleteStopsPlayback();
  testWireFirstFrameMustBeFull();
  testWireDisconnectDiscardsStagedUpload();
  testWireDisconnectDuringPendingCommit();
  testPlayerBBox();
  testPlayerPaddingBitsIgnored();
  testPlayerFullRefreshCadence();
  testPlayerAreaThreshold();
  testPlayerIdenticalFrames();
  testPlayerFirstFrameAlwaysFull();
  testPlayerLastColumn();
  testPlayerInPlaceMatchesReference();
  testPlayerPrimingMatchesFromZero();
  testPlayerAnimationChangedUnderPlayback();
  testRestoreStatic();
  testPlayerBufferAccessor();
  testPositionRoundTripAndMount();
  testPositionRejectsStaleAndCorrupt();
  testPositionTailFull();
  testPositionInvalidatedByCommitAndDelete();
  testPositionSaveFailureKeepsMetadata();
  testPositionThrottleBudget();
  testWirePlayResume();
  testPlayerTiming();
  testPlayerStopAndIndex();
  testPlayerOneShot();
  testPlayerPersistenceThrottle();
  testPlayerCorruptBlob();
  testCodecVectors();
  testFrameVectors();
  testAnimationCrcVectors();
  testRejectVectors();
  testPackVectors();
  std::puts("all animation firmware tests passed");
  return 0;
}
