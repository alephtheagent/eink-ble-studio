import { WIDTH, HEIGHT, FRAME_BYTES, renderGray, packBits, unpackBits } from './image.js';
import { crc32 } from './image.js';
import { withPages } from './pages-wire.js';
import { t, subscribeLanguage } from './i18n.js';
import { FONTS } from './fonts.js';

const $ = id => document.getElementById(id);
const clone = value => structuredClone(value);
const id = () => crypto.randomUUID();
function download(data, name) {
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function validState(state) {
  if (!state || !state.image || !state.image.values || !state.text || !Array.isArray(state.text.layers)) return false;
  const { source, values, rotation } = state.image;
  if (!Number.isFinite(Number(rotation)) || !['cover','fit','fill','vertical','tile'].includes(values.mode) || !['none','floyd-steinberg','bayer'].includes(values.dither)) return false;
  if (!['zoom','x','y','tileSize','brightness','contrast','threshold'].every(k => Number.isFinite(Number(values[k]))) || Number(values.zoom)<=0 || Number(values.tileSize)<=0) return false;
  if (source && (!Number.isSafeInteger(source.width) || !Number.isSafeInteger(source.height) || source.width<1 || source.height<1 || source.width*source.height>16000000 || !Array.isArray(source.data) || source.data.length!==source.width*source.height*4 || !source.data.every(n=>Number.isInteger(n)&&n>=0&&n<=255))) return false;
  if (state.drawing !== null && (!Array.isArray(state.drawing) || state.drawing.length!==WIDTH*HEIGHT || !state.drawing.every(n=>[-1,0,1].includes(n)))) return false;
  return state.text.layers.every(l => l && typeof l.id==='string' && typeof l.name==='string' && typeof l.content==='string' && FONTS.some(f=>f.id===l.fontId) && ['x','y','width','height','scale','rotation','opacity'].every(k=>Number.isFinite(l[k])) && Number.isInteger(l.width) && l.width>=1 && l.width<=500 && Number.isInteger(l.height) && l.height>=1 && l.height<=500 && Number.isInteger(l.scale) && l.scale>=1 && l.scale<=20 && l.opacity>=0 && l.opacity<=100 && ['left','center','right'].includes(l.align) && ['black','white'].includes(l.color) && ['transparent','white','black'].includes(l.background));
}
function thumbnail(frame) {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d'), image = ctx.createImageData(WIDTH, HEIGHT);
  const pixels = unpackBits(Uint8Array.from(frame));
  for (let i = 0; i < pixels.length; i++) {
    image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = pixels[i];
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}
export function createPages({ transport, render, getFrame, capture, restore }) {
  let pages = [], selected = 0, baseline = null, batch = [], pending = null;
  const status = $('pages-status');
  let statusKey=null, statusVars={}, statusPartial=false;
  function setStatus(key, vars = {}, partial = false) {
    statusKey = key;
    statusVars = vars;
    statusPartial = partial;
    status.textContent = t(key, vars) + (partial ? ' ' + t('pages.partial') : '');
  }
  const blank = () => {
    const state = clone(capture());
    state.image.source = null;
    state.image.whiteBackground = true;
    state.text = { layers: [], selected: null, sequence: 0 };
    state.drawing = null;
    return state;
  };
  function save() {
    if (!pages[selected]) return;
    pages[selected].state = capture();
    pages[selected].frame = Array.from(getFrame());
  }
  function show() {
    const list = $('page-list');
    list.replaceChildren();
    pages.forEach((page, i) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'page-thumb';
      button.setAttribute('aria-label', t('pages.page', { number: i + 1 }));
      button.setAttribute('aria-pressed', String(i === selected));
      button.append(thumbnail(page.frame), document.createTextNode(String(i + 1)));
      button.onclick = () => { save(); selected = i; restore(pages[i].state); show(); };
      list.append(button);
    });
  }
  function select(i) { selected = i; restore(pages[i].state); save(); show(); }
  function add(state = blank()) {
    save();
    pages.push({ id: id(), deviceId: 0, state, frame: Array(FRAME_BYTES).fill(0) });
    select(pages.length - 1);
  }
  function exportProject() {
    save();
    const journal=pending && { kind:pending.kind, id:pending.id, crc:pending.crc, order:pending.order, localPageId:pending.page?.id };
    download(JSON.stringify({format:'eink-studio-project',version:1,pages,selected,baseline,pending:journal}), 'eink-project.json');
  }
  $('project-export').onclick=exportProject; $('project-open').onclick=()=>$('project-file').click();
  $('project-file').onchange=async e=>{
    const file=e.target.files[0]; if (!file) return;
    try {
      const project=JSON.parse(await file.text());
      if (project.format!=='eink-studio-project'||project.version!==1||!Array.isArray(project.pages)||project.pages.some(p=>!p || typeof p.id!=='string' || !Number.isInteger(p.deviceId) || p.deviceId<0 || p.deviceId>0xffffffff || !validState(p.state) || !Array.isArray(p.frame) || p.frame.length!==FRAME_BYTES || !p.frame.every((n,i)=>Number.isInteger(n)&&n>=0&&n<=255&&(i%16!==15||!(n&63)))) || new Set(project.pages.map(p=>p.id)).size!==project.pages.length || new Set(project.pages.map(p=>p.deviceId).filter(Boolean)).size!==project.pages.filter(p=>p.deviceId).length) throw Error(t('pages.invalid'));
      const journal=project.pending;
      if(journal && (!project.baseline || !['upload','delete','order'].includes(journal.kind) || (journal.kind==='upload' && (!Number.isInteger(journal.id) || journal.id<=0 || !Number.isInteger(journal.crc) || (journal.localPageId!==undefined && typeof journal.localPageId!=='string'))) || (journal.kind==='delete' && (!Number.isInteger(journal.id) || journal.id<=0)) || (journal.kind==='order' && (!Array.isArray(journal.order) || !journal.order.every(n=>Number.isInteger(n)&&n>0))))) throw Error(t('pages.invalid'));
      const importedBaseline=project.baseline && Number.isInteger(project.baseline.rev) && Array.isArray(project.baseline.entries) && project.baseline.entries.every(e=>Number.isInteger(e.id)&&Number.isInteger(e.pageRev)&&Number.isInteger(e.crc)) ? project.baseline : null;
      if(journal&&!importedBaseline) throw Error(t('pages.invalid'));
      pages=project.pages; baseline=importedBaseline;
      pending=journal ? {kind:journal.kind,id:journal.id,crc:journal.crc,order:journal.order,page:pages.find(p=>p.id===journal.localPageId)} : null;
      if(pages.length) select(Math.max(0,Math.min(pages.length-1,Number(project.selected)||0))); else { selected=0; restore(blank()); show(); }
      setStatus('pages.opened');
    } catch(err) { setStatus('pages.openError',{error:err.message}); }
    finally { e.target.value=''; }
  };
  $('page-new').onclick = () => add();
  $('page-duplicate').onclick = () => {
    if (!pages[selected]) return;
    save();
    const page = clone(pages[selected]);
    page.id = id();
    page.deviceId = 0;
    pages.splice(selected + 1, 0, page);
    select(selected + 1);
  };
  $('page-delete').onclick = () => {
    if (!pages.length) return;
    pages.splice(selected, 1);
    if (pages.length) select(Math.min(selected, pages.length - 1));
    else { selected = 0; restore(blank()); show(); }
  };
  $('pages-clear').onclick = () => {
    if (!confirm(t('pages.clearConfirm'))) return;
    pages = []; selected = 0; restore(blank()); show();
  };
  for (const [name, delta] of [['page-up', -1], ['page-down', 1]]) $(name).onclick = () => {
    save();
    const j = selected + delta;
    if (j < 0 || j >= pages.length) return;
    [pages[selected], pages[j]] = [pages[j], pages[selected]];
    selected = j;
    show();
  };
  $('batch-open').onclick = () => $('batch-files').click();
  async function batchFrames() {
    const mode = $('batch-mode').value, rotation = Number($('batch-rotation').value);
    const threshold = Number($('batch-threshold').value), dither = $('batch-dither').value;
    return batch.map(source => packBits(renderGray(source.data, source.width, source.height, { mode, rotation }), WIDTH, HEIGHT, { threshold, dither }));
  }
  async function batchPreview() {
    const frames = await batchFrames();
    $('batch-preview').replaceChildren(...frames.map(thumbnail));
  }
  $('batch-files').onchange = async e => {
    try {
      batch = [];
      for (const file of e.target.files) {
        const bitmap = await createImageBitmap(file), canvas = document.createElement('canvas');
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        batch.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
        bitmap.close();
      }
      $('batch-panel').hidden = !batch.length;
      $('batch-panel').open = !!batch.length;
      await batchPreview();
    } catch (err) { setStatus('pages.importError', { error: err.message }); }
    finally { e.target.value = ''; }
  };
  function rasterState(frame) {
    const pixels=unpackBits(frame), rgba=new Uint8ClampedArray(WIDTH*HEIGHT*4);
    for(let i=0;i<pixels.length;i++) { rgba[i*4]=rgba[i*4+1]=rgba[i*4+2]=pixels[i]; rgba[i*4+3]=255; }
    const state=blank();
    state.image.source={width:WIDTH,height:HEIGHT,data:Array.from(rgba)};
    state.image.values={...state.image.values,mode:'fill',zoom:'1',x:'0',y:'0',threshold:'128',brightness:'0',contrast:'0',dither:'none',invert:false};
    state.image.rotation=0;
    return state;
  }
  async function receivePages() {
    const dialog=$('receive-dialog'); dialog.returnValue='cancel'; dialog.showModal();
    const choice=await new Promise(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue),{once:true}));
    if(choice!=='save'&&choice!=='replace')return;
    if(choice==='save')exportProject();
    document.querySelector('main').inert=true;
    try {
      const result=await withPages(transport,async wire=>{
        const snapshot=await wire.list(), loaded=[];
        for(const entry of snapshot.entries) {
          const frame=await wire.read(entry,snapshot.rev,(done,total)=>setStatus('pages.progress',{done,total}));
          loaded.push({id:id(),deviceId:entry.id,state:rasterState(frame),frame:Array.from(frame)});
        }
        const end=await wire.list(); if(end.rev!==snapshot.rev)throw Error(t('pages.conflict'));
        return {snapshot,loaded};
      });
      baseline=result.snapshot; pending=null; pages=result.loaded;
      if(pages.length)select(0);else {selected=0;restore(blank());show();}
      setStatus('pages.received');
    } catch(err) { setStatus('pages.error',{error:err.message}); }
    finally { document.querySelector('main').inert=false; }
  }
  $('pages-receive').onclick=receivePages;
  async function sendPages() { save(); document.querySelector('main').inert=true; try { await withPages(transport,async wire=>{
    // ABORT only clears an uncommitted transfer. A pending flash operation may
    // reject it as busy; in that case stop and let the user retry after it settles.
    if (pending?.kind === 'upload' || pending?.kind === 'order') await wire.request(Uint8Array.of(11));
    let current=await wire.list();
    if(!baseline) { if(current.entries.length)throw Error(t('pages.conflict')); baseline=current; }
    if(current.rev===baseline.rev && (current.entries.length!==baseline.entries.length || current.entries.some((e,i)=>{ const b=baseline.entries[i]; return e.id!==b.id || e.pageRev!==b.pageRev || e.crc!==b.crc; }))) throw Error(t('pages.conflict'));
    if(current.rev!==baseline.rev) {
      if(!pending || current.rev!==baseline.rev+1) throw Error(t('pages.conflict'));
      const unchanged=baseline.entries.filter(e=>e.id!==pending.id), now=current.entries.filter(e=>e.id!==pending.id);
      const same=unchanged.length===now.length && (pending.kind==='order' ? unchanged.every(e=>now.some(n=>e.id===n.id&&e.pageRev===n.pageRev&&e.crc===n.crc)) : unchanged.every((e,i)=>e.id===now[i].id && e.pageRev===now[i].pageRev && e.crc===now[i].crc));
      const found=current.entries.find(e=>e.id===pending.id);
      const previous=baseline.entries.find(e=>e.id===pending.id);
      const matches=pending.kind==='upload' ? !!found && found.crc===pending.crc && found.pageRev===(previous?.pageRev||0)+1 : pending.kind==='delete' ? !found : pending.order.every((id,i)=>current.entries[i]?.id===id);
      if(!same || !matches) throw Error(t('pages.conflict'));
      if(pending.kind==='upload' && pages.includes(pending.page)) pending.page.deviceId=pending.id;
      baseline=current; pending=null;
    } else pending=null;
    let rev=current.rev;
    async function updateBaseline(expected) { const snapshot=await wire.list(); if(snapshot.rev!==expected)throw Error(t('pages.conflict')); baseline=snapshot; pending=null; }
    const desired=new Set(pages.map(p=>p.deviceId).filter(Boolean));
    for(const entry of current.entries) if(!desired.has(entry.id)) { pending={kind:'delete',id:entry.id}; rev=await wire.remove(rev,entry); await updateBaseline(rev); }
    for(const page of pages) {
      const frame=Uint8Array.from(page.frame), existing=baseline.entries.find(e=>e.id===page.deviceId), crc=crc32(frame);
      if(existing&&existing.crc===crc)continue;
      const result=await wire.upload(rev,existing,frame,(done,total)=>setStatus('pages.progress',{done,total}), reserved=>{pending={kind:'upload',id:reserved,crc,page};});
      rev=result.rev;page.deviceId=result.id;await updateBaseline(rev);
    }
    const order=pages.map(p=>p.deviceId);
    if(order.some((id,i)=>baseline.entries[i]?.id!==id)) { pending={kind:'order',order}; rev=await wire.order(rev,order);await updateBaseline(rev); }
  }); setStatus('pages.sent'); } catch(err) { setStatus('pages.error',{error:err.message},true); } finally { document.querySelector('main').inert=false; } }
  $('pages-send').onclick=sendPages;
  for(const name of ['batch-mode','batch-rotation','batch-threshold','batch-dither']) $(name).oninput=batchPreview;
  $('batch-apply').onclick=async()=>{
    save();
    const frames=await batchFrames();
    for(let i=0;i<frames.length;i++) {
      const source=batch[i], state=blank();
      state.image.source={width:source.width,height:source.height,data:Array.from(source.data)};
      state.image.values={...state.image.values,mode:$('batch-mode').value,zoom:'1',x:'0',y:'0',threshold:$('batch-threshold').value,brightness:'0',contrast:'0',dither:$('batch-dither').value,invert:false};
      state.image.rotation=Number($('batch-rotation').value);
      pages.push({id:id(),deviceId:0,state,frame:Array.from(frames[i])});
    }
    batch=[]; $('batch-panel').hidden=true; select(pages.length-1);
  };
  pages=[{id:id(),deviceId:0,state:blank(),frame:Array(FRAME_BYTES).fill(0)}]; select(0);
  subscribeLanguage(()=>{show();if(statusKey)setStatus(statusKey,statusVars,statusPartial);});
  return { exportProject, refresh() { const canvas=$('page-list').children[selected]?.querySelector('canvas'); if(canvas) canvas.getContext('2d').drawImage($('native'),0,0); }, get pages(){save();return pages;}, get baseline(){return baseline;} };
}
