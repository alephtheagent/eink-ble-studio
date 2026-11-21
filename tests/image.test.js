import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { crc32, packBits, unpackBits, renderGray } from '../web/image.js';
const vectors = JSON.parse(fs.readFileSync(new URL('./vectors.json', import.meta.url)));
for (const [i,v] of vectors.crc.entries()) test(`shared CRC vector ${i}`,()=>assert.equal(crc32(Buffer.from(v.hex,'hex')),v.value));
for (const v of vectors.packing) test(`shared packing ${v.width}×${v.height}: black polarity, stride and padding`,()=>{
 const packed=packBits(v.gray,v.width,v.height);
 assert.deepEqual(Buffer.from(packed),Buffer.from(v.packedHex,'hex'));
 assert.equal(crc32(packed),v.crc32);
 assert.deepEqual([...unpackBits(packed,v.width,v.height)],v.gray);
});
test('approved reference pixel-for-pixel survives conversion',()=>{
 const frame=fs.readFileSync(new URL('./fixtures/approved-frame.bin',import.meta.url));
 assert.equal(crc32(frame),vectors.approved.crc32);
 const pixels=unpackBits(frame);
 const rgba=Uint8Array.from([...pixels].flatMap(v=>[v,v,v,255]));
 assert.deepEqual(Buffer.from(packBits(renderGray(rgba,122,250,{mode:'cover'}))),frame);
 for (const mode of ['vertical','tile']) assert.deepEqual(Buffer.from(packBits(renderGray(rgba,122,250,{mode,tileSize:122}))),frame);
});
test('threshold boundary, inversion, brightness and contrast',()=>{
 assert.equal(packBits([0,127,128,255],4,1)[0],0xc0);
 assert.equal(packBits([0,127,128,255],4,1,{invert:true})[0],0x30);
 assert.equal(packBits([127,128],2,1,{brightness:1})[0],0);
 assert.equal(packBits([100,150],2,1,{contrast:100})[0],128);
});
test('Floyd–Steinberg diffusion and Bayer use real spatial patterns',()=>{
 const gray=new Uint8Array(16).fill(128);
 assert.deepEqual([...packBits(gray,4,4,{dither:'bayer'})],[0x50,0xa0,0x50,0xa0]);
 assert.deepEqual([...packBits(gray,4,4,{dither:'floyd-steinberg'})],[0x50,0xa0,0x50,0xa0]);
 assert.deepEqual([...packBits(gray,4,4,{dither:'none'})],[0,0,0,0]);
});
test('transparent pixels composite white; fit has margins; cover and tiles have none',()=>{
 const transparent=new Uint8Array(8);assert.ok(renderGray(transparent,2,1).every(v=>v===255));
 const black=new Uint8Array([0,0,0,255,0,0,0,255]);
 const fit=renderGray(black,2,1,{mode:'fit'});assert.equal(fit[0],255);assert.equal(fit[125*122],0);
 for(const mode of ['cover','fill','tile','vertical'])assert.ok(renderGray(black,2,1,{mode,tileSize:7,x:0,y:0}).every(v=>v===0),mode);
 for(const mode of ['tile','vertical'])assert.ok(renderGray(black,2,1,{mode,tileSize:7,x:999,y:-999}).every(v=>v===0),mode);
});
test('rotation and position map source axes without mirroring',()=>{
 const source=new Uint8Array([0,0,0,255,255,255,255,255]);
 const rotated=renderGray(source,2,1,{mode:'cover',rotation:90});
 assert.equal(rotated[0],0);assert.equal(rotated[249*122],255);
 assert.ok(renderGray(source,2,1,{mode:'fit',x:1000}).every(v=>v===255));
});
test('invalid sizes and unknown algorithms fail explicitly',()=>{
 assert.throws(()=>packBits([],0,1));assert.throws(()=>packBits([],1,1));
 assert.throws(()=>packBits([0],1,1,{dither:'fake'}));assert.throws(()=>unpackBits([],122,250));
 assert.throws(()=>renderGray([],0,1));assert.throws(()=>renderGray([0,0,0,255],1,1,{zoom:0}));
});
