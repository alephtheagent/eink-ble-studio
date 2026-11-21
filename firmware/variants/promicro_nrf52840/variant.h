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
#define LED_STATE_ON 1
#define PIN_SERIAL1_RX 0
#define PIN_SERIAL1_TX 1
#define SPI_INTERFACES_COUNT 1
// Standard Pro Micro SPI footprint, nice!nano v2 physical mapping.
#define PIN_SPI_MISO 14 // pad 14, P1.11: leave physically unconnected
#define PIN_SPI_SCK 15  // pad 15, P1.13
#define PIN_SPI_MOSI 16 // pad 16, P0.10 (NFC disabled by build flag)
static const uint8_t SS = 10;
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
