#!/usr/bin/env python3
"""Generate a C++ vector header from the same JSON used by JavaScript tests."""
import json
import os
from pathlib import Path
import subprocess
ROOT = Path(__file__).resolve().parents[1]
SCRATCH = Path.home() / '.hermes/cache/scratch/eink-studio-host-tests'
SCRATCH.mkdir(parents=True, exist_ok=True)
vectors = json.loads((ROOT / 'tests/vectors.json').read_text())
lines = ['#include <stdint.h>', '#include <stddef.h>']
def array(name, data):
    lines.append('static const uint8_t '+name+'[] = {'+(','.join(str(x) for x in data) if data else '0')+'};')
for i, v in enumerate(vectors['crc']):
    array('crc_'+str(i), bytes.fromhex(v['hex']))
lines.append('struct CrcVector {const uint8_t* bytes; size_t size; uint32_t expected;};')
lines.append('static const CrcVector CRC_VECTORS[] = {'+','.join('{crc_%d,%d,%du}'%(i,len(bytes.fromhex(v['hex'])),v['value']) for i,v in enumerate(vectors['crc']))+'};')
for i,v in enumerate(vectors['packing']):
    array('gray_'+str(i),v['gray']);array('packed_'+str(i),bytes.fromhex(v['packedHex']))
lines.append('struct PixelVector {unsigned width,height; const uint8_t* gray; const uint8_t* packed; size_t packedSize; uint32_t crc;};')
lines.append('static const PixelVector PIXEL_VECTORS[] = {'+','.join('{%d,%d,gray_%d,packed_%d,%d,%du}'%(v['width'],v['height'],i,i,len(bytes.fromhex(v['packedHex'])),v['crc32']) for i,v in enumerate(vectors['packing']))+'};')
array('APPROVED',(ROOT/'tests'/vectors['approved']['file']).read_bytes())
lines.append('static const uint32_t APPROVED_CRC = %du;'%vectors['approved']['crc32'])
(SCRATCH/'vectors.h').write_text('\n'.join(lines)+'\n')
command = ['g++','-std=c++11','-Wall','-Wextra','-Werror','-Wno-misleading-indentation','-fsanitize=address,undefined','-fno-omit-frame-pointer','-g','-I'+str(ROOT/'firmware/include'),'-I'+str(SCRATCH),str(ROOT/'tests/protocol.cpp'),'-o',str(SCRATCH/'protocol-tests')]
subprocess.run(command,check=True)
subprocess.run([str(SCRATCH/'protocol-tests')],check=True,env={**os.environ,'ASAN_OPTIONS':'detect_leaks=0'})
boot_state = ['g++','-std=c++11','-Wall','-Wextra','-Werror','-fsanitize=address,undefined','-fno-omit-frame-pointer','-g','-I'+str(ROOT/'firmware/include'),str(ROOT/'tests/boot_state.cpp'),'-o',str(SCRATCH/'boot-state-tests')]
subprocess.run(boot_state,check=True)
subprocess.run([str(SCRATCH/'boot-state-tests')],check=True,env={**os.environ,'ASAN_OPTIONS':'detect_leaks=0'})
pages = ['g++','-std=c++11','-Wall','-Wextra','-Werror','-Wno-misleading-indentation','-fsanitize=address,undefined','-fno-omit-frame-pointer','-no-pie','-g','-I'+str(ROOT/'firmware/include'),str(ROOT/'tests/page_storage.cpp'),'-o',str(SCRATCH/'page-storage-tests')]
subprocess.run(pages,check=True)
subprocess.run([str(SCRATCH/'page-storage-tests')],check=True,env={**os.environ,'ASAN_OPTIONS':'detect_leaks=0'})
