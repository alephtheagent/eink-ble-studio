import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withPages } from '../web/pages-wire.js';

const frame = seed => Uint8Array.from({length:4000}, (_, i) => i % 16 === 15 ? (seed * 37 + i) & 0xc0 : (seed * 37 + i * 13) & 255);
const view = b => new DataView(b.buffer,b.byteOffset,b.byteLength);
test('production web page client talks to C++ firmware endpoint, survives reboot and reconciles conflict', async () => {
  const dir=mkdtempSync(join(tmpdir(),'eink-pages-')), executable=join(dir,'bridge');
  const build=spawnSync('g++',['-std=c++11','-Wall','-Wextra','-Werror','-Wno-misleading-indentation','-fsanitize=address,undefined','-fno-omit-frame-pointer','-no-pie','-Ifirmware/include','tests/pages_bridge.cpp','-o',executable],{encoding:'utf8'});
  assert.equal(build.status,0,build.stderr);
  const child=spawn(executable,[],{env:{...process.env,ASAN_OPTIONS:'detect_leaks=0'}});
  const lines=createInterface({input:child.stdout}); let pending, stderr='';
  child.stderr.on('data',s=>stderr+=s); lines.on('line',line=>{const resolve=pending; pending=null; resolve(Buffer.from(line,'hex'));});
  const exchange = text => new Promise((resolve,reject)=>{assert.ok(pending == null);pending=resolve;child.stdin.write(text+'\n',e=>{if(e)reject(e);});});
  const command={writeValueWithResponse:async bytes=>{await exchange('W '+Buffer.from(bytes).toString('hex'));}};
  const status={readValue:async()=>view(await exchange('S'))}, data={readValue:async()=>view(await exchange('D'))};
  const service={getCharacteristic:async uuid=>uuid.startsWith('7b1e0007')?command:uuid.startsWith('7b1e0008')?status:data};
  const transport={device:{gatt:{connected:true,getPrimaryService:async()=>service}},run:async(_label,fn)=>fn({}),operation:async(_ctx,_label,fn)=>fn()};
  try {
    await withPages(transport,async api=>{
      let state=await api.list(); assert.equal(state.entries.length,0);
      const a=frame(1),b=frame(2),c=frame(3),changed=frame(4);
      const pa=await api.upload(state.rev,null,a); const pb=await api.upload(pa.rev,null,b); const pc=await api.upload(pb.rev,null,c);
      state=await api.list(); assert.equal(state.entries.length,3);
      assert.deepEqual(await api.read(state.entries[0],state.rev),a); assert.deepEqual(await api.read(state.entries[1],state.rev),b); assert.deepEqual(await api.read(state.entries[2],state.rev),c);
      const updated=await api.upload(state.rev,state.entries[1],changed);
      await assert.rejects(api.remove(state.rev,state.entries[0]), error => error.code === 4);
      state=await api.list(); assert.equal(state.rev,updated.rev); assert.deepEqual(await api.read(state.entries[1],state.rev),changed);
      const revision=await api.order(state.rev,[pc.id,pa.id,pb.id]); state=await api.list(); assert.equal(state.rev,revision); assert.deepEqual(state.entries.map(x=>x.id),[pc.id,pa.id,pb.id]);
      await api.remove(state.rev,state.entries[1]); state=await api.list(); assert.deepEqual(state.entries.map(x=>x.id),[pc.id,pb.id]);
      await exchange('X'); await exchange('R'); state=await api.list(); assert.deepEqual(state.entries.map(x=>x.id),[pc.id,pb.id]); assert.deepEqual(await api.read(state.entries[0],state.rev),c); assert.deepEqual(await api.read(state.entries[1],state.rev),changed);
    });
  } finally { child.stdin.end(); await new Promise((resolve,reject)=>child.once('exit',code=>code===0?resolve():reject(Error(stderr||`bridge exit ${code}`)))); lines.close(); rmSync(dir,{recursive:true,force:true}); }
});
