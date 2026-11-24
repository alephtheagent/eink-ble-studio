#ifndef EINK_ANIM_CODEC_H
#define EINK_ANIM_CODEC_H
// Animation frame codec: frozen contract, see docs/protocol-animation.md.
// Header-only, C++11, no Arduino dependency, no dynamic allocation. Every
// function writes into caller-provided buffers; the only state is the caller's
// previous-frame and destination buffers.
//
// A frame blob is `kind:u8 reserved:u8=0 encLen:u16 crc:u32 payload[encLen]`
// (little-endian), total 8 + encLen bytes:
//   kind 0 (full)  payload is the 4000 decoded bytes verbatim (encLen == 4000)
//   kind 1 (delta) payload is PackBits(frame XOR previous decoded frame)
// `crc` is IEEE CRC32 (0xEDB88320, init/final 0xFFFFFFFF) of the 4000 decoded
// bytes. The animation CRC is the same CRC over all decoded frames concatenated
// in index order, computed incrementally with Crc32.
#include <stdint.h>
#include <stddef.h>
#include <string.h>

namespace eink {
namespace anim {

static constexpr uint16_t WIDTH = 122, HEIGHT = 250, STRIDE = 16, FRAME_BYTES = STRIDE * HEIGHT;
static constexpr unsigned MAX_FRAMES = 64;
static constexpr uint16_t DELAY_MIN_MS = 100, DELAY_MAX_MS = 60000;
static constexpr size_t BLOB_HEADER_BYTES = 8;
static constexpr size_t MAX_BLOB_BYTES = BLOB_HEADER_BYTES + FRAME_BYTES;
// One data bank: 13 erase sectors of 4096 bytes. Both banks together are 0x1A000;
// 0x1A000 is never a per-bank bound.
static constexpr size_t DATA_BANK_BYTES = 0xD000;
static constexpr uint8_t KIND_FULL = 0, KIND_DELTA = 1;

static_assert(FRAME_BYTES == 4000, "wire contract fixes the decoded frame at 4000 bytes");
static_assert(WIDTH <= STRIDE * 8, "stride must cover every visible pixel");
static_assert(MAX_FRAMES == 64, "BEGIN count and metadata entries are bounded by 64");
static_assert(MAX_BLOB_BYTES == 4008, "stored blob is at most 8 + 4000 bytes");
static_assert(MAX_BLOB_BYTES <= DATA_BANK_BYTES, "one blob must fit a data bank");
static_assert(DATA_BANK_BYTES == 13u * 4096u, "data bank is 13 erase sectors");

// Numeric values are wire-visible in tests/vectors-animation.json "rejects".
enum Status : uint8_t { CODEC_OK = 0, CODEC_MALFORMED = 1, CODEC_LENGTH = 2, CODEC_CRC = 3, CODEC_STREAM = 4 };

namespace detail {
inline uint16_t get16(const uint8_t* p) { return uint16_t(uint16_t(p[0]) | (uint16_t(p[1]) << 8)); }
inline uint32_t get32(const uint8_t* p) { return uint32_t(get16(p)) | (uint32_t(get16(p + 2)) << 16); }
inline void put16(uint8_t* p, uint16_t n) { p[0] = uint8_t(n); p[1] = uint8_t(n >> 8); }
inline void put32(uint8_t* p, uint32_t n) { put16(p, uint16_t(n)); put16(p + 2, uint16_t(n >> 16)); }
}  // namespace detail

// Chainable so the animation CRC can be folded over frames as they decode.
struct Crc32 {
  uint32_t state;
  Crc32() : state(0xFFFFFFFFu) {}
  // Call repeatedly to fold frames in: the animation CRC is the CRC over the
  // concatenated decoded frames in index order.
  void update(const uint8_t* p, size_t n) {
    uint32_t c = state;
    while (n--) {
      c ^= *p++;
      for (unsigned i = 0; i < 8; ++i) c = (c >> 1) ^ (0xEDB88320u & (0u - (c & 1u)));
    }
    state = c;
  }
  uint32_t value() const { return state ^ 0xFFFFFFFFu; }
};

inline uint32_t crc32(const uint8_t* p, size_t n) {
  Crc32 c;
  c.update(p, n);
  return c.value();
}

namespace detail {
// PackBits over `src XOR prev` (or plain `src` when prev is null) for any length.
// With out == 0 this only counts the encoded length, so a caller can decide
// between kind 0 and kind 1 before writing anything. Identical token choices to
// web/anim-codec.js: repeats start at 3, literals are capped at 128 bytes.
inline uint8_t at(const uint8_t* src, const uint8_t* prev, size_t i) {
  return prev ? uint8_t(src[i] ^ prev[i]) : src[i];
}
inline size_t packBitsXorN(uint8_t* out, const uint8_t* src, const uint8_t* prev, size_t n) {
  size_t produced = 0, i = 0;
  while (i < n) {
    const uint8_t first = at(src, prev, i);
    size_t run = 1;
    while (run < 128 && i + run < n && at(src, prev, i + run) == first) ++run;
    if (run >= 3) {
      if (out) { out[produced] = uint8_t(257 - run); out[produced + 1] = first; }
      produced += 2; i += run; continue;
    }
    const size_t start = i;
    while (i < n && i - start < 128) {
      if (i + 2 < n && at(src, prev, i) == at(src, prev, i + 1) && at(src, prev, i) == at(src, prev, i + 2)) break;
      ++i;
    }
    if (out) out[produced] = uint8_t(i - start - 1);
    ++produced;
    for (size_t j = start; j < i; ++j) {
      if (out) out[produced] = at(src, prev, j);
      ++produced;
    }
  }
  return produced;
}

inline size_t writeFull(uint8_t* blob, const uint8_t* frame) {
  blob[0] = KIND_FULL; blob[1] = 0;
  put16(blob + 2, FRAME_BYTES);
  put32(blob + 4, crc32(frame, FRAME_BYTES));
  memcpy(blob + BLOB_HEADER_BYTES, frame, FRAME_BYTES);
  return MAX_BLOB_BYTES;
}
}  // namespace detail

struct BlobHeader {
  uint8_t kind, reserved;
  uint16_t encLen;
  uint32_t crc;
};
static_assert(sizeof(BlobHeader) == BLOB_HEADER_BYTES, "blob header must be exactly 8 bytes");

// Validates the 8-byte header only: len >= 8, reserved == 0, kind <= 1,
// kind 0 => encLen == 4000, kind 1 => 1 <= encLen <= 4000.
inline bool parseBlobHeader(const uint8_t* blob, size_t len, BlobHeader& out) {
  if (!blob || len < BLOB_HEADER_BYTES) return false;
  out.kind = blob[0];
  out.reserved = blob[1];
  out.encLen = detail::get16(blob + 2);
  out.crc = detail::get32(blob + 4);
  if (out.reserved != 0 || out.kind > KIND_DELTA) return false;
  if (out.kind == KIND_FULL) return out.encLen == FRAME_BYTES;
  return out.encLen >= 1 && out.encLen <= FRAME_BYTES;
}

// Streaming PackBits decoder for one frame. Feed encoded bytes in any chunk
// sizes; `out` is the 4000-byte destination and must stay live until finish().
// Deltas are XORed with the previous decoded frame as bytes are produced, so no
// 4000-byte encoded staging buffer is ever needed.
struct StreamDecoder {
  const uint8_t* prev_;
  uint8_t* out_;
  uint16_t produced_;
  uint8_t literal_, repeat_, kind_;
  bool failed_;

  StreamDecoder() : prev_(0), out_(0), produced_(0), literal_(0), repeat_(0), kind_(KIND_FULL), failed_(false) {}

  // kind 0 requires prevFrame == 0; kind 1 requires prevFrame != 0.
  bool begin(uint8_t kind, const uint8_t* prevFrame) {
    prev_ = prevFrame; out_ = 0; produced_ = 0; literal_ = repeat_ = 0; kind_ = kind; failed_ = false;
    if (kind > KIND_DELTA) { failed_ = true; return false; }
    if (kind == KIND_DELTA && !prevFrame) { failed_ = true; return false; }
    if (kind == KIND_FULL && prevFrame) { failed_ = true; return false; }
    return true;
  }
  // Convenience: a null previous frame means a full frame.
  void reset(const uint8_t* prevFrame) { begin(prevFrame ? KIND_DELTA : KIND_FULL, prevFrame); }

  bool push(const uint8_t* encoded, size_t n, uint8_t* out) {
    if (failed_ || !encoded || !out) { failed_ = true; return false; }
    out_ = out;
    for (size_t i = 0; i < n; ++i) {
      const uint8_t b = encoded[i];
      if (kind_ == KIND_FULL) {
        if (produced_ == FRAME_BYTES) { failed_ = true; return false; }
        out_[produced_++] = b;
        continue;
      }
      if (literal_) { if (!emit(b)) return false; --literal_; }
      else if (repeat_) { const uint8_t count = repeat_; repeat_ = 0; for (uint8_t j = 0; j < count; ++j) if (!emit(b)) return false; }
      else if (b < 128) literal_ = uint8_t(b + 1);
      else if (b == 128) { failed_ = true; return false; }
      else {
        repeat_ = uint8_t(257 - b);
        if (repeat_ > FRAME_BYTES - produced_) { failed_ = true; return false; }
      }
    }
    return true;
  }

  bool finish() const { return !failed_ && produced_ == FRAME_BYTES && !literal_ && !repeat_; }
  uint16_t produced() const { return produced_; }
  bool failed() const { return failed_; }
  uint8_t kind() const { return kind_; }

 private:
  bool emit(uint8_t value) {
    if (produced_ == FRAME_BYTES) { failed_ = true; return false; }
    out_[produced_] = prev_ ? uint8_t(value ^ prev_[produced_]) : value;
    ++produced_;
    return true;
  }
};

// Decode a contiguous payload (no blob header). No CRC check is possible here.
inline Status decodePayload(uint8_t kind, const uint8_t* payload, size_t n, const uint8_t* prev, uint8_t* out) {
  if (!payload || !out) return CODEC_MALFORMED;
  if (kind > KIND_DELTA) return CODEC_MALFORMED;
  if (kind == KIND_FULL && n != FRAME_BYTES) return CODEC_LENGTH;
  if (kind == KIND_DELTA && (n < 1 || n > FRAME_BYTES)) return CODEC_LENGTH;
  if (kind == KIND_DELTA && !prev) return CODEC_MALFORMED;
  StreamDecoder decoder;
  if (!decoder.begin(kind, kind == KIND_DELTA ? prev : 0)) return CODEC_MALFORMED;
  if (!decoder.push(payload, n, out)) return CODEC_STREAM;
  return decoder.finish() ? CODEC_OK : CODEC_STREAM;
}

// PackBits over an arbitrary byte range. `out` may be null to measure the
// encoded size; otherwise it must hold at least 2 + 2*n/128 bytes for an
// incompressible input. Returns the encoded length.
inline size_t packBitsEncode(uint8_t* out, const uint8_t* raw, size_t n) {
  return detail::packBitsXorN(out, raw, 0, n);
}

// Strict PackBits decode into `out` (capacity bytes). Returns false on a reserved
// 0x80 control, an overrun of the input or the output, or any trailing input.
inline bool packBitsDecode(const uint8_t* encoded, size_t n, uint8_t* out, size_t capacity, size_t& produced) {
  produced = 0;
  if (!encoded || !out) return false;
  for (size_t i = 0; i < n;) {
    const uint8_t control = encoded[i++];
    if (control < 128) {
      const size_t count = size_t(control) + 1;
      if (i + count > n || produced + count > capacity) return false;
      for (size_t j = 0; j < count; ++j) out[produced++] = encoded[i++];
    } else if (control == 128) {
      return false;
    } else {
      const size_t count = size_t(257 - control);
      if (i >= n || produced + count > capacity) return false;
      const uint8_t value = encoded[i++];
      for (size_t j = 0; j < count; ++j) out[produced++] = value;
    }
  }
  return true;
}

// Full blob decode: header, exact length, stream, then CRC of the decoded frame.
// `prev` may be null only for kind 0. `out` is 4000 bytes; no allocation.
inline Status decodeBlob(const uint8_t* blob, size_t len, const uint8_t* prev, uint8_t* out) {
  BlobHeader header;
  if (!parseBlobHeader(blob, len, header)) {
    // Distinguish a bad length field from a malformed header.
    if (blob && len >= BLOB_HEADER_BYTES) {
      const uint8_t kind = blob[0];
      const uint16_t encLen = detail::get16(blob + 2);
      if (blob[1] == 0 && kind <= KIND_DELTA &&
          ((kind == KIND_FULL && encLen != FRAME_BYTES) || (kind == KIND_DELTA && (encLen < 1 || encLen > FRAME_BYTES))))
        return CODEC_LENGTH;
    }
    return CODEC_MALFORMED;
  }
  if (len != BLOB_HEADER_BYTES + size_t(header.encLen)) return CODEC_LENGTH;
  const Status status = decodePayload(header.kind, blob + BLOB_HEADER_BYTES, header.encLen, prev, out);
  if (status != CODEC_OK) return status;
  return crc32(out, FRAME_BYTES) == header.crc ? CODEC_OK : CODEC_CRC;
}


// Writes a kind 0 blob; returns 8 + 4000.
inline size_t encodeFull(uint8_t* blob, const uint8_t* frame) { return detail::writeFull(blob, frame); }

// Writes the smallest blob for (prev, frame) into a buffer of MAX_BLOB_BYTES.
// Emits kind 1 only when the delta payload is strictly shorter than 4000 bytes;
// otherwise (including the incompressible 4032-byte worst case) it emits kind 0
// and sets usedFull. Returns the number of blob bytes written.
inline size_t encodeDelta(uint8_t* blob, const uint8_t* prev, const uint8_t* frame, bool& usedFull) {
  const size_t payload = detail::packBitsXorN(0, frame, prev, FRAME_BYTES);
  if (!prev || payload >= FRAME_BYTES) { usedFull = true; return detail::writeFull(blob, frame); }
  blob[0] = KIND_DELTA; blob[1] = 0;
  detail::put16(blob + 2, uint16_t(payload));
  detail::put32(blob + 4, crc32(frame, FRAME_BYTES));
  detail::packBitsXorN(blob + BLOB_HEADER_BYTES, frame, prev, FRAME_BYTES);
  usedFull = false;
  return BLOB_HEADER_BYTES + payload;
}

}  // namespace anim
}  // namespace eink
#endif
