#!/usr/bin/env python3
"""Execute linked core guards/capability callback up to real S140 SVC.
Connection getters are controlled inputs, not an MTU negotiation emulator.
"""
import json
from pathlib import Path
import struct
import sys
from elftools.elf.elffile import ELFFile
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_THUMB, UC_MODE_MCLASS, UC_HOOK_CODE, UC_HOOK_INTR
from unicorn.arm_const import UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_SP, UC_ARM_REG_LR, UC_ARM_REG_PC


def check(path):
    cpu = Uc(UC_ARCH_ARM, UC_MODE_THUMB | UC_MODE_MCLASS)
    cpu.mem_map(0, 0x100000)
    cpu.mem_map(0x20000000, 0x40000)
    with Path(path).open('rb') as stream:
        elf = ELFFile(stream)
        for seg in elf.iter_segments():
            if seg['p_type'] == 'PT_LOAD':
                cpu.mem_write(seg['p_vaddr'], seg.data())
        symbols = {s.name: s['st_value'] for s in elf.get_section_by_name('.symtab').iter_symbols()}
        protocol_size = elf.get_section_by_name('.symtab').get_symbol_by_name('protocol')[0]['st_size']
    connection = {'present': True, 'connected': True, 'mtu': 23}
    getters = {symbols[name] & ~1: name for name in (
        '_ZN17AdafruitBluefruit10ConnectionEt', '_ZN13BLEConnection9connectedEv', '_ZN13BLEConnection6getMtuEv')}
    forbidden = {symbols[name] & ~1 for name in ('pvPortMalloc', '__wrap_malloc', 'malloc', '_Z16authorizeCommandtP17BLECharacteristicP21ble_gatts_evt_write_t')}
    replies = []

    def code(cpu, address, size, _):
        assert address not in forbidden, 'Queued write allocated or reached application parser'
        name = getters.get(address)
        if name:
            value = (0x20028000 if connection['present'] else 0) if 'ConnectionEt' in name else int(connection['connected']) if 'connected' in name else connection['mtu']
            cpu.reg_write(UC_ARM_REG_R0, value)
            cpu.reg_write(UC_ARM_REG_PC, cpu.reg_read(UC_ARM_REG_LR))

    def interrupt(cpu, intno, _):
        pc = cpu.reg_read(UC_ARM_REG_PC)
        svc = bytes(cpu.mem_read(pc - 2, 2))
        assert svc == bytes([176, 223]), (intno, svc.hex())
        raw = bytes(cpu.mem_read(cpu.reg_read(UC_ARM_REG_R1), 16))
        status, update, offset, length, ptr = struct.unpack_from('<HBxHHI', raw, 4)
        replies.append({'type': raw[0], 'status': status, 'update': update & 1, 'offset': offset,
                        'data': bytes(cpu.mem_read(ptr, length)) if length else b''})
        cpu.emu_stop()

    cpu.hook_add(UC_HOOK_CODE, code)
    cpu.hook_add(UC_HOOK_INTR, interrupt)

    def call(name, obj, arg, read=False):
        replies.clear()
        before = bytes(cpu.mem_read(symbols['protocol'], protocol_size))
        cpu.reg_write(UC_ARM_REG_R0, 0 if read else obj)
        cpu.reg_write(UC_ARM_REG_R1, obj if read else arg)
        cpu.reg_write(UC_ARM_REG_R2, arg)
        cpu.reg_write(UC_ARM_REG_SP, 0x2003f000)
        cpu.reg_write(UC_ARM_REG_LR, 0x101)
        cpu.emu_start(symbols[name] | 1, 0x100, count=100000)
        assert len(replies) == 1, replies
        assert bytes(cpu.mem_read(symbols['protocol'], protocol_size)) == before
        return replies[0]

    guards = []
    event = 0x20030000
    for opcode in (4, 5, 6):
        # ble_evt_t header4; conn2; authorize type1+pad1; write starts at8.
        request = struct.pack('<HHBBHHH', 1, 0, 0, 0, opcode | 0x100, 65535, 244) + bytes(244)
        cpu.mem_write(event, struct.pack('<HHHBB', 0x51, 20 + 244, 0, 2, 0) + request)
        entry = '_ZN17BLECharacteristic13_eventHandlerEP9ble_evt_t' if opcode == 4 else '_ZN7BLEGatt13_eventHandlerEP9ble_evt_t'
        reply = call(entry, symbols['command2Characteristic'], event)
        assert reply['type'] == 2 and reply['status'] == 0x103 and reply['update'] == 0
        guards.append(opcode)
    caps_results = []
    for present, connected, mtu, expected in ((True, True, 23, 20), (True, True, 128, 125), (True, True, 247, 244), (True, True, 517, 244), (True, True, 0, 20), (False, False, 247, 20), (True, False, 247, 20), (True, True, 23, 20)):
        connection.update(present=present, connected=connected, mtu=mtu)
        reply = call('_Z13authorizeCapstP17BLECharacteristicP20ble_gatts_evt_read_t', symbols['capsCharacteristic'], event, read=True)
        caps = reply['data']
        assert reply['type'] == 1 and reply['status'] == 0 and reply['update'] == 1
        assert len(caps) == 20 and caps[:8] == b'EBL2\x02\x00\x03\x01'
        assert struct.unpack_from('<HHHHI', caps, 8) == (expected, 4000, 4000, 15000, 0)
        caps_results.append({'present': present, 'connected': connected, 'mtu_input': mtu, 'safeWrite': expected})
    print(json.dumps({'guard_opcodes': guards, 'capabilities': caps_results, 'scope': 'Linked ARM core guard/callback to SVC; no SoftDevice, RF, allocation or display simulation'}, indent=2))


if __name__ == '__main__':
    check(sys.argv[1])
