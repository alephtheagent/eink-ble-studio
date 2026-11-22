#include <Arduino.h>
#include <SPI.h>
#include <GxEPD2_BW.h>
#include <bluefruit.h>
#include "protocol.h"
#include "welcome.h"
#include "boot_state.h"
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
      if (actionArmed) {
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
  xSemaphoreTake(protocolMutex, portMAX_DELAY);
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
  if (!protocolMutex || !diagnostics) while (true) delay(1000);

  Bluefruit.configPrphConn(247, BLE_GAP_EVENT_LENGTH_DEFAULT,
                          BLE_GATTS_HVN_TX_QUEUE_SIZE_DEFAULT, BLE_GATTC_WRITE_CMD_TX_QUEUE_SIZE_DEFAULT);
  Bluefruit.configUuid128Count(3);
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
    enterOTADfu();
  } else if (action == eink::ACTION_RESET_WELCOME) {
    bool ok = bootStore.erase();
    xSemaphoreTake(protocolMutex, portMAX_DELAY);
    if (!ok) protocol.actionFailed();
    actionArmed = false;
    publishStatus();
    xSemaphoreGive(protocolMutex);
  }

  if (refresh) {
    // No command can replace the frame while QUEUED/REFRESHING.
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
