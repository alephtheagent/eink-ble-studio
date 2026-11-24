import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BleTransport, decodeStatus, packetData, UUIDS } from '../web/ble.js';
import { crc32 } from '../web/image.js';
function decodePackBits(bytes) {
 const out=[];
 for(let i=0;i<bytes.length;){const control=bytes[i++];if(control<=127){const count=control+1;out.push(...bytes.subarray(i,i+count));i+=count;}else if(control>=129){const count=257-control,value=bytes[i++];for(let n=0;n<count;n++)out.push(value);}}
 return Uint8Array.from(out);
}
const v2Fake=expected=>{
 const state={id:0,received:0,total:0,crc:0,codec:0,phase:0,generation:0,writes:[],bytes:new Uint8Array(4000),decoded:null,valid:false};
 const capabilities={async readValue(){const b=new Uint8Array(20),v=new DataView(b.buffer);v.setUint32(0,0x324c4245,true);b.set([2,0,3,1],4);v.setUint16(8,20,true);v.setUint16(10,4000,true);v.setUint16(12,4000,true);v.setUint16(14,15000,true);return v;}};
 const command2={properties:{write:true},async writeValueWithResponse(packet){
  const b=new Uint8Array(packet),v=new DataView(packet.buffer,packet.byteOffset,packet.byteLength);state.writes.push(b);
  if(b[0]===0x11){state.id=v.getUint32(1,true);state.codec=b[5];state.total=v.getUint16(8,true);state.crc=v.getUint32(10,true);state.phase=1;}
  else if(b[0]===0x12){const offset=v.getUint16(5,true);assert.equal(offset,state.received);state.bytes.set(b.subarray(7),offset);state.received+=b.length-7;}
  else if(b[0]===0x13){state.decoded=state.codec===0?state.bytes.slice(0,state.total):decodePackBits(state.bytes.subarray(0,state.total));state.valid=state.decoded.length===4000&&crc32(state.decoded)===state.crc&&Buffer.from(state.decoded).equals(Buffer.from(expected));state.phase=state.valid?4:5;state.generation=state.valid?1:0;}
 }};
 const status2={async readValue(){const b=new Uint8Array(20),v=new DataView(b.buffer);b.set([2,state.phase,state.valid||state.phase!==5?0:6,state.codec]);v.setUint32(4,state.id,true);v.setUint16(8,state.received,true);v.setUint16(10,state.total,true);v.setUint32(12,state.crc,true);v.setUint32(16,state.generation,true);return v;}};
 const command={properties:{write:true},async writeValueWithResponse(){}},status={async readValue(){const b=new Uint8Array(20);b[0]=1;return new DataView(b.buffer);}};
 const service={async getCharacteristic(uuid){return ({[UUIDS.command]:command,[UUIDS.status]:status,[UUIDS.capabilities]:capabilities,[UUIDS.command2]:command2,[UUIDS.status2]:status2})[uuid];}};
 const device={gatt:{connected:false,async connect(){this.connected=true;return {async getPrimaryService(){return service;}};},disconnect(){this.connected=false;}},addEventListener(){},removeEventListener(){}};
 const bluetooth={async requestDevice(){return device;}};
 return {state,bluetooth,device};
};
test('v2 GATT negotiation and both codecs deliver exact frames',async()=>{
 for(const frame of [approved,new Uint8Array(4000)]){
  const f=v2Fake(frame),progress=[],client=new BleTransport({bluetooth:f.bluetooth,onProgress:(n,total)=>progress.push([n,total])});
  assert.equal((await client.connect()).version,2);const result=await client.send(frame,321);
  assert.equal(result.state,4);assert.equal(f.state.id,321);assert.equal(f.state.received,f.state.total);assert.equal(f.state.valid,true);
  assert.deepEqual(f.state.decoded,frame);assert.ok(f.state.writes.every(p=>p.length<=20));
  assert.deepEqual(progress.at(-1),[f.state.total,f.state.total]);
  if(frame.every(byte=>byte===0))assert.equal(f.state.codec,1);
 }
});
test('connection without GATT capabilities falls back to v1 callbacks and transfer',async()=>{
 const f=fake(),service={async getCharacteristic(uuid){if(uuid===UUIDS.command)return f.command;if(uuid===UUIDS.status)return f.status;const error=new Error('Not found');error.name='NotFoundError';throw error;}};
 f.device.gatt.connect=async()=>({async getPrimaryService(uuid){assert.equal(uuid,UUIDS.service);return service;}});
 const client=new BleTransport({bluetooth:{async requestDevice(){return f.device;}}});
 assert.equal((await client.connect()).version,1);assert.equal((await client.send(approved,77)).state,4);assert.deepEqual(f.state.frame,approved);
});
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
 const f=fake({rejectData:true});const c=new BleTransport(f);await assert.rejects(c.send(approved,9));
 assert.equal(f.state.received,0);assert.equal(f.state.writes.filter(p=>p[0]===3).length,0);assert.equal(c.busy,false);
});
test('disconnect fails incomplete transfer; fresh reconnect restarts and succeeds',async()=>{
 const f=fake({disconnectAt:13}),c=new BleTransport(f);await assert.rejects(c.send(approved,9));assert.equal(f.state.phase,1);assert.equal(f.state.received,13);
 const next=fake();Object.assign(c,{device:next.device,command:next.command,status:next.status});
 assert.equal((await c.send(approved,10)).state,4);assert.deepEqual(next.state.frame,approved);
});
test('operation timeout disconnects uncertain GATT and does not retry concurrently',async()=>{
 const f=fake({hang:true}),c=new BleTransport({...f,timeout:10});await assert.rejects(c.send(approved,9));
 assert.equal(f.state.disconnected,true);assert.equal(c.command,null);assert.equal(c.busy,false);
});
test('display refresh has finite timeout distinct from transfer completion',async()=>{
 const f=fake({stuck:true}),c=new BleTransport({...f,refreshTimeout:1});await assert.rejects(c.send(approved,9));assert.equal(f.state.phase,3);
});
test('corrupt local padding and invalid lengths never reach GATT',async()=>{
 const f=fake(),c=new BleTransport(f),bad=approved.slice();bad[15]|=1;
 await assert.rejects(c.send(bad,1));await assert.rejects(c.send(new Uint8Array(3999),1));assert.equal(f.state.writes.length,0);
 assert.throws(()=>packetData(1,3999,new Uint8Array(2)));assert.throws(()=>decodeStatus(new Uint8Array(19)));
});
test('missing Web Bluetooth produces actionable error',async()=>{
 const c=new BleTransport({bluetooth:null});await assert.rejects(c.connect());
});

function deferred(){
 let resolve,reject;
 const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
 return {promise,resolve,reject};
}
function discovery({connect,service,command,status}={}){
 const f=fake(), device=f.device;
 const svc={getCharacteristic:uuid=>uuid.endsWith('0006-6ba2-4f25-8ac7-1d54e91a1000')?Promise.reject(Object.assign(new Error('not found'),{name:'NotFoundError'})):uuid.endsWith('0002-6ba2-4f25-8ac7-1d54e91a1000')?(command?.() ?? Promise.resolve(f.command)):(status?.() ?? Promise.resolve(f.status))};
 const server={getPrimaryService:()=>service?.() ?? Promise.resolve(svc)};
 device.gatt.connect=connect ?? (()=>Promise.resolve(server));
 device.addEventListener=()=>{};
 return {...f,server,svc,bluetooth:{requestDevice:()=>Promise.resolve(device)}};
}
test('discovery failures and timeouts identify the exact stage',async()=>{
 for(const [key,stage] of [['connect','connect'],['service','discovery service'],['command','discovery command'],['status','discovery status']]){
  const f=discovery({[key]:()=>new Promise(()=>{})}),events=[];
  const c=new BleTransport({bluetooth:f.bluetooth,timeout:5,onDiagnostic:e=>events.push(e)});
  await assert.rejects(c.connect());
  assert.equal(f.state.disconnected,true);
  assert.equal(events.at(-1).stage,stage);
  assert.equal(c.command,null);
 }
 const f=discovery({service:()=>Promise.reject(new Error('service denied'))});
 await assert.rejects(new BleTransport({bluetooth:f.bluetooth}).connect());
});
test('write and acknowledgement errors identify packet and DATA offset',async()=>{
 for(const [opcode,stage] of [[1,'START'],[2,'DATA offset 13'],[3,'COMMIT']]){
  const f=fake(),write=f.command.writeValueWithResponse;
  f.command.writeValueWithResponse=async bytes=>{
   const offset=bytes[0]===2?new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint16(5,true):-1;
   if(bytes[0]===opcode&&(opcode!==2||offset===13))throw new Error('write failed');
   return write(bytes);
  };
  await assert.rejects(new BleTransport(f).send(approved,17));
 }
 const f=fake(),read=f.status.readValue;
 f.status.readValue=async()=>{if(f.state.received===13)throw new Error('read failed');return read();};
 await assert.rejects(new BleTransport(f).send(approved,18));
});
test('timeouts identify write, ack and refresh reads without concurrent retry',async()=>{
 for(const which of ['write','ack','refresh']){
  const f=fake({stuck:which==='refresh'}),write=f.command.writeValueWithResponse,read=f.status.readValue;
  let writes=0;
  f.command.writeValueWithResponse=async bytes=>{writes++;if(which==='write')return new Promise(()=>{});return write(bytes);};
  f.status.readValue=async()=>{if(which==='ack'||(which==='refresh'&&f.state.phase===3&&writes>0&&f.readCommit)){return new Promise(()=>{});} const result=await read();if(f.state.phase===3)f.readCommit=true;return result;};
  const c=new BleTransport({...f,timeout:5});
  await assert.rejects(c.send(approved,19));
  assert.equal(f.state.disconnected,true);
  if(which!=='refresh')assert.equal(writes,1);
 }
});
test('connect, send and status reject re-entry and disconnect cancels pending work',async()=>{
 const f=fake(),pending=deferred();
 f.command.writeValueWithResponse=()=>pending.promise;
 const c=new BleTransport(f),sending=c.send(approved,20);
 await assert.rejects(c.send(approved,21));
 await assert.rejects(c.connect());
 await assert.rejects(c.readStatus());
 c.disconnect();
 await assert.rejects(sending);
 pending.resolve();
 assert.equal(c.command,null);assert.equal(c.busy,false);
});
test('late connection cannot restore stale characteristics or disconnect a new attempt',async()=>{
 const pending=deferred(),disconnected=deferred(),f=discovery({connect:()=>pending.promise});
 const disconnect=f.device.gatt.disconnect;
 f.device.gatt.disconnect=function(){disconnect.call(this);disconnected.resolve();};
 f.device.gatt.connected=false;
 const c=new BleTransport({bluetooth:f.bluetooth,timeout:5});
 await assert.rejects(c.connect());
 await assert.rejects(c.connect());
 f.device.gatt.connected=true;pending.resolve(f.server);
 await disconnected.promise;
 assert.equal(f.device.gatt.connected,false);assert.equal(c.command,null);assert.equal(c.status,null);
});
test('late discovery result after disconnect cannot publish characteristics',async()=>{
 const pending=deferred(),started=deferred(),f=discovery({status:()=>{started.resolve();return pending.promise;}});
 const c=new BleTransport({bluetooth:f.bluetooth});
 const connecting=c.connect();
 await started.promise;
 c.disconnect();await assert.rejects(connecting);
 pending.resolve(f.status);
 assert.equal(c.command,null);assert.equal(c.status,null);
});
test('pending timed-out GATT write prevents reconnecting the same device',async()=>{
 const pending=deferred(),f=discovery();
 f.command.writeValueWithResponse=()=>pending.promise;
 const c=new BleTransport({bluetooth:f.bluetooth,timeout:5});
 await c.connect();
 await assert.rejects(c.send(approved,22));
 await assert.rejects(c.connect());
 pending.resolve();
});
test('device chooser grants access to the animation service',async()=>{
 const f=v2Fake(approved);let options=null;
 f.bluetooth.requestDevice=async opts=>{options=opts;return f.device;};
 const client=new BleTransport({bluetooth:f.bluetooth});
 await client.connect();
 assert.deepEqual(options.filters,[{services:[UUIDS.service]}]);
 assert.ok(Array.isArray(options.optionalServices),'optionalServices must be present');
 assert.ok(options.optionalServices.includes(UUIDS.anim),'animation service must be in optionalServices');
});
