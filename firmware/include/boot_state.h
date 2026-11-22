#ifndef EINK_BOOT_STATE_H
#define EINK_BOOT_STATE_H
#include "protocol.h"

namespace eink { namespace boot {
constexpr uint32_t ADDRESS = 0xEC000u;
constexpr uint32_t PAGE_SIZE = 4096u;
constexpr uint32_t MAGIC = 0x45494e4bu;
struct Record { uint32_t magic, buildId, crc; };
inline Record makeRecord(uint32_t buildId) {
  Record r = {MAGIC, buildId, 0};
  r.crc = crc32(reinterpret_cast<const uint8_t*>(&r), 8);
  return r;
}
inline bool valid(const Record& r, uint32_t buildId) {
  return r.magic == MAGIC && r.buildId == buildId &&
         r.crc == crc32(reinterpret_cast<const uint8_t*>(&r), 8);
}
enum class Result { UpToDate, WelcomeShown, WelcomeShownStoreFailed };
template<class Store, class Panel>
Result ensureWelcome(Store& store, Panel& panel, uint32_t buildId) {
  Record r;
  if (store.read(r) && valid(r, buildId)) return Result::UpToDate;
  panel.showWelcome();
  return store.save(buildId) ? Result::WelcomeShown : Result::WelcomeShownStoreFailed;
}
} }
#endif
