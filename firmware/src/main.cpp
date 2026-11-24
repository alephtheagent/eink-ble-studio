#include <Arduino.h>
#include <SPI.h>
#include <GxEPD2_BW.h>
#include <bluefruit.h>
#include "protocol.h"
#include "welcome.h"
#include "boot_state.h"
#include "page_wire.h"
#include "anim_wire.h"
#include "anim_player.h"
#include <InternalFileSystem.h>
#include <flash/flash_nrf5x.h>
#include <nrf_nvmc.h>

// Kept as data so the exact identity embedded in an ELF can be inspected.
extern "C" const volatile uint32_t eink_build_id = EINK_BUILD_ID;

// Arduino variant indexes, not Nordic GPIO numbers.
constexpr int16_t EPD_CS = 16, EPD_DC = 8, EPD_RES = 14, EPD_BUSY = 7;
static_assert(PIN_SPI_MOSI == 10 && PIN_SPI_SCK == 9 && PIN_SPI_MISO == 4, "Incorrect hardware SPI mapping");
using Panel = GxEPD2_213_BN;
static_assert(Panel::WIDTH_VISIBLE == eink::WIDTH && Panel::HEIGHT == eink::HEIGHT, "Incorrect display geometry");
GxEPD2_BW<Panel, Panel::HEIGHT> display(Panel(EPD_CS, EPD_DC, EPD_RES, EPD_BUSY));

BLEService service("7b1e0001-6ba2-4f25-8ac7-1d54e91a1000");
BLECharacteristic commandCharacteristic("7b1e0002-6ba2-4f25-8ac7-1d54e91a1000");
BLECharacteristic statusCharacteristic("7b1e0003-6ba2-4f25-8ac7-1d54e91a1000");
BLECharacteristic command2Characteristic("7b1e0004-6ba2-4f25-8ac7-1d54e91a1000");
BLECharacteristic status2Characteristic("7b1e0005-6ba2-4f25-8ac7-1d54e91a1000");
BLECharacteristic capsCharacteristic("7b1e0006-6ba2-4f25-8ac7-1d54e91a1000");
BLECharacteristic pageCommand("7b1e0007-6ba2-4f25-8ac7-1d54e91a1000");
BLECharacteristic pageStatus("7b1e0008-6ba2-4f25-8ac7-1d54e91a1000");
BLECharacteristic pageData("7b1e0009-6ba2-4f25-8ac7-1d54e91a1000");
// Same 128-bit base as every other characteristic: the SoftDevice's 128-bit vendor UUID
// pool is shared, so configUuid128Count(3) still covers all of them.
BLEService animService("7b1e0010-6ba2-4f25-8ac7-1d54e91a1000");
BLECharacteristic animCommand("7b1e0011-6ba2-4f25-8ac7-1d54e91a1000");
BLECharacteristic animStatus("7b1e0012-6ba2-4f25-8ac7-1d54e91a1000");
BLECharacteristic animData("7b1e0013-6ba2-4f25-8ac7-1d54e91a1000");
SemaphoreHandle_t pageFlashEvent;
volatile uint32_t pageFlashResult;
enum PageFlashOwner : uint8_t { FLASH_OTHER, FLASH_PAGE, FLASH_WAIT_OTHER };
volatile PageFlashOwner pageFlashOwner = FLASH_OTHER;
extern "C" void __real_flash_nrf5x_event_cb(uint32_t event);
extern "C" void __wrap_flash_nrf5x_event_cb(uint32_t event) {
  PageFlashOwner owner = pageFlashOwner;
  if (owner != FLASH_PAGE) __real_flash_nrf5x_event_cb(event);
  if (owner != FLASH_OTHER) {
    pageFlashResult = event;
    pageFlashOwner = FLASH_OTHER;
    xSemaphoreGive(pageFlashEvent);
  }
}
struct PageFlash {
  bool read(uint32_t addr, void* out, size_t len) { memcpy(out, reinterpret_cast<const void*>(addr), len); return true; }
  bool erase(uint32_t addr) { return flash_nrf5x_erase(addr); }
  bool program(uint32_t addr, const void* data, size_t len) {
    if ((addr & 3) || (len & 3) || (reinterpret_cast<uintptr_t>(data) & 3)) return false;
    const uint32_t* src = static_cast<const uint32_t*>(data);
    while (len) {
      size_t bytes = len > 1024 ? 1024 : len;
      uint32_t err;
      // SOC completion is dispatched by a FreeRTOS task. Suspend scheduling
      // across acceptance and ownership publication, not SoftDevice interrupts.
      // BUSY belongs to the previous flash operation: deliver its completion to
      // the core before retrying, never count it as our write acknowledgement.
      do {
        vTaskSuspendAll();
        err = sd_flash_write(reinterpret_cast<uint32_t*>(addr), src, bytes / 4);
        if (err == NRF_SUCCESS) pageFlashOwner = FLASH_PAGE;
        else if (err == NRF_ERROR_BUSY) pageFlashOwner = FLASH_WAIT_OTHER;
        xTaskResumeAll();
        if (err == NRF_SUCCESS || err == NRF_ERROR_BUSY)
          xSemaphoreTake(pageFlashEvent, portMAX_DELAY);
      } while (err == NRF_ERROR_BUSY);
      if (err != NRF_SUCCESS || pageFlashResult != NRF_EVT_FLASH_OPERATION_SUCCESS) return false;
      addr += bytes; src += bytes / 4; len -= bytes;
    }
    return true;
  }
};
PageFlash pageFlash;
eink::pages::Storage<PageFlash> pageStore(pageFlash);
eink::pages::Endpoint<decltype(pageStore)> pages(pageStore);
// The animation reservation shares the same flash driver (absolute addresses, word
// aligned programs) but a disjoint address range: 0xB0000..0xCC000.
eink::anim::Storage<PageFlash> animStore(pageFlash);
eink::anim::Endpoint<decltype(animStore)> animation(animStore);
volatile bool pageWorking = false;
volatile bool pageDisconnected = false;
volatile bool pageDisplaying = false;
// True while the main loop is performing animation flash work (bank erase, blob program,
// metadata write). BLE callbacks never do flash work; they only set this via poll().
volatile bool animFlashWorking = false;
// Set from the BLE event task on disconnect, serviced by the loop after poll() (so it can
// never run concurrently with animation flash work). BLE_CONN_HANDLE_INVALID means none.
volatile uint16_t animDisconnectedConn = BLE_CONN_HANDLE_INVALID;
uint16_t pageOwner = BLE_CONN_HANDLE_INVALID;
eink::Protocol protocol;
SemaphoreHandle_t protocolMutex;
uint16_t transferConnection = BLE_CONN_HANDLE_INVALID;
struct Diagnostic {
  uint32_t at, result;
  uint16_t conn, offset, length;
  uint8_t op, state, error, stage;
};
QueueHandle_t diagnostics;
// Protected by protocolMutex; only armed after the ATT reply succeeds.
bool actionArmed = false;
uint32_t actionAt = 0;

struct BootStore {
  bool read(eink::boot::Record& out) {
    memcpy(&out, reinterpret_cast<const void*>(eink::boot::ADDRESS), sizeof(out));
    return true;
  }
  bool erased() {
    const volatile uint32_t* words = reinterpret_cast<const volatile uint32_t*>(eink::boot::ADDRESS);
    for (unsigned i = 0; i < eink::boot::PAGE_SIZE / 4; ++i)
      if (words[i] != 0xffffffffu) return false;
    return true;
  }
  // Called before Bluefruit.begin(): the SoftDevice is not enabled yet.
  bool save(uint32_t buildId) {
    const eink::boot::Record record = eink::boot::makeRecord(buildId);
    nrf_nvmc_mode_set(NRF_NVMC, NRF_NVMC_MODE_ERASE);
    while (!nrf_nvmc_ready_check(NRF_NVMC)) {}
    nrf_nvmc_page_erase_start(NRF_NVMC, eink::boot::ADDRESS);
    while (!nrf_nvmc_ready_check(NRF_NVMC)) {}
    nrf_nvmc_mode_set(NRF_NVMC, NRF_NVMC_MODE_READONLY);
    while (!nrf_nvmc_ready_check(NRF_NVMC)) {}
    if (!erased()) return false;
    nrf_nvmc_mode_set(NRF_NVMC, NRF_NVMC_MODE_WRITE);
    while (!nrf_nvmc_ready_check(NRF_NVMC)) {}
    const uint32_t* src = reinterpret_cast<const uint32_t*>(&record);
    volatile uint32_t* dst = reinterpret_cast<volatile uint32_t*>(eink::boot::ADDRESS);
    for (unsigned i = 0; i < sizeof(record) / 4; ++i) {
      dst[i] = src[i];
      while (!nrf_nvmc_ready_check(NRF_NVMC)) {}
    }
    nrf_nvmc_mode_set(NRF_NVMC, NRF_NVMC_MODE_READONLY);
    while (!nrf_nvmc_ready_check(NRF_NVMC)) {}
    eink::boot::Record actual;
    return read(actual) && eink::boot::valid(actual, buildId);
  }
  // Once BLE is running, use the core's SoftDevice-aware asynchronous erase.
  bool erase() { return flash_nrf5x_erase(eink::boot::ADDRESS) && erased(); }
};

void initPanel() {
  SPI.begin();
  display.epd2.selectSPI(SPI, SPISettings(4000000, MSBFIRST, SPI_MODE0));
  display.init(115200, true, 50, false);
  display.setRotation(0);
}
struct WelcomePanel {
  void showWelcome() {
    initPanel();
    display.setFullWindow();
    display.firstPage();
    do {
      display.fillScreen(GxEPD_WHITE);
      display.drawBitmap(0, 0, eink_welcome_bitmap, eink::WIDTH, eink::HEIGHT, GxEPD_BLACK);
    } while (display.nextPage());
    display.hibernate();
  }
};
BootStore bootStore;

// GxEPD2 panel adapter for the animation player. GxEPD2_213_BN addresses columns in bytes,
// so a partial window is widened to whole byte columns; the widened box may reach into the
// hidden columns, which the next full refresh clears. `present()` therefore passes the
// player's exact pixel box to setPartialWindow, which widens it internally (see
// GxEPD2_BW::setPartialWindow and GxEPD2_213_BN::_writeImagePart in the pinned 1.6.9
// source), and draws the whole 4000-byte bitmap at (0,0): _writeImagePart clips it to the
// window, so no manual sub-rectangle extraction is needed.
struct AnimPanel : eink::anim::Panel {
  void present(uint16_t x, uint16_t y, uint16_t w, uint16_t h, const uint8_t* frame) override {
    display.setPartialWindow(x, y, w, h);
    display.firstPage();
    do {
      // firstPage() fills the buffer white; draw the full frame and let the window clip it.
      display.drawBitmap(0, 0, frame, eink::WIDTH, eink::HEIGHT, GxEPD_BLACK);
    } while (display.nextPage());
  }
  void presentFull(const uint8_t* frame) override {
    display.setFullWindow();
    display.firstPage();
    do {
      display.fillScreen(GxEPD_WHITE);
      display.drawBitmap(0, 0, frame, eink::WIDTH, eink::HEIGHT, GxEPD_BLACK);
    } while (display.nextPage());
  }
  void clear() override {
    display.setFullWindow();
    display.firstPage();
    do {
      display.fillScreen(GxEPD_WHITE);
    } while (display.nextPage());
  }
  void hibernate() override { display.hibernate(); }
};
AnimPanel animPanel;
eink::anim::Player<decltype(animStore)> player(animPanel);
// True while the panel is known to be initialized and awake for animation playback.
bool animPanelReady = false;
// Diagnostics: how many static restores happened, and whether the failure line was printed.
uint32_t animRestoreCount = 0;
bool animRestoreLogged = false;
// Last time a playback position was written (0 = never). Throttles saves to PERSIST_MS.
uint32_t animPositionSavedAt = 0;

// Never print or wait for USB from the BLE event task.
void diagnose(uint8_t stage, uint16_t conn, const ble_gatts_evt_write_t* request, uint32_t result, bool locked = true) {
  Diagnostic d = {millis(), result, conn, 0, 0, 0,
                  locked ? uint8_t(protocol.state()) : uint8_t(0xff),
                  locked ? uint8_t(protocol.error()) : uint8_t(0xff), stage};
  if (request) {
    d.length = request->len;
    d.op = request->len ? request->data[0] : 0;
    if (d.op == 2 && request->len >= 7) d.offset = eink::get16(request->data + 5);
  }
  xQueueSend(diagnostics, &d, 0);
}

// Caller holds protocolMutex. Publish before acknowledging an ATT write.
bool publishStatus() {
  uint8_t status[20];
  protocol.status(status);
  bool first = statusCharacteristic.write(status, sizeof(status)) == sizeof(status);
  protocol.status2(status);
  bool second = status2Characteristic.write(status, sizeof(status)) == sizeof(status);
  return first && second;
}
bool publishPages() {
  uint8_t data[20];
  pages.status(data);
  if (pageStatus.write(data, sizeof(data)) != sizeof(data)) return false;
  size_t len = pages.data(data);
  return !len || pageData.write(data, len) == len;
}

// Caller holds protocolMutex. Publish the animation status (and, for READ, the staged
// data characteristic) before acknowledging the ATT write.
bool publishAnim() {
  uint8_t data[20];
  animation.status(data);
  if (animStatus.write(data, sizeof(data)) != sizeof(data)) return false;
  size_t len = animation.data(data);
  return !len || animData.write(data, len) == len;
}

// Exclusive animation work: an upload, a staged command or in-flight flash. Playback alone
// is NOT exclusive, because legacy/pages commands preempt it (they stop playback and take
// the panel). Used to reject legacy and page writes while animation work is in flight.
bool animExclusive() { return animation.pending() || animation.ownsUpload() || animFlashWorking; }

// Stop playback and return the panel to static content: the first stored page if the page
// collection is non-empty, otherwise a cleared (white) panel. A one-shot animation that
// ended on its own is NOT routed through here — the contract keeps its last frame.
//
// Preconditions are checked by the caller: this does a flash read plus one full refresh, so
// it runs in the main loop only, never from a BLE callback, and never while a page owns the
// panel or the legacy receiver is busy. `restore` false means "stop only, the caller is
// about to draw something else" (legacy COMMIT, pages SHOW, welcome, DFU).
// Playback position persistence, append-only and erase-free: at most one record per
// PERSIST_MS and never while flash is exclusive (an upload or another flash operation is in
// progress). A FULL tail or a failed program is non-fatal: playback continues and the
// reported status is unchanged.
bool savePosition(uint16_t index, bool force) {
  if (animFlashWorking || animation.pending() || animation.ownsUpload()) return false;
  const uint32_t now = millis();
  if (!force && animPositionSavedAt && uint32_t(now - animPositionSavedAt) < eink::anim::Player<decltype(animStore)>::PERSIST_MS)
    return false;
  if (animStore.savePosition(index) != eink::anim::OK) return false;
  animPositionSavedAt = now;
  return true;
}

void stopPlayback(bool restore) {
  const bool wasRunning = player.running();
  // Persist where playback was before forgetting it. Forced: a stop is a deliberate user
  // action, so the 10 s throttle applies to the periodic saves, not to this one write.
  if (wasRunning) savePosition(player.index(), true);
  if (wasRunning) player.stop();
  animation.playbackStopped();
  animPanelReady = false;
  if (!restore) return;
  if (pageWorking || pageDisplaying || pages.busy()) return;  // another owner has the panel
  const eink::State state = protocol.state();
  if (state == eink::RECEIVING || state == eink::QUEUED || state == eink::REFRESHING) return;
  // player.buffer() is only valid while the player is stopped, which it now is.
  uint8_t* scratch = player.buffer();
  if (!scratch) return;
  ++animRestoreCount;
  const eink::anim::RestoreResult result = eink::anim::restoreStatic(animPanel, pageStore, scratch);
  if (result == eink::anim::RESTORE_FAILED && !animRestoreLogged) {
    // One line per boot, never per frame: the panel is white and playback is stopped.
    Serial.println("Animation stop: page restore failed, panel cleared");
    animRestoreLogged = true;
  }
}

void authorizeAnim(uint16_t conn, BLECharacteristic*, ble_gatts_evt_write_t* request) {
  ble_gatts_rw_authorize_reply_params_t reply = {};
  reply.type = BLE_GATTS_AUTHORIZE_TYPE_WRITE;
  // Bounded lock acquisition, same discipline as authorizeCommand: a lost race rejects the
  // ATT request instead of blocking the SoftDevice event task.
  if (request->op != BLE_GATTS_OP_WRITE_REQ || request->offset || animFlashWorking ||
      xSemaphoreTake(protocolMutex, pdMS_TO_TICKS(50)) != pdTRUE) {
    reply.params.write.gatt_status = BLE_GATT_STATUS_ATTERR_INSUF_RESOURCES;
  } else {
    eink::State state = protocol.state();
    // animFlashWorking is published under protocolMutex before the loop releases it, and it
    // is re-checked here under the same lock: the outer check above ran before the lock, so
    // without this a DATA command could reach animation.command() while poll() is running
    // outside the mutex, touching the endpoint state and the flash driver concurrently.
    // With this re-check, poll() and command() can never overlap.
    // The legacy receiver and the pages endpoint own shared panel/transfer state too:
    // animation commands wait for them instead of interleaving. Playback never blocks them.
    if (actionArmed || animFlashWorking || pageWorking || pageDisplaying || pages.busy() ||
        state == eink::RECEIVING || state == eink::QUEUED || state == eink::REFRESHING) {
      reply.params.write.gatt_status = BLE_GATT_STATUS_ATTERR_INSUF_RESOURCES;
    } else {
      animation.command(request->data, request->len, millis(), conn);
      bool ok = publishAnim();
      reply.params.write.gatt_status = ok ? BLE_GATT_STATUS_SUCCESS : BLE_GATT_STATUS_ATTERR_UNLIKELY_ERROR;
      reply.params.write.update = 1;
      reply.params.write.offset = request->offset;
      reply.params.write.len = request->len;
      reply.params.write.p_data = request->data;
    }
    xSemaphoreGive(protocolMutex);
  }
  if (sd_ble_gatts_rw_authorize_reply(conn, &reply) != NRF_SUCCESS) Bluefruit.disconnect(conn);
}

void authorizePages(uint16_t conn, BLECharacteristic*, ble_gatts_evt_write_t* request) {
  ble_gatts_rw_authorize_reply_params_t reply = {};
  reply.type = BLE_GATTS_AUTHORIZE_TYPE_WRITE;
  if (request->op != BLE_GATTS_OP_WRITE_REQ || request->offset || pageWorking || pageDisplaying ||
      animExclusive() || xSemaphoreTake(protocolMutex, 0) != pdTRUE) {
    reply.params.write.gatt_status = BLE_GATT_STATUS_ATTERR_INSUF_RESOURCES;
  } else {
    eink::State state = protocol.state();
    // animExclusive() is re-checked here because the outer check ran before the lock.
    if (actionArmed || animExclusive() || state == eink::RECEIVING ||
        state == eink::QUEUED || state == eink::REFRESHING) {
      reply.params.write.gatt_status = BLE_GATT_STATUS_ATTERR_INSUF_RESOURCES;
    } else {
      bool wasBusy = pages.busy();
      pages.command(request->data, request->len, conn);
      if (!wasBusy && pages.busy()) pageOwner = conn;
      bool ok = publishPages();
      reply.params.write.gatt_status = ok ? BLE_GATT_STATUS_SUCCESS : BLE_GATT_STATUS_ATTERR_UNLIKELY_ERROR;
      reply.params.write.update = 1;
      reply.params.write.offset = request->offset;
      reply.params.write.len = request->len;
      reply.params.write.p_data = request->data;
    }
    xSemaphoreGive(protocolMutex);
  }
  if (sd_ble_gatts_rw_authorize_reply(conn, &reply) != NRF_SUCCESS) Bluefruit.disconnect(conn);
}

// Run synchronously on Bluefruit's BLE event task: a successful Write Response
// must not precede the status update that acknowledges the command.
void authorizeCommand(uint16_t conn, BLECharacteristic* characteristic, ble_gatts_evt_write_t* request) {
  ble_gatts_rw_authorize_reply_params_t reply = {};
  reply.type = BLE_GATTS_AUTHORIZE_TYPE_WRITE;
  if (request->op != BLE_GATTS_OP_WRITE_REQ || request->offset != 0) {
    reply.params.write.gatt_status = BLE_GATT_STATUS_ATTERR_WRITE_NOT_PERMITTED;
  } else {
    // The loop only holds this lock for protocol transitions, never SPI/refresh.
    if (xSemaphoreTake(protocolMutex, pdMS_TO_TICKS(50)) != pdTRUE) {
      reply.params.write.gatt_status = BLE_GATT_STATUS_ATTERR_INSUF_RESOURCES;
    } else {
      if (actionArmed || pageWorking || pageDisplaying || pages.busy() || animExclusive()) {
        // animExclusive() is re-checked under the lock; the outer check is a fast reject.
        reply.params.write.gatt_status = BLE_GATT_STATUS_ATTERR_INSUF_RESOURCES;
        xSemaphoreGive(protocolMutex);
        sd_ble_gatts_rw_authorize_reply(conn, &reply);
        return;
      }
      if (characteristic == &command2Characteristic) protocol.command2(request->data, request->len, millis(), conn);
      else protocol.command(request->data, request->len, millis(), conn);
      if (protocol.state() == eink::RECEIVING) transferConnection = protocol.owner();
      bool published = publishStatus();
      reply.params.write.gatt_status = published ? BLE_GATT_STATUS_SUCCESS : BLE_GATT_STATUS_ATTERR_UNLIKELY_ERROR;
      // S140 6.1.1 ble_gatts.h: WRITE authorization MUST supply the value.
      reply.params.write.update = 1;
      reply.params.write.offset = request->offset;
      reply.params.write.len = request->len;
      reply.params.write.p_data = request->data;
      uint32_t result = sd_ble_gatts_rw_authorize_reply(conn, &reply);
      if (result != NRF_SUCCESS || !published || protocol.error() != eink::NONE ||
          (request->len && (request->data[0] == 1 || request->data[0] == 3)))
        diagnose(published ? 1 : 2, conn, request, result);
      if (result != NRF_SUCCESS || !published) {
        protocol.consumeAction();
        protocol.disconnect(conn);
        publishStatus();
      }
      else if (protocol.action() != eink::ACTION_NONE) {
        actionArmed = true;
        actionAt = millis();
      }
      xSemaphoreGive(protocolMutex);
      // Failed authorization leaves an uncertain ATT procedure: reconnect, not retry.
      if (result != NRF_SUCCESS || !published) Bluefruit.disconnect(conn);
      return;
    }
  }
  uint32_t result = sd_ble_gatts_rw_authorize_reply(conn, &reply);
  diagnose(3, conn, request, result, false);
}

void disconnected(uint16_t conn, uint8_t) {
  // An open animation upload belongs to the connection that issued BEGIN. Because
  // animExclusive() blocks legacy and page writes while an upload is open, leaving it to the
  // 15 s timeout would keep a reconnecting client out; the loop discards it on the next pass.
  animDisconnectedConn = conn;
  if (pageWorking) { if (conn == pageOwner) pageDisconnected = true; return; }
  xSemaphoreTake(protocolMutex, portMAX_DELAY);
  pages.disconnect(conn);
  if (conn == transferConnection) {
    protocol.disconnect(conn);
    transferConnection = BLE_CONN_HANDLE_INVALID;
    publishStatus();
    diagnose(4, conn, nullptr, 0);
  }
  xSemaphoreGive(protocolMutex);
}

void authorizeCaps(uint16_t conn, BLECharacteristic*, ble_gatts_evt_read_t*) {
  uint16_t mtu = 23;
  BLEConnection* connection = Bluefruit.Connection(conn);
  if (connection && connection->connected()) mtu = connection->getMtu();
  if (mtu < 23) mtu = 23;
  uint16_t safeWrite = mtu - 3;
  if (safeWrite > 244) safeWrite = 244;
  uint8_t caps[20] = {'E', 'B', 'L', '2', 2, 0, 3, 1};
  eink::put16(caps + 8, safeWrite);
  eink::put16(caps + 10, eink::FRAME_BYTES);
  eink::put16(caps + 12, eink::FRAME_BYTES);
  eink::put16(caps + 14, eink::TIMEOUT_MS);
  ble_gatts_rw_authorize_reply_params_t reply = {};
  reply.type = BLE_GATTS_AUTHORIZE_TYPE_READ;
  reply.params.read.gatt_status = BLE_GATT_STATUS_SUCCESS;
  reply.params.read.update = 1;
  reply.params.read.len = sizeof(caps);
  reply.params.read.p_data = caps;
  if (sd_ble_gatts_rw_authorize_reply(conn, &reply) != NRF_SUCCESS) Bluefruit.disconnect(conn);
}

void setup() {
  // initVariant preloads P0.13 HIGH and configures it as an output before setup.
  delay(250);
  Serial.begin(115200);
  WelcomePanel welcome;
  if (eink::boot::ensureWelcome(bootStore, welcome, eink_build_id) ==
      eink::boot::Result::WelcomeShownStoreFailed)
    Serial.println("Welcome state flash write failed; will retry on next boot");
  protocolMutex = xSemaphoreCreateMutex();
  diagnostics = xQueueCreate(16, sizeof(Diagnostic));
  pageFlashEvent = xSemaphoreCreateBinary();
  if (!protocolMutex || !diagnostics || !pageFlashEvent) while (true) delay(1000);
  if (!pageStore.begin()) Serial.println("Page storage recovery failed");
  if (!animStore.begin()) Serial.println("Animation storage recovery failed");
  // docs/protocol-animation.md: "The firmware constructs the player with
  // partialPresentation(true) and configure(10, 60)". The class defaults are already those
  // values; naming them here keeps the shipped configuration greppable and uses the class
  // constants so the defaults and this call cannot drift apart.
  player.configure(eink::anim::Player<decltype(animStore)>::DEFAULT_LOOP_REFRESH,
                   eink::anim::Player<decltype(animStore)>::DEFAULT_THRESHOLD);
  player.partialPresentation(true);

  Bluefruit.configPrphConn(247, BLE_GAP_EVENT_LENGTH_DEFAULT,
                          BLE_GATTS_HVN_TX_QUEUE_SIZE_DEFAULT, BLE_GATTC_WRITE_CMD_TX_QUEUE_SIZE_DEFAULT);
  Bluefruit.configUuid128Count(3);
  // Bluefruit blinks LED_BLUE while advertising and lights it while connected.
  // disable that software LED driver: nothing here needs it, and it costs battery.
  // initVariant left the pin driven LOW (inactive), so the LED stays off.
  Bluefruit.autoConnLed(false);
  if (!Bluefruit.begin()) while (true) delay(1000);
  Bluefruit.setName("Eink Studio");
  Bluefruit.Periph.setDisconnectCallback(disconnected);
  if (service.begin() != ERROR_NONE) while (true) delay(1000);
  commandCharacteristic.setProperties(CHR_PROPS_WRITE);
  commandCharacteristic.setPermission(SECMODE_NO_ACCESS, SECMODE_OPEN);
  commandCharacteristic.setMaxLen(20);
  commandCharacteristic.setWriteAuthorizeCallback(authorizeCommand, false);
  if (commandCharacteristic.begin() != ERROR_NONE) while (true) delay(1000);
  statusCharacteristic.setProperties(CHR_PROPS_READ);
  statusCharacteristic.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  statusCharacteristic.setFixedLen(20);
  if (statusCharacteristic.begin() != ERROR_NONE) while (true) delay(1000);
  command2Characteristic.setProperties(CHR_PROPS_WRITE);
  command2Characteristic.setPermission(SECMODE_NO_ACCESS, SECMODE_OPEN);
  command2Characteristic.setMaxLen(244);
  command2Characteristic.setWriteAuthorizeCallback(authorizeCommand, false);
  if (command2Characteristic.begin() != ERROR_NONE) while (true) delay(1000);
  status2Characteristic.setProperties(CHR_PROPS_READ);
  status2Characteristic.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  status2Characteristic.setFixedLen(20);
  if (status2Characteristic.begin() != ERROR_NONE) while (true) delay(1000);
  capsCharacteristic.setProperties(CHR_PROPS_READ);
  capsCharacteristic.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  capsCharacteristic.setFixedLen(20);
  capsCharacteristic.setReadAuthorizeCallback(authorizeCaps, false);
  if (capsCharacteristic.begin() != ERROR_NONE || !publishStatus()) while (true) delay(1000);
  pageCommand.setProperties(CHR_PROPS_WRITE);
  pageCommand.setPermission(SECMODE_NO_ACCESS, SECMODE_OPEN);
  pageCommand.setMaxLen(244);
  pageCommand.setWriteAuthorizeCallback(authorizePages, false);
  if (pageCommand.begin() != ERROR_NONE) while (true) delay(1000);
  pageStatus.setProperties(CHR_PROPS_READ);
  pageStatus.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  pageStatus.setFixedLen(20);
  if (pageStatus.begin() != ERROR_NONE) while (true) delay(1000);
  pageData.setProperties(CHR_PROPS_READ);
  pageData.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  pageData.setMaxLen(20);
  if (pageData.begin() != ERROR_NONE || !publishPages()) while (true) delay(1000);
  // Animation endpoints live in their own service 7b1e0010 (see docs/protocol-animation.md).
  if (animService.begin() != ERROR_NONE) while (true) delay(1000);
  animCommand.setProperties(CHR_PROPS_WRITE);
  animCommand.setPermission(SECMODE_NO_ACCESS, SECMODE_OPEN);
  animCommand.setMaxLen(244);
  animCommand.setWriteAuthorizeCallback(authorizeAnim, false);
  if (animCommand.begin() != ERROR_NONE) while (true) delay(1000);
  animStatus.setProperties(CHR_PROPS_READ);
  animStatus.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  animStatus.setFixedLen(20);
  if (animStatus.begin() != ERROR_NONE) while (true) delay(1000);
  animData.setProperties(CHR_PROPS_READ);
  animData.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  animData.setMaxLen(20);
  if (animData.begin() != ERROR_NONE || !publishAnim()) while (true) delay(1000);
  if (!Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE) ||
      !Bluefruit.Advertising.addService(service) || !Bluefruit.ScanResponse.addName()) while (true) delay(1000);
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(32, 244);
  Bluefruit.Advertising.setFastTimeout(30);
  if (!Bluefruit.Advertising.start(0)) while (true) delay(1000);
}

void loop() {
  Diagnostic d;
  while (xQueueReceive(diagnostics, &d, 0) == pdTRUE) {
    if (Serial) Serial.printf("BLE t=%lu stage=%u conn=%u op=%u offset=%u len=%u state=%u error=%u sdk=0x%08lx\n",
                             (unsigned long)d.at, d.stage, d.conn, d.op, d.offset, d.length,
                             d.state, d.error, (unsigned long)d.result);
  }
  // Animation flash work: poll() does at most one bank sector erase (or one staged blob
  // write) per call, so a full 13-sector erase never blocks BLE. The flag tells the BLE
  // callbacks to reject legacy/page writes while flash is busy.
  xSemaphoreTake(protocolMutex, portMAX_DELAY);
  bool doAnimWork = animation.pending() || animFlashWorking;
  bool animExpired = animation.expire(millis());
  if (animExpired) publishAnim();
  if (doAnimWork) animFlashWorking = true;
  xSemaphoreGive(protocolMutex);
  if (doAnimWork) {
    animation.poll();
    xSemaphoreTake(protocolMutex, portMAX_DELAY);
    publishAnim();
    animFlashWorking = false;
    xSemaphoreGive(protocolMutex);
  }
  // Drain a disconnect that arrived while animation work was in flight. This runs outside
  // poll(), so the BLE task and the flash work never touch the endpoint concurrently.
  if (animDisconnectedConn != BLE_CONN_HANDLE_INVALID) {
    xSemaphoreTake(protocolMutex, portMAX_DELAY);
    uint16_t gone = animDisconnectedConn;
    animDisconnectedConn = BLE_CONN_HANDLE_INVALID;
    if (!animFlashWorking) {
      bool wasUploading = animation.ownsUpload() || animation.pending();
      animation.disconnect(gone);
      if (wasUploading) publishAnim();
    }
    xSemaphoreGive(protocolMutex);
  }

  xSemaphoreTake(protocolMutex, portMAX_DELAY);
  bool doPageWork = pages.pending();
  if (doPageWork) pageWorking = true;
  xSemaphoreGive(protocolMutex);
  if (doPageWork) {
    pages.poll();
    xSemaphoreTake(protocolMutex, portMAX_DELAY);
    if (pageDisconnected) { pages.disconnect(pageOwner); pageDisconnected = false; }
    bool showPage = pages.takeShow();
    if (showPage) pageDisplaying = true;
    publishPages();
    pageWorking = false;
    xSemaphoreGive(protocolMutex);
    if (showPage) {
      stopPlayback(false);  // pages SHOW redraws the panel itself
      initPanel();
      display.setFullWindow();
      display.firstPage();
      do {
        display.fillScreen(GxEPD_WHITE);
        display.drawBitmap(0, 0, pages.frame(), eink::WIDTH, eink::HEIGHT, GxEPD_BLACK);
      } while (display.nextPage());
      display.hibernate();
      pageDisplaying = false;
    }
  }
  // Playback section. The player is driven entirely from the main loop on deadlines; the
  // mutex is never held across panel I/O (a partial refresh can take ~100 ms).
  {
    xSemaphoreTake(protocolMutex, portMAX_DELAY);
    // The panel is shared: while a legacy frame is queued/refreshing or a page owns it,
    // playback yields instead of fighting for the bus.
    bool panelBusy = pageWorking || pageDisplaying || pages.busy() || animFlashWorking ||
                     protocol.state() == eink::QUEUED || protocol.state() == eink::REFRESHING;
    // A stop is always honoured; a play request is only consumed when the panel is free, so
    // a PLAY that arrives during a legacy refresh starts as soon as that refresh finishes
    // instead of being silently dropped.
    bool stopRequested = animation.takeStop();
    bool playRequested = !panelBusy && animation.takePlay();
    uint16_t playIndex = animation.playIndex();
    if (playRequested && player.running()) player.stop();
    xSemaphoreGive(protocolMutex);
    if (stopRequested) {
      // STOP (and the stop DELETE requests) returns the panel to static content: the first
      // stored page, or cleared white when the collection is empty. One-shot completion is
      // not routed through here, so it keeps its last frame. The panel work runs outside
      // the mutex; only the status publication takes it again.
      stopPlayback(true);
      xSemaphoreTake(protocolMutex, portMAX_DELAY);
      publishAnim();
      xSemaphoreGive(protocolMutex);
    }
    if (playRequested) {
      // One panel initialization per playback run; a hibernated panel must be re-initialized
      // before the next present.
      if (!animPanelReady) { initPanel(); animPanelReady = true; }
      bool started = player.start(animStore, playIndex, millis());
      xSemaphoreTake(protocolMutex, portMAX_DELAY);
      if (started) animation.playing(true);
      else animation.playbackStopped();
      publishAnim();
      xSemaphoreGive(protocolMutex);
    } else if (player.running() && !panelBusy) {
      // tick() presents at most one due frame. The mutex is not held here.
      bool presented = player.tick(millis());
      if (!player.running()) {
        // One-shot animation finished or a corrupt blob stopped it: keep the last frame
        // visible and report that playback ended.
        xSemaphoreTake(protocolMutex, portMAX_DELAY);
        animation.playbackStopped();
        publishAnim();
        xSemaphoreGive(protocolMutex);
        animPanelReady = false;
      } else if (presented) {
        // Periodic position save, throttled by the player to one per 10 s and gated on
        // flash being idle. A FULL tail simply stops saving until the next metadata commit.
        if (player.shouldPersist(millis())) savePosition(player.index(), false);
        xSemaphoreTake(protocolMutex, portMAX_DELAY);
        publishAnim();
        xSemaphoreGive(protocolMutex);
      }
    }
  }

  xSemaphoreTake(protocolMutex, portMAX_DELAY);
  eink::State oldState = protocol.state();
  protocol.tick(millis());
  eink::Action action = eink::ACTION_NONE;
  if (actionArmed && uint32_t(millis() - actionAt) >= 1500) {
    action = protocol.consumeAction();
    // Keep command writes blocked until the erase has completed.
  }
  bool refresh = protocol.beginRefresh();
  if (refresh || oldState != protocol.state()) publishStatus();
  if (oldState != protocol.state()) diagnose(5, transferConnection, nullptr, 0);
  xSemaphoreGive(protocolMutex);
  if (action == eink::ACTION_ENTER_DFU) {
    stopPlayback(false);  // the device resets
    enterOTADfu();
  } else if (action == eink::ACTION_RESET_WELCOME) {
    stopPlayback(false);  // welcome is redrawn on the next boot
    bool ok = bootStore.erase();
    xSemaphoreTake(protocolMutex, portMAX_DELAY);
    if (!ok) protocol.actionFailed();
    actionArmed = false;
    publishStatus();
    xSemaphoreGive(protocolMutex);
  }

  if (refresh) {
    // No command can replace the frame while QUEUED/REFRESHING.
    stopPlayback(false);  // the legacy refresh draws its own frame
    initPanel();
    display.setFullWindow();
    display.firstPage();
    do {
      display.fillScreen(GxEPD_WHITE);
      display.drawBitmap(0, 0, protocol.frame(), eink::WIDTH, eink::HEIGHT, GxEPD_BLACK);
    } while (display.nextPage());
    display.hibernate();
    xSemaphoreTake(protocolMutex, portMAX_DELAY);
    protocol.finishRefresh();
    publishStatus();
    diagnose(6, transferConnection, nullptr, 0);
    xSemaphoreGive(protocolMutex);
  }
  delay(20);
}
