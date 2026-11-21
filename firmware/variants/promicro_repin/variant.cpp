#include "variant.h"
#include "wiring_constants.h"
#include "wiring_digital.h"
// Preserve original Pro Micro Arduino indexes. Port 1 is encoded as 32 + pin.
// 11,12,17 remain unavailable placeholders, never used by the display/SPI.
const uint32_t g_ADigitalPinMap[] = {
  8, 6, 17, 20, 22, 24, 32, 11, 36, 38, 9,
  0xFFFFFFFF, 0xFFFFFFFF, 15, 43, 45, 10, 0xFFFFFFFF,
  47, 2, 29, 31
};
void initVariant()
{
  // SuperMini/nice!nano v2 switched VCC: HIGH = enabled.
  // Preload the latch before output enable to avoid a LOW power-off glitch.
  nrf_gpio_pin_set(13);
  nrf_gpio_cfg_output(13);
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, LOW);
}
