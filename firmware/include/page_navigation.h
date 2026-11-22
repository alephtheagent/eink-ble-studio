#ifndef EINK_PAGE_NAVIGATION_H
#define EINK_PAGE_NAVIGATION_H
#include "page_storage.h"
namespace eink { namespace pages {
// A board-specific input may call move(); no GPIO or interrupt is assumed.
class Navigation {
 public:
  Navigation() : selected_(0) {}
  template<class Store> uint32_t move(const Store& store, int direction) {
    unsigned count = store.count(); if (!count || !direction) return 0;
    unsigned index = 0;
    for (; index < count; ++index) if (store.entry(index)->id == selected_) break;
    if (index == count) index = direction > 0 ? 0 : count - 1;
    else if (direction > 0) index = (index + 1) % count;
    else index = index ? index - 1 : count - 1;
    selected_ = store.entry(index)->id; return selected_;
  }
  void select(uint32_t id) { selected_ = id; }
 private:
  uint32_t selected_;
};
} }
#endif
