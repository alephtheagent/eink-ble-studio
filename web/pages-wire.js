import { FRAME_BYTES, crc32 } from './image.js';
import { UUIDS } from './ble.js';
import { t } from './i18n.js';
const uuid = n => UUIDS.service.replace('0001-', `${n}-`);
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
const command = (op, length = 1) => {
  const bytes = new Uint8Array(length);
  bytes[0] = op;
  return [bytes, new DataView(bytes.buffer)];
};
export async function withPages(transport, fn) {
  return transport.run('pages', async context => {
    const op = (label, action) => transport.operation(context,label,action);
    if (!transport.device?.gatt?.connected) throw Error(t('pages.connectFirst'));
    const service=await op('pages service',()=>transport.device.gatt.getPrimaryService(UUIDS.service));
    const cmd = await op('pages command', () => service.getCharacteristic(uuid('0007')));
    const status = await op('pages status', () => service.getCharacteristic(uuid('0008')));
    const data = await op('pages data', () => service.getCharacteristic(uuid('0009')));
    async function request(bytes) {
      await op('pages write',()=>cmd.writeValueWithResponse(bytes));
      const deadline=Date.now()+30000;
      for (;;) {
        const v=await op('pages status',()=>status.readValue());
        if(v.byteLength!==20 || v.getUint8(0)!==1 || v.getUint8(1)!==bytes[0] || (v.getUint8(3)&~1)) throw Error(t('pages.invalidStatus'));
        if (v.getUint8(3) & 1) {
          if (Date.now() > deadline) throw Error(t('pages.timeout'));
          await pause(50);
          continue;
        }
        if (v.getUint8(2)) {
          const error = Error(t('pages.deviceError', { code: v.getUint8(2) }));
          error.code = v.getUint8(2);
          throw error;
        }
        return {rev:v.getUint32(4,true),id:v.getUint32(8,true),pageRev:v.getUint32(12,true),value:v.getUint32(16,true)};
      }
    }
    async function list() {
      const info=await request(command(1)[0]), entries=[];
      if(info.pageRev>65535 || info.id>info.pageRev || info.value>info.pageRev+1) throw Error(t('pages.invalidInfo'));
      for(let i=0;i<info.id;i++) {
        const [b,v]=command(2,3); v.setUint16(1,i,true); const s=await request(b);
        if(s.rev!==info.rev)throw Error(t('pages.changed'));
        if(!s.id || !s.pageRev || entries.some(e=>e.id===s.id))throw Error(t('pages.invalidInfo'));
        entries.push({id:s.id,pageRev:s.pageRev,crc:s.value});
      }
      const end=await request(command(1)[0]);
      if(end.rev!==info.rev || end.id!==info.id || end.pageRev!==info.pageRev)throw Error(t('pages.changed'));
      return {rev:info.rev,entries,capacity:info.pageRev,free:info.value};
    }
    async function read(entry,rev,progress) {
      const frame=new Uint8Array(FRAME_BYTES);
      for(let offset=0;offset<FRAME_BYTES;) {
        const [b,v]=command(3,7);v.setUint32(1,entry.id,true);v.setUint16(5,offset,true);
        const s=await request(b);
        if(s.rev!==rev||s.id!==entry.id||s.pageRev!==entry.pageRev||s.value!==entry.crc)throw Error(t('pages.changed'));
        const d=await op('pages data',()=>data.readValue());
        if(d.byteLength<3||d.byteLength>20||d.getUint16(0,true)!==offset||offset+d.byteLength-2>FRAME_BYTES)throw Error(t('pages.invalidData'));
        const chunk=new Uint8Array(d.buffer,d.byteOffset+2,d.byteLength-2);frame.set(chunk,offset);offset+=chunk.length;progress?.(offset,FRAME_BYTES);
      }
      if(crc32(frame)!==entry.crc)throw Error(t('pages.crc'));
      return frame;
    }
    async function upload(rev,entry,frame,progress,onBegin) {
      if (!(frame instanceof Uint8Array) || frame.length!==FRAME_BYTES) throw Error(t('pages.invalidFrame'));
      for(let i=15;i<FRAME_BYTES;i+=16) if(frame[i]&63) throw Error(t('pages.padding'));
      const crc=crc32(frame), [b,v]=command(4,17);
      v.setUint32(1,rev,true);v.setUint32(5,entry?.id||0,true);v.setUint32(9,entry?.pageRev||0,true);v.setUint32(13,crc,true);
      let started=false, committing=false;
      try {
        started=true; const start=await request(b);
        if(start.rev!==rev||start.value!==0||!start.id||start.pageRev!==(entry?.pageRev||0)||(entry&&start.id!==entry.id)) throw Error(t('pages.invalidUpload'));
        onBegin?.(start.id);
        for(let offset=0;offset<FRAME_BYTES;) {
          const chunk=frame.subarray(offset,offset+17), [d,dv]=command(5,3+chunk.length);dv.setUint16(1,offset,true);d.set(chunk,3);
          const s=await request(d);offset+=chunk.length;
          if(s.rev!==rev||s.id!==start.id||s.pageRev!==start.pageRev||s.value!==offset)throw Error(t('pages.invalidOffset'));
          progress?.(offset,FRAME_BYTES);
        }
        committing=true;
        const s=await request(command(6)[0]);
        if(s.rev!==rev+1||s.id!==start.id||s.pageRev!==start.pageRev+1||s.value!==crc)throw Error(t('pages.invalidCommit'));
        return {rev:s.rev,id:s.id,pageRev:s.pageRev,crc};
      } catch(error) {
        if(started&&!committing) try { await request(command(11)[0]); } catch {}
        throw error;
      }
    }
    async function remove(rev, entry) {
      const [b, v] = command(7, 13);
      v.setUint32(1, rev, true);
      v.setUint32(5, entry.id, true);
      v.setUint32(9, entry.pageRev, true);
      const s = await request(b);
      if (s.id !== entry.id || s.rev !== rev + 1) throw Error(t('pages.invalidDelete'));
      return s.rev;
    }
    async function order(rev,ids) {
      const [b,v]=command(8,7);v.setUint32(1,rev,true);v.setUint16(5,ids.length,true);
      let started=false, committing=false;
      try {
        started=true; await request(b);
        for (let i = 0; i < ids.length;) {
          const group = ids.slice(i, i + 4), [d, dv] = command(9, 3 + group.length * 4);
          dv.setUint16(1, i, true);
          group.forEach((id, j) => dv.setUint32(3 + j * 4, id, true));
          const s = await request(d);
          i += group.length;
          if (s.rev !== rev || s.value !== i) throw Error(t('pages.invalidOrder'));
        }
        committing = true;
        const result = await request(command(10)[0]);
        if (result.rev !== rev + 1) throw Error(t('pages.invalidOrder'));
        return result.rev;
      } catch (error) {
        if (started && !committing) try { await request(command(11)[0]); } catch {}
        throw error;
      }
    }
    return fn({request,list,read,upload,remove,order});
  });
}
