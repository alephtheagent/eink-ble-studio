#ifndef EINK_ANIM_PLAYER_H
#define EINK_ANIM_PLAYER_H
#include "anim_storage.h"
#include "anim_codec.h"

namespace eink { namespace anim {

// Panel abstraction: the player never touches GxEPD2, SPI or Arduino.
struct Panel {
  virtual ~Panel() {}
  // Present the changed rectangle (x,y,w,h) of the 4000-byte native frame with a partial
  // panel refresh. `frame` is the whole 4000-byte image; the implementation clips it to
  // the window (GxEPD2 does exactly that in GxEPD2_213_BN::_writeImagePart).
  virtual void present(uint16_t x, uint16_t y, uint16_t w, uint16_t h, const uint8_t* frame) = 0;
  // Full refresh that clears the panel first (whole-window redraw).
  virtual void presentFull(const uint8_t* frame) = 0;
  // Full refresh that leaves the panel uniformly white without drawing a bitmap. Used when
  // there is no static content to show (no pages stored, or the page read failed).
  virtual void clear() = 0;
  // Playback finished or was stopped: put the panel back to a low-power state.
  virtual void hibernate() {}
};

struct BBox {
  uint16_t x, y, w, h, area;
};

// Result of returning the panel to static content after playback.
enum RestoreResult : uint8_t {
  RESTORE_PAGE = 0,   // the first stored page was drawn with a full refresh
  RESTORE_EMPTY = 1,  // no page collection: the panel was cleared white
  RESTORE_FAILED = 2  // the page store could not be read: cleared white, log once
};

// Puts the panel back to static content after playback stops, using `buffer` as scratch
// (a 4000-byte area the caller guarantees is not in use, e.g. Player::buffer() while the
// player is stopped). Deliberately does no flash work itself beyond the caller-visible page
// read and never loops: one read attempt, one present, return. A caller that must not block
// BLE should call it from the main loop only.
template<class PageStore>
inline RestoreResult restoreStatic(Panel& panel, PageStore& pages, uint8_t* buffer) {
  if (pages.count()) {
    const auto* entry = pages.entry(0);
    if (entry && pages.read(entry->id, 0, buffer, FRAME_BYTES) == 0) {  // pages::OK == 0
      panel.presentFull(buffer);
      return RESTORE_PAGE;
    }
    panel.clear();
    return RESTORE_FAILED;
  }
  panel.clear();
  return RESTORE_EMPTY;
}

enum PlayerState : uint8_t { PLAYER_IDLE, PLAYER_RUNNING };

// Decodes and presents one stored animation on deadlines. No Arduino, no heap.
//
// Buffer arithmetic — why the whole feature uses exactly TWO static 4000-byte buffers:
//   * this player holds ONE frame (`frame_`). A delta frame is decoded IN PLACE
//     (out[i] = prev[i] ^ value, reading each byte before overwriting it) and the
//     changed-pixel bounding box is accumulated from the produced bytes during that decode,
//     so no second full frame is needed to diff against. A single encoded byte expands to at
//     most 128 decoded bytes, so a rolling 128-byte window of the pre-decode contents is
//     enough to recover each XOR — that window, not a frame, is the extra state.
//   * the wire endpoint holds ONE frame (`decoded_`) because FRAME_COMMIT must verify the
//     CRC of the decoded frame and COMMIT needs the running animation CRC. That buffer must
//     stay separate: docs/protocol-animation.md explicitly allows an upload while an
//     animation is playing, and sharing one buffer would corrupt the frame on the panel.
// Total static frame storage: 2 x 4000 = 8000 bytes, zero per-frame allocation.
//
// Timing: delayMs is the hold time AFTER a refresh completes, floored at 100 ms; a refresh
// that overruns simply delays the animation and no frame is ever skipped.
//
// Presentation policy (ghosting mitigation). A frame is presented with a partial window
// (the changed bounding box) only when ALL hold: a frame was already presented, the blob
// is kind 1 (delta), the loop cadence has not fired, and the changed box covers less than
// `threshold_` percent of the panel's real pixels. Otherwise it is a full refresh: the first
// frame, any kind 0 blob, every Nth presented frame, a scene change, and after stop() (or
// another owner takes the panel) the next start() presents a full frame again. A frame whose
// changed box is empty is not refreshed at all and still consumes its delay.
template<class Store> class Player {
 public:
  static constexpr uint32_t PERSIST_MS = 10000;
  // Same value as the wire's "no frame" index; defined locally so the player does not
  // depend on anim_wire.h (it is usable without the BLE endpoint).
  static constexpr uint16_t NO_FRAME = 0xffffu;
  // Real visible pixels (122 x 250), NOT frame bits: the six padding bits per row must
  // never influence the area threshold.
  static constexpr uint32_t PANEL_PIXELS = uint32_t(WIDTH) * uint32_t(HEIGHT);
  // Defaults: a full refresh every 10 presented frames, and whenever the changed bounding
  // box covers 60% or more of the panel. Partial refresh is on by default.
  static constexpr uint32_t DEFAULT_LOOP_REFRESH = 10;
  static constexpr uint8_t DEFAULT_THRESHOLD = 60;

  explicit Player(Panel& panel)
      : panel_(panel), store_(nullptr), state_(PLAYER_IDLE), index_(0), error_(OK), loops_(0),
        loopRefresh_(DEFAULT_LOOP_REFRESH), threshold_(DEFAULT_THRESHOLD), partial_(true),
        deadline_(0), persisted_(0), persistedOnce_(false), presented_(false),
        startedCount_(0), startedCrc_(0), bbox_{0, 0, 0, 0, 0} {
    memset(frame_, 0, sizeof(frame_));
  }

  // loopRefresh: N presented frames between forced full refreshes (0 disables the cadence).
  // thresholdPercent: changed-area percent of the panel above which a frame is presented as
  // a full refresh.
  void configure(uint32_t loopRefresh, uint8_t thresholdPercent) {
    loopRefresh_ = loopRefresh;
    threshold_ = thresholdPercent > 100 ? 100 : thresholdPercent;
  }
  void partialPresentation(bool value) { partial_ = value; }

  bool start(Store& store, uint16_t index, uint32_t nowMs) {
    stop();
    if (!store.healthy()) { error_ = STORAGE; return false; }
    if (!store.count()) { error_ = NOT_FOUND; return false; }
    if (index >= store.count()) { error_ = LIMIT; return false; }
    if (!store.frameEncLen(index) || store.frameEncLen(index) > FRAME_BYTES) {
      error_ = MALFORMED;
      return false;
    }
    store_ = &store;
    index_ = index;
    loops_ = 0;
    presented_ = false;
    error_ = OK;
    // The animation is identified by its frame count and animation CRC. A COMMIT that
    // replaces it during playback changes at least one of them (a metadata write always
    // advances the generation, and the animation CRC covers every decoded frame), so this
    // snapshot is what lets tick() notice that its index no longer refers to this animation.
    startedCount_ = uint16_t(store.count());
    startedCrc_ = store.animationCrc();
    state_ = PLAYER_RUNNING;
    deadline_ = nowMs;  // the first frame is due immediately
    return true;
  }

  // Stops playback. The caller decides what to draw next (the panel keeps the last frame).
  void stop() {
    if (state_ == PLAYER_RUNNING && presented_) panel_.hibernate();
    state_ = PLAYER_IDLE;
    store_ = nullptr;
    presented_ = false;
    bbox_ = BBox{0, 0, 0, 0, 0};
  }

  bool running() const { return state_ == PLAYER_RUNNING; }
  uint16_t index() const { return index_; }
  Result error() const { return error_; }
  uint32_t deadline() const { return deadline_; }
  uint32_t loops() const { return loops_; }
  uint32_t loopRefresh() const { return loopRefresh_; }
  uint8_t threshold() const { return threshold_; }
  const uint8_t* frame() const { return frame_; }
  BBox lastBBox() const { return bbox_; }
  // Mutable access to the player's ONE 4000-byte frame buffer. Valid ONLY while the player
  // is not running: it is the caller's scratch area for restoring static content after
  // stop(). Using it while running() would corrupt the frame on the panel.
  uint8_t* buffer() { return (state_ == PLAYER_RUNNING) ? nullptr : frame_; }

  // Presents one due frame. Returns true when a frame was decoded and presented.
  bool tick(uint32_t nowMs) {
    if (state_ != PLAYER_RUNNING || !store_) return false;
    // Re-identify the animation before touching index_. A COMMIT during playback may have
    // replaced it with a different length or different contents; entry(index_) would then
    // read past frameCount (memory-safe but garbage) or silently mix two animations.
    if (!store_->healthy() || uint16_t(store_->count()) != startedCount_ ||
        store_->animationCrc() != startedCrc_) {
      fail(ANIM_CHANGED);
      return false;
    }
    if (int32_t(nowMs - deadline_) < 0) return false;
    // A delta frame needs its predecessor, so starting at index > 0 first replays frames
    // 0..index-1 in place without presenting anything. A full-kind frame is self-contained.
    if (!presented_ && index_ && store_->frameKind(index_) != KIND_FULL) {
      if (!primeTo(index_)) return false;
      if (state_ != PLAYER_RUNNING) return false;
    }
    const uint32_t hold = holdFor(index_);
    if (!decodeAndPresent()) return false;
    if (state_ != PLAYER_RUNNING) return true;  // one-shot animation finished
    // delayMs is the hold time after this refresh completed.
    deadline_ = nowMs + hold;
    return true;
  }

  // True at most once per PERSIST_MS; the caller persists the playing index when it is.
  bool shouldPersist(uint32_t nowMs) {
    if (state_ != PLAYER_RUNNING) return false;
    if (persistedOnce_ && uint32_t(nowMs - persisted_) < PERSIST_MS) return false;
    persistedOnce_ = true;
    persisted_ = nowMs;
    return true;
  }

 private:
  static constexpr uint32_t READ_CHUNK = 64;
  // One encoded byte produces at most 128 decoded bytes (a PackBits repeat of 128).
  static constexpr uint16_t MAX_RUN = 128;

  uint32_t holdFor(uint16_t index) const {
    const uint32_t delay = store_->frameDelay(index);
    return delay < DELAY_MIN_MS ? DELAY_MIN_MS : delay;
  }

  // Decodes stored frame `index` IN PLACE into frame_ and accumulates the changed-pixel
  // bounding box into `box`. For a delta, frame_ is its own reference, so every byte is read
  // out of the rolling window before it is overwritten.
  bool decodeInPlace(uint16_t index, BBox& box) {
    const uint8_t kind = store_->frameKind(index);
    StreamDecoder decoder;
    decoder.begin(kind, kind == KIND_FULL ? nullptr : frame_);
    const uint32_t encoded = store_->payloadLength(index);
    uint8_t chunk[READ_CHUNK];
    box = BBox{0, 0, 0, 0, 0};

    uint8_t window[MAX_RUN];
    uint16_t windowBase = 0;
    uint16_t windowLen = 0;
    // Refreshes the window so it covers [at, at + MAX_RUN).
    auto cover = [&](uint16_t at) {
      const uint16_t remaining = uint16_t(FRAME_BYTES - at);
      windowLen = remaining < MAX_RUN ? remaining : MAX_RUN;
      windowBase = at;
      memcpy(window, frame_ + at, windowLen);
    };
    cover(0);

    for (uint32_t off = 0; off < encoded;) {
      uint32_t n = encoded - off;
      if (n > READ_CHUNK) n = READ_CHUNK;
      if (store_->readPayload(index, off, chunk, n) != OK) { fail(STORAGE); return false; }
      // One encoded byte per push bounds each step's output to MAX_RUN bytes, which is
      // exactly what the rolling window covers.
      for (uint32_t i = 0; i < n; ++i) {
        const uint16_t before = decoder.produced();
        if (uint16_t(before - windowBase) >= windowLen) cover(before);
        if (!decoder.push(chunk + i, 1, frame_)) { fail(CODEC); return false; }
        const uint16_t after = decoder.produced();
        for (uint16_t p = before; p < after; ++p) {
          const uint16_t slot = uint16_t(p - windowBase);
          const uint8_t previous = slot < windowLen ? window[slot] : frame_[p];
          addChanged(box, p, uint8_t(frame_[p] ^ previous));
        }
      }
      off += n;
    }
    if (!decoder.finish() || decoder.produced() != FRAME_BYTES) { fail(CODEC); return false; }
    // Verify against the CRC recorded at upload, so a damaged blob is a reported error
    // instead of a corrupted picture.
    if (eink::crc32(frame_, FRAME_BYTES) != store_->frameCrc(index)) { fail(BAD_CRC); return false; }
    return true;
  }

  // Adds the changed bits of one decoded byte to the bounding box, ignoring the six padding
  // bits of each row's last byte (122 pixels live in 16 bytes, 1 = black).
  static void addChanged(BBox& box, uint16_t produced, uint8_t diff) {
    if (!diff) return;
    const uint16_t y = uint16_t(produced / STRIDE);
    const uint16_t byte = uint16_t(produced % STRIDE);
    const uint8_t mask = byte == STRIDE - 1 ? 0xc0 : 0xff;
    diff = uint8_t(diff & mask);
    if (!diff) return;
    uint16_t x0 = WIDTH, y0 = HEIGHT, x1 = 0, y1 = 0;
    if (box.area) {
      x0 = box.x;
      y0 = box.y;
      x1 = uint16_t(box.x + box.w - 1);
      y1 = uint16_t(box.y + box.h - 1);
    }
    for (uint8_t bit = 0; bit < 8; ++bit) {
      if (!(diff & (0x80u >> bit))) continue;
      const uint16_t x = uint16_t(byte * 8u + bit);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    box.x = x0;
    box.y = y0;
    box.w = uint16_t(x1 - x0 + 1);
    box.h = uint16_t(y1 - y0 + 1);
    box.area = uint16_t(uint32_t(box.w) * box.h);
  }

  // Builds the delta reference for `target` by decoding frames 0..target-1 in order, in
  // place. Nothing is presented; the boxes produced here are discarded because the first
  // presented frame is always a full refresh anyway.
  bool primeTo(uint16_t target) {
    for (uint16_t i = 0; i < target; ++i) {
      BBox ignored = {0, 0, 0, 0, 0};
      if (!decodeInPlace(i, ignored)) return false;
    }
    return true;
  }

  bool decodeAndPresent() {
    // start() snapshotted the count; index_ must still be inside it before any entry() read.
    if (index_ >= startedCount_) { fail(ANIM_CHANGED); return false; }
    const uint8_t kind = store_->frameKind(index_);
    // In place: frame_ becomes the new frame and bbox_ describes what changed, accumulated
    // during the decode rather than by diffing two buffers.
    if (!decodeInPlace(index_, bbox_)) return false;
    // An unchanged frame costs no panel time at all: the delay is still consumed, so the
    // animation keeps its timing without a pointless refresh. It does not count toward the
    // cadence either, which counts refreshes that actually happened.
    if (bbox_.area == 0 && presented_) {
      advance();
      return true;
    }
    ++loops_;
    // Cadence counts PRESENTED frames from the start of playback; the first frame is
    // always a full refresh, so with N=10 the full refreshes are frames 1, 10, 20, ... and
    // there are at most 9 partial refreshes in a row.
    const bool fastPartial = (store_->flags() & FLAG_FAST_PARTIAL) != 0;
    const bool loopBoundary = !fastPartial && loopRefresh_ && presented_ && (loops_ % loopRefresh_ == 0);
    const bool scene = !fastPartial && uint32_t(bbox_.area) * 100u >= PANEL_PIXELS * threshold_;
    // A full-kind blob normally forces a full refresh, but with FLAG_FAST_PARTIAL the
    // decoded pixels are already in frame_, so the changed box can still go through a
    // partial window. That is what removes the flash on GIF frames the encoder could
    // not compress as a delta.
    if (partial_ && presented_ && !loopBoundary && !scene && (fastPartial || kind != KIND_FULL)) {
      panel_.present(bbox_.x, bbox_.y, bbox_.w, bbox_.h, frame_);
    } else {
      panel_.presentFull(frame_);
    }
    presented_ = true;
    advance();
    return true;
  }

  void advance() {
    const uint16_t count = uint16_t(store_->count());
    if (uint16_t(index_ + 1) < count) { ++index_; return; }
    if (store_->flags() & FLAG_LOOP) { index_ = 0; return; }
    // One-shot animation: stop after the last frame, leaving it on the panel.
    panel_.hibernate();
    state_ = PLAYER_IDLE;
    store_ = nullptr;
    index_ = NO_FRAME;
  }

  void fail(Result r) {
    error_ = r;
    if (presented_) panel_.hibernate();
    state_ = PLAYER_IDLE;
    store_ = nullptr;
    presented_ = false;
  }

  Panel& panel_;
  Store* store_;
  PlayerState state_;
  uint16_t index_;
  Result error_;
  uint32_t loops_, loopRefresh_;
  uint8_t threshold_;
  bool partial_;
  uint32_t deadline_, persisted_;
  bool persistedOnce_, presented_;
  // Identity of the animation this playback belongs to (see start()).
  uint16_t startedCount_;
  uint32_t startedCrc_;
  BBox bbox_;
  // The ONLY frame buffer in the player. See the buffer-arithmetic comment at the top.
  alignas(4) uint8_t frame_[FRAME_BYTES];
};
} }
#endif
