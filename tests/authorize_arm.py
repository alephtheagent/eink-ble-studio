#!/usr/bin/env python3
"""Execute the linked authorize callback, inspect its real SoftDevice SVC arguments.

This is an ABI/SDK-contract regression, NOT a SoftDevice/RF emulator. Only RTOS
locking, clock and status attribute IO are intercepted. No SVC success is
invented: execution stops at the authorization SVC before SoftDevice would run.
S140 6.1.1 ble_gatts.h: write authorization MUST set update and provide data.
"""
import json
from pathlib import Path
import struct
import sys
import zlib
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
    hooks = {symbols[n] & ~1: n for n in (
        'xQueueSemaphoreTake', 'xQueueGenericSend', 'millis',
        '_ZN17BLECharacteristic5writeEPKvt')}
    disconnect_symbol = '_ZN17AdafruitBluefruit10disconnectEt'
    if disconnect_symbol in symbols:
        hooks[symbols[disconnect_symbol] & ~1] = disconnect_symbol
    published = []
    replies = []
    svc_result = None
    fail_status_write = False
    def code(cpu, address, size, _):
        name = hooks.get(address)
        if not name:
            return
        if 'BLECharacteristic' in name:
            ptr, length = cpu.reg_read(UC_ARM_REG_R1), cpu.reg_read(UC_ARM_REG_R2)
            published.append(bytes(cpu.mem_read(ptr, length)))
            result = 0 if fail_status_write else length
        elif 'Bluefruit' in name:
            result = 0
        else:
            result = 100 if name == 'millis' else 1
        cpu.reg_write(UC_ARM_REG_R0, result)
        cpu.reg_write(UC_ARM_REG_PC, cpu.reg_read(UC_ARM_REG_LR))

    def interrupt(cpu, intno, _):
        pc = cpu.reg_read(UC_ARM_REG_PC)
        svc = bytes(cpu.mem_read(pc - 2, 2))
        assert svc[1] == 0xdf, (intno, hex(pc), svc.hex())
        ptr = cpu.reg_read(UC_ARM_REG_R1)
        raw = bytes(cpu.mem_read(ptr, 16))
        kind = raw[0]
        status, update, offset, length, data = struct.unpack_from('<HBxHHI', raw, 4)
        replies.append({'svc': svc[0], 'type': kind, 'status': status,
                        'update': update & 1, 'offset': offset, 'length': length,
                        'data': bytes(cpu.mem_read(data, length)).hex() if length else ''})
        if svc_result is None:
            cpu.emu_stop()
        else:
            cpu.reg_write(UC_ARM_REG_R0, svc_result)

    cpu.hook_add(UC_HOOK_CODE, code)
    cpu.hook_add(UC_HOOK_INTR, interrupt)
    # Actual ble_gatts_evt_write_t ARM ABI: handle, UUID(4), op, auth, offset, len, data.
    def command(packet, version=1, complete=False, authorize_result=0,
                fail_status=False, expected_att_status=0):
        nonlocal svc_result, fail_status_write
        request = 0x20030000
        published.clear()
        replies.clear()
        svc_result = authorize_result if complete else None
        fail_status_write = fail_status
        cpu.mem_write(request, struct.pack('<HHBBHHH', 1, 0, 0, 0, 0x101, 0, len(packet)) + packet)
        cpu.reg_write(UC_ARM_REG_R0, 0)
        cpu.reg_write(UC_ARM_REG_R1, symbols['command2Characteristic' if version == 2 else 'commandCharacteristic'])
        cpu.reg_write(UC_ARM_REG_R2, request)
        cpu.reg_write(UC_ARM_REG_SP, 0x2003f000)
        cpu.reg_write(UC_ARM_REG_LR, 0x101)
        cpu.emu_start(symbols['_Z16authorizeCommandtP17BLECharacteristicP21ble_gatts_evt_write_t'] | 1, 0x100, count=2000000)
        armed = bool(cpu.mem_read(symbols['actionArmed'], 1)[0])
        if svc_result is None:
            # Stop at the real SVC boundary: action cannot arm before ATT auth returns.
            assert not armed
        assert len(replies) == 1, replies
        reply = replies[0]
        assert reply['type'] == 2 and reply['status'] == expected_att_status, reply
        assert reply['update'] == 1, f'S140 contract violation: WRITE authorize reply.update MUST be 1; actual={reply}'
        assert reply['offset'] == 0 and reply['length'] == len(packet) and reply['data'] == packet.hex(), reply
        assert len(published) >= 2, 'Both application statuses must precede ATT reply'
        result = next(s for s in published if s[0] == version)
        return (result, armed, [s for s in published]) if complete else result

    # Exercise the actual compiled receiver and CRC, not a second protocol model.
    root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(root / 'tools'))
    from welcome_bitmap import approved_frame
    frame, _ = approved_frame()
    start = struct.pack('<BIHI', 1, 7, len(frame), zlib.crc32(frame))
    status = command(start)
    assert status[1:3] == bytes([1, 0]) and struct.unpack_from('<H', status, 8)[0] == 0
    first_reply = replies[0]
    assert command(struct.pack('<BI', 3, 7))[1:3] == bytes([1, 5])
    packets = 0
    for offset in range(0, len(frame), 13):
        payload = frame[offset:offset + 13]
        packet = struct.pack('<BIH', 2, 7, offset) + payload
        status = command(packet)
        assert status[1:3] == bytes([1, 0])
        assert struct.unpack_from('<H', status, 8)[0] == offset + len(payload)
        if offset == 0:
            assert command(packet) == status, 'Exact retry must not advance receiver'
        packets += 1
    status = command(struct.pack('<BI', 3, 7))
    assert status[1:3] == bytes([2, 0]), status.hex()
    assert command(struct.pack('<BI', 3, 7)) == status
    v1_status = status
    # Run the actual compiled streaming decoder at both command-size extremes.
    v2_results = []
    for ceiling, codec in ((20, 0), (125, 0), (244, 0), (20, 1), (125, 1), (244, 1)):
        cpu.mem_write(symbols['protocol'], bytes(protocol_size))
        raw = bytes(4000)
        wire = bytes([129, 0]) * 31 + bytes([225, 0]) if codec else raw
        status = command(struct.pack('<BIBHHI', 0x11, 9, codec, 4000, len(wire), zlib.crc32(raw)), 2)
        assert status[1:4] == bytes([1, 0, codec])
        for offset in range(0, len(wire), ceiling - 7):
            payload = wire[offset:offset + ceiling - 7]
            status = command(struct.pack('<BIH', 0x12, 9, offset) + payload, 2)
            assert status[1:3] == bytes([1, 0])
            assert struct.unpack_from('<H', status, 8)[0] == offset + len(payload)
        status = command(struct.pack('<BI', 0x13, 9), 2)
        assert status[1:3] == bytes([2, 0]), status.hex()
        v2_results.append({'write_ceiling': ceiling, 'codec': codec, 'wire_bytes': len(wire), 'status': status.hex()})
    # Linked production callback acceptance/rejection and status-before-ATT.
    cpu.mem_write(symbols['protocol'], bytes(protocol_size))
    reset_status = command(b'\x06')
    assert reset_status[3] == 1 and reset_status[2] == 0
    cpu.mem_write(symbols['protocol'], bytes(protocol_size))
    dfu_status = command(b'\x05')
    assert dfu_status[3] == 2 and dfu_status[2] == 0
    cpu.mem_write(symbols['protocol'], bytes(protocol_size))
    receiving_status = command(struct.pack('<BIHI', 1, 31, 4000, zlib.crc32(bytes(4000))))
    assert receiving_status[1:3] == bytes([1, 0])
    rejected_dfu_status = command(b'\x05')
    assert rejected_dfu_status[1:3] == bytes([1, 2]) and rejected_dfu_status[3] == 0
    print(json.dumps({'linked_actions': {'reset_status': reset_status.hex(),
                                        'enter_dfu_status': dfu_status.hex(),
                                        'dfu_while_receiving_status': rejected_dfu_status.hex(),
                                        'action_armed_before_svc': False}}))
    # Continue the linked callback past SVC for real success/failure ordering.
    cpu.mem_write(symbols['protocol'], bytes(protocol_size))
    cpu.mem_write(symbols['actionArmed'], b'\0')
    success_status, success_armed, _ = command(b'\x05', complete=True)
    assert success_status[3] == 2 and success_armed, success_status.hex()
    cpu.mem_write(symbols['actionArmed'], b'\0')
    cpu.mem_write(symbols['protocol'], bytes(protocol_size))
    failed_auth_status, failed_auth_armed, failed_auth_published = command(
        b'\x05', complete=True, authorize_result=1)
    assert failed_auth_status[3] == 2 and not failed_auth_armed
    assert failed_auth_published[-1][3] == 0, [s.hex() for s in failed_auth_published]
    cpu.mem_write(symbols['protocol'], bytes(protocol_size))
    cpu.mem_write(symbols['actionArmed'], b'\0')
    failed_publish_status, failed_publish_armed, failed_publish_published = command(
        b'\x05', complete=True, fail_status=True, expected_att_status=0x010e)
    assert failed_publish_status[3] == 2 and not failed_publish_armed
    assert failed_publish_published[-1][3] == 0, [s.hex() for s in failed_publish_published]
    print(json.dumps({'linked_deferred_action': {
        'successful_att_authorization_arms': success_armed,
        'failed_att_authorization_clears': [s[3] for s in failed_auth_published],
        'failed_status_publication_att_error': 0x010e,
        'failed_status_publication_clears': [s[3] for s in failed_publish_published]}}))
    print(json.dumps({'linked_v2': v2_results}))
    print(json.dumps({'elf': str(path), 'START_authorize_SVC': first_reply,
                      'DATA_packets': packets, 'frame_bytes': len(frame),
                      'final_status': v1_status.hex(), 'CRC32': hex(zlib.crc32(frame)),
                      'scope': 'Linked callback/receiver to SVC boundary with injected authorization outcomes; no SoftDevice, RF or hardware execution'}, indent=2))
    print('ARM callback contract + full MTU23 frame + action success/failure sequencing PASS')

if __name__ == '__main__':
    check(sys.argv[1])
