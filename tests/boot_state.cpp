#include "boot_state.h"
#include "protocol.h"
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>

using namespace eink;
using namespace eink::boot;

struct Trace {
  char events[8];
  unsigned count;
  Trace() : events{}, count(0) {}
  void push(char event) { assert(count < sizeof(events)); events[count++] = event; }
};

static Record erasedRecord();

struct FakeStore {
  Record record;
  Trace& trace;
  bool saveOk, readOk;
  unsigned reads, saves;
  FakeStore(const Record& initial, Trace& events, bool saveResult = true, bool readResult = true)
      : record(initial), trace(events), saveOk(saveResult), readOk(readResult), reads(0), saves(0) {}
  bool read(Record& out) {
    ++reads;
    trace.push('R');
    if (!readOk) return false;
    out = record;
    return true;
  }
  bool save(uint32_t buildId) {
    ++saves;
    trace.push('S');
    if (!saveOk) return false;
    record = makeRecord(buildId);
    return true;
  }
  void erase() { record = erasedRecord(); trace.push('E'); }
};

struct FakePanel {
  Trace& trace;
  unsigned welcomeCalls;
  explicit FakePanel(Trace& events) : trace(events), welcomeCalls(0) {}
  void showWelcome() { ++welcomeCalls; trace.push('W'); }
};

static Record erasedRecord() {
  Record record;
  std::memset(&record, 0xff, sizeof(record));
  return record;
}

int main() {
  const uint32_t buildA = 0x12345678u;
  const uint32_t buildB = buildA + 1;
  Record validA = makeRecord(buildA);
  assert(valid(validA, buildA));
  assert(!valid(validA, buildB));

  Record corruptedBuild = validA;
  corruptedBuild.buildId = buildB;
  assert(!valid(corruptedBuild, buildA));
  assert(!valid(corruptedBuild, buildB));
  Record corrupted = validA;
  corrupted.crc ^= 1u;
  assert(!valid(corrupted, buildA));
  corrupted = validA;
  corrupted.magic ^= 1u;
  assert(!valid(corrupted, buildA));
  assert(!valid(erasedRecord(), buildA));

  // Erased flash on first boot: read, show approved welcome, then save state.
  {
    Trace trace;
    FakeStore store(erasedRecord(), trace);
    FakePanel panel(trace);
    assert(ensureWelcome(store, panel, buildA) == Result::WelcomeShown);
    assert(store.reads == 1 && store.saves == 1 && panel.welcomeCalls == 1);
    assert(trace.count == 3 && trace.events[0] == 'R' && trace.events[1] == 'W' && trace.events[2] == 'S');
    assert(valid(store.record, buildA));
  }

  // A subsequent boot with the same record must not call the panel or save again.
  {
    Trace trace;
    FakeStore store(validA, trace);
    FakePanel panel(trace);
    assert(ensureWelcome(store, panel, buildA) == Result::UpToDate);
    assert(store.reads == 1 && store.saves == 0 && panel.welcomeCalls == 0);
    assert(trace.count == 1 && trace.events[0] == 'R');
  }

  // A new firmware build invalidates the old record and shows welcome once.
  {
    Trace trace;
    FakeStore store(validA, trace);
    FakePanel panel(trace);
    assert(ensureWelcome(store, panel, buildB) == Result::WelcomeShown);
    assert(store.reads == 1 && store.saves == 1 && panel.welcomeCalls == 1);
    assert(trace.count == 3 && trace.events[0] == 'R' && trace.events[1] == 'W' && trace.events[2] == 'S');
    assert(valid(store.record, buildB));
  }

  // A corrupt record also triggers the welcome path and repairs persisted state.
  {
    Trace trace;
    FakeStore store(corrupted, trace);
    FakePanel panel(trace);
    assert(ensureWelcome(store, panel, buildA) == Result::WelcomeShown);
    assert(store.reads == 1 && store.saves == 1 && panel.welcomeCalls == 1);
    assert(valid(store.record, buildA));
  }

  // RESET_WELCOME is acknowledged as an action; simulated reboot erases state,
  // after which the normal boot path displays welcome and records this build.
  {
    Trace trace;
    FakeStore store(validA, trace);
    Protocol command;
    const uint8_t reset = 0x06;
    command.command(&reset, 1, 20, 0);
    uint8_t status[20];
    command.status(status);
    assert(status[3] == ACTION_RESET_WELCOME);
    assert(command.consumeAction() == ACTION_RESET_WELCOME);
    store.erase();

    FakePanel panel(trace);
    assert(ensureWelcome(store, panel, buildA) == Result::WelcomeShown);
    assert(store.reads == 1 && store.saves == 1 && panel.welcomeCalls == 1);
    assert(trace.count == 4 && trace.events[0] == 'E' && trace.events[1] == 'R' &&
           trace.events[2] == 'W' && trace.events[3] == 'S');
    assert(valid(store.record, buildA));
  }

  // Failed persistence is surfaced, not reported as a successful stored welcome.
  {
    Trace trace;
    FakeStore store(erasedRecord(), trace, false);
    FakePanel panel(trace);
    assert(ensureWelcome(store, panel, buildA) == Result::WelcomeShownStoreFailed);
    assert(store.reads == 1 && store.saves == 1 && panel.welcomeCalls == 1);
    assert(trace.count == 3 && trace.events[0] == 'R' && trace.events[1] == 'W' && trace.events[2] == 'S');
  }

  // A failed read is treated as unknown state, so the welcome runs and repairs it.
  {
    Trace trace;
    FakeStore store(validA, trace, true, false);
    FakePanel panel(trace);
    assert(ensureWelcome(store, panel, buildA) == Result::WelcomeShown);
    assert(store.reads == 1 && store.saves == 1 && panel.welcomeCalls == 1);
    assert(trace.count == 3 && trace.events[0] == 'R' && trace.events[1] == 'W' && trace.events[2] == 'S');
    assert(valid(store.record, buildA));
  }

  // A save failure leaves the record invalid; next boot retries welcome and persistence.
  {
    Trace trace;
    FakeStore store(erasedRecord(), trace, false);
    FakePanel panel(trace);
    assert(ensureWelcome(store, panel, buildA) == Result::WelcomeShownStoreFailed);
    store.saveOk = true;
    assert(ensureWelcome(store, panel, buildA) == Result::WelcomeShown);
    assert(store.reads == 2 && store.saves == 2 && panel.welcomeCalls == 2);
    assert(trace.count == 6 && trace.events[0] == 'R' && trace.events[1] == 'W' && trace.events[2] == 'S' &&
           trace.events[3] == 'R' && trace.events[4] == 'W' && trace.events[5] == 'S');
    assert(valid(store.record, buildA));
  }

  std::puts("C++ boot state: record validation, first/repeat boot, changed build, corruption/read failure, reset-state and persistence retry PASS");
}
