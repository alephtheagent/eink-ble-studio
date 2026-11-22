// Real-Firefox integration checks for additive text behavior and BLE callback wiring.
import { firefox } from 'playwright';
import { createCanvas } from '@napi-rs/canvas';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const scratch=path.join(root,'scratch');
await fs.mkdir(path.join(scratch,'downloads'),{recursive:true});
const browser=await firefox.launch({headless:true,downloadsPath:path.join(scratch,'downloads'),...(process.env.FIREFOX_EXECUTABLE_PATH?{executablePath:process.env.FIREFOX_EXECUTABLE_PATH}:{})});
async function downloadFrame(page){
 const event=page.waitForEvent('download');await page.locator('#frame').click();
 return fs.readFile(await (await event).path());
}
try {
 const old=await browser.newPage({viewport:{width:1280,height:900}}),oldErrors=[];
 old.on('pageerror',e=>oldErrors.push(e.message));await old.goto(process.env.STUDIO_URL||'http://127.0.0.1:8765/');
 await old.locator('nav summary').nth(0).click();await old.locator('[data-action="reference"]').click();
 assert.deepEqual(await downloadFrame(old),await fs.readFile(path.join(root,'tests/fixtures/approved-frame.bin')));
 await old.locator('#file').setInputFiles(path.join(root,'tests/fixtures/approved-native.png'));
 await old.locator('#image-name').filter({hasText:'approved-native.png'}).waitFor();
 assert.deepEqual(await old.locator('#native').evaluate(c=>[c.width,c.height]),[122,250]);
 const initial=await downloadFrame(old),box=await old.locator('#preview').boundingBox();
 await old.mouse.move(box.x+30,box.y+30);await old.mouse.down();await old.mouse.move(box.x+50,box.y+50);await old.mouse.up();
 assert.ok(Number(await old.locator('#x').inputValue())>0);assert.ok(Number(await old.locator('#y').inputValue())>0);
 await old.locator('#reset').click();await old.locator('#mode').selectOption('tile');await old.locator('#tileSize').fill('31');
 const tiled=await downloadFrame(old);assert.notDeepEqual(tiled,initial);
 const gray=createCanvas(64,64),ctx=gray.getContext('2d'),image=ctx.createImageData(64,64);
 for(let y=0;y<64;y++)for(let x=0;x<64;x++){const i=(y*64+x)*4;image.data[i]=image.data[i+1]=image.data[i+2]=x*4;image.data[i+3]=255;}
 ctx.putImageData(image,0,0);const grayPath=path.join(scratch,'gray-gradient.png');await fs.writeFile(grayPath,gray.toBuffer('image/png'));
 await old.locator('#file').setInputFiles(grayPath);await old.locator('#image-name').filter({hasText:'gray-gradient.png'}).waitFor();
 await old.locator('#threshold').evaluate(e=>{e.value='128';e.dispatchEvent(new Event('input',{bubbles:true}));});const threshold128=await downloadFrame(old);
 await old.locator('#threshold').evaluate(e=>{e.value='200';e.dispatchEvent(new Event('input',{bubbles:true}));});
 assert.equal(await old.locator('#threshold-value').innerText(),'200');const threshold=await downloadFrame(old);assert.notDeepEqual(threshold,threshold128);
 await old.locator('#mode').selectOption('cover');await old.locator('#reset').click();const beforeRotation=await downloadFrame(old);
 await old.locator('nav summary').nth(1).click();await old.locator('[data-action="image-fine"]').click();
 await old.locator('#image-rotation').fill('12');const rotated=await downloadFrame(old);assert.notDeepEqual(rotated,beforeRotation);
 await old.locator('#preview').focus();await old.keyboard.press('Control+z');assert.equal(await old.locator('#image-rotation').inputValue(),'0');
 assert.deepEqual(oldErrors,[]);await fs.rm(grayPath,{force:true});
 await old.close();

 const mock=`(()=>{
  const s={id:0,received:0,crc:0,phase:0,generation:0,error:0,frame:new Uint8Array(4000),complete:false};
  const crc32=a=>{let c=0xffffffff;for(const b of a){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;};
  const command={async writeValueWithResponse(bytes){const b=new Uint8Array(bytes),v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);if(b[0]===1){s.id=v.getUint32(1,true);s.crc=v.getUint32(7,true);s.phase=1;s.received=0;}else if(b[0]===2){const offset=v.getUint16(5,true);if(offset!==s.received){s.error=4;return;}s.frame.set(b.subarray(7),offset);s.received+=b.length-7;}else if(b[0]===3){s.complete=s.received===4000&&crc32(s.frame)===s.crc;s.phase=s.complete?4:5;s.error=s.complete?0:6;}}};
  const status={async readValue(){const b=new Uint8Array(20),v=new DataView(b.buffer);b[0]=1;b[1]=s.phase;b[2]=s.error;v.setUint32(4,s.id,true);v.setUint16(8,s.received,true);v.setUint16(10,4000,true);v.setUint32(12,s.crc,true);v.setUint32(16,s.generation,true);return v;}};
  const service={async getCharacteristic(uuid){if(uuid==='7b1e0002-6ba2-4f25-8ac7-1d54e91a1000')return command;if(uuid==='7b1e0003-6ba2-4f25-8ac7-1d54e91a1000')return status;throw new DOMException('Not found','NotFoundError');}};
  const device={gatt:{connected:false,async connect(){this.connected=true;return{async getPrimaryService(){return service;}};},disconnect(){this.connected=false;}},addEventListener(){},removeEventListener(){}};
  Object.defineProperty(navigator,'bluetooth',{configurable:true,value:{async requestDevice(){return device;}}});window.__mockBle=s;
 })();`;
 const text=await browser.newPage({viewport:{width:390,height:844}});await text.addInitScript(mock);const textErrors=[];text.on('pageerror',e=>textErrors.push(e.message));
 await text.goto(process.env.STUDIO_URL||'http://127.0.0.1:8765/');
 await text.locator('nav summary').nth(0).click();await text.locator('[data-action="text-only"]').click();
 await text.locator('#text-content').fill('Русский текст');await text.locator('#text-width').fill('90');
 const composed=await downloadFrame(text);assert.equal(composed.length,4000);assert.ok([...Array(250)].every((_,y)=>(composed[y*16+15]&63)===0));
 await text.locator('#connect').click();await text.getByText(/Connected\./).waitFor();await text.locator('#send').click();await text.getByText('Display refresh completed.').waitFor({timeout:30000});
 const sent=await text.evaluate(()=>Array.from(window.__mockBle.frame));assert.deepEqual(Buffer.from(sent),composed);assert.equal(await text.evaluate(()=>window.__mockBle.complete),true);
 await text.locator('#preview').evaluate(canvas=>{canvas.setPointerCapture=()=>{};const fire=(type,id,x,y)=>canvas.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:id,pointerType:'touch',button:0,clientX:x,clientY:y}));fire('pointerdown',11,100,100);fire('pointerdown',12,200,100);for(let n=0;n<8;n++)fire('pointermove',12,200,100);});
 const unchanged=await text.locator('#text-scale').inputValue();assert.equal(unchanged,'1');
 await text.locator('#preview').evaluate(canvas=>{canvas.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:12,pointerType:'touch',button:0,clientX:220,clientY:100}));canvas.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:11,pointerType:'touch',button:0,clientX:100,clientY:100}));canvas.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:12,pointerType:'touch',button:0,clientX:220,clientY:100}));});
 assert.equal(await text.locator('#text-scale').inputValue(),'2');assert.deepEqual(textErrors,[]);
 await fs.mkdir(path.join(scratch,'final'),{recursive:true});await text.evaluate(()=>scrollTo(0,0));await text.screenshot({path:path.join(scratch,'final','text-send-touch-firefox.png'),fullPage:true});
 await text.locator('#font-toggle').click();await text.screenshot({path:path.join(scratch,'final','text-font-picker-firefox.png'),fullPage:true});
 console.log(JSON.stringify({approvedFrame:'exact',tileAndThreshold:'changed frame',fineRotationUndo:'pass',textOnlySend:'4000-byte frame exactly matches exported frame through mocked v1 GATT',touchPinch:'equal-distance no-op; pinch increases size one step',pageErrors:[...oldErrors,...textErrors]},null,2));
 await text.close();
} finally {await browser.close();}
