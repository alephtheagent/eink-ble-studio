#include "variant.h"
#include "wiring_constants.h"
#include "wiring_digital.h"
// Classic Pro Micro header numbering; 11,12,17 are unavailable placeholders.
const uint32_t g_ADigitalPinMap[] = {
  8, 6, 17, 20, 22, 24, 32, 11, 36, 38, 9,
  0xFFFFFFFF, 0xFFFFFFFF, 15, 43, 45, 10, 0xFFFFFFFF,
  47, 2, 29, 31
};
void initVariant()
{
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, LOW);
  // nice!nano switched 3.3V rail: LOW = enabled. Do not use RAW/B+.
  nrf_gpio_cfg_output(13);
  nrf_gpio_pin_clear(13);
}
