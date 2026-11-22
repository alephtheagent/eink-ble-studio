// Browser UI and production page client against the native production endpoint.
// Only GATT and flash are simulated; no RF, bootloader or panel is exercised.
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, extname, sep } from 'node:path';
import assert from 'node:assert/strict';

const dir=await mkdtemp(join(tmpdir(),'eink-browser-')), executable=join(dir,'bridge');
const build=spawnSync('g++',['-std=c++11','-Wall','-Wextra','-Werror','-Wno-misleading-indentation','-fsanitize=address,undefined','-fno-omit-frame-pointer','-no-pie','-Ifirmware/include','tests/pages_bridge.cpp','-o',executable],{encoding:'utf8'});
assert.equal(build.status,0,build.stderr);
const child=spawn(executable,[],{env:{...process.env,ASAN_OPTIONS:'detect_leaks=0'}}), lines=createInterface({input:child.stdout});
let pending, stderr='', writes=[], uploadBytes=0, dropCommit=false, dropArmed=false, rejectBefore=0;
child.stderr.on('data',d=>stderr+=d); lines.on('line',s=>{const done=pending;pending=null;done(Buffer.from(s,'hex'));});
const exchange=message=>new Promise((resolve,reject)=>{assert.ok(pending==null);pending=resolve;child.stdin.write(message+'\n',e=>{if(e)reject(e);});});
const root=resolve('web');
const server=createServer(async(req,res)=>{const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname), file=resolve(root,'.'+(name==='/'?'/index.html':name)); if(!file.startsWith(root+sep)){res.writeHead(403).end();return;} try{const bytes=await readFile(file);res.writeHead(200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png'})[extname(file)]||'application/octet-stream'});res.end(bytes);}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r)); let browser;
try {
 browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage'],...(process.env.TASK_BROWSER_PATH?{executablePath:process.env.TASK_BROWSER_PATH}:{})}); const context=await browser.newContext({acceptDownloads:true,locale:'en-US'}), page=await context.newPage(), errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.exposeBinding('bridge',async(_source,op,value)=>{
   if(op==='W'){const b=Buffer.from(value);writes.push(b[0]);if(b[0]===5)uploadBytes+=b.length-3;if(rejectBefore===b[0]){rejectBefore=0;throw Error('Injected ATT rejection before delivery');}if(dropCommit&&b[0]===6)dropArmed=true;return [...await exchange('W '+b.toString('hex'))];}
   if(op==='S'){const result=await exchange('S'); if(dropArmed && !(result[3]&1)){dropArmed=false;dropCommit=false;throw Error('Injected lost commit acknowledgement');}return [...result];}
   return [...await exchange(op)];
 });
 await page.addInitScript(()=>{
   const cv=a=>new DataView(Uint8Array.from(a).buffer);
   const cmd={properties:{write:true},async writeValueWithResponse(bytes){await window.bridge('W',Array.from(bytes));}};
   const status={async readValue(){return cv(await window.bridge('S'));}}, data={async readValue(){return cv(await window.bridge('D'));}};
   const service={async getCharacteristic(uuid){const n=uuid.slice(4,8);if(n==='0007')return cmd;if(n==='0008')return status;if(n==='0009')return data;if(n==='0002')return {properties:{write:true},async writeValueWithResponse(){}};if(n==='0003')return {async readValue(){return cv([1,...new Array(19).fill(0)]);}};throw new DOMException('Not found','NotFoundError');}};
   const device={gatt:{connected:false,async connect(){this.connected=true;return this;},async getPrimaryService(){return service;},disconnect(){this.connected=false;}},addEventListener(){},removeEventListener(){}};
   Object.defineProperty(navigator,'bluetooth',{value:{async requestDevice(){return device;}},configurable:true});
 });
 await page.goto(`http://127.0.0.1:${server.address().port}/`);
 await page.locator('#connect').click(); await page.waitForFunction(()=>!document.querySelector('#disconnect').disabled);
 const click=async id=>page.locator('#'+id).click();
 const statusText=()=>page.locator('#pages-status').textContent();
 const phrases=await page.evaluate(async()=>{const {t}=await import('./i18n.js');return {sent:t('pages.sent'),received:t('pages.received'),opened:t('pages.opened')};});
 async function send(){await page.locator('#pages-status').evaluate(e=>e.textContent='');await click('pages-send');await page.waitForFunction(()=>!document.querySelector('main').inert && !!document.querySelector('#pages-status').textContent,null,{timeout:120000});return statusText();}
 async function receive(choice){if(choice!=='cancel')await page.locator('#pages-status').evaluate(e=>e.textContent='');await click('pages-receive');await page.locator(`#receive-dialog button[value="${choice}"]`).click();if(choice!=='cancel')await page.waitForFunction(text=>document.querySelector('#pages-status').textContent===text,phrases.received,{timeout:120000});}
 async function project(){const event=page.waitForEvent('download');await click('project-export');return JSON.parse(await readFile(await (await event).path(),'utf8'));}
 await click('mode-text');await page.locator('#screen-text').fill('Page one');await click('page-new');await click('mode-text');await page.locator('#screen-text').fill('Page two');
 assert.equal(await send(),phrases.sent); assert.equal(writes.filter(x=>x===6).length,2);
 const before=await project();
 await receive('cancel'); assert.deepEqual(await project(),before);
 const saved=page.waitForEvent('download');await receive('save'); assert.ok(await (await saved).path()); await page.waitForFunction(()=>document.querySelector('#page-list button'));
 await receive('replace'); await page.waitForFunction(()=>document.querySelector('#page-list button'));
 const raster=await project(); assert.equal(raster.pages.length,2); assert.ok(raster.pages[0].state.image.source); assert.equal(raster.pages[0].state.text.layers.length,0);
 await click('mode-text');await page.locator('#screen-text').fill('Editable overlay');const overlay=await project();assert.ok(overlay.pages[0].state.text.layers.length>0);assert.ok(overlay.pages[0].state.image.source);
 writes=[];uploadBytes=0;await send(); assert.equal(writes.filter(x=>x===6).length,1,'only modified page must be written');assert.equal(uploadBytes,4000,'exactly one frame transferred');
 await page.locator('#screen-text').fill('Retry rejected upload');rejectBefore=6;assert.notEqual(await send(),phrases.sent);writes=[];assert.equal(await send(),phrases.sent);assert.ok(writes.includes(11),'retry aborts abandoned upload on the same connection');
 await click('page-down');rejectBefore=10;assert.notEqual(await send(),phrases.sent);writes=[];assert.equal(await send(),phrases.sent);assert.ok(writes.includes(11),'retry aborts abandoned reorder on the same connection');
 writes=[];await click('page-delete');assert.equal(writes.filter(x=>x===7).length,0,'local delete must not mutate remote');await send();assert.equal(writes.filter(x=>x===7).length,1);
 await click('mode-text');await page.locator('#screen-text').fill('Lost acknowledgement recovery');dropCommit=true;writes=[];assert.notEqual(await send(),phrases.sent);assert.equal(writes.filter(x=>x===6).length,1);
 const pendingDownload=page.waitForEvent('download');await click('project-export');const pendingPath=await (await pendingDownload).path();
 await page.reload();await page.locator('#project-file').setInputFiles(pendingPath);await page.waitForFunction(text=>document.querySelector('#pages-status').textContent===text,phrases.opened);
 await click('connect');await page.waitForFunction(()=>!document.querySelector('#disconnect').disabled);
 writes=[];assert.equal(await send(),phrases.sent);assert.equal(writes.filter(x=>x===6).length,0,'resuming exported uncertain commit must not duplicate write');
 const resumed=await project();assert.ok(resumed.pages[0].state.text.layers.length>0,'editable layers survive recovery');
 assert.deepEqual(errors,[]);console.log('PASS actual browser pages UI ↔ production C++ endpoint: receive choices, raster overlay, changed-only, staged delete, lost ACK resume');
 await context.close();
} finally {await browser?.close();await new Promise(r=>server.close(r));child.stdin.end();await new Promise((resolve,reject)=>child.once('exit',code=>code===0?resolve():reject(Error(stderr||`bridge exited ${code}`))));lines.close();await rm(dir,{recursive:true,force:true});}
