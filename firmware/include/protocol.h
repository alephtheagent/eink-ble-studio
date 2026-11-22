#ifndef EINK_PROTOCOL_H
#define EINK_PROTOCOL_H
#include <stdint.h>
#include <stddef.h>
#include <string.h>

namespace eink {
static const uint16_t WIDTH = 122, HEIGHT = 250, STRIDE = 16, FRAME_BYTES = 4000;
static const uint32_t TIMEOUT_MS = 15000;
enum State : uint8_t { IDLE, RECEIVING, QUEUED, REFRESHING, DONE, ERROR };
enum Error : uint8_t { NONE, MALFORMED, BUSY, ID, OFFSET, LENGTH, CRC, PADDING, TIMEOUT, DISCONNECTED, CODEC_STREAM, STORAGE };
enum Action : uint8_t { ACTION_NONE, ACTION_RESET_WELCOME, ACTION_ENTER_DFU };
inline uint16_t get16(const uint8_t* p) { return uint16_t(p[0]) | (uint16_t(p[1]) << 8); }
inline uint32_t get32(const uint8_t* p) { return uint32_t(get16(p)) | (uint32_t(get16(p + 2)) << 16); }
inline void put16(uint8_t* p, uint16_t n) { p[0] = uint8_t(n); p[1] = uint8_t(n >> 8); }
inline void put32(uint8_t* p, uint32_t n) { put16(p, uint16_t(n)); put16(p + 2, uint16_t(n >> 16)); }
inline uint32_t crc32(const uint8_t* p, size_t n) {
  uint32_t c = 0xffffffffu;
  while (n--) { c ^= *p++; for (unsigned i = 0; i < 8; ++i) c = (c >> 1) ^ (0xedb88320u & (0u - (c & 1u))); }
  return c ^ 0xffffffffu;
}

// All commands, status snapshots and transitions are serialized by the caller.
class Protocol {
 public:
  Protocol() : state_(IDLE), error_(NONE), id_(0), received_(0), total_(0), expected_(0), generation_(0), activity_(0), owner_(0), dialect_(0), codec_(0), produced_(0), literal_(0), repeat_(0), lastLen_(0), action_(ACTION_NONE) {}
  void command(const uint8_t* p, size_t n, uint32_t now, uint16_t conn = 0) { handle(p, n, now, conn, 1); }
  void command2(const uint8_t* p, size_t n, uint32_t now, uint16_t conn = 0) { handle(p, n, now, conn, 2); }
  void tick(uint32_t now) { if (state_ == RECEIVING && uint32_t(now - activity_) >= TIMEOUT_MS) { state_ = ERROR; error_ = TIMEOUT; } }
  void disconnect(uint16_t conn = 0) { if (state_ == RECEIVING && owner_ == conn) { state_ = ERROR; error_ = DISCONNECTED; } }
  bool beginRefresh() { if (state_ != QUEUED) return false; state_ = REFRESHING; error_ = NONE; return true; }
  void finishRefresh() { if (state_ == REFRESHING) { ++generation_; state_ = DONE; error_ = NONE; } }
  const uint8_t* frame() const { return frame_; }
  uint16_t owner() const { return owner_; }
  State state() const { return state_; }
  Error error() const { return error_; }
  Action action() const { return action_; }
  Action consumeAction() { Action a = action_; action_ = ACTION_NONE; return a; }
  void actionFailed() { error_ = STORAGE; }
  void status(uint8_t out[20]) const {
    out[0] = 1; out[1] = state_; out[2] = error_; out[3] = action_;
    put32(out + 4, id_); put16(out + 8, received_); put16(out + 10, FRAME_BYTES);
    put32(out + 12, expected_); put32(out + 16, generation_);
  }
  void status2(uint8_t out[20]) const {
    out[0] = 2; out[1] = state_; out[2] = error_; out[3] = action_ ? uint8_t(action_) : codec_;
    put32(out + 4, id_); put16(out + 8, received_); put16(out + 10, total_);
    put32(out + 12, expected_); put32(out + 16, generation_);
  }
 private:
  bool feed(const uint8_t* p, size_t n) {
    for (size_t i = 0; i < n; ++i) {
      uint8_t b = p[i];
      if (!codec_ || literal_) {
        if (produced_ == FRAME_BYTES) return false;
        frame_[produced_++] = b;
        if (literal_) --literal_;
      } else if (repeat_) {
        if (repeat_ > FRAME_BYTES - produced_) return false;
        for (unsigned j = 0; j < repeat_; ++j) frame_[produced_++] = b;
        repeat_ = 0;
      } else if (b < 128) {
        literal_ = b + 1;
      } else if (b == 128) return false;
      else {
        repeat_ = uint8_t(257 - b);
        if (repeat_ > FRAME_BYTES - produced_) return false;
      }
    }
    return true;
  }
  void handle(const uint8_t* p, size_t n, uint32_t now, uint16_t conn, uint8_t dialect) {
    tick(now);
    if (!p || !n || n > (dialect == 1 ? 20u : 244u)) { error_ = MALFORMED; return; }
    uint8_t op = p[0];
    if (dialect == 2) { if (op < 0x11 || op > 0x16) { error_ = MALFORMED; return; } op -= 0x10; }
    if (op == 5 || op == 6) {
      if (n != 1) { error_ = MALFORMED; return; }
      if (state_ == RECEIVING || state_ == QUEUED || state_ == REFRESHING) { error_ = BUSY; return; }
      action_ = op == 5 ? ACTION_ENTER_DFU : ACTION_RESET_WELCOME;
      error_ = NONE;
      return;
    }
    if ((op == 1 && n != (dialect == 1 ? 11u : 14u)) || (op == 2 && n < 8) ||
        ((op == 3 || op == 4) && n != 5) || op < 1 || op > 4) { error_ = MALFORMED; return; }
    uint32_t id = get32(p + 1);
    if ((state_ == RECEIVING || state_ == QUEUED || state_ == REFRESHING) && (owner_ != conn || dialect_ != dialect)) { error_ = BUSY; return; }
    if (op == 1) {
      uint8_t codec = dialect == 1 ? 0 : p[5];
      uint16_t decoded = get16(p + (dialect == 1 ? 5 : 6));
      uint16_t total = dialect == 1 ? FRAME_BYTES : get16(p + 8);
      uint32_t expected = get32(p + (dialect == 1 ? 7 : 10));
      if (state_ == QUEUED || state_ == REFRESHING) { error_ = BUSY; return; }
      if (state_ == RECEIVING) {
        if (id != id_ || decoded != FRAME_BYTES || codec != codec_ || total != total_ || expected != expected_) { error_ = BUSY; return; }
        activity_ = now; error_ = NONE; return;
      }
      if (decoded != FRAME_BYTES || !total || total > FRAME_BYTES || (!codec && total != FRAME_BYTES)) { error_ = LENGTH; return; }
      if (codec > 1) { error_ = CODEC_STREAM; return; }
      state_ = RECEIVING; error_ = NONE; id_ = id; received_ = produced_ = 0; total_ = total; expected_ = expected;
      activity_ = now; owner_ = conn; dialect_ = dialect; codec_ = codec; literal_ = repeat_ = 0; lastLen_ = 0; return;
    }
    if (op == 4) {
      if (state_ == QUEUED || state_ == REFRESHING || (dialect == 2 && state_ == DONE)) { error_ = BUSY; return; }
      if (state_ != IDLE && (id != id_ || dialect_ != dialect || owner_ != conn)) { error_ = ID; return; }
      state_ = IDLE; error_ = NONE; id_ = received_ = total_ = expected_ = codec_ = 0; return;
    }
    if (id != id_ || dialect_ != dialect || owner_ != conn) { error_ = ID; return; }
    if (op == 3 && (state_ == QUEUED || state_ == REFRESHING || state_ == DONE)) { error_ = NONE; return; }
    if (state_ != RECEIVING) { error_ = BUSY; return; }
    if (op == 2) {
      uint16_t offset = get16(p + 5); size_t count = n - 7;
      if (offset > total_ || count > size_t(total_ - offset)) { error_ = LENGTH; return; }
      if (offset == received_) {
        if (!feed(p + 7, count)) { state_ = ERROR; error_ = CODEC_STREAM; return; }
        received_ += uint16_t(count); activity_ = now; error_ = NONE;
        if (dialect == 2) { memcpy(last_, p, n); lastLen_ = uint16_t(n); }
        return;
      }
      if ((dialect == 1 && offset < received_ && offset + count <= received_ && memcmp(frame_ + offset, p + 7, count) == 0) ||
          (dialect == 2 && n == lastLen_ && memcmp(last_, p, n) == 0)) { activity_ = now; error_ = NONE; return; }
      error_ = OFFSET; return;
    }
    if (received_ != total_) { error_ = LENGTH; return; }
    if (produced_ != FRAME_BYTES || literal_ || repeat_) { state_ = ERROR; error_ = CODEC_STREAM; return; }
    if (crc32(frame_, FRAME_BYTES) != expected_) { state_ = ERROR; error_ = CRC; return; }
    for (unsigned y = 0; y < HEIGHT; ++y) if (frame_[y * STRIDE + STRIDE - 1] & 0x3f) { state_ = ERROR; error_ = PADDING; return; }
    state_ = QUEUED; error_ = NONE;
  }
  State state_; Error error_; uint32_t id_; uint16_t received_, total_; uint32_t expected_, generation_, activity_;
  uint16_t owner_; uint8_t dialect_, codec_; uint16_t produced_; uint8_t literal_, repeat_; uint16_t lastLen_;
  Action action_;
  uint8_t last_[244], frame_[FRAME_BYTES];
};
}
#endif
