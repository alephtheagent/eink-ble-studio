#include "protocol.h"
#include "vectors.h"
#include <cassert>
#include <cstdio>
#include <vector>
using namespace eink;
static std::vector<uint8_t> start(uint32_t id, uint32_t crc, uint16_t size=4000) {
  std::vector<uint8_t> p(11); p[0]=1; put32(p.data()+1,id); put16(p.data()+5,size); put32(p.data()+7,crc); return p;
}
static std::vector<uint8_t> simple(uint8_t op,uint32_t id=7) {
  std::vector<uint8_t> p(5); p[0]=op; put32(p.data()+1,id); return p;
}
static std::vector<uint8_t> data(uint16_t offset,const uint8_t* src,size_t count,uint32_t id=7) {
  std::vector<uint8_t> p(7+count); p[0]=2; put32(p.data()+1,id); put16(p.data()+5,offset);
  for(size_t i=0;i<count;++i)p[7+i]=src[i]; return p;
}
static void send(Protocol& p,const std::vector<uint8_t>& v,uint32_t now=1){p.command(v.data(),v.size(),now);}
static uint16_t received(const Protocol& p){uint8_t s[20];p.status(s);return get16(s+8);}
static void fill(Protocol& p,const uint8_t* frame,uint32_t expected){
 send(p,start(7,expected));
 for(uint16_t i=0;i<4000;i+=13)send(p,data(i,frame+i,(4000-i<13)?4000-i:13));
}
static void testActions() {
  Protocol p;
  uint8_t reset[] = {0x06};
  p.command(reset, sizeof reset, 10, 0);
  uint8_t status[20];
  p.status(status);
  assert(status[3] == ACTION_RESET_WELCOME && p.action() == ACTION_RESET_WELCOME);
  assert(p.state() == IDLE && p.error() == NONE);
  assert(p.consumeAction() == ACTION_RESET_WELCOME);
  assert(p.consumeAction() == ACTION_NONE && p.action() == ACTION_NONE);

  uint8_t enter[] = {0x05};
  p.command(enter, sizeof enter, 11, 0);
  p.status2(status);
  assert(status[3] == ACTION_ENTER_DFU && p.consumeAction() == ACTION_ENTER_DFU);

  uint8_t reset2[] = {0x16};
  p.command2(reset2, sizeof reset2, 12, 0);
  p.status2(status);
  assert(status[3] == ACTION_RESET_WELCOME && p.action() == ACTION_RESET_WELCOME);
  assert(p.consumeAction() == ACTION_RESET_WELCOME);
  uint8_t enter2[] = {0x15};
  p.command2(enter2, sizeof enter2, 13, 0);
  p.status2(status);
  assert(status[3] == ACTION_ENTER_DFU && p.consumeAction() == ACTION_ENTER_DFU);
  assert(p.consumeAction() == ACTION_NONE);
  Protocol receiving;
  const std::vector<uint8_t> begin = start(9, 0);
  send(receiving, begin);
  const uint8_t blockedDfu[] = {0x05};
  receiving.command(blockedDfu, sizeof blockedDfu, 14, 0);
  receiving.status(status);
  assert(receiving.state() == RECEIVING && receiving.error() == BUSY &&
         receiving.action() == ACTION_NONE && status[3] == ACTION_NONE);


  uint8_t malformed[] = {0x05, 0};
  p.command(malformed, sizeof malformed, 14, 0);
  assert(p.error() == MALFORMED && p.action() == ACTION_NONE && p.state() == IDLE);
  p.command(nullptr, 0, 15, 0);
  assert(p.error() == MALFORMED && p.action() == ACTION_NONE && p.state() == IDLE);
  uint8_t malformed2[] = {0x16, 0};
  p.command2(malformed2, sizeof malformed2, 16, 0);
  assert(p.error() == MALFORMED && p.action() == ACTION_NONE && p.state() == IDLE);
  uint8_t unknown2[] = {0x17};
  p.command2(unknown2, sizeof unknown2, 17, 0);
  assert(p.error() == MALFORMED && p.action() == ACTION_NONE && p.state() == IDLE);
}

int main(){
 for(const auto& v:CRC_VECTORS)assert(crc32(v.bytes,v.size)==v.expected);
 for(const auto& v:PIXEL_VECTORS){
  assert(crc32(v.packed,v.packedSize)==v.crc);
  const unsigned stride=(v.width+7)/8;
  for(unsigned y=0;y<v.height;++y){
   for(unsigned x=0;x<v.width;++x)assert(bool(v.packed[y*stride+x/8]&(128>>(x%8)))==(v.gray[y*v.width+x]<128));
   if(v.width%8)assert((v.packed[(y+1)*stride-1]&((1<<(8-v.width%8))-1))==0);
  }
 }
 testActions();
 Protocol p; uint8_t white[4000]={};
 send(p,start(7,crc32(white,4000),3999));assert(p.error()==LENGTH && p.state()==IDLE);
 send(p,start(7,crc32(white,4000)));assert(p.state()==RECEIVING);
 send(p,simple(3));assert(p.error()==LENGTH && !p.beginRefresh());
 send(p,data(13,white,13));assert(p.error()==OFFSET && received(p)==0);
 send(p,data(0,white,13,8));assert(p.error()==ID && received(p)==0);
 send(p,data(0,white,13));assert(p.error()==NONE && received(p)==13);
 send(p,start(7,crc32(white,4000)));assert(received(p)==13);
 send(p,data(0,white,13));assert(p.error()==NONE && received(p)==13);
 uint8_t black[13]={128};send(p,data(0,black,13));assert(p.error()==OFFSET && received(p)==13);
 send(p,data(12,white,13));assert(p.error()==OFFSET && received(p)==13);
 send(p,data(3999,white,2));assert(p.error()==LENGTH && received(p)==13);
 send(p,simple(4));assert(p.state()==IDLE && received(p)==0);
 uint8_t oversized[21]={2};p.command(oversized,21,1);assert(p.error()==MALFORMED);
 p.command(nullptr,0,1);assert(p.error()==MALFORMED);
 fill(p,white,123);send(p,simple(3));assert(p.state()==ERROR && p.error()==CRC && !p.beginRefresh());
 white[15]=1;fill(p,white,crc32(white,4000));send(p,simple(3));assert(p.state()==ERROR && p.error()==PADDING && !p.beginRefresh());white[15]=0;
 fill(p,APPROVED,APPROVED_CRC);send(p,simple(3));assert(p.state()==QUEUED);
 send(p,simple(3));assert(p.state()==QUEUED && p.error()==NONE);
 send(p,start(8,0));assert(p.error()==BUSY && p.state()==QUEUED);
 p.disconnect();assert(p.state()==QUEUED);assert(p.beginRefresh());assert(!p.beginRefresh());
 send(p,simple(4));assert(p.error()==BUSY && p.state()==REFRESHING);
 for(size_t i=0;i<4000;++i)assert(p.frame()[i]==APPROVED[i]);
 p.finishRefresh();assert(p.state()==DONE);uint8_t s[20];p.status(s);assert(get32(s+16)==1);
 send(p,simple(3));p.finishRefresh();p.status(s);assert(get32(s+16)==1 && p.error()==NONE);
 send(p,start(7,0),100);p.disconnect();assert(p.state()==ERROR && p.error()==DISCONNECTED);
 send(p,start(7,0),101);assert(p.state()==RECEIVING && received(p)==0);
 p.tick(15100);assert(p.state()==RECEIVING);p.tick(15101);assert(p.state()==ERROR && p.error()==TIMEOUT);
 send(p,start(7,0),0xfffffff0);p.tick(0x00003a88);assert(p.state()==ERROR && p.error()==TIMEOUT);
 std::puts("C++: shared vectors, protocol bounds/CRC/duplicates/recovery, v1/v2 reset/DFU actions and status PASS");
}
