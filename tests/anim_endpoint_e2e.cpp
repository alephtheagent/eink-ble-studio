// Wire-level end-to-end harness: drives a real eink::anim::Endpoint<Storage<FakeFlash>>
// with raw command bytes so a JavaScript test can play the client side.
//
// tests/anim-wire-e2e.test.js builds the upload stream with the SITE's own builders
// (web/anim.js) and feeds it here, which is the only test that proves the bytes the
// browser actually writes on the command characteristic are accepted by the firmware.
//
// Protocol, one command per line on stdin, hex payloads, one reply line each:
//   C <hex>   command(bytes, 0, 0); poll() until !pending(); then print
//             "<err> <rev> <count> <index> <dataBytes> <animcrc> <flags> <statusHex> <dataHex>"
//   T         now += 1000 ms (do not poll)
//   X <conn>  disconnect(conn)
//   P         takePlay()  -> prints "play <index>" or "play none"
//   S         takeStop()  -> prints "stop <0|1>"
//   Y <0|1>   playing(value)
//   R         expire(now) -> prints "expired <0|1>"
//   V <index> Storage::savePosition(index) -> prints "pos <result>"
//   W         Storage::loadPosition()      -> prints "pos stored <index>" or "pos none"
//   V <index> Store::savePosition(index) -> prints "pos <result>"
//   W         Store::loadPosition()     -> prints "pos <stored|none> <index>"
// <err> is the decimal error/result code from status byte 2, so the test can assert the
// documented values (0 OK, 8 offset, 11 limit, ...). No Arduino, no heap.
#include "anim_storage.h"
#include "anim_wire.h"
#include <array>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

namespace {

constexpr uint32_t REGION = eink::anim::END - eink::anim::BASE;

// In-memory flash for the animation reservation. Same semantics as the storage test's
// FakeFlash: programming only clears bits, erase writes 0xFF, addresses must be in range.
struct FakeFlash {
  std::array<uint8_t, REGION> bytes;
  FakeFlash() { bytes.fill(0xff); }
  bool read(uint32_t address, void* out, size_t size) {
    if (address < eink::anim::BASE || address + size > eink::anim::END) return false;
    std::memcpy(out, bytes.data() + address - eink::anim::BASE, size);
    return true;
  }
  bool program(uint32_t address, const void* source, size_t size) {
    if (address < eink::anim::BASE || address + size > eink::anim::END) return false;
    if ((address % 4) || (size % 4)) return false;
    const uint8_t* p = static_cast<const uint8_t*>(source);
    for (size_t i = 0; i < size; ++i) {
      uint8_t& cell = bytes[address - eink::anim::BASE + i];
      if ((cell & p[i]) != p[i]) return false;  // programming may only clear bits
      cell &= p[i];
    }
    return true;
  }
  bool erase(uint32_t address) {
    if (address < eink::anim::BASE || address % eink::anim::SECTOR) return false;
    if (address + eink::anim::SECTOR > eink::anim::END) return false;
    std::memset(bytes.data() + address - eink::anim::BASE, 0xff, eink::anim::SECTOR);
    return true;
  }
};

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
  out.reserve(size * 2 + 1);
  for (size_t i = 0; i < size; ++i) {
    out.push_back(digits[data[i] >> 4]);
    out.push_back(digits[data[i] & 15]);
  }
  if (out.empty()) out.push_back('-');
  return out;
}

void printReply(const eink::anim::Endpoint<eink::anim::Storage<FakeFlash> >& endpoint) {
  uint8_t status[20];
  endpoint.status(status);
  char head[256];
  std::snprintf(head, sizeof(head), "%u %lu %u %u %lu %lu %u ",
                unsigned(status[2]),
                static_cast<unsigned long>(eink::get32(status + 4)),
                unsigned(eink::get16(status + 8)),
                unsigned(eink::get16(status + 10)),
                static_cast<unsigned long>(eink::get32(status + 12)),
                static_cast<unsigned long>(eink::get32(status + 16)),
                unsigned(status[3]));
  std::cout << head << tohex(status, sizeof(status)) << ' ';
  uint8_t data[20];
  const size_t length = endpoint.data(data);
  std::cout << tohex(data, length) << '\n';
}

}  // namespace

int main() {
  FakeFlash flash;
  eink::anim::Storage<FakeFlash> store(flash);
  if (!store.begin()) {
    std::fprintf(stderr, "storage recovery failed\n");
    return 1;
  }
  eink::anim::Endpoint<eink::anim::Storage<FakeFlash> > endpoint(store);
  uint32_t now = 0;
  std::string op;
  while (std::cin >> op) {
    if (op == "C") {
      std::string payload;
      std::cin >> payload;
      const std::vector<uint8_t> bytes = unhex(payload);
      endpoint.command(bytes.empty() ? 0 : bytes.data(), bytes.size(), now, 1);
      // The main loop drains one pending operation; BEGIN erases sector by sector.
      for (unsigned guard = 0; endpoint.pending() && guard < 64; ++guard) endpoint.poll();
      printReply(endpoint);
    } else if (op == "T") {
      now += 1000;
      std::cout << "now " << now << '\n';
    } else if (op == "X") {
      unsigned conn = 0;
      std::cin >> conn;
      endpoint.disconnect(static_cast<uint16_t>(conn));
      std::cout << "OK\n";
    } else if (op == "V") {
      unsigned index = 0;
      std::cin >> index;
      std::cout << "pos " << unsigned(store.savePosition(static_cast<uint16_t>(index))) << '\n';
    } else if (op == "W") {
      uint16_t index = 0;
      if (store.loadPosition(index)) std::cout << "pos stored " << index << '\n';
      else std::cout << "pos none\n";
    } else if (op == "P") {
      if (endpoint.takePlay()) std::cout << "play " << endpoint.playIndex() << '\n';
      else std::cout << "play none\n";
    } else if (op == "S") {
      std::cout << "stop " << (endpoint.takeStop() ? 1 : 0) << '\n';
    } else if (op == "Y") {
      unsigned value = 0;
      std::cin >> value;
      endpoint.playing(value != 0);
      std::cout << "OK\n";
    } else if (op == "R") {
      std::cout << "expired " << (endpoint.expire(now) ? 1 : 0) << '\n';
    } else {
      std::cout << "BAD\n";
    }
    std::cout.flush();
  }
  return 0;
}
