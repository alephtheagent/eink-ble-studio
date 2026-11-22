#!/usr/bin/env python3
"""Package application-only UF2; inspect ELF and execute linked GPIO/SPI code.
Requires pyelftools and unicorn. Never accesses a device or upload tool.
"""
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import zipfile
from elftools.elf.elffile import ELFFile
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_THUMB, UC_MODE_MCLASS, UC_HOOK_MEM_WRITE
from unicorn.arm_const import UC_ARM_REG_SP, UC_ARM_REG_LR, UC_ARM_REG_R0, UC_ARM_REG_PC

from welcome_bitmap import verify_elf
ROOT = Path(__file__).resolve().parents[1]
ORIGIN, LIMIT, FAMILY = 0x26000, 0xEC000, 0xADA52840
OUT = Path(os.environ.get('ARTIFACTS_DIR', ROOT / 'artifacts'))
PREFIX = OUT / 'eink-ble-welcome-once-dfu-bw-s140v6'


def arm_smoke(elf, symbols, initial_out, initial_cnf):
    cpu = Uc(UC_ARCH_ARM, UC_MODE_THUMB | UC_MODE_MCLASS)
    for address, size in ((0, 0x100000), (0x20000000, 0x40000),
                          (0x40000000, 0x100000), (0x50000000, 0x10000),
                          (0xE0000000, 0x100000)):
        cpu.mem_map(address, size)
    for segment in elf.iter_segments():
        if segment['p_type'] == 'PT_LOAD':
            cpu.mem_write(segment['p_vaddr'], segment.data())
    power = {'out': initial_out, 'cnf': initial_cnf, 'writes': []}
    cpu.mem_write(0x50000504, struct.pack('<I', initial_out))
    cpu.mem_write(0x50000734, struct.pack('<I', initial_cnf))

    def on_write(cpu, access, address, size, value, data):
        if address == 0x50000504:
            power['out'] = value
        elif address == 0x50000508:
            power['out'] |= value
        elif address == 0x5000050C:
            power['out'] &= ~value
        elif address == 0x50000734:
            power['cnf'] = value
        else:
            return
        power['writes'].append([hex(address), hex(value)])
        assert not (power['cnf'] & 1) or power['out'] & (1 << 13), 'VCC driven LOW'

    cpu.hook_add(UC_HOOK_MEM_WRITE, on_write)

    def call(name):
        cpu.reg_write(UC_ARM_REG_SP, 0x2003F000)
        cpu.reg_write(UC_ARM_REG_LR, 0x101)
        cpu.emu_start(symbols[name] | 1, 0x100, count=100000)
        assert cpu.reg_read(UC_ARM_REG_PC) == 0x100, name

    call('_Z11initVariantv')
    assert power['writes'][:2] == [['0x50000508', '0x2000'], ['0x50000734', '0x3']]
    assert power['cnf'] == 3 and power['out'] & (1 << 13)
    call('_GLOBAL__sub_I__ZN8SPIClassC2EP13NRF_SPIM_Typehhh')
    cpu.reg_write(UC_ARM_REG_R0, symbols['SPI'])
    call('_ZN8SPIClass5beginEv')
    pins = [struct.unpack('<I', cpu.mem_read(0x4002F000 + offset, 4))[0]
            for offset in (0x508, 0x50C, 0x510)]
    assert pins == [38, 9, 22], pins
    assert bytes(cpu.mem_read(0x50000A2C, 4)) == b'\0' * 4, 'SPI touched RES P1.11'
    return {'initial_out': initial_out, 'initial_cnf': initial_cnf,
            'vcc_writes': power['writes'], 'SPIM3_sck_mosi_miso': pins}


def main():
    config = (ROOT / 'firmware/platformio.ini').read_text()
    # Resolve PlatformIO's explicit scratch build directory without embedding a user identity.
    import configparser
    ini = configparser.ConfigParser()
    ini.read_string(config)
    build = Path(ini['platformio']['build_dir']).expanduser() / 'repin_bw'
    if not build.is_absolute():
        build = ROOT / 'firmware' / build
    OUT.mkdir(parents=True, exist_ok=True)
    elf_path = PREFIX.with_suffix('.elf')
    PREFIX.with_suffix('.hex').write_bytes((build / 'firmware.hex').read_bytes())
    objcopy = Path.home() / '.platformio/packages/toolchain-gccarmnoneeabi/bin/arm-none-eabi-objcopy'
    # Keep symbols for verification, omit debug records containing build-machine paths.
    subprocess.run([str(objcopy), '--strip-debug', str(build / 'firmware.elf'), str(elf_path)], check=True)
    subprocess.run([str(objcopy), '-O', 'binary', str(elf_path), str(PREFIX.with_suffix('.bin'))], check=True)
    binary = PREFIX.with_suffix('.bin').read_bytes()
    assert b'/home/' not in binary and b'/home/' not in elf_path.read_bytes(), 'Build paths not sanitized'
    with elf_path.open('rb') as stream:
        elf = ELFFile(stream)
        assert elf.elfclass == 32 and elf.little_endian and elf['e_machine'] == 'EM_ARM'
        assert elf['e_flags'] & 0x400
        welcome = verify_elf(elf)
        segments = [s for s in elf.iter_segments() if s['p_type'] == 'PT_LOAD' and s['p_filesz']]
        addresses = []
        for section in elf.iter_sections():
            if not section['sh_flags'] & 2 or section['sh_type'] == 'SHT_NOBITS' or not section['sh_size']:
                continue
            segment = next(s for s in segments if s.section_in_segment(section))
            address = segment['p_paddr'] + section['sh_addr'] - segment['p_vaddr']
            data = section.data()
            assert ORIGIN <= address < address + len(data) <= LIMIT
            assert binary[address - ORIGIN:address - ORIGIN + len(data)] == data
            addresses.append(address)
        assert min(addresses) == ORIGIN
        build_id_symbol = elf.get_section_by_name('.symtab').get_symbol_by_name('eink_build_id')[0]
        build_id_section = elf.get_section(build_id_symbol['st_shndx'])
        build_id_offset = build_id_symbol['st_value'] - build_id_section['sh_addr']
        embedded_build_id, = struct.unpack_from('<I', build_id_section.data(), build_id_offset)
        symbols = {s.name: s['st_value'] for s in elf.get_section_by_name('.symtab').iter_symbols()}
        pinmap = symbols['g_ADigitalPinMap'] - ORIGIN
        mapping = struct.unpack('<22I', binary[pinmap:pinmap + 88])
        assert [mapping[i] for i in (10, 9, 8, 16, 7, 14, 4)] == [9, 38, 36, 10, 11, 43, 22]
        smoke = [arm_smoke(elf, symbols, out, cnf) for out, cnf in ((0, 0), (8192, 0), (8192, 3), (0, 3))]
    authorize = subprocess.run(
        [sys.executable, str(ROOT / 'tests/authorize_arm.py'), str(elf_path)],
        check=True, capture_output=True, text=True)
    print(authorize.stdout, end='')
    authorize_smoke = [
        json.loads(line) for line in authorize.stdout.splitlines()
        if line.startswith('{"linked_actions":') or line.startswith('{"linked_deferred_action":')
    ]
    assert len(authorize_smoke) == 2, 'Linked ARM action smoke results were not emitted'
    subprocess.run([sys.executable, str(ROOT / 'tests/core_arm.py'), str(elf_path)], check=True)
    sp, reset = struct.unpack('<II', binary[:8])
    image_end = ORIGIN + len(binary)
    assert image_end <= LIMIT, 'application image overlaps reserved state sector'
    assert sp == 0x20040000 and reset & 1 and ORIGIN <= reset - 1 < ORIGIN + len(binary)
    count = (len(binary) + 255) // 256
    blocks = []
    for i in range(count):
        data = binary[i * 256:(i + 1) * 256].ljust(256, b'\0')
        header = struct.pack('<8I', 0x0A324655, 0x9E5D5157, 0x2000, ORIGIN + i * 256, 256, i, count, FAMILY)
        blocks.append(header + data + bytes(220) + struct.pack('<I', 0x0AB16F30))
    uf2 = b''.join(blocks)
    PREFIX.with_suffix('.uf2').write_bytes(uf2)
    # Decode the generated artifact independently; all address/family/sequence fields checked.
    reconstructed = bytearray()
    for i in range(count):
        block = uf2[i * 512:(i + 1) * 512]
        fields = struct.unpack('<8I', block[:32])
        assert fields == (0x0A324655, 0x9E5D5157, 0x2000, ORIGIN + i * 256, 256, i, count, FAMILY)
        assert fields[3] + 256 <= LIMIT
        assert struct.unpack('<I', block[508:])[0] == 0x0AB16F30
        reconstructed.extend(block[32:288])
    assert reconstructed[:len(binary)] == binary and not any(reconstructed[len(binary):])
    archive = PREFIX.with_suffix('.zip')
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as zipped:
        zipped.write(PREFIX.with_suffix('.uf2'), PREFIX.with_suffix('.uf2').name)
    with zipfile.ZipFile(archive) as zipped:
        assert zipped.testzip() is None
        assert zipped.read(PREFIX.with_suffix('.uf2').name) == uf2
    result = {'origin': hex(ORIGIN), 'limit_exclusive': hex(LIMIT), 'family': hex(FAMILY),
              'binary_bytes': len(binary), 'image_end_exclusive': hex(image_end),
              'layout_margin_bytes': LIMIT - image_end,
              'embedded_build_id': hex(embedded_build_id),
              'state_sector': {'address': hex(LIMIT), 'size_bytes': 0x1000, 'excluded_from_application': image_end <= LIMIT},
              'uf2_bytes': len(uf2), 'blocks': count, 'initial_sp': hex(sp), 'reset_vector': hex(reset),
              'arm_smoke': smoke,
              'linked_action_smoke': authorize_smoke,
              'welcome': welcome,
              'authorize_contract': 'PASS: linked ARM v1/v2 callback/receiver and core PREP/EXEC/capabilities to SVC boundary; injected SVC returns verify deferred action success/failure',
              'scope': 'Linked ARM protocol/authorization with injected SVC outcomes, plus GPIO/SPI memory-backed MMIO; not hardware, RF, display timing or electrical verification.',
              'sha256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                         for p in (PREFIX.with_suffix(ext) for ext in ('.elf', '.hex', '.bin', '.uf2', '.zip'))}}
    (OUT / 'verification-welcome-once-dfu.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
