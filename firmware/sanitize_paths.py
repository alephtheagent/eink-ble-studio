"""Keep useful assertion basenames without embedding build-machine account paths.
The pinned GCC 7 toolchain predates -ffile-prefix-map. This changes diagnostic
strings only; assertions, source code and the hardware profile stay unchanged.
"""
import os
from pathlib import Path
import secrets

Import('env')
# Embed the invocation ID in compiler command signatures. A generated header
# in the build directory is insufficient: SCons can miss its dependency on
# incremental builds, leaving the prior ID in the firmware.
env.Append(CPPDEFINES=[('EINK_BUILD_ID', '0x%08Xu' % secrets.randbits(32))])
# The custom linker script includes the unchanged core common section layout.
env.AppendUnique(LIBPATH=[str(Path(env.PioPlatform().get_package_dir('framework-arduinoadafruitnrf52')) / 'cores/nRF5/linker')])


core_source = Path(env.PioPlatform().get_package_dir('framework-arduinoadafruitnrf52')) / 'libraries/Bluefruit52Lib/src/BLECharacteristic.cpp'
source = core_source.read_text()
anchor = '''        switch(wr_req->op)
        {'''
guard = '''        // Project policy: never allow queued writes to reach Bluefruit's
        // long-write allocator or bypass the application authorizer.
        if (wr_req->op != BLE_GATTS_OP_WRITE_REQ)
        {
          ble_gatts_rw_authorize_reply_params_t reply = {};
          reply.type = BLE_GATTS_AUTHORIZE_TYPE_WRITE;
          reply.params.write.gatt_status = BLE_GATT_STATUS_ATTERR_WRITE_NOT_PERMITTED;
          sd_ble_gatts_rw_authorize_reply(conn_hdl, &reply);
          break;
        }

'''
if source.count(anchor) != 1:
    raise RuntimeError('Pinned Bluefruit write handler changed; refusing unpatched build')
patched = Path(env.subst('$BUILD_DIR')) / 'project-core/BLECharacteristic.cpp'
patched.parent.mkdir(parents=True, exist_ok=True)
patched.write_text(source.replace(anchor, guard + anchor))

# EXEC has no attribute handle. Bluefruit otherwise broadcasts EXEC NOW to
# every characteristic and does not route CANCEL at all.
gatt_source = core_source.parent / 'BLEGatt.cpp'
gatt = gatt_source.read_text()
gatt_anchor = '  /*------------- Server Characteristics -------------*/'
gatt_guard = '''  if (evt_id == BLE_GATTS_EVT_RW_AUTHORIZE_REQUEST &&
      evt->evt.gatts_evt.params.authorize_request.type == BLE_GATTS_AUTHORIZE_TYPE_WRITE)
  {
    uint8_t op = evt->evt.gatts_evt.params.authorize_request.request.write.op;
    if (op == BLE_GATTS_OP_EXEC_WRITE_REQ_NOW || op == BLE_GATTS_OP_EXEC_WRITE_REQ_CANCEL)
    {
      ble_gatts_rw_authorize_reply_params_t reply = {};
      reply.type = BLE_GATTS_AUTHORIZE_TYPE_WRITE;
      reply.params.write.gatt_status = BLE_GATT_STATUS_ATTERR_WRITE_NOT_PERMITTED;
      sd_ble_gatts_rw_authorize_reply(evt_conn_hdl, &reply);
      return;
    }
  }

'''
if gatt.count(gatt_anchor) != 1:
    raise RuntimeError('Pinned Bluefruit dispatcher changed; refusing unpatched build')
patched_gatt = patched.parent / 'BLEGatt.cpp'
patched_gatt.write_text(gatt.replace(gatt_anchor, gatt_guard + gatt_anchor))


def portable_filename(env, node):
    if not node.name.endswith(('.c', '.cpp', '.cc')):
        return node
    if os.path.realpath(str(node)) == os.path.realpath(str(core_source)):
        node = env.File(str(patched))
        env.AppendUnique(CPPPATH=[str(core_source.parent)])
    elif os.path.realpath(str(node)) == os.path.realpath(str(gatt_source)):
        node = env.File(str(patched_gatt))
        env.AppendUnique(CPPPATH=[str(core_source.parent)])
    return env.Object(
        node,
        CPPDEFINES=list(env['CPPDEFINES']) + [('__FILE__', '\\"' + node.name + '\\"')],
        CCFLAGS=list(env['CCFLAGS']) + ['-Wno-builtin-macro-redefined'],
    )


env.AddBuildMiddleware(portable_filename)
