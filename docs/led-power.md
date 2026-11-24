# BLE status LED and power

The firmware disables Bluefruit's automatic connection LED driver before `Bluefruit.begin()`. Bluefruit therefore does not blink the blue status LED while advertising or light it while connected. The repin variant configures the onboard LED pin P0.15 (Arduino `LED_BUILTIN`, active high) as an output initially LOW, so it remains off. This changes only the application's software LED behavior; bootloader and hardware charging LEDs are unchanged.

The separate P0.13 HIGH output is the display VCC enable and is unchanged. No GPIO assignment was changed. Reduced LED activity may reduce battery consumption, but the benefit has not been measured. This firmware has not been flashed to a physical board.

The legacy DFU `application_version` is uint32 BCD value `66048` (`0x010200` = 1.2.0); it is derived from, but distinct in encoding from, the application SemVer (`1.2.0`).
