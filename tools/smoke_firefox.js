// Optional real-browser smoke, Firefox only. Start npm run serve first.
import { firefox } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const browser=await firefox.launch({headless:true});
const results=[];
try {
 for(const [name,width,height] of [['desktop',1280,900],['mobile',390,844],['narrow',320,740]]) {
  const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(process.env.STUDIO_URL||'http://127.0.0.1:8765/');
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
  for (const summary of await page.locator('summary').all()) {
    await summary.click();
    const menu = summary.locator('..').locator('.menu');
    const box = await menu.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width, `Menu clipped at ${width}px: ${JSON.stringify(box)}`);
    await page.keyboard.press('Escape');
  }
  const layout=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth,controls:[...document.querySelectorAll('main button,main input:not([type=file]),main select')].filter(e=>{const r=e.getBoundingClientRect();return r.left<0||r.right>innerWidth;}).map(e=>e.id)}));
  assert.ok(layout.scroll<=layout.width,JSON.stringify(layout));assert.deepEqual(layout.controls,[]);assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(root,'artifacts',`editor-${name}.png`),fullPage:true});
  results.push({name,width,height,overflow:false,approvedFrame:'exact',keyboard:'pass',menus:'pass',fileInput:'pass',pageErrors:errors});
  await page.close();
 }
 await fs.writeFile(path.join(root,'artifacts/firefox-smoke.json'),JSON.stringify({browser:'Firefox',results},null,2)+'\n');
 console.log(JSON.stringify(results,null,2));
} finally {await browser.close();}
