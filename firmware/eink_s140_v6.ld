/* S140 v6 application; animations 0xB0000..0xCC000, pages 0xCC000..0xEC000,
   boot state at 0xEC000. */
SEARCH_DIR(.)
GROUP(-lgcc -lc -lnosys)
MEMORY
{
  FLASH (rx) : ORIGIN = 0x26000, LENGTH = 0xB0000 - 0x26000
  RAM (rwx) : ORIGIN = 0x20006000, LENGTH = 0x20040000 - 0x20006000
}
SECTIONS
{
  . = ALIGN(4);
  .svc_data :
  {
    PROVIDE(__start_svc_data = .);
    KEEP(*(.svc_data))
    PROVIDE(__stop_svc_data = .);
  } > RAM
  .fs_data :
  {
    PROVIDE(__start_fs_data = .);
    KEEP(*(.fs_data))
    PROVIDE(__stop_fs_data = .);
  } > RAM
} INSERT AFTER .data;
INCLUDE "nrf52_common.ld"
