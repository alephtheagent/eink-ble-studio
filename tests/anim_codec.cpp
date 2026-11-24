// Host test for firmware/include/anim_codec.h against tests/vectors-animation.json.
// Compiled by tests/run_cpp.py, which generates the vectors header with the same
// JSON the JavaScript tests read. Every expectation here comes from that file, so
// JS and C++ cannot drift apart silently.
#include "anim_vectors.h"
#include "anim_codec.h"
// The animation CRC must be bit-identical to the legacy protocol CRC.
#include "protocol.h"
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace {

int failures = 0;

void check(bool condition, const char* what) {
  if (condition) return;
  std::fprintf(stderr, "FAIL %s\n", what);
  ++failures;
}

bool equal(const uint8_t* a, const uint8_t* b, size_t n) { return std::memcmp(a, b, n) == 0; }

const char* statusName(uint8_t status) {
  switch (status) {
    case eink::anim::CODEC_OK: return "OK";
    case eink::anim::CODEC_MALFORMED: return "MALFORMED";
    case eink::anim::CODEC_LENGTH: return "LENGTH";
    case eink::anim::CODEC_CRC: return "CRC";
    case eink::anim::CODEC_STREAM: return "STREAM";
  }
  return "?";
}

}  // namespace

int main() {
  using namespace eink::anim;

  // ---------------------------------------------------------------- constants
  check(FRAME_BYTES == 4000, "FRAME_BYTES");
  check(BLOB_HEADER_BYTES == 8, "BLOB_HEADER_BYTES");
  check(MAX_BLOB_BYTES == 4008, "MAX_BLOB_BYTES");
  check(MAX_FRAMES == 64, "MAX_FRAMES");
  check(DATA_BANK_BYTES == 0xD000, "DATA_BANK_BYTES");
  check(DELAY_MIN_MS == 100 && DELAY_MAX_MS == 60000, "delay bounds");

  // --------------------------------------------------------------------- CRC
  for (size_t i = 0; i < ANIM_CRC_COUNT; ++i) {
    const AnimCrcVector& vector = ANIM_CRC[i];
    check(crc32(vector.bytes, vector.size) == vector.value, vector.name);
    // Chunked updates must agree with the one-shot call.
    Crc32 chunked;
    size_t offset = 0;
    while (offset < vector.size) {
      const size_t take = (vector.size - offset) > 7 ? 7 : (vector.size - offset);
      chunked.update(vector.bytes + offset, take);
      offset += take;
    }
    check(chunked.value() == vector.value, "chunked Crc32 must match one-shot crc32");
  }
  check(crc32(0, 0) == 0, "empty CRC is zero");
  for (size_t i = 0; i < ANIM_FRAME_COUNT; ++i) {
    const uint8_t* frameBytes = ANIM_FRAMES[i].bytes;
    check(eink::anim::crc32(frameBytes, FRAME_BYTES) == eink::crc32(frameBytes, FRAME_BYTES),
          "animation CRC must equal eink::crc32 from protocol.h");
  }

  // ------------------------------------------------------------------ frames
  for (size_t i = 0; i < ANIM_FRAME_COUNT; ++i) {
    const AnimFrameVector& vector = ANIM_FRAMES[i];
    check(vector.size == FRAME_BYTES, "frame vector size");
    check(crc32(vector.bytes, vector.size) == vector.crc, vector.name);
    for (unsigned y = 0; y < HEIGHT; ++y)
      check((vector.bytes[y * STRIDE + STRIDE - 1] & 0x3f) == 0, "frame vector padding");
  }

  // ------------------------------------------------------------------- blobs
  for (size_t i = 0; i < ANIM_BLOB_COUNT; ++i) {
    const AnimBlobVector& vector = ANIM_BLOBS[i];
    const uint8_t* prev = vector.prev < 0 ? 0 : ANIM_FRAMES[vector.prev].bytes;
    const uint8_t* frame = ANIM_FRAMES[vector.frame].bytes;

    BlobHeader header;
    check(parseBlobHeader(vector.blob, vector.blobSize, header), vector.name);
    check(header.kind == vector.kind, "blob vector kind");
    check(header.encLen == vector.encLen, "blob vector encLen");
    check(vector.blobSize == BLOB_HEADER_BYTES + vector.encLen, "blob vector length");

    uint8_t encoded[MAX_BLOB_BYTES];
    bool usedFull = !prev;
    const size_t encodedSize = encodeDelta(encoded, prev, frame, usedFull);
    check(encodedSize == vector.blobSize, "encodeDelta size");
    check(usedFull == (vector.kind == KIND_FULL), "encodeDelta kind choice");
    check(equal(encoded, vector.blob, vector.blobSize), "encodeDelta bytes");

    uint8_t full[MAX_BLOB_BYTES];
    check(encodeFull(full, frame) == MAX_BLOB_BYTES, "encodeFull size");
    check(equal(full, vector.blob, vector.blobSize) == (vector.kind == KIND_FULL), "encodeFull vs vector");

    uint8_t decoded[FRAME_BYTES];
    std::memset(decoded, 0xa5, sizeof(decoded));
    const Status status = decodeBlob(vector.blob, vector.blobSize, prev, decoded);
    check(status == CODEC_OK, "decodeBlob status");
    if (status != CODEC_OK) std::fprintf(stderr, "  %s -> %s\n", vector.name, statusName(status));
    check(equal(decoded, frame, FRAME_BYTES), "decodeBlob frame");

    // Streaming in awkward chunk sizes must produce the same bytes as one shot.
    uint8_t streamed[FRAME_BYTES];
    std::memset(streamed, 0x5a, sizeof(streamed));
    StreamDecoder decoder;
    check(decoder.begin(vector.kind, vector.kind == KIND_DELTA ? prev : 0), "StreamDecoder begin");
    const uint8_t* payload = vector.blob + BLOB_HEADER_BYTES;
    size_t offset = 0;
    size_t chunk = 1;
    while (offset < vector.encLen) {
      size_t take = chunk;
      if (take > vector.encLen - offset) take = vector.encLen - offset;
      check(decoder.push(payload + offset, take, streamed), "StreamDecoder push");
      offset += take;
      chunk = chunk == 1 ? 13 : chunk == 13 ? 64 : 1;
    }
    check(decoder.finish(), "StreamDecoder finish");
    check(decoder.produced() == FRAME_BYTES, "StreamDecoder produced");
    check(equal(streamed, frame, FRAME_BYTES), "StreamDecoder frame");
  }

  // -------------------------------------------------------------- animations
  for (size_t i = 0; i < ANIM_ANIMATION_COUNT; ++i) {
    const AnimAnimationVector& vector = ANIM_ANIMATIONS[i];
    Crc32 animation;
    for (unsigned f = 0; f < vector.count; ++f) {
      animation.update(ANIM_FRAMES[vector.frames[f]].bytes, FRAME_BYTES);
    }
    check(animation.value() == vector.crc, vector.name);

    // The same CRC folded over frames decoded from blobs.
    Crc32 decodedAnimation;
    uint8_t previous[FRAME_BYTES];
    uint8_t current[FRAME_BYTES];
    bool havePrevious = false;
    for (unsigned f = 0; f < vector.count; ++f) {
      const uint8_t* frame = ANIM_FRAMES[vector.frames[f]].bytes;
      uint8_t blob[MAX_BLOB_BYTES];
      bool usedFull = !havePrevious;
      const size_t blobSize = encodeDelta(blob, havePrevious ? previous : 0, frame, usedFull);
      check(decodeBlob(blob, blobSize, havePrevious ? previous : 0, current) == CODEC_OK, "animation decode");
      decodedAnimation.update(current, FRAME_BYTES);
      std::memcpy(previous, current, FRAME_BYTES);
      havePrevious = true;
    }
    check(decodedAnimation.value() == vector.crc, "animation CRC through the codec");
  }

  // ---------------------------------------------------------------- PackBits
  for (size_t i = 0; i < ANIM_PACKBITS_COUNT; ++i) {
    const AnimPackBitsVector& vector = ANIM_PACKBITS[i];
    uint8_t payload[FRAME_BYTES * 2];
    const size_t size = packBitsEncode(payload, vector.raw, vector.rawSize);
    check(size == vector.encodedSize, vector.name);
    check(equal(payload, vector.encoded, vector.encodedSize), vector.name);
    // Measure-only mode must return the same length without writing.
    check(packBitsEncode(0, vector.raw, vector.rawSize) == size, "packBitsEncode measure mode");
    uint8_t decoded[FRAME_BYTES * 2];
    size_t produced = 0;
    check(packBitsDecode(vector.encoded, vector.encodedSize, decoded, sizeof(decoded), produced), vector.name);
    check(produced == vector.rawSize, vector.name);
    check(equal(decoded, vector.raw, vector.rawSize), vector.name);
  }
  for (size_t i = 0; i < ANIM_PACKBITS_FRAME_COUNT; ++i) {
    const AnimPackBitsFrameVector& vector = ANIM_PACKBITS_FRAMES[i];
    // A frame-sized delta must choose the same kind the JS encoder chose.
    const uint8_t zero[FRAME_BYTES] = {0};
    uint8_t blob[MAX_BLOB_BYTES];
    bool usedFull = false;
    const size_t size = encodeDelta(blob, zero, vector.delta, usedFull);
    const bool fits = vector.encodedSize < FRAME_BYTES;
    check(usedFull == !fits, vector.name);
    check(size == (fits ? BLOB_HEADER_BYTES + vector.encodedSize : MAX_BLOB_BYTES), vector.name);
    if (fits) check(equal(blob + BLOB_HEADER_BYTES, vector.encoded, vector.encodedSize), vector.name);
    uint8_t decoded[FRAME_BYTES];
    check(decodeBlob(blob, size, zero, decoded) == CODEC_OK, vector.name);
    check(equal(decoded, vector.delta, FRAME_BYTES), vector.name);
  }
  for (size_t i = 0; i < ANIM_PACKBITS_DECODE_COUNT; ++i) {
    const AnimPackBitsDecodeVector& vector = ANIM_PACKBITS_DECODE[i];
    uint8_t raw[FRAME_BYTES * 2];
    size_t produced = 0;
    check(packBitsDecode(vector.encoded, vector.encodedSize, raw, sizeof(raw), produced), vector.name);
    check(produced == vector.rawSize, "decode vector length");
    check(equal(raw, vector.raw, vector.rawSize), vector.name);
  }
  {
    // Reserved control byte and overruns are rejected by the shared decoder.
    uint8_t out[16];
    size_t produced = 0;
    const uint8_t reserved[] = {0x80};
    check(!packBitsDecode(reserved, 1, out, sizeof(out), produced), "control 128 rejected");
    const uint8_t overrun[] = {0xff, 0x41};
    check(!packBitsDecode(overrun, 2, out, 1, produced), "repeat overrun rejected");
    const uint8_t shortLiteral[] = {0x05, 1, 2};
    check(!packBitsDecode(shortLiteral, 3, out, sizeof(out), produced), "literal underrun rejected");
  }

  // ----------------------------------------------------------------- rejects
  for (size_t i = 0; i < ANIM_REJECT_COUNT; ++i) {
    const AnimRejectVector& vector = ANIM_REJECTS[i];
    const uint8_t* prev = vector.prev < 0 ? 0 : ANIM_FRAMES[vector.prev].bytes;
    BlobHeader header;
    const bool headerOk = parseBlobHeader(vector.blob, vector.blobSize, header);
    if (vector.stage == 0) {
      check(!headerOk, vector.name);
      continue;
    }
    check(headerOk, vector.name);
    if (!headerOk) continue;
    uint8_t out[FRAME_BYTES];
    const Status status = decodeBlob(vector.blob, vector.blobSize, prev, out);
    if (status != vector.error) {
      std::fprintf(stderr, "FAIL %s: got %s want %s\n", vector.name, statusName(status), statusName(vector.error));
      ++failures;
    }
  }

  // ------------------------------------------------------- extra edge checks
  {
    // A delta blob with no previous frame must be malformed, not a silent pass.
    uint8_t blob[MAX_BLOB_BYTES];
    bool usedFull = true;
    const size_t size = encodeDelta(blob, ANIM_FRAMES[0].bytes, ANIM_FRAMES[0].bytes, usedFull);
    uint8_t out[FRAME_BYTES];
    check(decodeBlob(blob, size, 0, out) == CODEC_MALFORMED, "delta without previous");
    // Trailing bytes are a length error.
    uint8_t padded[MAX_BLOB_BYTES + 1];
    std::memcpy(padded, blob, size);
    padded[size] = 0;
    check(decodeBlob(padded, size + 1, ANIM_FRAMES[0].bytes, out) == CODEC_LENGTH, "trailing byte");
    // A single flipped payload byte is a CRC error.
    uint8_t corrupt[MAX_BLOB_BYTES];
    std::memcpy(corrupt, blob, size);
    corrupt[size - 1] ^= 0xff;
    const Status status = decodeBlob(corrupt, size, ANIM_FRAMES[0].bytes, out);
    check(status == CODEC_CRC || status == CODEC_STREAM, "corrupt payload rejected");
    // Full-frame encode/decode round trip is byte identical.
    uint8_t full[MAX_BLOB_BYTES];
    check(encodeFull(full, ANIM_FRAMES[0].bytes) == MAX_BLOB_BYTES, "encodeFull");
    check(decodeBlob(full, MAX_BLOB_BYTES, 0, out) == CODEC_OK, "decodeFull");
    check(equal(out, ANIM_FRAMES[0].bytes, FRAME_BYTES), "decodeFull bytes");
    // Incompressible delta falls back to kind 0 and stays within one data bank.
    check(size <= DATA_BANK_BYTES, "blob fits one data bank");
  }

  if (failures) {
    std::fprintf(stderr, "%d animation codec check(s) failed\n", failures);
    return 1;
  }
  std::printf("animation codec: %zu crc, %zu frame, %zu blob, %zu animation, %zu packbits, %zu packbits-frame, %zu reject vectors passed\n",
              ANIM_CRC_COUNT, ANIM_FRAME_COUNT, ANIM_BLOB_COUNT, ANIM_ANIMATION_COUNT,
              ANIM_PACKBITS_COUNT, ANIM_PACKBITS_FRAME_COUNT, ANIM_REJECT_COUNT);
  return 0;
}
