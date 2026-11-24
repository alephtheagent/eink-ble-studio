#ifndef EINK_ANIM_WIRE_H
#define EINK_ANIM_WIRE_H
#include "anim_storage.h"
#include "anim_codec.h"

namespace eink { namespace anim {
// GATT service 7b1e0010-6ba2-4f25-8ac7-1d54e91a1000, command 7b1e0011 (WRITE with
// response, maxLen 244), status 7b1e0012 (READ, fixed 20) and data 7b1e0013 (READ,
// maxLen 20). Same 128-bit base as every other characteristic, so the pinned core's
// configUuid128Count(3) budget is unchanged.
//
// Hard rule: no flash operation runs in the BLE callback. command() validates and stages;
// poll() does the flash work (and the frame decode) in the main loop. A command with
// pending work leaves status flag bit 0 set and the client polls until it clears — the
// pages-endpoint model. The inactive bank erase is spread over many poll() calls, one
// 4 KiB sector each.
//
// The endpoint owns one decoded frame buffer: FRAME_COMMIT must verify the CRC of the
// DECODED frame (and its padding bits), and COMMIT must compare the animation CRC (CRC32
// over the concatenation of all decoded frames). Frames arrive in index order, so that
// buffer is also the reference for the next delta frame.
//
// Playback handshake: this object owns no panel and never blocks. PLAY sets a request that
// takePlay() consumes in the main loop; STOP sets one that takeStop() consumes. The main
// loop starts/stops the Player and reports back with playing().
//
// Semantics are docs/protocol-animation.md; that document is normative.
//
// RESUME, additive inside opcode 07: PLAY with start == 0xFFFF resumes at the position last
// saved in the metadata sector's playback tail, or at frame 0 when none is stored for the
// current durable animation. The ack `index` is always the index actually used, so a client
// does not need to know whether a position existed. Any other start value behaves exactly as
// before. No field, length or status bit changes.
static constexpr uint16_t OP_INFO = 0x01, OP_BEGIN = 0x02, OP_FRAME = 0x03, OP_DATA = 0x04,
                          OP_FRAME_COMMIT = 0x05, OP_COMMIT = 0x06, OP_PLAY = 0x07,
                          OP_STOP = 0x08, OP_DELETE = 0x09, OP_READ = 0x0A, OP_ABORT = 0x0C;
static constexpr uint8_t FLAG_PENDING = 1, FLAG_PLAYING = 2;
static constexpr uint16_t NO_INDEX = 0xffffu;
// Upload activity timeout, matching the legacy receiver: no accepted upload command for
// this long discards the open upload (the durable animation is untouched).
static constexpr uint32_t UPLOAD_TIMEOUT_MS = 15000;
// Per-command DATA staging: at MTU 23 the payload is at most 17 bytes, so this is never
// the limiting factor; it exists to keep the flash write out of the BLE task.
static constexpr size_t STAGE_BYTES = 512;

template<class Store> class Endpoint {
 public:
  explicit Endpoint(Store& store)
      : store_(store), op_(0), error_(OK), pending_(false), beginStarted_(false),
        playing_(false), playPending_(false), stopPending_(false), playIndex_(0), conn_(0),
        mode_(0), index_(0), count_(0), flags_(0), crc_(0), revision_(0), value_(0),
        dataBytes_(0), animCrc_(0), frameKind_(0), frameEncLen_(0), frameDelay_(0),
        frameCrc_(0), frameIndex_(0), received_(0), activity_(0), animCrcState_(0xffffffffu),
        readIndex_(0), readOffset_(0), readTotal_(0), dataLen_(0), stageLen_(0),
        uploadRevision_(0), uploadCrc_(0), uploadCount_(0), uploadFlags_(0),
        frameOpen_(false), framePendingOpen_(false), openIndex_(0), openEncLen_(0),
        openDelay_(0), openKind_(0), openCrc_(0), lastCommitOk_(false) {
    memset(stage_, 0, sizeof(stage_));
    memset(data_, 0, sizeof(data_));
    memset(decoded_, 0, sizeof(decoded_));
  }

  // ------------------------------------------------------------------ BLE callback
  // Returns void: the caller publishes status() before acknowledging the ATT write.
  void command(const uint8_t* p, size_t n, uint32_t nowMs, uint16_t conn = 0) {
    // While a command is pending the state is frozen: every command is busy.
    if (pending_) { op_ = p ? p[0] : 0; error_ = BUSY; return; }
    if (!p || !n || n > 244) { op_ = 0; error_ = MALFORMED; return; }
    const uint8_t op = p[0];
    if (mode_ && conn_ != conn) { op_ = op; error_ = BUSY; return; }
    op_ = op;
    error_ = OK;
    value_ = 0;
    dataLen_ = 0;
    dataBytes_ = 0;
    animCrc_ = 0;
    if (!store_.healthy()) { error_ = STORAGE; return; }
    switch (op) {
      case OP_INFO:
        if (n != 1) break;
        index_ = (playing_ || playPending_) ? playIndex_ : NO_INDEX;
        count_ = uint16_t(store_.count());
        dataBytes_ = store_.dataBytes();
        animCrc_ = store_.animationCrc();
        lastCommitOk_ = false;
        return;
      case OP_BEGIN: {
        if (n != 13) break;
        const uint32_t expected = get32(p + 1);
        const uint16_t declared = get16(p + 5);
        const uint16_t beginFlags = get16(p + 7);
        const uint32_t beginCrc = get32(p + 9);
        // Identical repeat while an upload is open: report progress, change nothing.
        if (mode_ && expected == uploadRevision_ && declared == uploadCount_ &&
            beginFlags == uploadFlags_ && beginCrc == uploadCrc_) {
          index_ = uint16_t(store_.uploadedFrames());
          count_ = uint16_t(store_.uploadedFrames());
          return;
        }
        if (mode_ || frameOpen_ || framePendingOpen_) { error_ = BUSY; return; }
        if (expected != store_.revision()) { error_ = CONFLICT; return; }
        if (!declared || declared > MAX_FRAMES) { error_ = MALFORMED; return; }
        if (beginFlags & ~FLAG_LOOP) { error_ = MALFORMED; return; }
        conn_ = conn;
        uploadRevision_ = expected;
        uploadCount_ = declared;
        uploadFlags_ = beginFlags;
        uploadCrc_ = beginCrc;
        count_ = declared;
        activity_ = nowMs;
        index_ = 0;
        lastCommitOk_ = false;
        pending_ = true;  // beginUpload() plus the resumable bank erase run in poll()
        return;
      }
      case OP_FRAME: {
        if (n != 13) break;
        const uint16_t frameIdx = get16(p + 1);
        const uint8_t kind = p[3];
        const uint8_t reserved = p[4];
        const uint16_t encLen = get16(p + 5);
        const uint32_t frameCrc = get32(p + 7);
        const uint16_t delay = get16(p + 11);
        if (!mode_) { error_ = CONFLICT; return; }
        if (reserved != 0) { error_ = MALFORMED; return; }
        if (kind > KIND_DELTA) { error_ = MALFORMED; return; }
        if (kind == KIND_FULL ? encLen != FRAME_BYTES : (!encLen || encLen > FRAME_BYTES)) {
          error_ = MALFORMED;
          return;
        }
        if (delay < DELAY_MIN_MS || delay > DELAY_MAX_MS) { error_ = LIMIT; return; }
        if (frameIdx >= uploadCount_) { error_ = LIMIT; return; }
        const unsigned committed = store_.uploadedFrames();
        // Ascending order; index 0 must be a full frame; only the most recently committed
        // index may be re-uploaded (a retry after a lost FRAME_COMMIT response).
        if (frameIdx > committed) { error_ = CONFLICT; return; }
        if (frameIdx == 0 && kind != KIND_FULL) { error_ = CONFLICT; return; }
        if (frameIdx < committed && unsigned(frameIdx) + 1u < committed) {
          error_ = CONFLICT;
          return;
        }
        // An identical FRAME for the open frame is idempotent: keep the received offset.
        if (frameOpen_ && frameIdx == openIndex_ && kind == openKind_ && encLen == openEncLen_ &&
            frameCrc == openCrc_ && delay == openDelay_) {
          index_ = frameIdx;
          count_ = uint16_t(committed);
          return;
        }
        if (frameOpen_ || framePendingOpen_) { error_ = BUSY; return; }
        frameIndex_ = frameIdx;
        frameKind_ = kind;
        frameEncLen_ = encLen;
        frameCrc_ = frameCrc;
        frameDelay_ = delay;
        index_ = frameIdx;
        activity_ = nowMs;
        lastCommitOk_ = false;
        pending_ = true;
        return;
      }
      case OP_DATA: {
        if (n < 4) break;
        const uint16_t off = get16(p + 1);
        const size_t len = n - 3;
        if (!frameOpen_) { error_ = CONFLICT; return; }
        if (off != received_) { error_ = BAD_OFFSET; index_ = received_; return; }
        // Never accept more encoded bytes than the frame declared.
        if (len > size_t(frameEncLen_ - received_)) { error_ = LIMIT; index_ = received_; return; }
        if (len > STAGE_BYTES - stageLen_) { error_ = LIMIT; index_ = received_; return; }
        memcpy(stage_ + stageLen_, p + 3, len);
        stageLen_ += len;
        received_ = uint16_t(received_ + len);
        index_ = received_;
        activity_ = nowMs;
        lastCommitOk_ = false;
        pending_ = true;
        return;
      }
      case OP_FRAME_COMMIT:
        if (n != 1) break;
        if (!frameOpen_) { error_ = CONFLICT; return; }
        if (received_ != frameEncLen_) { error_ = CONFLICT; index_ = received_; return; }
        activity_ = nowMs;
        lastCommitOk_ = false;
        pending_ = true;
        return;
      case OP_COMMIT:
        if (n != 1) break;
        // A COMMIT whose response was lost may be repeated: if the previous COMMIT
        // succeeded and nothing has changed since, report the same durable state.
        if (!mode_ && lastCommitOk_) {
          count_ = uint16_t(store_.count());
          dataBytes_ = store_.dataBytes();
          animCrc_ = store_.animationCrc();
          revision_ = store_.revision();
          index_ = 0;
          return;
        }
        if (!mode_) { error_ = BUSY; return; }
        if (frameOpen_ || framePendingOpen_) { error_ = BUSY; return; }
        if (store_.uploadedFrames() != uploadCount_) { error_ = CONFLICT; return; }
        activity_ = nowMs;
        pending_ = true;
        return;
      case OP_PLAY: {
        if (n != 3) break;
        const uint16_t start = get16(p + 1);
        if (!store_.count()) { error_ = NOT_FOUND; return; }
        uint16_t resume = 0;
        if (start == NO_INDEX) {
          // RESUME: the stored position only counts when it belongs to the durable animation
          // (savePosition() records the metadata generation, and loadPosition() rejects a
          // stale one). Without a valid record playback starts at 0.
          if (store_.loadPosition(resume) && resume >= store_.count()) resume = 0;
        } else {
          if (start >= store_.count()) { error_ = LIMIT; return; }
          resume = start;
        }
        index_ = resume;
        playIndex_ = resume;
        playPending_ = true;
        stopPending_ = false;
        lastCommitOk_ = false;
        return;
      }
      case OP_STOP:
        if (n != 1) break;
        // Idempotent: stopping when nothing plays is error 0.
        playPending_ = false;
        if (playing_) stopPending_ = true;
        index_ = 0;
        lastCommitOk_ = false;
        return;
      case OP_DELETE:
        if (n != 5) break;
        revision_ = get32(p + 1);
        if (mode_ || frameOpen_ || framePendingOpen_) { error_ = BUSY; return; }
        if (revision_ != store_.revision()) { error_ = CONFLICT; return; }
        // Deleting nothing is an idempotent no-op only when expectedRev is 0.
        if (!store_.count() && revision_ == 0) { count_ = 0; index_ = 0; return; }
        if (!store_.count()) { error_ = CONFLICT; return; }
        conn_ = conn;
        activity_ = nowMs;
        index_ = 0;
        lastCommitOk_ = false;
        pending_ = true;
        return;
      case OP_READ: {
        if (n != 5) break;
        index_ = get16(p + 1);
        readOffset_ = get16(p + 3);
        if (index_ >= store_.count()) { error_ = NOT_FOUND; return; }
        readIndex_ = index_;
        readTotal_ = store_.blobLength(index_);
        if (readOffset_ > readTotal_) { error_ = BAD_OFFSET; return; }
        dataBytes_ = readTotal_;
        activity_ = nowMs;
        lastCommitOk_ = false;
        pending_ = true;
        return;
      }
      case OP_ABORT:
        if (n != 1) break;
        // Discards the open upload only; the durable animation and playback are untouched.
        store_.abortUpload();
        mode_ = 0;
        frameOpen_ = framePendingOpen_ = false;
        received_ = stageLen_ = 0;
        index_ = 0;
        lastCommitOk_ = false;
        return;
    }
    error_ = MALFORMED;
  }

  // ------------------------------------------------------------------ main loop
  void poll() {
    if (!pending_) return;
    switch (op_) {
      case OP_BEGIN:
        if (!beginStarted_) {
          error_ = store_.beginUpload(uploadCount_, uploadFlags_, uploadCrc_);
          if (error_ != OK) { pending_ = false; mode_ = 0; return; }
          beginStarted_ = true;
          mode_ = 1;
          received_ = stageLen_ = 0;
          frameOpen_ = framePendingOpen_ = false;
          animCrcState_ = 0xffffffffu;
        }
        // One sector per call: the 13-sector erase of the inactive bank never blocks the
        // loop (or BLE) for longer than a single erase.
        if (store_.erasePending()) {
          error_ = store_.eraseStep();
          if (error_ != OK) { pending_ = false; beginStarted_ = false; mode_ = 0; return; }
        }
        if (!store_.erasePending()) { pending_ = false; beginStarted_ = false; }
        return;
      case OP_FRAME:
        error_ = startFrame();
        if (error_ != OK) { abandonUpload(); }
        pending_ = false;
        return;
      case OP_DATA:
        if (stageLen_) {
          // Decode first: a codec error must not leave programmed bytes claiming to be a
          // frame, so nothing is written for a rejected chunk.
          if (!decoder_.push(stage_, stageLen_, decoded_)) {
            error_ = CODEC;
            abandonUpload();
          } else {
            error_ = store_.writePayload(stage_, stageLen_);
            if (error_ != OK) abandonUpload();
          }
        }
        stageLen_ = 0;
        pending_ = false;
        return;
      case OP_FRAME_COMMIT:
        error_ = finishFrame();
        pending_ = false;
        return;
      case OP_COMMIT:
        error_ = store_.commit(animCrcState_ ^ 0xffffffffu);
        if (error_ == OK) {
          mode_ = 0;
          lastCommitOk_ = true;
          count_ = uint16_t(store_.count());
          dataBytes_ = store_.dataBytes();
          animCrc_ = store_.animationCrc();
          revision_ = store_.revision();
          index_ = 0;
        } else {
          abandonUpload();
        }
        pending_ = false;
        return;
      case OP_DELETE:
        error_ = store_.remove();
        if (error_ == OK) {
          count_ = 0;
          revision_ = store_.revision();
          dataBytes_ = 0;
          animCrc_ = 0;
          playing_ = false;
          playPending_ = false;
          stopPending_ = true;
          index_ = 0;
        }
        pending_ = false;
        return;
      case OP_READ: {
        size_t len = readTotal_ - readOffset_;
        if (len > 18) len = 18;
        put16(data_, readOffset_);
        dataLen_ = 2;
        error_ = store_.readBlob(readIndex_, readOffset_, data_ + 2, len);
        if (error_ != OK) { dataLen_ = 0; pending_ = false; return; }
        dataLen_ += len;
        index_ = readIndex_;
        dataBytes_ = readTotal_;
        value_ = readOffset_ + uint32_t(len);
        pending_ = false;
        return;
      }
    }
    pending_ = false;
  }

  // A disconnect or 15 s without accepted upload activity discards the open upload. The
  // durable animation is untouched. Returns true when an upload was discarded.
  bool expire(uint32_t nowMs) {
    if (!mode_ || pending_ || !activity_) return false;
    if (uint32_t(nowMs - activity_) < UPLOAD_TIMEOUT_MS) return false;
    abandonUpload();
    return true;
  }

  // ------------------------------------------------------------------ status / data
  void status(uint8_t out[20]) const {
    out[0] = 1;
    out[1] = op_;
    out[2] = error_;
    out[3] = uint8_t((pending_ ? FLAG_PENDING : 0) | ((playing_ || playPending_) ? FLAG_PLAYING : 0));
    put32(out + 4, store_.revision());
    put16(out + 8, uint16_t(store_.count()));
    put16(out + 10, index_);
    put32(out + 12, dataBytes_);
    put32(out + 16, animCrc_);
  }
  size_t data(uint8_t out[20]) const { memcpy(out, data_, dataLen_); return dataLen_; }

  bool pending() const { return pending_; }
  bool uploading() const { return mode_ == 1 || store_.uploading(); }
  bool idle() const { return !pending_ && !mode_; }
  // True while an upload, a pending command or panel-owning playback exists. main.cpp uses
  // it to exclude the legacy and pages endpoints while animation work is in flight.
  bool busy() const { return mode_ != 0 || pending_ || playPending_ || playing_ || stopPending_; }
  bool ownsUpload() const { return mode_ != 0; }

  // Playback handshake.
  bool takePlay() { bool value = playPending_; playPending_ = false; return value; }
  bool takeStop() { bool value = stopPending_; stopPending_ = false; return value; }
  bool playing() const { return playing_; }
  uint16_t playIndex() const { return playIndex_; }
  void playing(bool value) {
    playing_ = value;
    if (!value) playIndex_ = 0;
    if (value) stopPending_ = false;
  }
  // The caller returned the panel to static content (or another path owns it).
  void playbackStopped() { playing_ = false; playPending_ = false; playIndex_ = 0; stopPending_ = false; }
  uint32_t runningCrc() const { return animCrcState_ ^ 0xffffffffu; }

  // Called from the main loop (never the BLE task) after poll() has drained, so it cannot
  // race the flash work. A disconnect discards an open upload immediately — letting it sit
  // until the 15 s timeout would keep legacy/page traffic out for a connection that is gone —
  // but a metadata write that is already running is allowed to finish durably: aborting it
  // mid-program would leave the alternate bank torn for no benefit, since the client's
  // COMMIT may already have been reported as pending.
  void disconnect(uint16_t conn = 0) {
    if (conn_ != conn) return;
    playPending_ = false;
    const bool metadataWrite = pending_ && (op_ == OP_COMMIT || op_ == OP_DELETE);
    if (metadataWrite) return;
    if (mode_ || frameOpen_) abandonUpload();
    pending_ = false;
    beginStarted_ = false;
  }
  // Drops all in-RAM transfer state; durable metadata is untouched.
  void abandon() {
    abandonUpload();
    pending_ = false;
    beginStarted_ = false;
    playPending_ = false;
  }

 private:
  void abandonUpload() {
    mode_ = 0;
    frameOpen_ = framePendingOpen_ = false;
    received_ = stageLen_ = 0;
    store_.abortUpload();
  }

  // Starts the frame named by the staged FRAME command: possibly reopens the last committed
  // index, then programs the 8-byte blob header.
  Result startFrame() {
    if (!mode_) return CONFLICT;
    if (frameIndex_ < store_.uploadedFrames()) {
      Result r = store_.reopenLastFrame();
      if (r != OK) return r;
      if (store_.uploadedFrames() != frameIndex_) return CONFLICT;
    }
    if (frameIndex_ != store_.uploadedFrames()) return CONFLICT;
    if (frameIndex_ == 0 && frameKind_ != KIND_FULL) return CONFLICT;
    Result r = store_.beginFrame(frameKind_, frameEncLen_, frameCrc_, frameDelay_);
    if (r != OK) return r;
    // Frames arrive in index order, so the previous decoded frame is the delta reference.
    decoder_.begin(frameKind_, frameKind_ == KIND_FULL ? nullptr : decoded_);
    received_ = stageLen_ = 0;
    openIndex_ = frameIndex_;
    openKind_ = frameKind_;
    openEncLen_ = frameEncLen_;
    openCrc_ = frameCrc_;
    openDelay_ = frameDelay_;
    frameOpen_ = true;
    framePendingOpen_ = false;
    return OK;
  }

  // FRAME_COMMIT: verify the decoded stream, its CRC and its padding, then append the blob.
  Result finishFrame() {
    if (!mode_ || !frameOpen_) return CONFLICT;
    if (received_ != frameEncLen_) return CONFLICT;
    if (!decoder_.finish() || decoder_.produced() != FRAME_BYTES) {
      abandonUpload();
      return CODEC;
    }
    if (eink::crc32(decoded_, FRAME_BYTES) != frameCrc_) {
      abandonUpload();
      return BAD_CRC;
    }
    for (unsigned y = 0; y < HEIGHT; ++y) {
      if (decoded_[y * STRIDE + STRIDE - 1] & 0x3f) {
        abandonUpload();
        return BAD_PADDING;
      }
    }
    Result r = store_.commitFrame();
    frameOpen_ = false;
    if (r != OK) { abandonUpload(); return r; }
    animCrcState_ = crcUpdate(animCrcState_, decoded_, FRAME_BYTES);
    const unsigned committed = store_.uploadedFrames();
    index_ = committed < uploadCount_ ? uint16_t(committed) : NO_INDEX;
    count_ = uint16_t(committed);
    return OK;
  }

  Store& store_;
  uint8_t op_;
  Result error_;
  bool pending_, beginStarted_;
  bool playing_, playPending_, stopPending_;
  uint16_t playIndex_, conn_;
  uint8_t mode_;  // 0 idle, 1 upload
  uint16_t index_, count_, flags_;
  uint32_t crc_, revision_, value_, dataBytes_, animCrc_;
  uint8_t frameKind_;
  uint16_t frameEncLen_, frameDelay_;
  uint32_t frameCrc_;
  uint16_t frameIndex_, received_;
  uint32_t activity_;
  uint32_t animCrcState_;
  uint16_t readIndex_, readOffset_;
  uint32_t readTotal_;
  size_t dataLen_, stageLen_;
  // Upload parameters, kept so an identical BEGIN repeat is idempotent.
  uint32_t uploadRevision_, uploadCrc_;
  uint16_t uploadCount_, uploadFlags_;
  // The frame currently being received.
  bool frameOpen_, framePendingOpen_;
  uint16_t openIndex_, openEncLen_, openDelay_;
  uint8_t openKind_;
  uint32_t openCrc_;
  bool lastCommitOk_;
  StreamDecoder decoder_;
  uint8_t stage_[STAGE_BYTES];
  uint8_t data_[20];
  alignas(4) uint8_t decoded_[FRAME_BYTES];
};
} }
#endif
