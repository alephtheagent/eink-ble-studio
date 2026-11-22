#ifndef EINK_PAGE_WIRE_H
#define EINK_PAGE_WIRE_H
#include "page_storage.h"
namespace eink { namespace pages {
template<class Store> class Endpoint {
 public:
  explicit Endpoint(Store& store) : store_(store), op_(0), error_(OK), pending_(false), mode_(0), owner_(0), expected_(0), id_(0), pageRev_(0), value_(0), crc_(0), offset_(0), count_(0), dataLen_(0), show_(false) { memset(frame_, 0, sizeof(frame_)); }
  void command(const uint8_t* p, size_t n, uint16_t conn = 0) {
    if (pending_) return;
    if (!p || !n || n > 244) { op_ = 0; error_ = MALFORMED; return; }
    uint8_t op = p[0];
    // A pending display copy owns frame_; only continuation of the active transfer may proceed.
    if (show_ && !(mode_ && owner_ == conn && (op == 5 || op == 6 || op == 9 || op == 10 || op == 11))) { op_ = op; error_ = BUSY; return; }
    if (mode_ && owner_ != conn) { op_ = op; error_ = BUSY; return; }
    if (mode_ && op != 5 && op != 6 && op != 9 && op != 10 && op != 11) { op_ = op; error_ = BUSY; return; }
    op_ = op; error_ = OK; dataLen_ = 0; value_ = 0;
    if (!store_.healthy()) { error_ = STORAGE_ERROR; return; }
    switch (op) {
      case 1:
        if (n != 1) break;
        id_ = store_.count(); pageRev_ = CAPACITY; value_ = store_.freeSlots(); return;
      case 2: {
        if (n != 3) break;
        const Entry* e = store_.entry(get16(p + 1));
        if (!e) { error_ = NOT_FOUND; return; }
        id_ = e->id; pageRev_ = e->revision; value_ = e->crc; return;
      }
      case 3: {
        if (n != 7) break;
        uint32_t id = get32(p + 1); uint16_t off = get16(p + 5);
        const Entry* e = store_.find(id); if (!e) { error_ = NOT_FOUND; return; }
        if (off > FRAME_BYTES) { error_ = BAD_OFFSET; return; }
        id_ = id; pageRev_ = e->revision; value_ = e->crc;
        put16(data_, off); dataLen_ = 2; unsigned len = FRAME_BYTES - off; if (len > 18) len = 18;
        error_ = store_.read(id, off, data_ + 2, len); if (error_ == OK) dataLen_ += len; else dataLen_ = 0;
        return;
      }
      case 4: {
        if (n != 17 || mode_) break;
        expected_ = get32(p + 1); uint32_t requested = get32(p + 5); pageRev_ = get32(p + 9); crc_ = get32(p + 13);
        if (expected_ != store_.revision()) { error_ = CONFLICT; return; }
        const Entry* e = requested ? store_.find(requested) : nullptr;
        if (requested && !e) { error_ = NOT_FOUND; return; }
        if ((e && e->revision != pageRev_) || (!requested && pageRev_)) { error_ = CONFLICT; return; }
        if (!requested && (store_.count() >= CAPACITY || store_.nextId() == UINT32_MAX)) { error_ = FULL; return; }
        id_ = requested ? requested : store_.nextId(); create_ = !requested; offset_ = 0; owner_ = conn; mode_ = 1; return;
      }
      case 5: {
        if (n < 4 || mode_ != 1) break;
        uint16_t off = get16(p + 1); size_t len = n - 3;
        if (off != offset_ || len > size_t(FRAME_BYTES - offset_)) { error_ = BAD_OFFSET; value_ = offset_; return; }
        memcpy(frame_ + offset_, p + 3, len); offset_ += len; value_ = offset_; return;
      }
      case 6:
        if (n != 1 || mode_ != 1) break;
        if (offset_ != FRAME_BYTES) { error_ = BAD_OFFSET; value_ = offset_; return; }
        pending_ = true; return;
      case 7:
        if (n != 13 || mode_) break;
        expected_ = get32(p + 1); id_ = get32(p + 5); pageRev_ = get32(p + 9); owner_ = conn; pending_ = true; return;
      case 8:
        if (n != 7 || mode_) break;
        expected_ = get32(p + 1); count_ = get16(p + 5);
        if (expected_ != store_.revision()) { error_ = CONFLICT; return; }
        if (count_ != store_.count() || count_ > CAPACITY) { error_ = MALFORMED; return; }
        owner_ = conn; offset_ = 0; mode_ = 2; return;
      case 9: {
        if (n < 7 || ((n - 3) & 3) || mode_ != 2) break;
        unsigned index = get16(p + 1), items = (n - 3) / 4;
        if (index != offset_ || items > unsigned(count_ - offset_)) { error_ = BAD_OFFSET; value_ = offset_; return; }
        for (unsigned i = 0; i < items; ++i) order_[offset_++] = get32(p + 3 + i * 4);
        value_ = offset_; return;
      }
      case 10:
        if (n != 1 || mode_ != 2) break;
        if (offset_ != count_) { error_ = BAD_OFFSET; value_ = offset_; return; }
        pending_ = true; return;
      case 11:
        if (n != 1) break;
        mode_ = 0; offset_ = 0; return;
      case 12:
        if (n != 5 || mode_) break;
        id_ = get32(p + 1); if (!store_.find(id_)) { error_ = NOT_FOUND; return; }
        owner_ = conn; pending_ = true; return;
    }
    error_ = MALFORMED;
  }
  void poll() {
    if (!pending_) return;
    if (op_ == 6) { Entry e; error_ = store_.put(expected_, create_ ? 0 : id_, pageRev_, crc_, frame_, e); if (error_ == OK) { id_ = e.id; pageRev_ = e.revision; value_ = e.crc; } mode_ = 0; }
    else if (op_ == 7) error_ = store_.remove(expected_, id_, pageRev_);
    else if (op_ == 10) { error_ = store_.reorder(expected_, order_, count_); mode_ = 0; }
    else if (op_ == 12) { error_ = store_.read(id_, 0, frame_, FRAME_BYTES); if (error_ == OK) show_ = true; }
    pending_ = false;
  }
  void status(uint8_t out[20]) const { out[0] = 1; out[1] = op_; out[2] = error_; out[3] = pending_ ? 1 : 0; put32(out + 4, store_.revision()); put32(out + 8, id_); put32(out + 12, pageRev_); put32(out + 16, value_); }
  size_t data(uint8_t out[20]) const { memcpy(out, data_, dataLen_); return dataLen_; }
  void disconnect(uint16_t conn = 0) { if (owner_ == conn && !pending_) mode_ = 0; }
  bool busy() const { return mode_ || pending_ || show_; }
  bool pending() const { return pending_; }
  bool takeShow() { bool value = show_; show_ = false; return value; }
  const uint8_t* frame() const { return frame_; }
 private:
  Store& store_; uint8_t op_; Result error_; bool pending_; uint8_t mode_; uint16_t owner_; uint32_t expected_, id_, pageRev_, value_, crc_; uint16_t offset_, count_; size_t dataLen_; bool show_, create_; uint32_t order_[CAPACITY]; uint8_t data_[20]; alignas(4) uint8_t frame_[FRAME_BYTES];
};
} }
#endif
