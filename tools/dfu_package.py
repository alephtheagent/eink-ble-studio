#!/usr/bin/env python3
"""Create and independently verify an application-only Nordic DFU package."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
NRFUTIL = os.environ.get('NRFUTIL') or shutil.which('nrfutil') or Path.home() / '.local/bin/nrfutil'
NRF_SITE = Path.home() / '.platformio/packages/tool-adafruit-nrfutil/site-packages'
ORIGIN, LIMIT, DEVICE_TYPE, SD_REQ = 0x26000, 0xCC000, 0x0052, 0x00B6


def fail(message):
    raise RuntimeError(message)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('hex', type=Path)
    parser.add_argument('--application-version', type=int, default=1)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--result', type=Path, default=ROOT / 'artifacts/eink-ble-welcome-once-dfu-bw-s140v6-dfu.json')
    args = parser.parse_args()
    hex_path = args.hex.resolve()
    output = (args.output or hex_path.with_suffix('.dfu.zip')).resolve()
    if not 0 <= args.application_version <= 0xFFFFFFFF:
        fail('application-version must fit uint32')
    if NRF_SITE.is_dir():
        sys.path.insert(0, str(NRF_SITE))
    from nordicsemi.dfu.intelhex import IntelHex
    ih = IntelHex(str(hex_path))
    if not ih.addresses():
        fail('application hex contains no data')
    low, high = min(ih.addresses()), max(ih.addresses()) + 1
    if low != ORIGIN or high > LIMIT:
        fail(f'hex bounds invalid: min={low:#x} max-exclusive={high:#x}, required origin {ORIGIN:#x} and max <= {LIMIT:#x}')
    hex_binary = ih.tobinarray(start=low, end=high - 1).tobytes()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.unlink(missing_ok=True)
    cmd = [str(NRFUTIL), 'dfu', 'genpkg', '--dfu-ver', '0.5', '--dev-type', hex(DEVICE_TYPE),
           '--sd-req', hex(SD_REQ), '--application-version', str(args.application_version),
           '--application', str(hex_path)]
    cmd.append(str(output))
    subprocess.run(cmd, check=True)
    with zipfile.ZipFile(output) as zf:
        if zf.testzip() is not None:
            fail('ZIP CRC failure')
        names = zf.namelist()
        if len(names) != 3 or 'manifest.json' not in names:
            fail(f'Unexpected zip members (expected manifest, one init packet, one application bin): {names}')
        from nordicsemi.dfu.manifest import Manifest
        parsed_manifest = Manifest.from_json(zf.read('manifest.json').decode('utf-8'))
        if parsed_manifest.application is None:
            fail('Nordic manifest parser found no application firmware')
        manifest = json.loads(zf.read('manifest.json'))
        m = manifest.get('manifest', {})
        if m.get('dfu_version') != 0.5:
            fail(f"manifest DFU version {m.get('dfu_version')!r} != legacy 0.5")
        app = m.get('application')
        if not app:
            fail('manifest lacks application')
        bin_name, dat_name = app.get('bin_file'), app.get('dat_file')
        if not bin_name or not dat_name or bin_name not in names or dat_name not in names:
            fail('application bin or init packet missing')
        if (not bin_name.endswith('.bin') or not dat_name.endswith('.dat')
                or len([n for n in names if n.endswith('.bin')]) != 1
                or set(names) != {'manifest.json', bin_name, dat_name}):
            fail(f'Unexpected ZIP contents: {names}')
        metadata = app.get('init_packet_data', {})
        expected = {'application_version': args.application_version, 'device_type': DEVICE_TYPE,
                    'device_revision': 0xFFFF, 'softdevice_req': [SD_REQ]}
        for k, v in expected.items():
            if metadata.get(k) != v:
                fail(f'manifest {k}: {metadata.get(k)!r} != {v!r}')
        binary, dat = zf.read(bin_name), zf.read(dat_name)
        if binary != hex_binary:
            fail('generated application BIN differs byte-for-byte from input Intel HEX span')
        expected_length = high - low
        if len(binary) != expected_length:
            fail(f'BIN length {len(binary)} != Intel HEX payload span {expected_length}')
        # Parse Nordic's version-0.5 init-packet fields using the package's own field model.
        from nordicsemi.dfu.init_packet import PacketField
        from nordicsemi.dfu.crc16 import calc_crc16
        fields = {}
        pos = 0
        for field, fmt in ((PacketField.DEVICE_TYPE, '<H'), (PacketField.DEVICE_REVISION, '<H'),
                           (PacketField.APP_VERSION, '<I')):
            size = struct.calcsize(fmt)
            if pos + size > len(dat): fail('truncated init packet')
            fields[field] = struct.unpack_from(fmt, dat, pos)[0]
            pos += size
        n = struct.unpack_from('<H', dat, pos)[0]; pos += 2
        if pos + 2 * n > len(dat): fail('truncated SoftDevice requirement list')
        fields[PacketField.REQUIRED_SOFTDEVICES_ARRAY] = list(struct.unpack_from('<' + 'H' * n, dat, pos)); pos += 2 * n
        if pos + 2 != len(dat):
            fail(f'legacy DFU 0.5 init packet must end with CRC16, got {len(dat) - pos} trailing bytes')
        fields[PacketField.NORDIC_PROPRIETARY_OPT_DATA_FIRMWARE_CRC16] = struct.unpack_from('<H', dat, pos)[0]
        if fields[PacketField.DEVICE_TYPE] != DEVICE_TYPE:
            fail('init packet device type mismatch')
        if fields[PacketField.DEVICE_REVISION] != 0xFFFF:
            fail('init packet device revision mismatch')
        if fields[PacketField.APP_VERSION] != args.application_version:
            fail('init packet application version mismatch')
        if fields[PacketField.REQUIRED_SOFTDEVICES_ARRAY] != [SD_REQ]:
            fail('init packet SoftDevice requirement mismatch')
        firmware_crc = calc_crc16(binary)
        if metadata.get('firmware_crc16') != firmware_crc:
            fail('manifest firmware CRC16 does not match application BIN')
        if fields[PacketField.NORDIC_PROPRIETARY_OPT_DATA_FIRMWARE_CRC16] != firmware_crc:
            fail('init packet firmware CRC16 does not match application BIN')
        if 'private' in json.dumps(manifest).lower() or any(b'-----BEGIN PRIVATE KEY-----' in zf.read(n) for n in names):
            fail('private key material detected in package')
        files = {n: {'bytes': len(zf.read(n)), 'sha256': hashlib.sha256(zf.read(n)).hexdigest()} for n in names}
        # Legacy DFU 0.5 carries no cryptographic signature or firmware hash.
    result = {'package': str(output), 'sha256': hashlib.sha256(output.read_bytes()).hexdigest(),
              'application_version': args.application_version, 'dfu_version': 0.5,
              'device_type': hex(DEVICE_TYPE),
              'sd_req': [hex(SD_REQ)], 'hex_bounds': {'min': hex(low), 'max_exclusive': hex(high)},
              'application_bin_bytes': len(binary), 'firmware_sha256': hashlib.sha256(binary).hexdigest(),
              'preservation': 'HEX/DFU payload excludes pages, welcome and filesystem; bootloader erase behavior is not verified. Back up pages before updates.',
              'signature': 'none: DFU 0.5 legacy init packet (CRC16 metadata only)',
              'files': files, 'zip_bytes': output.stat().st_size}
    args.result.parent.mkdir(parents=True, exist_ok=True)
    args.result.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'dfu_package: {exc}', file=sys.stderr)
        raise
