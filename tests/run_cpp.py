#!/usr/bin/env python3
"""Generate C++ vector headers from the same JSON the JavaScript tests read, then
compile and run every host C++ test with sanitizers.

To add a test, append one compile_and_run(...) call in main(); every target gets
the same flags, sanitizers and include path.
"""
import fcntl
import json
import os
from pathlib import Path
import subprocess

from anim_vectors import write_header as write_anim_firmware_vectors

ROOT = Path(__file__).resolve().parents[1]
SCRATCH = Path.home() / '.hermes/cache/scratch/eink-studio-host-tests'
SCRATCH.mkdir(parents=True, exist_ok=True)

CXXFLAGS = ['-std=c++11', '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined',
            '-fno-omit-frame-pointer', '-g']
# No-pie keeps static frame buffers in range for the linked-address tests.
NOPIE = ['-no-pie']
# Misleading-indentation is silenced only for the headers that predate this build.
LEGACY = ['-Wno-misleading-indentation']


def array(name, data):
    return 'static const uint8_t ' + name + '[] = {' + (','.join(str(x) for x in data) if data else '0') + '};'


def write_vectors_header():
    """tests/vectors.json -> vectors.h (CRC, pixel packing, approved frame)."""
    vectors = json.loads((ROOT / 'tests/vectors.json').read_text())
    lines = ['#include <stdint.h>', '#include <stddef.h>']
    for i, v in enumerate(vectors['crc']):
        lines.append(array('crc_' + str(i), bytes.fromhex(v['hex'])))
    lines.append('struct CrcVector {const uint8_t* bytes; size_t size; uint32_t expected;};')
    lines.append('static const CrcVector CRC_VECTORS[] = {' + ','.join(
        '{crc_%d,%d,%du}' % (i, len(bytes.fromhex(v['hex'])), v['value'])
        for i, v in enumerate(vectors['crc'])) + '};')
    for i, v in enumerate(vectors['packing']):
        lines.append(array('gray_' + str(i), v['gray']))
        lines.append(array('packed_' + str(i), bytes.fromhex(v['packedHex'])))
    lines.append('struct PixelVector {unsigned width,height; const uint8_t* gray; const uint8_t* packed; size_t packedSize; uint32_t crc;};')
    lines.append('static const PixelVector PIXEL_VECTORS[] = {' + ','.join(
        '{%d,%d,gray_%d,packed_%d,%d,%du}' % (v['width'], v['height'], i, i,
                                              len(bytes.fromhex(v['packedHex'])), v['crc32'])
        for i, v in enumerate(vectors['packing'])) + '};')
    lines.append(array('APPROVED', (ROOT / 'tests' / vectors['approved']['file']).read_bytes()))
    lines.append('static const uint32_t APPROVED_CRC = %du;' % vectors['approved']['crc32'])
    (SCRATCH / 'vectors.h').write_text('\n'.join(lines) + '\n')


def write_anim_vectors_header():
    """tests/vectors-animation.json -> anim_vectors.h.

    Mirrors the schema documented in docs/protocol-animation.md: crc, frames,
    blobs, animations, packbits, packbitsDecode, rejects.
    """
    vectors = json.loads((ROOT / 'tests/vectors-animation.json').read_text())
    lines = ['#ifndef ANIM_VECTORS_H', '#define ANIM_VECTORS_H',
             '#include <stdint.h>', '#include <stddef.h>']
    for i, v in enumerate(vectors['crc']):
        lines.append(array('anim_crc_%d' % i, bytes.fromhex(v['hex'])))
    lines.append('struct AnimCrcVector {const char* name; const uint8_t* bytes; size_t size; uint32_t value;};')
    lines.append('static const AnimCrcVector ANIM_CRC[] = {' + ','.join(
        '{"%s",anim_crc_%d,%d,%du}' % (v.get('name', 'crc-%d' % i), i,
                                       len(bytes.fromhex(v['hex'])), v['value'])
        for i, v in enumerate(vectors['crc'])) + '};')
    lines.append('static const size_t ANIM_CRC_COUNT = sizeof(ANIM_CRC)/sizeof(ANIM_CRC[0]);')

    for i, v in enumerate(vectors['frames']):
        lines.append(array('anim_frame_%d' % i, bytes.fromhex(v['hex'])))
    lines.append('struct AnimFrameVector {const char* name; const uint8_t* bytes; size_t size; uint32_t crc;};')
    lines.append('static const AnimFrameVector ANIM_FRAMES[] = {' + ','.join(
        '{"%s",anim_frame_%d,%d,%du}' % (v['name'], i, len(bytes.fromhex(v['hex'])), v['crc'])
        for i, v in enumerate(vectors['frames'])) + '};')
    lines.append('static const size_t ANIM_FRAME_COUNT = sizeof(ANIM_FRAMES)/sizeof(ANIM_FRAMES[0]);')

    for i, v in enumerate(vectors['blobs']):
        lines.append(array('anim_blob_%d' % i, bytes.fromhex(v['blobHex'])))
    lines.append('struct AnimBlobVector {const char* name; int prev; int frame; uint8_t kind; uint16_t encLen; uint32_t crc; const uint8_t* blob; size_t blobSize;};')
    lines.append('static const AnimBlobVector ANIM_BLOBS[] = {' + ','.join(
        '{"%s",%s,%d,%d,%d,%du,anim_blob_%d,%d}' % (
            v['name'], '-1' if v['prev'] is None else str(v['prev']), v['frame'], v['kind'],
            v['encLen'], v['crc'], i, len(bytes.fromhex(v['blobHex'])))
        for i, v in enumerate(vectors['blobs'])) + '};')
    lines.append('static const size_t ANIM_BLOB_COUNT = sizeof(ANIM_BLOBS)/sizeof(ANIM_BLOBS[0]);')

    for i, v in enumerate(vectors['animations']):
        lines.append('static const uint16_t anim_anim_frames_%d[] = {%s};' % (
            i, ','.join(str(x) for x in v['frames']) or '0'))
    lines.append('struct AnimAnimationVector {const char* name; const uint16_t* frames; unsigned count; uint32_t crc;};')
    lines.append('static const AnimAnimationVector ANIM_ANIMATIONS[] = {' + ','.join(
        '{"%s",anim_anim_frames_%d,%d,%du}' % (v['name'], i, len(v['frames']), v['crc'])
        for i, v in enumerate(vectors['animations'])) + '};')
    lines.append('static const size_t ANIM_ANIMATION_COUNT = sizeof(ANIM_ANIMATIONS)/sizeof(ANIM_ANIMATIONS[0]);')

    for i, v in enumerate(vectors['packbits']):
        lines.append(array('anim_raw_%d' % i, bytes.fromhex(v['rawHex'])))
        lines.append(array('anim_packed_%d' % i, bytes.fromhex(v['encodedHex'])))
    lines.append('struct AnimPackBitsVector {const char* name; const uint8_t* raw; size_t rawSize; const uint8_t* encoded; size_t encodedSize;};')
    lines.append('static const AnimPackBitsVector ANIM_PACKBITS[] = {' + ','.join(
        '{"%s",anim_raw_%d,%d,anim_packed_%d,%d}' % (
            v['name'], i, len(bytes.fromhex(v['rawHex'])), i, len(bytes.fromhex(v['encodedHex'])))
        for i, v in enumerate(vectors['packbits'])) + '};')
    lines.append('static const size_t ANIM_PACKBITS_COUNT = sizeof(ANIM_PACKBITS)/sizeof(ANIM_PACKBITS[0]);')

    for i, v in enumerate(vectors['packbitsFrames']):
        lines.append(array('anim_pf_delta_%d' % i, bytes.fromhex(v['deltaHex'])))
        lines.append(array('anim_pf_enc_%d' % i, bytes.fromhex(v['encodedHex'])))
    lines.append('struct AnimPackBitsFrameVector {const char* name; const uint8_t* delta; const uint8_t* encoded; size_t encodedSize;};')
    lines.append('static const AnimPackBitsFrameVector ANIM_PACKBITS_FRAMES[] = {' + ','.join(
        '{"%s",anim_pf_delta_%d,anim_pf_enc_%d,%d}' % (
            v['name'], i, i, len(bytes.fromhex(v['encodedHex'])))
        for i, v in enumerate(vectors['packbitsFrames'])) + '};')
    lines.append('static const size_t ANIM_PACKBITS_FRAME_COUNT = sizeof(ANIM_PACKBITS_FRAMES)/sizeof(ANIM_PACKBITS_FRAMES[0]);')

    for i, v in enumerate(vectors['packbitsDecode']):
        lines.append(array('anim_dec_enc_%d' % i, bytes.fromhex(v['encodedHex'])))
        lines.append(array('anim_dec_raw_%d' % i, bytes.fromhex(v['rawHex'])))
    lines.append('struct AnimPackBitsDecodeVector {const char* name; const uint8_t* encoded; size_t encodedSize; const uint8_t* raw; size_t rawSize;};')
    lines.append('static const AnimPackBitsDecodeVector ANIM_PACKBITS_DECODE[] = {' + ','.join(
        '{"%s",anim_dec_enc_%d,%d,anim_dec_raw_%d,%d}' % (
            v['name'], i, len(bytes.fromhex(v['encodedHex'])), i, len(bytes.fromhex(v['rawHex'])))
        for i, v in enumerate(vectors['packbitsDecode'])) + '};')
    lines.append('static const size_t ANIM_PACKBITS_DECODE_COUNT = sizeof(ANIM_PACKBITS_DECODE)/sizeof(ANIM_PACKBITS_DECODE[0]);')

    for i, v in enumerate(vectors['rejects']):
        lines.append(array('anim_reject_%d' % i, bytes.fromhex(v['blobHex'])))
    lines.append('// stage: 0 = parseBlobHeader must fail, 1 = header parses and decodeBlob fails.')
    lines.append('struct AnimRejectVector {const char* name; int prev; uint8_t stage; uint8_t error; const uint8_t* blob; size_t blobSize;};')
    lines.append('static const AnimRejectVector ANIM_REJECTS[] = {' + ','.join(
        '{"%s",%s,%d,%d,anim_reject_%d,%d}' % (
            v['name'], '-1' if v['prev'] is None else str(v['prev']),
            0 if v['stage'] == 'header' else 1, v['error'], i, len(bytes.fromhex(v['blobHex'])))
        for i, v in enumerate(vectors['rejects'])) + '};')
    lines.append('static const size_t ANIM_REJECT_COUNT = sizeof(ANIM_REJECTS)/sizeof(ANIM_REJECTS[0]);')
    lines.append('#endif')
    (SCRATCH / 'anim_vectors.h').write_text('\n'.join(lines) + '\n')


def compile_and_run(name, source, include_dirs, extra=None):
    executable = SCRATCH / (name + '-tests')
    command = ['g++'] + CXXFLAGS + (extra or []) + ['-I' + str(d) for d in include_dirs] + \
              [str(ROOT / source), '-o', str(executable)]
    subprocess.run(command, check=True)
    subprocess.run([str(executable)], check=True, env={**os.environ, 'ASAN_OPTIONS': 'detect_leaks=0'})


def main():
    # Serialize concurrent runs (npm test and a direct invocation share SCRATCH, and
    # relinking an executable that is still running fails with ETXTBSY).
    lock = (SCRATCH / 'run.lock').open('w')
    fcntl.flock(lock, fcntl.LOCK_EX)
    write_vectors_header()
    write_anim_vectors_header()
    # tests/anim_firmware.cpp includes vectors_animation.h; the same writer serves
    # tests/run_anim_cpp.py, so the two runners can never disagree.
    write_anim_firmware_vectors(SCRATCH / 'vectors_animation.h')
    include = [ROOT / 'firmware/include', SCRATCH]
    # Target list: (name, source, include dirs, extra flags). Add a block here to add a test.
    compile_and_run('protocol', 'tests/protocol.cpp', include, LEGACY)
    compile_and_run('boot-state', 'tests/boot_state.cpp', [ROOT / 'firmware/include'])
    compile_and_run('page-storage', 'tests/page_storage.cpp', [ROOT / 'firmware/include'], LEGACY + NOPIE)
    compile_and_run('anim-codec', 'tests/anim_codec.cpp', include)
    compile_and_run('anim-firmware', 'tests/anim_firmware.cpp', include)
    lock.close()


if __name__ == '__main__':
    main()
