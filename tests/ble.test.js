import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BleTransport, decodeStatus, packetData } from '../web/ble.js';
import { crc32 } from '../web/image.js';
const approved=new Uint8Array(fs.readFileSync(new URL('./fixtures/approved-frame.bin',import.meta.url)));
function fake({rejectData=false,loseAck=false,disconnectAt=-1,hang=false,stuck=false}={}){
 const state={id:0,received:0,crc:0,phase:0,generation:0,frame:new Uint8Array(4000),writes:[],error:0,disconnected:false};
 const device={gatt:{connected:true,disconnect(){this.connected=false;state.disconnected=true;}}};
 const command={async writeValueWithResponse(bytes){
  if(hang)return new Promise(()=>{});
  assert.ok(bytes.length<=20);state.writes.push(bytes.slice());const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),id=v.getUint32(1,true);
  if(bytes[0]===1){state.id=id;state.crc=v.getUint32(7,true);state.phase=1;state.received=0;}
  else if(bytes[0]===2){
   const offset=v.getUint16(5,true);assert.equal(id,state.id);
   if(offset===disconnectAt){device.gatt.disconnect();throw new Error('Disconnected');}
   if(rejectData){state.error=4;return;}
   if(offset===state.received){state.frame.set(bytes.subarray(7),offset);state.received+=bytes.length-7;}
   else {assert.ok(offset+bytes.length-7<=state.received);assert.deepEqual(state.frame.slice(offset,offset+bytes.length-7),bytes.slice(7));}
   if(loseAck){loseAck=false;throw new Error('ACK lost after delivery');}
  }else if(bytes[0]===3){assert.equal(state.received,4000);assert.equal(crc32(state.frame),state.crc);state.phase=stuck?3:4;if(!stuck)state.generation++;}
 }};
 const status={async readValue(){if(!device.gatt.connected)throw new Error('Disconnected');const b=new Uint8Array(20),v=new DataView(b.buffer);b[0]=1;b[1]=state.phase;b[2]=state.error;v.setUint32(4,state.id,true);v.setUint16(8,state.received,true);v.setUint16(10,4000,true);v.setUint32(12,state.crc,true);v.setUint32(16,state.generation,true);return v;}};
 return {state,device,command,status};
}
test('MTU23 approved frame acknowledged end-to-end with exact duplicate after lost ACK',async()=>{
 const f=fake({loseAck:true}),progress=[];const client=new BleTransport({...f,onProgress:n=>progress.push(n)});
 const result=await client.send(approved,123);
 assert.equal(result.state,4);assert.equal(result.generation,1);assert.deepEqual(f.state.frame,approved);
 assert.deepEqual(f.state.writes[1],f.state.writes[2]);assert.equal(progress.at(-1),4000);
 assert.ok(progress.every((n,i)=>!i||n>=progress[i-1]));assert.equal(client.busy,false);
});
test('explicit rejection never commits or reports success',async()=>{
 const f=fake({rejectData:true});const c=new BleTransport(f);await assert.rejects(c.send(approved,9),/Device error/);
 assert.equal(f.state.received,0);assert.equal(f.state.writes.filter(p=>p[0]===3).length,0);assert.equal(c.busy,false);
});
test('disconnect fails incomplete transfer; fresh reconnect restarts and succeeds',async()=>{
 const f=fake({disconnectAt:13}),c=new BleTransport(f);await assert.rejects(c.send(approved,9),/Disconnected/);assert.equal(f.state.phase,1);assert.equal(f.state.received,13);
 const next=fake();Object.assign(c,{device:next.device,command:next.command,status:next.status});
 assert.equal((await c.send(approved,10)).state,4);assert.deepEqual(next.state.frame,approved);
});
test('operation timeout disconnects uncertain GATT and does not retry concurrently',async()=>{
 const f=fake({hang:true}),c=new BleTransport({...f,timeout:10});await assert.rejects(c.send(approved,9),/timed out/);
 assert.equal(f.state.disconnected,true);assert.equal(c.command,null);assert.equal(c.busy,false);
});
test('display refresh has finite timeout distinct from transfer completion',async()=>{
 const f=fake({stuck:true}),c=new BleTransport({...f,refreshTimeout:1});await assert.rejects(c.send(approved,9),/refresh timed out/);assert.equal(f.state.phase,3);
});
test('corrupt local padding and invalid lengths never reach GATT',async()=>{
 const f=fake(),c=new BleTransport(f),bad=approved.slice();bad[15]|=1;
 await assert.rejects(c.send(bad,1),/padding/);await assert.rejects(c.send(new Uint8Array(3999),1),/length/);assert.equal(f.state.writes.length,0);
 assert.throws(()=>packetData(1,3999,new Uint8Array(2)));assert.throws(()=>decodeStatus(new Uint8Array(19)));
});
test('missing Web Bluetooth produces actionable error',async()=>{
 const c=new BleTransport({bluetooth:null});await assert.rejects(c.connect(),/iOS Safari/);
});
