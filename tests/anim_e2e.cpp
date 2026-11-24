// Host end-to-end harness: blob stream file -> firmware C++ decoder -> frames.
//
// Protocol on stdin/stdout, one command per line, hex payloads:
//   F <blobHex>   decode one blob with the previous decoded frame; prints
//                 "<status> <crcHex> <frameHex>"
//   R             reset the decoder (drop the previous frame)
//   S <frameHex>  seed the previous decoded frame without decoding a blob
//   A <framesHex> append the CRC32 of the given decoded frame to the animation CRC
//   C             print the current animation CRC as 8 lowercase hex digits
#include "anim_codec.h"
#include <cstdio>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

namespace {

std::vector<uint8_t> unhex(const std::string& text) {
  std::vector<uint8_t> out;
  if (text.size() % 2) return out;
  out.reserve(text.size() / 2);
  for (size_t i = 0; i + 1 < text.size(); i += 2) {
    unsigned value = 0;
    if (std::sscanf(text.c_str() + i, "%2x", &value) != 1) return std::vector<uint8_t>();
    out.push_back(static_cast<uint8_t>(value));
  }
  return out;
}

std::string tohex(const uint8_t* data, size_t size) {
  static const char digits[] = "0123456789abcdef";
  std::string out;
  out.reserve(size * 2);
  for (size_t i = 0; i < size; ++i) { out.push_back(digits[data[i] >> 4]); out.push_back(digits[data[i] & 15]); }
  return out;
}

}  // namespace

int main() {
  using namespace eink::anim;
  uint8_t previous[FRAME_BYTES];
  uint8_t current[FRAME_BYTES];
  bool havePrevious = false;
  Crc32 animation;
  std::string op;
  while (std::cin >> op) {
    if (op == "F") {
      std::string payload;
      std::cin >> payload;
      const std::vector<uint8_t> blob = unhex(payload);
      const Status status = decodeBlob(blob.empty() ? 0 : blob.data(), blob.size(),
                                       havePrevious ? previous : 0, current);
      std::cout << unsigned(status) << ' ';
      if (status == CODEC_OK) {
        char crcText[9];
        std::snprintf(crcText, sizeof(crcText), "%08x", crc32(current, FRAME_BYTES));
        std::cout << crcText << ' ' << tohex(current, FRAME_BYTES);
        std::memcpy(previous, current, FRAME_BYTES);
        havePrevious = true;
      } else {
        std::cout << "00000000 -";
      }
      std::cout << '\n';
    } else if (op == "S") {
      std::string payload;
      std::cin >> payload;
      const std::vector<uint8_t> frame = unhex(payload);
      if (frame.size() == FRAME_BYTES) {
        std::memcpy(previous, frame.data(), FRAME_BYTES);
        havePrevious = true;
        std::cout << "OK\n";
      } else {
        std::cout << "BAD\n";
      }
    } else if (op == "R") {
      havePrevious = false;
      std::memset(previous, 0, sizeof(previous));
      animation = Crc32();
      std::cout << "OK\n";
    } else if (op == "A") {
      std::string payload;
      std::cin >> payload;
      const std::vector<uint8_t> frame = unhex(payload);
      if (frame.size() == FRAME_BYTES) { animation.update(frame.data(), FRAME_BYTES); std::cout << "OK\n"; }
      else std::cout << "BAD\n";
    } else if (op == "C") {
      char text[9];
      std::snprintf(text, sizeof(text), "%08x", animation.value());
      std::cout << text << '\n';
    } else {
      std::cout << "BAD\n";
    }
    std::cout.flush();
  }
  return 0;
}
