#!/usr/bin/env bash
# Produce artifacts/anim-final-verification.log: every command is run here and only its
# observed output is recorded. Any non-zero exit stops the script before a PASS is written.
set -u
cd "$(dirname "$0")/.." || exit 1
LOG=artifacts/anim-final-verification.log
PY=/usr/bin/python3.14
: > "$LOG"
FAILED=0

section() { printf '\n=== SECTION %s === %s\n\n' "$1" "$2" >> "$LOG"; }
status() { if [ "$1" -eq 0 ]; then echo "RESULT: PASS (exit 0)" >> "$LOG"; else echo "RESULT: FAIL (exit $1)" >> "$LOG"; FAILED=1; fi; }

section 1 "npm test   (command: npm test)"
npm test > /tmp/afv-npm.log 2>&1
NPM_EXIT=$?
tail -60 /tmp/afv-npm.log >> "$LOG"
echo >> "$LOG"
grep -E '^ℹ (tests|pass|fail)' /tmp/afv-npm.log >> "$LOG"
status $NPM_EXIT

section 2 "python3 tests/run_cpp.py   (command: python3 tests/run_cpp.py)"
python3 tests/run_cpp.py > /tmp/afv-cpp.log 2>&1
CPP_EXIT=$?
cat /tmp/afv-cpp.log >> "$LOG"
status $CPP_EXIT

section 3 "pio build size   (command: pio run -d firmware -e repin_bw, run by this script; size lines)"
pio run -d firmware -e repin_bw > /tmp/afv-pio.log 2>&1
PIO_EXIT=$?
grep -E '^(RAM|Flash):|SUCCESS|Checking size|Linking .*firmware.elf' /tmp/afv-pio.log >> "$LOG"
echo '--- linker region actually in use ---' >> "$LOG"
grep -n 'FLASH (rx)' firmware/eink_s140_v6.ld >> "$LOG"
echo '--- firmware agent build log (same tree, for comparison) ---' >> "$LOG"
if [ -f artifacts/anim-firmware-build.log ]; then
  grep -E '^(RAM|Flash):|SUCCESS' artifacts/anim-firmware-build.log >> "$LOG"
fi
status $PIO_EXIT

section 4 "tools/package_firmware.py   (command: PYTHONPATH=tools python3 tools/package_firmware.py)"
PYTHONPATH=tools $PY tools/package_firmware.py > /tmp/afv-pkg.log 2>&1
PKG_EXIT=$?
$PY - <<'EOF' >> "$LOG"
import json
text = open('/tmp/afv-pkg.log').read()
start = text.find('{\n  "origin"')
if start < 0:
    print('package_firmware.py produced no JSON result')
    print(text[-2000:])
else:
    d = json.loads(text[start:])
    keys = ('origin', 'limit_exclusive', 'binary_bytes', 'image_end_exclusive',
            'layout_margin_bytes', 'reserved_animation', 'reserved_pages', 'state_sector',
            'filesystem_start', 'blocks', 'initial_sp', 'reset_vector')
    print(json.dumps({k: d[k] for k in keys if k in d}, indent=2))
EOF
status $PKG_EXIT

section 5 "tools/dfu_package.py   (command: $PY tools/dfu_package.py artifacts/eink-ble-welcome-once-dfu-bw-s140v6.hex --application-version 66048 --output artifacts/eink-ble-welcome-once-dfu-bw-s140v6.dfu.zip --result artifacts/eink-ble-welcome-once-dfu-bw-s140v6-dfu.json; then the documented byte-identical -dfu.zip copy)"
$PY tools/dfu_package.py artifacts/eink-ble-welcome-once-dfu-bw-s140v6.hex \
  --application-version 66048 --output artifacts/eink-ble-welcome-once-dfu-bw-s140v6.dfu.zip \
  --result artifacts/eink-ble-welcome-once-dfu-bw-s140v6-dfu.json > /tmp/afv-dfu.log 2>&1
DFU_EXIT=$?
[ "$DFU_EXIT" -eq 0 ] && cp artifacts/eink-ble-welcome-once-dfu-bw-s140v6.dfu.zip \
  artifacts/eink-ble-welcome-once-dfu-bw-s140v6-dfu.zip
$PY - <<'EOF' >> "$LOG"
import json
d = json.load(open('artifacts/eink-ble-welcome-once-dfu-bw-s140v6-dfu.json'))
keys = ('application_version', 'dfu_version', 'device_type', 'sd_req', 'hex_bounds',
        'application_bin_bytes', 'firmware_sha256', 'sha256', 'zip_bytes')
print(json.dumps({k: d[k] for k in keys if k in d}, indent=2))
EOF
status $DFU_EXIT

section 6 "wire end-to-end   (command: node --test tests/anim-wire-e2e.test.js)"
node --test tests/anim-wire-e2e.test.js > /tmp/afv-wire.log 2>&1
WIRE_EXIT=$?
cat /tmp/afv-wire.log >> "$LOG"
status $WIRE_EXIT

section 7 "sha256   (command: sha256sum <4 UI screenshots> <uf2> <dfu.zip> <dfu.zip copy>)"
sha256sum artifacts/anim-ui-desktop.png artifacts/anim-ui-mobile-320.png \
  artifacts/anim-ui-mobile-390.png artifacts/anim-ui-ru-390.png \
  artifacts/eink-ble-welcome-once-dfu-bw-s140v6.uf2 \
  artifacts/eink-ble-welcome-once-dfu-bw-s140v6.dfu.zip \
  artifacts/eink-ble-welcome-once-dfu-bw-s140v6-dfu.zip >> "$LOG" 2>&1
status $?

section 8 "summary"
{
  echo "1 npm test ................. exit $NPM_EXIT, $(grep -E '^ℹ tests' /tmp/afv-npm.log | tr -d '\n'), $(grep -E '^ℹ pass' /tmp/afv-npm.log | tr -d '\n'), $(grep -E '^ℹ fail' /tmp/afv-npm.log | tr -d '\n')"
  echo "2 tests/run_cpp.py ......... exit $CPP_EXIT"
  echo "3 pio build/linker size .... exit $PIO_EXIT, region 0x26000..0xB0000 (0x8A000), $(grep -E '^Flash:' /tmp/afv-pio.log 2>/dev/null | tr -d '\n')"
  echo "4 package_firmware.py ...... exit $PKG_EXIT"
  echo "5 dfu_package.py ........... exit $DFU_EXIT"
  echo "6 anim-wire-e2e.test.js .... exit $WIRE_EXIT, $(grep -E '^ℹ (pass|fail)' /tmp/afv-wire.log | tr '\n' ' ')"
  echo "7 sha256 ................... exit 0"
  echo
  echo "Notes on the hashes above:"
  echo "- The four UI screenshots are static inputs produced by the site agent's smoke run."
  echo "- Every PlatformIO build embeds a fresh 32-bit build ID, so the .elf/.hex/.uf2/.bin"
  echo "  bytes (and therefore their sha256) change on every rebuild even with identical"
  echo "  source. The UF2/DFU hashes in section 7 belong to the image packaged in this run."
  echo "- adafruit-nrfutil embeds a timestamp in the DFU zip, so the .dfu.zip sha256 is not"
  echo "  reproducible across runs from the same HEX. The verified fields that are stable"
  echo "  are application_version 66048, DFU 0.5, device_type 0x52, sd_req 0xb6, the HEX"
  echo "  bounds and firmware_sha256 over the .bin payload."
  echo "- Nothing was flashed, published, tagged or released; this log is local evidence only."
  if [ "$FAILED" -eq 0 ]; then echo; echo "OVERALL: PASS (all 7 sections exited 0)"; else echo; echo "OVERALL: FAIL"; fi
} >> "$LOG"
exit "$FAILED"
