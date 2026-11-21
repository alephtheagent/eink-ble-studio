#ifndef EINK_PROTOCOL_H
#define EINK_PROTOCOL_H

#include <stdint.h>
#include <stddef.h>
#include <string.h>

namespace eink {
static const uint16_t WIDTH = 122, HEIGHT = 250, STRIDE = 16, FRAME_BYTES = 4000;
static const uint32_t TIMEOUT_MS = 15000;
enum State : uint8_t { IDLE, RECEIVING, QUEUED, REFRESHING, DONE, ERROR };
enum Error : uint8_t { NONE, MALFORMED, BUSY, ID, OFFSET, LENGTH, CRC, PADDING, TIMEOUT, DISCONNECTED };

inline uint16_t get16(const uint8_t* p) { return uint16_t(p[0]) | (uint16_t(p[1]) << 8); }
inline uint32_t get32(const uint8_t* p) { return uint32_t(get16(p)) | (uint32_t(get16(p + 2)) << 16); }
inline void put16(uint8_t* p, uint16_t n) { p[0] = uint8_t(n); p[1] = uint8_t(n >> 8); }
inline void put32(uint8_t* p, uint32_t n) { put16(p, uint16_t(n)); put16(p + 2, uint16_t(n >> 16)); }
inline uint32_t crc32(const uint8_t* p, size_t n) {
  uint32_t c = 0xffffffffu;
  while (n--) { c ^= *p++; for (unsigned i = 0; i < 8; ++i) c = (c >> 1) ^ (0xedb88320u & (0u - (c & 1u))); }
  return c ^ 0xffffffffu;
}

// Call command/tick/disconnect and refresh transitions under the same lock.
class Protocol {
 public:
  Protocol() : state_(IDLE), error_(NONE), id_(0), received_(0), expected_(0), generation_(0), activity_(0) {}
  void command(const uint8_t* p, size_t n, uint32_t now) {
    tick(now);
    if (!p || n == 0 || n > 20) { error_ = MALFORMED; return; }
    const uint8_t op = p[0];
    if ((op == 1 && n != 11) || (op == 2 && (n < 8 || n > 20)) ||
        ((op == 3 || op == 4) && n != 5) || op < 1 || op > 4) { error_ = MALFORMED; return; }
    const uint32_t id = get32(p + 1);
    if (op == 1) {
      const uint16_t length = get16(p + 5); const uint32_t expected = get32(p + 7);
      if (state_ == QUEUED || state_ == REFRESHING) { error_ = BUSY; return; }
      if (state_ == RECEIVING) {
        if (id != id_ || length != FRAME_BYTES || expected != expected_) { error_ = BUSY; return; }
        activity_ = now; error_ = NONE; return;
      }
      if (length != FRAME_BYTES) { error_ = LENGTH; return; }
      state_ = RECEIVING; error_ = NONE; id_ = id; received_ = 0; expected_ = expected; activity_ = now; return;
    }
    if (op == 4) {
      if (state_ == QUEUED || state_ == REFRESHING) { error_ = BUSY; return; }
      if (state_ != IDLE && id != id_) { error_ = ID; return; }
      state_ = IDLE; error_ = NONE; id_ = 0; received_ = 0; expected_ = 0; return;
    }
    if (id != id_) { error_ = ID; return; }
    if (op == 3 && (state_ == QUEUED || state_ == REFRESHING || state_ == DONE)) { error_ = NONE; return; }
    if (state_ != RECEIVING) { error_ = BUSY; return; }
    if (op == 2) {
      const uint16_t offset = get16(p + 5); const size_t count = n - 7;
      if (offset > FRAME_BYTES || count > size_t(FRAME_BYTES - offset)) { error_ = LENGTH; return; }
      if (offset == received_) { memcpy(frame_ + offset, p + 7, count); received_ += uint16_t(count); activity_ = now; error_ = NONE; return; }
      if (offset < received_ && offset + count <= received_ && memcmp(frame_ + offset, p + 7, count) == 0) { activity_ = now; error_ = NONE; return; }
      error_ = OFFSET; return;
    }
    if (received_ != FRAME_BYTES) { error_ = LENGTH; return; }
    if (crc32(frame_, FRAME_BYTES) != expected_) { state_ = ERROR; error_ = CRC; return; }
    for (unsigned y = 0; y < HEIGHT; ++y) if (frame_[y * STRIDE + STRIDE - 1] & 0x3f) { state_ = ERROR; error_ = PADDING; return; }
    state_ = QUEUED; error_ = NONE;
  }
  void tick(uint32_t now) { if (state_ == RECEIVING && uint32_t(now - activity_) >= TIMEOUT_MS) { state_ = ERROR; error_ = TIMEOUT; } }
  void disconnect() { if (state_ == RECEIVING) { state_ = ERROR; error_ = DISCONNECTED; } }
  bool beginRefresh() { if (state_ != QUEUED) return false; state_ = REFRESHING; error_ = NONE; return true; }
  void finishRefresh() { if (state_ == REFRESHING) { ++generation_; state_ = DONE; error_ = NONE; } }
  const uint8_t* frame() const { return frame_; }
  State state() const { return state_; }
  Error error() const { return error_; }
  void status(uint8_t out[20]) const {
    out[0] = 1; out[1] = state_; out[2] = error_; out[3] = 0;
    put32(out + 4, id_); put16(out + 8, received_); put16(out + 10, FRAME_BYTES);
    put32(out + 12, expected_); put32(out + 16, generation_);
  }
 private:
  State state_; Error error_; uint32_t id_; uint16_t received_; uint32_t expected_, generation_, activity_;
  uint8_t frame_[FRAME_BYTES];
};
}
#endif
