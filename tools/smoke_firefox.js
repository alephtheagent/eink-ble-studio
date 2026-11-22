// Optional real-browser smoke, Firefox only. Start npm run serve first.
import { firefox } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const browser=await firefox.launch({headless:true,...(process.env.FIREFOX_EXECUTABLE_PATH?{executablePath:process.env.FIREFOX_EXECUTABLE_PATH}:{})});
const results=[];
try {
 for(const [name,width,height] of [['desktop',1280,900],['mobile',390,844],['narrow',320,740]]) {
  const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
  const errors=[];const requests=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r.url()));
  await page.goto(process.env.STUDIO_URL||'http://127.0.0.1:8765/');
  const firstScreen=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth,firmwareOpen:document.querySelector('#firmware')?.open===true,bluetoothStatus:document.querySelector('#status')?.textContent.trim()}));
  assert.ok(firstScreen.scroll<=firstScreen.width,`First-screen overflow at ${width}px: ${JSON.stringify(firstScreen)}`);
  assert.equal(firstScreen.firmwareOpen,false,`Firmware must not obscure the initial screen at ${width}px`);
  assert.match(firstScreen.bluetoothStatus,/Web Bluetooth unavailable|not supported|unavailable/i,`Firefox should honestly report unsupported Web Bluetooth: ${firstScreen.bluetoothStatus}`);
  await page.screenshot({path:path.join(root,'artifacts',`first-${name}.png`),fullPage:true});
  await page.getByRole('button',{name:'Approved reference',exact:true}).click();
  await page.locator('#image-name').filter({hasText:'Approved native reference'}).waitFor();
  const download=page.waitForEvent('download');await page.locator('#frame').click();
  const frame=await fs.readFile(await (await download).path());
  assert.deepEqual(frame,await fs.readFile(path.join(root,'tests/fixtures/approved-frame.bin')));
  await page.locator('#preview').focus();await page.keyboard.press('Shift+ArrowRight');assert.equal(await page.locator('#x').inputValue(),'10');
  await page.keyboard.press('+');assert.equal(Number(await page.locator('#zoom').inputValue()),1.1);
  await page.locator('#reset').click();
  await page.locator('summary').filter({hasText:'Edit'}).click();await page.locator('[data-action="invert"]').click();assert.equal(await page.locator('#invert').isChecked(),true);
  await page.locator('#invert').uncheck();
  await page.locator('#file').setInputFiles(path.join(root,'tests/fixtures/approved-native.png'));
  await page.locator('#image-name').filter({hasText:'approved-native.png'}).waitFor();
  for (const detail of await page.locator('nav details').all()) {
    const summary = detail.locator('summary');
    await summary.click();
    const menu = detail.locator('.menu');
    const box = await menu.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width, `Menu clipped at ${width}px: ${JSON.stringify(box)}`);
    await page.keyboard.press('Escape');
  }
  await page.locator('summary').filter({hasText:'File'}).click();
  await page.locator('[data-action="firmware"]').click();
  await page.locator('#firmware[open]').waitFor();
  const warning=(await page.locator('#fw-warning').textContent()).trim();
  assert.ok(warning.length>0,`#fw-warning must explain DFU risk at ${width}px`);
  assert.match(await page.locator('#fw-support').textContent(),/Chromium/i);
  assert.match(await page.locator('#fw-installed').textContent(),/unknown|not report/i);
  assert.match(await page.locator('#fw-support').textContent(),/Android/i);
  assert.equal(await page.locator('#fw-flash').isDisabled(),true);
  assert.match(await page.locator('#fw-warning').textContent(),/bootloader/i);
  assert.match(await page.locator('#fw-warning').textContent(),/retry|repeat/i);
  await page.locator('#fw-progress').waitFor();
  const layout=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth,firmwareOpen:document.querySelector('#firmware')?.open===true,controls:[...document.querySelectorAll('main *')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.left<0||r.right>innerWidth);}).map(e=>e.id||e.tagName)}));
  assert.equal(layout.firmwareOpen,true,`Firmware panel must stay open for overflow check at ${width}px`);
  assert.ok(layout.scroll<=layout.width,JSON.stringify(layout));assert.deepEqual(layout.controls,[]);assert.deepEqual(errors,[]);
  assert.ok(requests.every(url=>['127.0.0.1','localhost'].includes(new URL(url).hostname)),`External requests during page load: ${requests.filter(url=>!['127.0.0.1','localhost'].includes(new URL(url).hostname)).join(', ')}`);
  await page.screenshot({path:path.join(root,'artifacts',`editor-${name}.png`),fullPage:true});
  results.push({name,width,height,firstScreen:{overflow:false,firmwareHidden:!firstScreen.firmwareOpen,bluetooth: firstScreen.bluetoothStatus},overflow:false,firmware:'pass',approvedFrame:'exact',keyboard:'pass',menus:'pass',fileInput:'pass',pageErrors:errors});
  await page.close();
 }
 await fs.writeFile(path.join(root,'artifacts/firefox-smoke.json'),JSON.stringify({browser:'Firefox',results},null,2)+'\n');
 console.log(JSON.stringify(results,null,2));
} finally {await browser.close();}
