// Minimal host-side stand-ins for the Arduino String class and millis().
#pragma once
#include <string>
#include <cstdlib>

class String {
 public:
  String() {}
  String(const char *s) : s_(s ? s : "") {}
  String(const std::string &s) : s_(s) {}
  unsigned int length() const { return (unsigned int)s_.size(); }
  int indexOf(char ch) const { return indexOf(ch, 0); }
  int indexOf(char ch, unsigned int from) const {
    if (from >= s_.size()) return -1;
    size_t p = s_.find(ch, from);
    return p == std::string::npos ? -1 : (int)p;
  }
  String substring(unsigned int from) const { return from >= s_.size() ? String("") : String(s_.substr(from)); }
  String substring(unsigned int from, unsigned int to) const {
    if (from > to) { unsigned int t = from; from = to; to = t; }
    if (from >= s_.size()) return String("");
    return String(s_.substr(from, to - from));
  }
  long toInt() const { return std::atol(s_.c_str()); }  // Arduino: 0 on garbage
  bool startsWith(const String &p) const { return s_.compare(0, p.s_.size(), p.s_) == 0; }
  bool operator==(const char *o) const { return s_ == o; }
  void trim() {
    size_t a = s_.find_first_not_of(" \t\r\n"), b = s_.find_last_not_of(" \t\r\n");
    s_ = (a == std::string::npos) ? "" : s_.substr(a, b - a + 1);
  }
  const char *c_str() const { return s_.c_str(); }
 private:
  std::string s_;
};

static unsigned long g_fake_millis = 0;
static inline unsigned long millis() { return g_fake_millis; }
