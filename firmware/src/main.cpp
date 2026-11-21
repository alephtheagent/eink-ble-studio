#include <Arduino.h>
#include <SPI.h>
#include <GxEPD2_BW.h>
#include <bluefruit.h>
#include "protocol.h"

// Arduino variant indexes, not Nordic GPIO numbers.
constexpr int16_t EPD_CS = 16, EPD_DC = 8, EPD_RES = 14, EPD_BUSY = 7;
static_assert(PIN_SPI_MOSI == 10 && PIN_SPI_SCK == 9 && PIN_SPI_MISO == 4, "Incorrect hardware SPI mapping");
using Panel = GxEPD2_213_BN;
static_assert(Panel::WIDTH_VISIBLE == eink::WIDTH && Panel::HEIGHT == eink::HEIGHT, "Incorrect display geometry");
GxEPD2_BW<Panel, Panel::HEIGHT> display(Panel(EPD_CS, EPD_DC, EPD_RES, EPD_BUSY));

BLEService service("7b1e0001-6ba2-4f25-8ac7-1d54e91a1000");
BLECharacteristic commandCharacteristic("7b1e0002-6ba2-4f25-8ac7-1d54e91a1000");
BLECharacteristic statusCharacteristic("7b1e0003-6ba2-4f25-8ac7-1d54e91a1000");
eink::Protocol protocol;
SemaphoreHandle_t protocolMutex;
uint16_t transferConnection = BLE_CONN_HANDLE_INVALID;

// Caller holds protocolMutex. Publish before acknowledging an ATT write.
void publishStatus() {
  uint8_t status[20];
  protocol.status(status);
  statusCharacteristic.write(status, sizeof(status));
}

// Run synchronously on Bluefruit's BLE event task: a successful Write Response
// must not precede the status update that acknowledges the command.
void authorizeCommand(uint16_t conn, BLECharacteristic*, ble_gatts_evt_write_t* request) {
  ble_gatts_rw_authorize_reply_params_t reply = {};
  reply.type = BLE_GATTS_AUTHORIZE_TYPE_WRITE;
  if (request->op != BLE_GATTS_OP_WRITE_REQ || request->offset != 0) {
    reply.params.write.gatt_status = BLE_GATT_STATUS_ATTERR_WRITE_NOT_PERMITTED;
  } else {
    xSemaphoreTake(protocolMutex, portMAX_DELAY);
    protocol.command(request->data, request->len, millis());
    if (protocol.state() == eink::RECEIVING) transferConnection = conn;
    publishStatus();
    reply.params.write.gatt_status = BLE_GATT_STATUS_SUCCESS;
    sd_ble_gatts_rw_authorize_reply(conn, &reply);
    xSemaphoreGive(protocolMutex);
    return;
  }
  sd_ble_gatts_rw_authorize_reply(conn, &reply);
}

void disconnected(uint16_t conn, uint8_t) {
  xSemaphoreTake(protocolMutex, portMAX_DELAY);
  if (conn == transferConnection) {
    protocol.disconnect();
    transferConnection = BLE_CONN_HANDLE_INVALID;
    publishStatus();
  }
  xSemaphoreGive(protocolMutex);
}

void setup() {
  // initVariant preloads P0.13 HIGH and configures it as an output before setup.
  delay(250);
  SPI.begin();
  display.epd2.selectSPI(SPI, SPISettings(4000000, MSBFIRST, SPI_MODE0));
  display.init(115200, true, 50, false);
  display.setRotation(0);
  protocolMutex = xSemaphoreCreateMutex();
  if (!protocolMutex) while (true) delay(1000);

  // Normal bandwidth fixes the ATT MTU at the standard 23 bytes.
  Bluefruit.configPrphBandwidth(BANDWIDTH_NORMAL);
  Bluefruit.configUuid128Count(3);
  Bluefruit.begin();
  Bluefruit.setName("Eink Studio");
  Bluefruit.Periph.setDisconnectCallback(disconnected);
  service.begin();
  commandCharacteristic.setProperties(CHR_PROPS_WRITE);
  commandCharacteristic.setPermission(SECMODE_NO_ACCESS, SECMODE_OPEN);
  commandCharacteristic.setMaxLen(20);
  commandCharacteristic.setWriteAuthorizeCallback(authorizeCommand, false);
  commandCharacteristic.begin();
  statusCharacteristic.setProperties(CHR_PROPS_READ);
  statusCharacteristic.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  statusCharacteristic.setFixedLen(20);
  statusCharacteristic.begin();
  publishStatus();
  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addService(service);
  Bluefruit.ScanResponse.addName();
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(32, 244);
  Bluefruit.Advertising.setFastTimeout(30);
  Bluefruit.Advertising.start(0);
}

void loop() {
  xSemaphoreTake(protocolMutex, portMAX_DELAY);
  eink::State oldState = protocol.state();
  protocol.tick(millis());
  bool refresh = protocol.beginRefresh();
  if (refresh || oldState != protocol.state()) publishStatus();
  xSemaphoreGive(protocolMutex);

  if (refresh) {
    // No command can replace the frame while QUEUED/REFRESHING.
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
    xSemaphoreGive(protocolMutex);
  }
  delay(20);
}
