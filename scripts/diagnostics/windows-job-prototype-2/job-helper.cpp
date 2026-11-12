#define _WIN32_WINNT 0x0A00
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <io.h>
#include <stdint.h>
#include <stdio.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <string>
#include <vector>
#include <deque>
#include <mutex>
#include <algorithm>

static HANDLE control = INVALID_HANDLE_VALUE;
static HANDLE available;
static std::mutex queueMutex;
static std::deque<std::vector<unsigned char>> commands;
static bool readerEnded = false;
static DWORD readerError = 0;
static HANDLE job = NULL;
static PROCESS_INFORMATION root = {};
static bool rootReported = false;
static bool started = false;
static bool negative = false;
static std::wstring fault;
struct Observer { HANDLE handle; DWORD pid; unsigned long long created; std::string token; BOOL member; };
static std::vector<Observer> observers;
struct BoundMember { HANDLE handle; DWORD pid; unsigned long long created; };
static std::vector<BoundMember> bound;
static bool sealAccepted = false;
static bool bindingComplete = false;
static bool settlementPending = false;
static unsigned long long operationDeadline = 0;

static unsigned long long filetime(FILETIME t) { return (static_cast<unsigned long long>(t.dwHighDateTime) << 32) | t.dwLowDateTime; }
static unsigned long long now() { FILETIME t; GetSystemTimePreciseAsFileTime(&t); return filetime(t) / 10000 - 11644473600000ULL; }
static bool transfer(bool writing, void* bytes, DWORD length, DWORD* error) {
  auto p = static_cast<unsigned char*>(bytes);
  while (length) {
    OVERLAPPED ov = {};
    ov.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!ov.hEvent) { *error = GetLastError(); return false; }
    DWORD done = 0;
    BOOL ok = writing ? WriteFile(control, p, length, &done, &ov) : ReadFile(control, p, length, &done, &ov);
    DWORD e = ok ? ERROR_SUCCESS : GetLastError();
    if (!ok && e == ERROR_IO_PENDING) {
      ok = GetOverlappedResult(control, &ov, &done, TRUE);
      e = ok ? ERROR_SUCCESS : GetLastError();
    }
    CloseHandle(ov.hEvent);
    if (!ok || done == 0) { *error = ok ? ERROR_BROKEN_PIPE : e; return false; }
    p += done; length -= done;
  }
  *error = ERROR_SUCCESS;
  return true;
}
static void emit(const char* event, const char* fields = "", ...) {
  char suffix[24000];
  va_list args; va_start(args, fields); int n = vsnprintf(suffix, sizeof suffix, fields, args); va_end(args);
  if (n < 0 || n >= static_cast<int>(sizeof suffix)) ExitProcess(93);
  char line[24576];
  n = snprintf(line, sizeof line, "{\"event\":\"%s\",\"timeMs\":%llu,\"tickMs\":%llu%s}\n", event, now(), GetTickCount64(), suffix);
  if (n < 0 || n >= static_cast<int>(sizeof line)) ExitProcess(94);
  DWORD error;
  if (!transfer(true, line, static_cast<DWORD>(n), &error)) ExitProcess(95);
}
static int errorExit(const char* operation, DWORD error, bool injected = false) {
  emit("native-error", ",\"operation\":\"%s\",\"error\":%lu,\"injected\":%s", operation, error, injected ? "true" : "false");
  return 2;
}
static DWORD WINAPI reader(void*) {
  DWORD error = 0;
  for (;;) {
    uint32_t size;
    if (!transfer(false, &size, 4, &error)) break;
    if (!size || size > 65536) { error = ERROR_BAD_LENGTH; break; }
    std::vector<unsigned char> frame(size);
    if (!transfer(false, frame.data(), size, &error)) break;
    { std::lock_guard<std::mutex> lock(queueMutex); commands.push_back(std::move(frame)); }
    SetEvent(available);
  }
  { std::lock_guard<std::mutex> lock(queueMutex); readerEnded = true; readerError = error; }
  SetEvent(available);
  return 0;
}
struct Frame {
  const std::vector<unsigned char>& bytes; size_t offset = 1; bool valid = true;
  uint32_t u32() { uint32_t x = 0; if (offset + 4 > bytes.size()) valid = false; else { memcpy(&x, bytes.data() + offset, 4); offset += 4; } return x; }
  unsigned long long u64() { unsigned long long x = 0; if (offset + 8 > bytes.size()) valid = false; else { memcpy(&x, bytes.data() + offset, 8); offset += 8; } return x; }
  std::wstring wide() { uint32_t n = u32(); if (!valid || n % 2 || n > 60000 || offset + n > bytes.size()) { valid = false; return L""; } std::wstring value(n / 2, L'\0'); memcpy(value.data(), bytes.data() + offset, n); offset += n; return value; }
  bool end() { return valid && offset == bytes.size(); }
};
static bool next(std::vector<unsigned char>& value) {
  std::lock_guard<std::mutex> lock(queueMutex);
  if (commands.empty()) return false;
  value = std::move(commands.front()); commands.pop_front();
  if (!commands.empty()) SetEvent(available);
  return true;
}
static unsigned long long creation(HANDLE process, DWORD* error) {
  FILETIME a, b, c, d;
  if (!GetProcessTimes(process, &a, &b, &c, &d)) { *error = GetLastError(); return 0; }
  *error = 0; return filetime(a);
}
static void rootExit() {
  if (rootReported || !root.hProcess || WaitForSingleObject(root.hProcess, 0) != WAIT_OBJECT_0) return;
  DWORD code;
  if (!GetExitCodeProcess(root.hProcess, &code)) { emit("native-error", ",\"operation\":\"GetExitCodeProcess\",\"error\":%lu", GetLastError()); return; }
  rootReported = true;
  emit("root-exited", ",\"pid\":%lu,\"code\":%lu", root.dwProcessId, code);
}
static bool count(DWORD* value, DWORD* error, HANDLE target) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info = {};
  if (!QueryInformationJobObject(target, JobObjectBasicAccountingInformation, &info, sizeof info, NULL)) { *error = GetLastError(); return false; }
  *value = info.ActiveProcesses; *error = 0; return true;
}
static unsigned snapshot(const char* phase) {
  unsigned pending = 0;
  for (const auto& o : observers) {
    DWORD wait = WaitForSingleObject(o.handle, 0); DWORD e = wait == WAIT_FAILED ? GetLastError() : 0;
    if (wait != WAIT_OBJECT_0) ++pending;
    BOOL currentMember = FALSE; BOOL membershipOk = IsProcessInJob(o.handle, job, &currentMember); DWORD membershipError = membershipOk ? 0 : GetLastError();
    emit("observer-membership", ",\"phase\":\"%s\",\"pid\":%lu,\"created\":\"%llu\",\"memberAtObservation\":%s,\"currentMember\":%s,\"membershipOk\":%s,\"membershipError\":%lu,\"wait\":%lu", phase, o.pid, o.created, o.member ? "true" : "false", currentMember ? "true" : "false", membershipOk ? "true" : "false", membershipError, wait);
    emit("observer", ",\"phase\":\"%s\",\"pid\":%lu,\"created\":\"%llu\",\"token\":\"%s\",\"member\":%s,\"wait\":%lu,\"error\":%lu", phase, o.pid, o.created, o.token.c_str(), o.member ? "true" : "false", wait, e);
  }
  return pending;
}
static void heldDrop() {
  DWORD before = 0, beforeError = 0, after = 0, afterError = 0;
  bool beforeOk = count(&before, &beforeError, job);
  for (auto& o : observers) { CloseHandle(o.handle); o.handle = NULL; }
  observers.clear();
  for (auto& member : bound) CloseHandle(member.handle);
  bound.clear();
  DWORD rootWait = root.hProcess ? WaitForSingleObject(root.hProcess, 0) : WAIT_FAILED;
  if (root.hProcess) { CloseHandle(root.hProcess); root.hProcess = NULL; }
  bool afterOk = count(&after, &afterError, job);
  emit("held-drop", ",\"beforeOk\":%s,\"before\":%lu,\"beforeError\":%lu,\"rootWaitBeforeDrop\":%lu,\"afterOk\":%s,\"after\":%lu,\"afterError\":%lu", beforeOk ? "true" : "false", before, beforeError, rootWait, afterOk ? "true" : "false", after, afterError);
}
static int launch(Frame& f) {
  negative = f.u32() != 0;
  std::wstring image = f.wide(), line = f.wide(), cwd = f.wide(); fault = f.wide();
  if (!f.end()) return errorExit("launch-frame", ERROR_INVALID_DATA);
  if (fault == L"crash-before") ExitProcess(86);
  job = CreateJobObjectW(NULL, NULL);
  if (!job) return errorExit("CreateJobObjectW", GetLastError());
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  HANDLE configured = fault == L"job" ? INVALID_HANDLE_VALUE : job;
  if (!SetInformationJobObject(configured, JobObjectExtendedLimitInformation, &limits, sizeof limits)) return errorExit("SetInformationJobObject", GetLastError(), fault == L"job");
  if (!SetHandleInformation(control, HANDLE_FLAG_INHERIT, 0)) return errorExit("private-control", GetLastError());
  HANDLE inherited[3] = {};
  for (int i = 0; i < 3; ++i) {
    HANDLE source = reinterpret_cast<HANDLE>(_get_osfhandle(i));
    if (!DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &inherited[i], 0, TRUE, DUPLICATE_SAME_ACCESS)) return errorExit("DuplicateHandle-stdio", GetLastError());
  }
  STARTUPINFOEXW si = {}; si.StartupInfo.cb = sizeof si; si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  si.StartupInfo.hStdInput = inherited[0]; si.StartupInfo.hStdOutput = inherited[1]; si.StartupInfo.hStdError = inherited[2];
  SIZE_T bytes = 0; DWORD attributes = negative ? 1 : 2;
  InitializeProcThreadAttributeList(NULL, attributes, 0, &bytes);
  si.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(HeapAlloc(GetProcessHeap(), 0, bytes));
  if (!si.lpAttributeList) return errorExit("attribute-allocation", ERROR_NOT_ENOUGH_MEMORY);
  if (!InitializeProcThreadAttributeList(si.lpAttributeList, attributes, 0, &bytes)) return errorExit("InitializeProcThreadAttributeList", GetLastError());
  SIZE_T inheritedBytes = fault == L"attributes" ? 1 : sizeof inherited;
  if (!UpdateProcThreadAttribute(si.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, inheritedBytes, NULL, NULL)) return errorExit("HANDLE_LIST", GetLastError(), fault == L"attributes");
  if (!negative && !UpdateProcThreadAttribute(si.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job, sizeof job, NULL, NULL)) return errorExit("JOB_LIST", GetLastError());
  wchar_t raw[64]; swprintf_s(raw, L"%llu", reinterpret_cast<unsigned long long>(control)); SetEnvironmentVariableW(L"PROBE_CONTROL_HANDLE", raw);
  swprintf_s(raw, L"%llu", reinterpret_cast<unsigned long long>(job)); SetEnvironmentVariableW(L"PROBE_JOB_HANDLE", raw);
  if (fault == L"create") image += L".missing";
  BOOL created = CreateProcessW(image.c_str(), line.data(), NULL, NULL, TRUE, CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, NULL, cwd.c_str(), &si.StartupInfo, &root);
  DWORD e = created ? 0 : GetLastError();
  DeleteProcThreadAttributeList(si.lpAttributeList); HeapFree(GetProcessHeap(), 0, si.lpAttributeList);
  for (HANDLE handle : inherited) CloseHandle(handle);
  if (!created) return errorExit("CreateProcessW", e, fault == L"create");
  _close(0); _close(1); _close(2);
  BOOL member = FALSE;
  if (!IsProcessInJob(root.hProcess, job, &member)) return errorExit("IsProcessInJob-root", GetLastError());
  DWORD creationError; auto createdAt = creation(root.hProcess, &creationError);
  if (creationError) return errorExit("GetProcessTimes-root", creationError);
  BOOL helperInJob = FALSE; IsProcessInJob(GetCurrentProcess(), NULL, &helperInJob);
  emit("ready", ",\"pid\":%lu,\"created\":\"%llu\",\"member\":%s,\"negative\":%s,\"helperInParentJob\":%s,\"stdioCopiesClosed\":true", root.dwProcessId, createdAt, member ? "true" : "false", negative ? "true" : "false", helperInJob ? "true" : "false");
  if (fault == L"crash-ready") ExitProcess(86);
  return 0;
}
static int observe(Frame& f) {
  DWORD pid = f.u32(); std::wstring tokenWide = f.wide();
  if (!f.end() || tokenWide.size() > 100) return errorExit("observe-frame", ERROR_INVALID_DATA);
  std::string token;
  for (wchar_t c : tokenWide) { if (!((c >= L'a' && c <= L'z') || (c >= L'A' && c <= L'Z') || (c >= L'0' && c <= L'9') || c == L'-' || c == L'_')) return errorExit("observe-token", ERROR_INVALID_DATA); token.push_back(static_cast<char>(c)); }
  HANDLE process = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE, FALSE, pid);
  if (!process) return errorExit("OpenProcess-observer", GetLastError());
  DWORD e; auto created = creation(process, &e); if (e) return errorExit("GetProcessTimes-observer", e);
  BOOL member = FALSE; if (!IsProcessInJob(process, job, &member)) return errorExit("IsProcessInJob-observer", GetLastError());
  observers.push_back({ process, pid, created, token, member });
  emit("observed", ",\"pid\":%lu,\"created\":\"%llu\",\"token\":\"%s\",\"member\":%s,\"wait\":%lu", pid, created, token.c_str(), member ? "true" : "false", WaitForSingleObject(process, 0));
  return 0;
}
static bool memberList(const char* phase, std::vector<DWORD>& pids) {
  const DWORD capacity = 4096;
  std::vector<unsigned char> bytes(sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + capacity * sizeof(ULONG_PTR));
  auto list = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(bytes.data());
  BOOL ok = QueryInformationJobObject(job, JobObjectBasicProcessIdList, list, static_cast<DWORD>(bytes.size()), NULL);
  DWORD e = ok ? 0 : GetLastError();
  emit("member-list", ",\"phase\":\"%s\",\"ok\":%s,\"error\":%lu,\"assigned\":%lu,\"returned\":%lu,\"capacity\":%lu", phase, ok ? "true" : "false", e, list->NumberOfAssignedProcesses, list->NumberOfProcessIdsInList, capacity);
  if (!ok || list->NumberOfAssignedProcesses != list->NumberOfProcessIdsInList || list->NumberOfProcessIdsInList > capacity) return false;
  for (DWORD i = 0; i < list->NumberOfProcessIdsInList; ++i) {
    if (list->ProcessIdList[i] > MAXDWORD) return false;
    pids.push_back(static_cast<DWORD>(list->ProcessIdList[i]));
    emit("listed-member", ",\"phase\":\"%s\",\"pid\":%lu", phase, pids.back());
  }
  std::sort(pids.begin(), pids.end());
  return std::adjacent_find(pids.begin(), pids.end()) == pids.end();
}
static void ledger(const char* phase) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info = {};
  BOOL ok = QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &info, sizeof info, NULL);
  DWORD error = ok ? 0 : GetLastError();
  bool rootInBound = false;
  for (const auto& member : bound) if (member.pid == root.dwProcessId) rootInBound = true;
  emit("lifetime-accounting", ",\"phase\":\"%s\",\"ok\":%s,\"error\":%lu,\"active\":%lu,\"totalProcesses\":%lu,\"totalTerminatedProcesses\":%lu,\"boundHandles\":%zu,\"candidateIdentitiesIncludingRoot\":%zu,\"observerHandlesExcluded\":%zu", phase, ok ? "true" : "false", error, info.ActiveProcesses, info.TotalProcesses, info.TotalTerminatedProcesses, bound.size(), bound.size() + (root.hProcess && !rootInBound ? 1 : 0), observers.size());
}
static int seal(Frame& f) {
  DWORD limit = f.u32(); auto deadline = f.u64();
  if (!f.end() || operationDeadline || now() >= deadline) return errorExit("seal-frame-state", ERROR_INVALID_DATA);
  operationDeadline = deadline;
  DWORD before = 0, be = 0, after = 0, ae = 0;
  bool beforeOk = count(&before, &be, job);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
  BOOL queried = QueryInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof limits, NULL);
  DWORD queryError = queried ? 0 : GetLastError();
  if (!queried) { emit("uncertain", ",\"reason\":\"query-before-seal\",\"error\":%lu", queryError); return 3; }
  limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
  limits.BasicLimitInformation.ActiveProcessLimit = limit;
  ledger("before-seal");
  emit("seal-begin", ",\"limit\":%lu,\"beforeOk\":%s,\"before\":%lu,\"beforeError\":%lu,\"deadlineMs\":%llu", limit, beforeOk ? "true" : "false", before, be, deadline);
  BOOL ok = SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof limits);
  DWORD e = ok ? 0 : GetLastError();
  bool afterOk = count(&after, &ae, job);
  sealAccepted = ok != FALSE;
  emit("seal-result", ",\"limit\":%lu,\"ok\":%s,\"error\":%lu,\"before\":%lu,\"afterOk\":%s,\"after\":%lu,\"afterError\":%lu,\"deadlineMs\":%llu", limit, ok ? "true" : "false", e, before, afterOk ? "true" : "false", after, ae, deadline);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION readback = {};
  BOOL readbackOk = QueryInformationJobObject(job, JobObjectExtendedLimitInformation, &readback, sizeof readback, NULL); DWORD readbackError = readbackOk ? 0 : GetLastError();
  emit("seal-readback", ",\"ok\":%s,\"error\":%lu,\"limitFlags\":%lu,\"activeProcessLimit\":%lu", readbackOk ? "true" : "false", readbackError, readback.BasicLimitInformation.LimitFlags, readback.BasicLimitInformation.ActiveProcessLimit);
  ledger("after-seal"); snapshot("after-seal"); emit("seal-observations-complete");
  return 0;
}
static int bindMembers(Frame& f) {
  auto deadline = f.u64();
  if (!f.end() || !sealAccepted || deadline != operationDeadline || now() >= deadline) { emit("uncertain", ",\"reason\":\"unaccepted-or-expired-seal\""); return 3; }
  ledger("before-bind"); snapshot("before-bind");
  std::vector<DWORD> first, second;
  if (!memberList("before-bind", first)) { emit("uncertain", ",\"reason\":\"incomplete-member-list\""); return 3; }
  for (DWORD pid : first) {
    if (now() >= deadline) { emit("uncertain", ",\"reason\":\"bind-deadline\""); return 3; }
    HANDLE process = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) { emit("uncertain", ",\"reason\":\"bind-open-process\",\"pid\":%lu,\"error\":%lu", pid, GetLastError()); return 3; }
    BOOL member = FALSE; BOOL inJobOk = IsProcessInJob(process, job, &member); DWORD membershipError = inJobOk ? 0 : GetLastError();
    DWORD creationError = 0; auto created = creation(process, &creationError);
    DWORD wait = WaitForSingleObject(process, 0); DWORD waitError = wait == WAIT_FAILED ? GetLastError() : 0;
    emit("bound-member", ",\"pid\":%lu,\"created\":\"%llu\",\"member\":%s,\"membershipError\":%lu,\"creationError\":%lu,\"wait\":%lu,\"waitError\":%lu", pid, created, member ? "true" : "false", membershipError, creationError, wait, waitError);
    if (!inJobOk || !member || creationError || waitError) { CloseHandle(process); emit("uncertain", ",\"reason\":\"ambiguous-member-identity\",\"pid\":%lu", pid); return 3; }
    for (const auto& observed : observers) if (observed.pid == pid && observed.created != created) { CloseHandle(process); emit("uncertain", ",\"reason\":\"known-identity-changed\",\"pid\":%lu", pid); return 3; }
    if (pid == root.dwProcessId) { DWORD e; auto expected = creation(root.hProcess, &e); if (e || expected != created) { CloseHandle(process); emit("uncertain", ",\"reason\":\"root-identity-changed\""); return 3; } }
    bound.push_back({ process, pid, created });
  }
  if (!memberList("after-bind", second) || first != second) { emit("uncertain", ",\"reason\":\"member-list-changed\""); return 3; }
  bindingComplete = true; ledger("after-bind");
  emit("bound-ready", ",\"members\":%zu,\"deadlineMs\":%llu,\"claim\":\"experimental-complete-current-list\"", bound.size(), deadline);
  return 0;
}
static unsigned boundSnapshot(const char* phase) {
  unsigned pending = 0;
  for (const auto& member : bound) {
    DWORD wait = WaitForSingleObject(member.handle, 0); DWORD error = wait == WAIT_FAILED ? GetLastError() : 0;
    if (wait != WAIT_OBJECT_0) ++pending;
    emit("bound-wait", ",\"phase\":\"%s\",\"pid\":%lu,\"created\":\"%llu\",\"wait\":%lu,\"error\":%lu", phase, member.pid, member.created, wait, error);
  }
  return pending;
}
static int stopBound(Frame& f) {
  auto deadline = f.u64();
  if (!f.end() || !bindingComplete || deadline != operationDeadline || now() >= deadline) { emit("uncertain", ",\"reason\":\"unbound-or-expired-stop\""); return 3; }
  emit("stop-selected", ",\"deadlineMs\":%llu,\"witness\":\"sealed-bound-handles\"", deadline);
  BOOL ok = TerminateJobObject(job, 41); DWORD e = ok ? 0 : GetLastError();
  emit("terminate", ",\"ok\":%s,\"error\":%lu", ok ? "true" : "false", e);
  if (!ok) { emit("uncertain", ",\"reason\":\"terminate\",\"error\":%lu", e); return 3; }
  bool countCandidateLogged = false;
  while (now() < deadline) {
    rootExit(); DWORD active = 0, queryError = 0;
    if (!count(&active, &queryError, job)) { emit("uncertain", ",\"reason\":\"accounting\",\"error\":%lu", queryError); return 3; }
    DWORD rootWait = WaitForSingleObject(root.hProcess, 0);
    bool allSignaled = true;
    for (const auto& member : bound) {
      DWORD wait = WaitForSingleObject(member.handle, 0);
      if (wait == WAIT_FAILED) { emit("uncertain", ",\"reason\":\"bound-wait\",\"error\":%lu", GetLastError()); return 3; }
      if (wait != WAIT_OBJECT_0) allSignaled = false;
    }
    if (!active && rootWait == WAIT_OBJECT_0 && !countCandidateLogged) {
      countCandidateLogged = true;
      unsigned observedPending = snapshot("count-only-candidate");
      unsigned boundPending = boundSnapshot("count-only-candidate");
      ledger("count-only-candidate");
      std::vector<DWORD> current; memberList("count-only-candidate", current);
      emit("count-only-candidate", ",\"active\":0,\"rootWait\":0,\"observerUnsignaled\":%u,\"boundUnsignaled\":%u", observedPending, boundPending);
    }
    if (!active && rootWait == WAIT_OBJECT_0 && allSignaled) {
      ledger("bound-stop-verdict");
      std::vector<DWORD> current; memberList("bound-stop-verdict", current);
      unsigned pending = snapshot("stop-verdict"); boundSnapshot("stop-verdict");
      emit("stopped", ",\"active\":0,\"rootWait\":0,\"knownUnsignaled\":%u,\"boundMembers\":%zu,\"deadlineMs\":%llu,\"witness\":\"sealed-bound-handles\"", pending, bound.size(), deadline);
      settlementPending = true;
      return -1;
    }
    Sleep(1);
  }
  snapshot("deadline"); boundSnapshot("deadline"); emit("uncertain", ",\"reason\":\"bound-deadline\",\"deadlineMs\":%llu", deadline); return 3;
}
static int stop(Frame& f) {
  auto deadline = f.u64(); if (!f.end()) return errorExit("stop-frame", ERROR_INVALID_DATA);
  emit("stop-selected", ",\"deadlineMs\":%llu", deadline);
  if (fault != L"deadline") {
    HANDLE target = fault == L"terminate" ? INVALID_HANDLE_VALUE : job;
    BOOL ok = TerminateJobObject(target, 41); DWORD e = ok ? 0 : GetLastError();
    emit("terminate", ",\"ok\":%s,\"error\":%lu,\"injected\":%s", ok ? "true" : "false", e, fault == L"terminate" ? "true" : "false");
    if (!ok) { emit("uncertain", ",\"reason\":\"terminate\",\"error\":%lu", e); return 3; }
  }
  DWORD previous = 0xFFFFFFFF;
  while (now() < deadline) {
    rootExit(); DWORD active = 0, e = 0;
    if (!count(&active, &e, fault == L"query" ? INVALID_HANDLE_VALUE : job)) { emit("uncertain", ",\"reason\":\"query\",\"error\":%lu,\"injected\":%s", e, fault == L"query" ? "true" : "false"); return 3; }
    DWORD rootWait = WaitForSingleObject(root.hProcess, 0);
    if (active != previous) { emit("accounting", ",\"active\":%lu,\"rootWait\":%lu", active, rootWait); previous = active; }
    if (active == 0 && rootWait == WAIT_OBJECT_0) {
      unsigned pending = snapshot("stop-verdict");
      ledger("v1-count-only-candidate");
      std::vector<DWORD> current; memberList("v1-count-only-candidate", current);
      emit("candidate", ",\"active\":0,\"rootWait\":%lu,\"knownUnsignaled\":%u,\"deadlineMs\":%llu", rootWait, pending, deadline);
      if (fault == L"malformed-stop") { char bad[] = "{malformed\n"; DWORD error; transfer(true, bad, sizeof bad - 1, &error); Sleep(INFINITE); }
      if (fault == L"withhold-stop") Sleep(INFINITE);
      if (fault == L"invalid-ack") { emit("stopped"); Sleep(INFINITE); }
      emit("stopped", ",\"active\":0,\"rootWait\":%lu,\"knownUnsignaled\":%u,\"deadlineMs\":%llu", rootWait, pending, deadline);
      if (negative) {
        for (auto& o : observers) if (WaitForSingleObject(o.handle, 0) == WAIT_TIMEOUT) { BOOL ok = TerminateProcess(o.handle, 42); emit("negative-cleanup", ",\"pid\":%lu,\"created\":\"%llu\",\"ok\":%s,\"error\":%lu", o.pid, o.created, ok ? "true" : "false", ok ? 0 : GetLastError()); WaitForSingleObject(o.handle, 2000); }
      }
      if (fault == L"count-only") { settlementPending = true; return -1; }
      heldDrop(); return 0;
    }
    if (rootWait == WAIT_FAILED) { emit("uncertain", ",\"reason\":\"root-wait\",\"error\":%lu", GetLastError()); return 3; }
    Sleep(1);
  }
  snapshot("deadline"); emit("uncertain", ",\"reason\":\"deadline\",\"deadlineMs\":%llu", deadline);
  if (fault != L"deadline") heldDrop();
  return 3;
}
static int inspectHandles() {
  wchar_t value[64]; DWORD flags = 0;
  GetEnvironmentVariableW(L"PROBE_CONTROL_HANDLE", value, 64); HANDLE c = reinterpret_cast<HANDLE>(_wcstoui64(value, NULL, 10));
  BOOL controlPresent = GetHandleInformation(c, &flags); DWORD ce = controlPresent ? 0 : GetLastError();
  GetEnvironmentVariableW(L"PROBE_JOB_HANDLE", value, 64); HANDLE j = reinterpret_cast<HANDLE>(_wcstoui64(value, NULL, 10));
  BOOL jobPresent = GetHandleInformation(j, &flags); DWORD je = jobPresent ? 0 : GetLastError();
  printf("{\"controlPresent\":%s,\"controlError\":%lu,\"jobPresent\":%s,\"jobError\":%lu}\n", controlPresent ? "true" : "false", ce, jobPresent ? "true" : "false", je);
  return 0;
}
#include "native-fixture.h"
int wmain(int argc, wchar_t** argv) {
  if (argc >= 2 && wcscmp(argv[1], L"--native-creator") == 0) return nativeCreator(argc, argv);
  if (argc >= 2 && wcscmp(argv[1], L"--native-sleeper") == 0) return nativeSleeper(argc, argv);
  if (argc == 2 && wcscmp(argv[1], L"--inspect-handles") == 0) return inspectHandles();
  control = reinterpret_cast<HANDLE>(_get_osfhandle(3));
  if (control == INVALID_HANDLE_VALUE) return 90;
  DWORD flags = 0; if (!GetHandleInformation(control, &flags)) return 91;
  emit("hello", ",\"pid\":%lu,\"fd\":3,\"fileType\":%lu,\"inheritFlag\":%lu", GetCurrentProcessId(), GetFileType(control), flags & HANDLE_FLAG_INHERIT);
  available = CreateEventW(NULL, FALSE, FALSE, NULL);
  if (!available) return errorExit("control-event", GetLastError());
  HANDLE readerThread = CreateThread(NULL, 0, reader, NULL, 0, NULL);
  if (!readerThread) return errorExit("control-reader", GetLastError());
  CloseHandle(readerThread);
  for (;;) {
    rootExit();
    std::vector<unsigned char> command;
    while (next(command)) {
      Frame f{ command }; char kind = static_cast<char>(command[0]);
      if (kind == 'P' && command.size() == 1) { emit("pong"); continue; }
      if (kind == 'L' && !job) { int result = launch(f); if (result) return result; continue; }
      if (kind == 'X') ExitProcess(86);
      if (!job || !root.hProcess) return errorExit("command-state", ERROR_INVALID_STATE);
      if (kind == 'S' && !started && command.size() == 1) {
        DWORD result = ResumeThread(root.hThread); if (result == static_cast<DWORD>(-1)) return errorExit("ResumeThread", GetLastError());
        CloseHandle(root.hThread); root.hThread = NULL; started = true; emit("started", ",\"previousSuspendCount\":%lu", result); continue;
      }
      if (kind == 'O') { int result = observe(f); if (result) return result; continue; }
      if (kind == 'A' && negative) { BOOL ok = AssignProcessToJobObject(job, root.hProcess); DWORD e = ok ? 0 : GetLastError(); emit("assigned-late", ",\"ok\":%s,\"error\":%lu", ok ? "true" : "false", e); if (!ok) return 2; continue; }
      if (kind == 'D') {
        DWORD index = f.u32(); if (!f.end() || index >= observers.size()) return errorExit("audit-retirement-index", ERROR_INVALID_DATA);
        const auto& observed = observers[index]; BOOL ok = TerminateProcess(observed.handle, 43); DWORD error = ok ? 0 : GetLastError();
        DWORD wait = WaitForSingleObject(observed.handle, 0);
        emit("audit-external-termination", ",\"ok\":%s,\"error\":%lu,\"pid\":%lu,\"created\":\"%llu\",\"wait\":%lu", ok ? "true" : "false", error, observed.pid, observed.created, wait);
        snapshot("external-termination-before-bind"); ledger("external-termination-before-bind"); std::vector<DWORD> current; memberList("external-termination-before-bind", current);
        emit("audit-retirement-observed"); continue;
      }
      if (kind == 'B') { int result = seal(f); if (result) return result; continue; }
      if (kind == 'Q') { int result = bindMembers(f); if (result) return result; continue; }
      if (kind == 'V' && settlementPending) { ledger("node-settlement"); std::vector<DWORD> current; memberList("node-settlement", current); snapshot("node-settlement"); boundSnapshot("node-settlement"); emit("settlement-observed"); heldDrop(); return 0; }
      if (kind == 'T') { int result = fault == L"bound" ? stopBound(f) : stop(f); if (result == -1) continue; return result; }
      if (kind == 'R') {
        auto deadline = f.u64(); if (!f.end() || now() >= deadline) { emit("uncertain", ",\"reason\":\"release-deadline\""); return 3; }
        rootExit(); if (!rootReported) return errorExit("release-before-root-exit", ERROR_INVALID_STATE);
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
        HANDLE target = fault == L"release" ? INVALID_HANDLE_VALUE : job;
        BOOL ok = SetInformationJobObject(target, JobObjectExtendedLimitInformation, &limits, sizeof limits); DWORD e = ok ? 0 : GetLastError();
        if (!ok) { emit("uncertain", ",\"reason\":\"release\",\"error\":%lu,\"injected\":%s", e, fault == L"release" ? "true" : "false"); return 3; }
        CloseHandle(job); job = NULL; emit("released", ",\"killOnClose\":false,\"deadlineMs\":%llu", deadline); return 0;
      }
      return errorExit("unknown-command", ERROR_INVALID_DATA);
    }
    { std::lock_guard<std::mutex> lock(queueMutex); if (readerEnded) return errorExit("control-eof", readerError); }
    HANDLE waiters[] = { available, root.hProcess };
    DWORD result = WaitForMultipleObjects(root.hProcess && !rootReported ? 2 : 1, waiters, FALSE, INFINITE);
    if (result == WAIT_FAILED) return errorExit("main-wait", GetLastError());
  }
}
