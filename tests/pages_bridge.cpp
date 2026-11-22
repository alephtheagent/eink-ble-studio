#include "page_storage.h"
#include "page_wire.h"
#include <array>
#include <cassert>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <memory>
#include <string>
#include <vector>
using namespace eink::pages;
struct Flash {
  std::array<uint8_t, 32 * SECTOR> bytes;
  Flash() { bytes.fill(255); }
  bool read(uint32_t a, void* p, size_t n) { if(a < BASE || a + n > BASE + bytes.size()) return false; memcpy(p, bytes.data()+a-BASE,n); return true; }
  bool program(uint32_t a, const void* p, size_t n) { if(a < BASE || a + n > BASE + bytes.size()) return false; const auto* src=static_cast<const uint8_t*>(p); for(size_t i=0;i<n;i++) { auto& d=bytes[a-BASE+i]; if((d&src[i])!=src[i]) return false; d &= src[i]; } return true; }
  bool erase(uint32_t a) { if(a < BASE || a + SECTOR > BASE + bytes.size() || a % SECTOR) return false; memset(bytes.data()+a-BASE,255,SECTOR); return true; }
};
static void print(const uint8_t* p,size_t n) { static const char* h="0123456789abcdef"; for(size_t i=0;i<n;i++) std::cout<<h[p[i]>>4]<<h[p[i]&15]; std::cout<<std::endl; }
int main() {
  Flash f; using Store=Storage<Flash>; std::unique_ptr<Store> s; std::unique_ptr<Endpoint<Store>> endpoint;
  auto boot=[&] { endpoint.reset(); s.reset(new Store(f)); assert(s->begin()); endpoint.reset(new Endpoint<Store>(*s)); }; boot();
  char op; while(std::cin>>op) {
    if(op=='W') { std::string str; std::cin>>str; std::vector<uint8_t> bytes; for(size_t i=0;i+1<str.size();i+=2) bytes.push_back(static_cast<uint8_t>(std::stoul(str.substr(i,2),nullptr,16))); endpoint->command(bytes.data(),bytes.size()); }
    else if(op=='R') boot(); else if(op=='X') endpoint->disconnect();
    uint8_t result[20]={}; if(op=='D') { size_t n=endpoint->data(result); print(result,n); }
    else { endpoint->status(result); print(result,20); if(op=='S') endpoint->poll(); }
  }
}
