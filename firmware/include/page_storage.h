#ifndef EINK_PAGE_STORAGE_H
#define EINK_PAGE_STORAGE_H
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include "protocol.h"

namespace eink { namespace pages {
// Dedicated application reservation: two metadata sectors and thirty frame sectors.
static constexpr uint32_t BASE = 0xCC000u, SECTOR = 4096u;
static constexpr unsigned SLOTS = 30, CAPACITY = SLOTS - 1;
static constexpr uint32_t MAGIC = 0x50414745u, COMMITTED = 0x434f4d54u;
struct Entry { uint32_t id, revision, crc, slot; };
struct Metadata {
  uint32_t magic, generation, revision, nextId, count;
  Entry entries[CAPACITY];
  uint32_t crc, marker;
};
static_assert(sizeof(Metadata) < SECTOR, "metadata must fit in a sector");
enum Result : uint8_t { OK, MALFORMED, BUSY, NOT_FOUND, CONFLICT, FULL, BAD_CRC, STORAGE_ERROR, BAD_OFFSET, BAD_PADDING };

// Flash methods use absolute byte addresses; program address and length are word aligned.
// A successful program/erase has completed and can immediately be read back.
template<class Flash> class Storage {
 public:
  explicit Storage(Flash& flash) : flash_(flash), active_(-1), healthy_(false), readFailed_(false) { memset(&meta_, 0, sizeof(meta_)); }
  bool begin() {
    readFailed_ = false;
    Metadata a, b;
    bool va = load(0, a), vb = load(1, b);
    if (readFailed_) { healthy_ = false; return false; }
    if (va || vb) {
      if (vb && (!va || b.generation > a.generation)) { meta_ = b; active_ = 1; }
      else { meta_ = a; active_ = 0; }
      healthy_ = true; return true;
    }
    // An interrupted first metadata commit may leave one noncommitted bank.
    uint32_t ma, mb;
    if (!readFlash(BASE + offsetof(Metadata, marker), &ma, sizeof(ma)) ||
        !readFlash(BASE + SECTOR + offsetof(Metadata, marker), &mb, sizeof(mb)) ||
        ma == COMMITTED || mb == COMMITTED) { healthy_ = false; return false; }
    bool blankA = erased(BASE), blankB = erased(BASE + SECTOR);
    if (readFailed_ || (!blankA && !blankB)) { healthy_ = false; return false; }
    memset(&meta_, 0, sizeof(meta_)); meta_.magic = MAGIC; meta_.nextId = 1;
    active_ = -1; healthy_ = true; return true;
  }
  uint32_t nextId() const { return meta_.nextId; }
  bool healthy() const { return healthy_; }
  uint32_t revision() const { return meta_.revision; }
  uint32_t count() const { return meta_.count; }
  uint32_t freeSlots() const { return SLOTS - meta_.count; }
  const Entry* entry(unsigned index) const { return index < meta_.count ? &meta_.entries[index] : nullptr; }
  const Entry* find(uint32_t id) const { for (unsigned i = 0; i < meta_.count; ++i) if (meta_.entries[i].id == id) return &meta_.entries[i]; return nullptr; }
  Result read(uint32_t id, uint16_t offset, void* out, size_t len) {
    if (!healthy_) return STORAGE_ERROR;
    const Entry* e = find(id); if (!e) return NOT_FOUND;
    if (offset > FRAME_BYTES || len > size_t(FRAME_BYTES - offset)) return BAD_OFFSET;
    return flash_.read(slotAddress(e->slot) + offset, out, len) ? OK : STORAGE_ERROR;
  }
  Result put(uint32_t expected, uint32_t id, uint32_t pageRevision, uint32_t crc, const uint8_t* frame, Entry& result) {
    if (!healthy_) return STORAGE_ERROR;
    if (expected != meta_.revision) return CONFLICT;
    if (meta_.revision == UINT32_MAX || meta_.generation == UINT32_MAX) return FULL;
    unsigned index = meta_.count;
    if (id) {
      for (unsigned i = 0; i < meta_.count; ++i) if (meta_.entries[i].id == id) { index = i; break; }
      if (index == meta_.count) return NOT_FOUND;
      if (meta_.entries[index].revision != pageRevision) return CONFLICT;
      if (pageRevision == UINT32_MAX) return FULL;
    } else {
      if (pageRevision) return CONFLICT;
      if (meta_.count == CAPACITY || meta_.nextId == UINT32_MAX) return FULL;
    }
    if (crc32(frame, FRAME_BYTES) != crc) return BAD_CRC;
    for (unsigned y = 0; y < HEIGHT; ++y) if (frame[y * STRIDE + STRIDE - 1] & 0x3f) return BAD_PADDING;
    unsigned slot = 0;
    for (; slot < SLOTS; ++slot) { bool used = false; for (unsigned i = 0; i < meta_.count; ++i) if (meta_.entries[i].slot == slot) used = true; if (!used) break; }
    if (slot == SLOTS) return FULL;
    uint32_t addr = slotAddress(slot);
    if (!flash_.erase(addr) || !erased(addr) || !flash_.program(addr, frame, FRAME_BYTES) || !verifyFrame(slot, crc)) return STORAGE_ERROR;
    Metadata next = meta_;
    Entry e = {id ? id : next.nextId++, id ? next.entries[index].revision + 1 : 1u, crc, slot};
    if (!e.revision || !next.nextId) return FULL;
    next.entries[index] = e; if (!id) ++next.count;
    Result r = commit(next); if (r == OK) result = e; return r;
  }
  Result remove(uint32_t expected, uint32_t id, uint32_t pageRevision) {
    if (!healthy_) return STORAGE_ERROR;
    if (expected != meta_.revision) return CONFLICT;
    unsigned i = 0; while (i < meta_.count && meta_.entries[i].id != id) ++i;
    if (i == meta_.count) return NOT_FOUND;
    if (meta_.entries[i].revision != pageRevision) return CONFLICT;
    Metadata next = meta_; for (unsigned j = i + 1; j < next.count; ++j) next.entries[j - 1] = next.entries[j];
    --next.count; memset(&next.entries[next.count], 0, sizeof(Entry)); return commit(next);
  }
  Result reorder(uint32_t expected, const uint32_t* ids, unsigned count) {
    if (!healthy_) return STORAGE_ERROR;
    if (expected != meta_.revision) return CONFLICT;
    if (count != meta_.count) return MALFORMED;
    Metadata next = meta_;
    for (unsigned i = 0; i < count; ++i) {
      const Entry* e = find(ids[i]); if (!e) return NOT_FOUND;
      for (unsigned j = 0; j < i; ++j) if (ids[j] == ids[i]) return MALFORMED;
      next.entries[i] = *e;
    }
    return commit(next);
  }
 private:
  static uint32_t slotAddress(unsigned slot) { return BASE + (2 + slot) * SECTOR; }
  bool readFlash(uint32_t addr, void* out, size_t len) { if (flash_.read(addr, out, len)) return true; readFailed_ = true; return false; }
  bool erased(uint32_t addr) { uint32_t words[32]; for (unsigned off = 0; off < SECTOR; off += sizeof(words)) { if (!readFlash(addr + off, words, sizeof(words))) return false; for (unsigned i = 0; i < sizeof(words)/sizeof(words[0]); ++i) if (words[i] != 0xffffffffu) return false; } return true; }
  bool verifyFrame(unsigned slot, uint32_t expected) {
    uint8_t buf[128]; uint32_t c = 0xffffffffu;
    for (unsigned off = 0; off < FRAME_BYTES;) { unsigned n = FRAME_BYTES - off; if (n > sizeof(buf)) n = sizeof(buf); if (!readFlash(slotAddress(slot) + off, buf, n)) return false; for (unsigned i = 0; i < n; ++i) { c ^= buf[i]; for (unsigned j = 0; j < 8; ++j) c = (c >> 1) ^ (0xedb88320u & (0u - (c & 1u))); } off += n; }
    return (c ^ 0xffffffffu) == expected;
  }
  bool load(unsigned sector, Metadata& m) {
    if (!readFlash(BASE + sector * SECTOR, &m, sizeof(m)) || m.magic != MAGIC || m.marker != COMMITTED || m.count > CAPACITY || !m.nextId || m.crc != crc32(reinterpret_cast<const uint8_t*>(&m), offsetof(Metadata, crc))) return false;
    for (unsigned i = 0; i < m.count; ++i) {
      if (!m.entries[i].id || !m.entries[i].revision || m.entries[i].slot >= SLOTS || !verifyFrame(m.entries[i].slot, m.entries[i].crc)) return false;
      for (unsigned j = 0; j < i; ++j) if (m.entries[i].id == m.entries[j].id || m.entries[i].slot == m.entries[j].slot) return false;
    }
    return true;
  }
  Result commit(Metadata& next) {
    if (next.revision == UINT32_MAX || next.generation == UINT32_MAX) return FULL;
    ++next.revision; ++next.generation; next.crc = crc32(reinterpret_cast<const uint8_t*>(&next), offsetof(Metadata, crc)); next.marker = 0xffffffffu;
    unsigned target = active_ == 0 ? 1 : 0; uint32_t addr = BASE + target * SECTOR;
    if (!flash_.erase(addr) || !erased(addr) || !flash_.program(addr, &next, offsetof(Metadata, marker))) return STORAGE_ERROR;
    Metadata check; if (!flash_.read(addr, &check, sizeof(check)) || memcmp(&check, &next, sizeof(next)) != 0) return STORAGE_ERROR;
    uint32_t marker = COMMITTED;
    if (!flash_.program(addr + offsetof(Metadata, marker), &marker, sizeof(marker))) { healthy_ = false; return STORAGE_ERROR; }
    if (!load(target, check)) { healthy_ = false; return STORAGE_ERROR; }
    meta_ = check; active_ = int(target); return OK;
  }
  Flash& flash_; Metadata meta_; int active_; bool healthy_, readFailed_;
};
} }
#endif
