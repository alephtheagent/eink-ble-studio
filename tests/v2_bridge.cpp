#include "protocol.h"
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

static std::vector<uint8_t> unhex(const std::string& s) {
  std::vector<uint8_t> result;
  for (size_t i = 0; i + 1 < s.size(); i += 2)
    result.push_back(static_cast<uint8_t>(std::stoul(s.substr(i, 2), nullptr, 16)));
  return result;
}
static void hex(const uint8_t* p, size_t n) {
  static const char digits[] = "0123456789abcdef";
  for (size_t i = 0; i < n; ++i) std::cout << digits[p[i] >> 4] << digits[p[i] & 15];
}
int main() {
  eink::Protocol receiver;
  char op;
  while (std::cin >> op) {
    unsigned now = 1, conn = 0;
    std::string data;
    if (op == '2' || op == '1') {
      std::cin >> now >> conn >> data;
      const auto bytes = unhex(data);
      if (op == '2') receiver.command2(bytes.data(), bytes.size(), now, conn);
      else receiver.command(bytes.data(), bytes.size(), now, conn);
    } else if (op == 'T') {
      std::cin >> now; receiver.tick(now);
    } else if (op == 'D') {
      std::cin >> conn; receiver.disconnect(conn);
    } else if (op == 'R') {
      if (receiver.beginRefresh()) receiver.finishRefresh();
    }
    uint8_t status[20]; receiver.status2(status);
    hex(status, sizeof status); std::cout << ' ';
    hex(receiver.frame(), eink::FRAME_BYTES); std::cout << '\n';
  }
}
