#pragma once
#include "WVariant.h"
#define VARIANT_MCK 64000000ul
#define USE_LFXO
#define PINS_COUNT 22
#define NUM_DIGITAL_PINS 22
#define NUM_ANALOG_INPUTS 3
#define NUM_ANALOG_OUTPUTS 0
#define PIN_LED1 13
#define LED_BUILTIN PIN_LED1
#define LED_CONN PIN_LED1
// The Adafruit Bluefruit library references LED_BLUE directly; some package
// revisions compile that reference without an #ifdef guard. The board has a
// single blue status LED, so reuse it.
#define LED_BLUE LED_CONN
#define LED_STATE_ON 1
#define PIN_SERIAL1_RX 0
#define PIN_SERIAL1_TX 1
#define SPI_INTERFACES_COUNT 1
// Arduino indexes, resolved through g_ADigitalPinMap by SPIClass.
#define PIN_SPI_MISO 4 // P0.22: unused input; leave physically unconnected
#define PIN_SPI_SCK 9  // P1.06 = GPIO 38, not P0.06
#define PIN_SPI_MOSI 10 // P0.09; NFC disabled through UICR at startup
static const uint8_t SS = 16; // P0.10, display CS
static const uint8_t MISO = PIN_SPI_MISO;
static const uint8_t SCK = PIN_SPI_SCK;
static const uint8_t MOSI = PIN_SPI_MOSI;
#define WIRE_INTERFACES_COUNT 1
#define PIN_WIRE_SDA 2
#define PIN_WIRE_SCL 3
#define PIN_A0 19
#define PIN_A1 20
#define PIN_A2 21
static const uint8_t A0 = PIN_A0;
static const uint8_t A1 = PIN_A1;
static const uint8_t A2 = PIN_A2;
#define ADC_RESOLUTION 14
