#include "page_storage.h"
#include "page_wire.h"
#include <array>
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
using namespace eink::pages;
struct Flash {
  std::array<uint8_t,32 * SECTOR> bytes;
  int calls = 0, fail = -1;
  Flash() { bytes.fill(0xff); }
  bool hit() { return calls++ == fail; }
  bool read(uint32_t addr, void* out, size_t size) {
    assert(addr >= BASE && addr + size <= BASE + bytes.size());
    if (hit()) return false;
    memcpy(out, bytes.data() + addr - BASE, size); return true;
  }
  bool program(uint32_t addr, const void* src, size_t size) {
    assert(addr >= BASE && addr + size <= BASE + bytes.size() && !(addr % 4) && !(size % 4));
    bool cut = hit(); size_t n = cut ? size / 2 : size;
    const uint8_t* p = static_cast<const uint8_t*>(src);
    for (size_t i = 0; i < n; ++i) { auto& d = bytes[addr - BASE + i]; assert((d & p[i]) == p[i]); d &= p[i]; }
    return !cut;
  }
  bool erase(uint32_t addr) {
    assert(addr >= BASE && addr + SECTOR <= BASE + bytes.size() && !(addr % SECTOR));
    bool cut = hit(); memset(bytes.data() + addr - BASE, 0xff, cut ? SECTOR / 2 : SECTOR); return !cut;
  }
};
using Store = Storage<Flash>;
using Frame = std::array<uint8_t,eink::FRAME_BYTES>;
static Frame frame(uint8_t v) { Frame f; f.fill(v); for (size_t y = 0; y < eink::HEIGHT; ++y) f[y * eink::STRIDE + eink::STRIDE - 1] &= 0xc0; return f; }
static Entry add(Store& s, const Frame& f) { Entry e; assert(s.put(s.revision(), 0, 0, eink::crc32(f.data(), f.size()), f.data(), e) == OK); return e; }
static void matches(Store& s, uint32_t id, const Frame& expected) { Frame out; assert(s.read(id, 0, out.data(), out.size()) == OK); assert(out == expected); }
enum Operation { UPDATE, DELETE, REORDER, CREATE };
static Result mutate(Store& s, Operation op, uint32_t a, uint32_t b, const Frame& f) {
  if (op == DELETE) return s.remove(s.revision(), a, s.find(a)->revision);
  if (op == REORDER) { uint32_t ids[] = {b,a}; return s.reorder(s.revision(), ids, 2); }
  Entry e; return s.put(s.revision(), op == UPDATE ? a : 0, op == UPDATE ? s.find(a)->revision : 0, eink::crc32(f.data(), f.size()), f.data(), e);
}
int main() {
  auto first = frame(0x55), second = frame(0xaa), changed = frame(0x33);
  Flash initial; Store seed(initial); assert(seed.begin()); auto a = add(seed, first), b = add(seed, second);
  for (Operation op : {UPDATE, DELETE, REORDER, CREATE}) {
    Flash probe = initial; Store p(probe); assert(p.begin()); probe.calls = 0; assert(mutate(p, op, a.id, b.id, changed) == OK); int stages = probe.calls;
    for (int cut = 0; cut < stages; ++cut) {
      Flash flash = initial; Store s(flash); assert(s.begin()); flash.calls = 0; flash.fail = cut;
      (void)mutate(s, op, a.id, b.id, changed);
      flash.fail = -1; Store reboot(flash); assert(reboot.begin());
      assert(reboot.revision() == 2 || reboot.revision() == 3);
      matches(reboot, b.id, second);
      if (reboot.revision() == 2) { assert(reboot.count() == 2); matches(reboot, a.id, first); assert(reboot.entry(0)->id == a.id); }
      else if (op == UPDATE) { assert(reboot.count() == 2); matches(reboot, a.id, changed); }
      else if (op == DELETE) { assert(reboot.count() == 1 && !reboot.find(a.id)); }
      else if (op == REORDER) { assert(reboot.count() == 2 && reboot.entry(0)->id == b.id && reboot.entry(1)->id == a.id); matches(reboot, a.id, first); }
      else { assert(reboot.count() == 3); matches(reboot, a.id, first); matches(reboot, reboot.entry(2)->id, changed); }
    }
    std::printf("operation %d: %d interruption points including torn program/erase\n", op, stages);
  }
  for (bool corruptFrame : {false, true}) {
    Flash flash = initial; Store s(flash); assert(s.begin());
    assert(mutate(s, UPDATE, a.id, b.id, changed) == OK);
    if (corruptFrame) flash.bytes[(2 + s.find(a.id)->slot) * SECTOR] ^= 1;
    else flash.bytes[offsetof(Metadata, crc)] ^= 1; // Third commit is in metadata bank zero.
    Store recovered(flash); assert(recovered.begin()); assert(recovered.revision() == 2);
    matches(recovered, a.id, first); matches(recovered, b.id, second);
  }
  std::puts("invalid newest metadata and corrupted newest frame recover previous bank");
  Flash full; Store s(full); assert(s.begin());
  for (unsigned i = 0; i < CAPACITY; ++i) add(s, first);
  Entry e; assert(s.put(s.revision(), 0, 0, eink::crc32(first.data(), first.size()), first.data(), e) == FULL);
  auto id = s.entry(0)->id, pageRev = s.entry(0)->revision;
  assert(s.put(s.revision()-1, id, pageRev, eink::crc32(changed.data(), changed.size()), changed.data(), e) == CONFLICT);
  assert(s.put(s.revision(), id, pageRev, eink::crc32(changed.data(), changed.size()), changed.data(), e) == OK);
  Store reboot(full); assert(reboot.begin()); assert(reboot.count() == CAPACITY); matches(reboot, id, changed);
  assert(reboot.remove(reboot.revision(), id, reboot.find(id)->revision) == OK); add(reboot, second);
  Store last(full); assert(last.begin() && last.count() == CAPACITY);
  std::puts("full, conflict, update with spare, delete and reuse passed");
  {
    Flash flash; Store s(flash); assert(s.begin());
    Endpoint<Store> endpoint(s); auto firstPage = add(s, first);
    uint8_t show[5] = {12, 0, 0, 0, 0}; show[1] = uint8_t(firstPage.id); show[2] = uint8_t(firstPage.id >> 8); show[3] = uint8_t(firstPage.id >> 16); show[4] = uint8_t(firstPage.id >> 24);
    endpoint.command(show, sizeof show); endpoint.poll(); uint8_t out[20]; endpoint.status(out);
    assert(out[2] == OK);
    endpoint.command(show, sizeof show); endpoint.status(out);
    assert(out[2] == BUSY);
    uint8_t info[] = {1}; endpoint.command(info, 1); endpoint.status(out); assert(out[2] == BUSY);
    uint8_t data[] = {5, 0, 0, 42}; endpoint.command(data, sizeof data); endpoint.status(out); assert(out[2] == BUSY);
    assert(endpoint.takeShow());
    endpoint.command(info, 1); endpoint.status(out); assert(out[2] == OK);
    std::puts("pending display copy rejects new reads and uploads without corrupting its frame");
  }
}
