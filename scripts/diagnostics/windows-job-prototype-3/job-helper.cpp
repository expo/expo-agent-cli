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
static std::wstring fault;
struct Observer { HANDLE handle; DWORD pid; unsigned long long created; std::string token; BOOL member; };
static std::vector<Observer> observers;
struct Member { HANDLE handle; DWORD pid; unsigned long long created; };
struct Census {
  std::vector<Member> members;
  bool healthy = true;
  bool sampled = false;
  bool identityFaultInjected = false;
  DWORD lastTotal = 0;
  unsigned long long beganTick = 0;
  const char* firstFault = "";
};
static Census census;
static HANDLE completion = NULL;
static const size_t capacity = 4096;
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
static void coverageFault(const char* reason, DWORD pid = 0, DWORD error = 0) {
  if (census.healthy) census.firstFault = reason;
  census.healthy = false;
  emit("coverage-fault", ",\"reason\":\"%s\",\"pid\":%lu,\"error\":%lu", reason, pid, error);
}
static JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting(const char* phase, bool report) {
  if (census.beganTick && GetTickCount64() - census.beganTick > 60000 && census.healthy) coverageFault("collector-age-limit");
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info = {};
  BOOL ok = QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &info, sizeof info, NULL);
  DWORD error = ok ? 0 : GetLastError();
  bool changed = !census.sampled || info.TotalProcesses != census.lastTotal;
  if (!ok) coverageFault("accounting-query", 0, error);
  if (ok && census.sampled && info.TotalProcesses < census.lastTotal) coverageFault("lifetime-count-decreased");
  if (ok && info.TotalProcesses > capacity) coverageFault("lifetime-count-capacity");
  if (ok && info.TotalProcesses < census.members.size()) coverageFault("lifetime-count-below-covered");
  if (ok) { census.sampled = true; census.lastTotal = info.TotalProcesses; }
  if (report || changed || !ok) emit("lifetime-accounting", ",\"phase\":\"%s\",\"ok\":%s,\"error\":%lu,\"active\":%lu,\"totalProcesses\":%lu,\"totalTerminatedProcesses\":%lu,\"covered\":%zu,\"healthy\":%s,\"nonWrappingPremiseProven\":false", phase, ok ? "true" : "false", error, info.ActiveProcesses, info.TotalProcesses, info.TotalTerminatedProcesses, census.members.size(), census.healthy ? "true" : "false");
  return info;
}
static void capture(DWORD pid, const char* source) {
  for (const auto& member : census.members) if (member.pid == pid) return;
  if (census.members.size() == capacity) { coverageFault("retained-handle-capacity", pid); return; }
  HANDLE handle = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!handle) { coverageFault("capture-open-process", pid, GetLastError()); return; }
  DWORD creationError = 0;
  auto created = creation(handle, &creationError);
  BOOL member = FALSE;
  BOOL membershipOk = IsProcessInJob(handle, job, &member);
  DWORD membershipError = membershipOk ? 0 : GetLastError();
  DWORD wait = WaitForSingleObject(handle, 0);
  DWORD waitError = wait == WAIT_FAILED ? GetLastError() : 0;
  emit("capture-attempt", ",\"source\":\"%s\",\"pid\":%lu,\"created\":\"%llu\",\"creationError\":%lu,\"member\":%s,\"membershipError\":%lu,\"wait\":%lu,\"waitError\":%lu", source, pid, created, creationError, member ? "true" : "false", membershipError, wait, waitError);
  if (!membershipOk || !member || creationError || waitError || !created) {
    CloseHandle(handle); coverageFault("capture-identity", pid); return;
  }
  if (fault == L"identity" && pid != root.dwProcessId && !census.identityFaultInjected) {
    census.identityFaultInjected = true;
    emit("identity-negative-control", ",\"pid\":%lu,\"actualCreated\":\"%llu\",\"injectedExpectedCreated\":\"%llu\"", pid, created, created + 1);
    CloseHandle(handle); coverageFault("injected-identity-mismatch", pid); return;
  }
  census.members.push_back({ handle, pid, created });
  emit("captured", ",\"source\":\"%s\",\"pid\":%lu,\"created\":\"%llu\",\"member\":true,\"wait\":%lu,\"covered\":%zu", source, pid, created, wait, census.members.size());
}
static void collect() {
  if (!completion || settlementPending) return;
  for (unsigned i = 0; i < 256; ++i) {
    DWORD message = 0; ULONG_PTR key = 0; LPOVERLAPPED value = NULL;
    BOOL ok = GetQueuedCompletionStatus(completion, &message, &key, &value, 0);
    DWORD error = ok ? 0 : GetLastError();
    if (!ok && error == WAIT_TIMEOUT) return;
    if (!ok) { coverageFault("completion-query", 0, error); return; }
    auto rawPid = reinterpret_cast<ULONG_PTR>(value);
    if (key != reinterpret_cast<ULONG_PTR>(job) || rawPid > MAXDWORD) { coverageFault("completion-identity"); continue; }
    DWORD pid = static_cast<DWORD>(rawPid);
    emit("job-notification", ",\"message\":%lu,\"pid\":%lu", message, pid);
    if (message == JOB_OBJECT_MSG_NEW_PROCESS) {
      if ((fault == L"missing-notification" || fault == L"count-only") && pid != root.dwProcessId) emit("discovery-suppressed", ",\"pid\":%lu,\"injected\":true", pid);
      else capture(pid, "completion-discovery");
    }
    if (message == JOB_OBJECT_MSG_ACTIVE_PROCESS_LIMIT || message == JOB_OBJECT_MSG_END_OF_PROCESS_TIME || message == JOB_OBJECT_MSG_END_OF_JOB_TIME) coverageFault("limit-notification", pid);
  }
}
static int launch(Frame& f) {
  if (f.u32() != 0) return errorExit("unsupported-negative-launch", ERROR_INVALID_DATA);
  std::wstring image = f.wide(), line = f.wide(), cwd = f.wide(); fault = f.wide();
  if (!f.end()) return errorExit("launch-frame", ERROR_INVALID_DATA);
  if (fault == L"crash-before") ExitProcess(86);
  job = CreateJobObjectW(NULL, NULL);
  if (!job) return errorExit("CreateJobObjectW", GetLastError());
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  HANDLE configured = fault == L"job" ? INVALID_HANDLE_VALUE : job;
  if (!SetInformationJobObject(configured, JobObjectExtendedLimitInformation, &limits, sizeof limits)) return errorExit("SetInformationJobObject", GetLastError(), fault == L"job");
  completion = CreateIoCompletionPort(INVALID_HANDLE_VALUE, NULL, 0, 1);
  if (!completion) return errorExit("CreateIoCompletionPort", GetLastError());
  JOBOBJECT_ASSOCIATE_COMPLETION_PORT association = {};
  association.CompletionKey = job;
  association.CompletionPort = completion;
  if (!SetInformationJobObject(job, JobObjectAssociateCompletionPortInformation, &association, sizeof association)) return errorExit("associate-completion-port", GetLastError());
  census.beganTick = GetTickCount64();
  accounting("before-root", true);
  if (!SetHandleInformation(control, HANDLE_FLAG_INHERIT, 0)) return errorExit("private-control", GetLastError());
  HANDLE inherited[3] = {};
  for (int i = 0; i < 3; ++i) {
    HANDLE source = reinterpret_cast<HANDLE>(_get_osfhandle(i));
    if (!DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &inherited[i], 0, TRUE, DUPLICATE_SAME_ACCESS)) return errorExit("DuplicateHandle-stdio", GetLastError());
  }
  STARTUPINFOEXW si = {}; si.StartupInfo.cb = sizeof si; si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  si.StartupInfo.hStdInput = inherited[0]; si.StartupInfo.hStdOutput = inherited[1]; si.StartupInfo.hStdError = inherited[2];
  SIZE_T bytes = 0; DWORD attributes = 2;
  InitializeProcThreadAttributeList(NULL, attributes, 0, &bytes);
  si.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(HeapAlloc(GetProcessHeap(), 0, bytes));
  if (!si.lpAttributeList) return errorExit("attribute-allocation", ERROR_NOT_ENOUGH_MEMORY);
  if (!InitializeProcThreadAttributeList(si.lpAttributeList, attributes, 0, &bytes)) return errorExit("InitializeProcThreadAttributeList", GetLastError());
  SIZE_T inheritedBytes = fault == L"attributes" ? 1 : sizeof inherited;
  if (!UpdateProcThreadAttribute(si.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, inheritedBytes, NULL, NULL)) return errorExit("HANDLE_LIST", GetLastError(), fault == L"attributes");
  if (!UpdateProcThreadAttribute(si.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job, sizeof job, NULL, NULL)) return errorExit("JOB_LIST", GetLastError());
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
  if (!member) return errorExit("root-outside-job", ERROR_INVALID_DATA);
  census.members.push_back({root.hProcess, root.dwProcessId, createdAt});
  emit("captured", ",\"source\":\"original-root-handle\",\"pid\":%lu,\"created\":\"%llu\",\"member\":true,\"wait\":%lu,\"covered\":%zu", root.dwProcessId, createdAt, WaitForSingleObject(root.hProcess, 0), census.members.size());
  accounting("root-created", true);
  BOOL helperInJob = FALSE; IsProcessInJob(GetCurrentProcess(), NULL, &helperInJob);
  emit("ready", ",\"pid\":%lu,\"created\":\"%llu\",\"member\":%s,\"negative\":%s,\"helperInParentJob\":%s,\"stdioCopiesClosed\":true", root.dwProcessId, createdAt, member ? "true" : "false", "false", helperInJob ? "true" : "false");
  if (fault == L"crash-ready") ExitProcess(86);
  return 0;
}
static int observe(Frame& f) {
  DWORD pid = f.u32(); std::wstring tokenWide = f.wide();
  if (!f.end() || tokenWide.size() > 100) return errorExit("observe-frame", ERROR_INVALID_DATA);
  std::string token;
  for (wchar_t c : tokenWide) { if (!((c >= L'a' && c <= L'z') || (c >= L'A' && c <= L'Z') || (c >= L'0' && c <= L'9') || c == L'-' || c == L'_')) return errorExit("observe-token", ERROR_INVALID_DATA); token.push_back(static_cast<char>(c)); }
  HANDLE process = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return errorExit("OpenProcess-observer", GetLastError());
  DWORD e; auto created = creation(process, &e); if (e) return errorExit("GetProcessTimes-observer", e);
  BOOL member = FALSE; if (!IsProcessInJob(process, job, &member)) return errorExit("IsProcessInJob-observer", GetLastError());
  observers.push_back({ process, pid, created, token, member });
  emit("observed", ",\"pid\":%lu,\"created\":\"%llu\",\"token\":\"%s\",\"member\":%s,\"wait\":%lu", pid, created, token.c_str(), member ? "true" : "false", WaitForSingleObject(process, 0));
  return 0;
}
static bool memberList(const char* phase, std::vector<DWORD>& pids) {
  std::vector<unsigned char> bytes(sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + capacity * sizeof(ULONG_PTR));
  auto list = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(bytes.data());
  BOOL ok = QueryInformationJobObject(job, JobObjectBasicProcessIdList, list, static_cast<DWORD>(bytes.size()), NULL);
  DWORD e = ok ? 0 : GetLastError();
  emit("member-list", ",\"phase\":\"%s\",\"ok\":%s,\"error\":%lu,\"assigned\":%lu,\"returned\":%lu,\"capacity\":%zu", phase, ok ? "true" : "false", e, list->NumberOfAssignedProcesses, list->NumberOfProcessIdsInList, capacity);
  if (!ok || list->NumberOfAssignedProcesses != list->NumberOfProcessIdsInList || list->NumberOfProcessIdsInList > capacity) return false;
  for (DWORD i = 0; i < list->NumberOfProcessIdsInList; ++i) {
    if (list->ProcessIdList[i] > MAXDWORD) return false;
    pids.push_back(static_cast<DWORD>(list->ProcessIdList[i]));
    emit("listed-member", ",\"phase\":\"%s\",\"pid\":%lu", phase, pids.back());
  }
  std::sort(pids.begin(), pids.end());
  return std::adjacent_find(pids.begin(), pids.end()) == pids.end();
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
static unsigned retainedWaits(const char* phase, bool report) {
  unsigned pending = 0;
  for (const auto& member : census.members) {
    DWORD wait = WaitForSingleObject(member.handle, 0);
    DWORD error = wait == WAIT_FAILED ? GetLastError() : 0;
    if (wait != WAIT_OBJECT_0) ++pending;
    if (wait == WAIT_FAILED) coverageFault("retained-wait", member.pid, error);
    if (report) emit("retained-wait", ",\"phase\":\"%s\",\"pid\":%lu,\"created\":\"%llu\",\"wait\":%lu,\"error\":%lu", phase, member.pid, member.created, wait, error);
  }
  return pending;
}
static void dropHandles() {
  for (const auto& member : census.members) CloseHandle(member.handle);
  census.members.clear(); root.hProcess = NULL;
  for (const auto& observed : observers) CloseHandle(observed.handle);
  observers.clear();
  emit("held-drop");
}
static int uncertain(const char* reason, unsigned long long deadline) {
  retainedWaits("uncertain-verdict", true); snapshot("uncertain-verdict");
  accounting("uncertain-verdict", true);
  settlementPending = true;
  emit("uncertain", ",\"reason\":\"%s\",\"firstCoverageFault\":\"%s\",\"deadlineMs\":%llu", reason, census.firstFault, deadline);
  return -1;
}
static int stop(Frame& frame) {
  auto deadline = frame.u64();
  if (!frame.end() || operationDeadline || now() >= deadline) return errorExit("stop-frame-state", ERROR_INVALID_DATA);
  operationDeadline = deadline;
  emit("stop-selected", ",\"deadlineMs\":%llu,\"witness\":\"retained-lifetime-census\"", deadline);
  collect();
  accounting("before-current-census", true);
  if (fault != L"count-only") {
    std::vector<DWORD> current;
    if (!memberList("pre-termination", current)) coverageFault("incomplete-current-census");
    for (DWORD pid : current) {
      if (now() >= deadline) return uncertain("census-deadline", deadline);
      capture(pid, "pre-termination-census");
    }
    accounting("after-current-census", true);
  }
  if (fault != L"deadline") {
    HANDLE target = fault == L"terminate" ? INVALID_HANDLE_VALUE : job;
    BOOL ok = TerminateJobObject(target, 41); DWORD error = ok ? 0 : GetLastError();
    emit("terminate", ",\"ok\":%s,\"error\":%lu,\"injected\":%s", ok ? "true" : "false", error, fault == L"terminate" ? "true" : "false");
    if (!ok) return uncertain("terminate", deadline);
  }
  bool oldPredicateLogged = false;
  while (now() < deadline) {
    collect(); rootExit();
    DWORD rootWait = WaitForSingleObject(root.hProcess, 0);
    unsigned pending = retainedWaits("poll", false);
    auto info = accounting("stop-poll", false);
    if (!info.ActiveProcesses && rootWait == WAIT_OBJECT_0 && !oldPredicateLogged) {
      oldPredicateLogged = true;
      unsigned knownPending = snapshot("count-only-candidate");
      retainedWaits("count-only-candidate", true);
      emit("count-only-candidate", ",\"active\":0,\"rootWait\":0,\"observerUnsignaled\":%u,\"retainedUnsignaled\":%u,\"covered\":%zu,\"totalProcesses\":%lu", knownPending, pending, census.members.size(), info.TotalProcesses);
      if (fault == L"count-only") {
        snapshot("stop-verdict");
        emit("stopped", ",\"active\":0,\"rootWait\":0,\"knownUnsignaled\":%u,\"deadlineMs\":%llu,\"witness\":\"rejected-count-only-comparison\"", knownPending, deadline);
        settlementPending = true; return -1;
      }
    }
    if (fault != L"count-only" && !pending && rootWait == WAIT_OBJECT_0) {
      info = accounting("after-all-retained-signaled", true);
      if (census.healthy && info.TotalProcesses == census.members.size()) {
        retainedWaits("stop-verdict", true);
        unsigned knownPending = snapshot("stop-verdict");
        if (fault == L"withhold-stop") { emit("acknowledgement-withheld", ",\"deadlineMs\":%llu", deadline); Sleep(INFINITE); }
        emit("stopped", ",\"active\":%lu,\"rootWait\":0,\"knownUnsignaled\":%u,\"retainedUnsignaled\":0,\"covered\":%zu,\"totalProcesses\":%lu,\"healthy\":true,\"deadlineMs\":%llu,\"witness\":\"retained-lifetime-census\",\"nonWrappingPremiseProven\":false", info.ActiveProcesses, knownPending, census.members.size(), info.TotalProcesses, deadline);
        settlementPending = true; return -1;
      }
      if (!census.healthy) return uncertain("coverage-fault", deadline);
      emit("coverage-gap", ",\"totalProcesses\":%lu,\"covered\":%zu", info.TotalProcesses, census.members.size());
      return uncertain("lifetime-count-gap", deadline);
    }
    Sleep(1);
  }
  return uncertain("deadline-or-lifetime-gap", deadline);
}
#include "native-fixture.h"
int wmain(int argc, wchar_t** argv) {
  if (argc >= 2 && wcscmp(argv[1], L"--native-creator") == 0) return nativeCreator(argc, argv);
  if (argc >= 2 && wcscmp(argv[1], L"--native-sleeper") == 0) return nativeSleeper(argc, argv);
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
    rootExit(); collect();
    if (job && !settlementPending) {
      accounting("running", false);
    }
    std::vector<unsigned char> command;
    while (next(command)) {
      Frame frame{ command }; char kind = static_cast<char>(command[0]);
      if (kind == 'P' && command.size() == 1) { emit("pong"); continue; }
      if (kind == 'L' && !job) { int result = launch(frame); if (result) return result; continue; }
      if (kind == 'X') ExitProcess(86);
      if (!job || !root.hProcess) return errorExit("command-state", ERROR_INVALID_STATE);
      if (kind == 'S' && !started && command.size() == 1) {
        DWORD result = ResumeThread(root.hThread);
        if (result == static_cast<DWORD>(-1)) return errorExit("ResumeThread", GetLastError());
        CloseHandle(root.hThread); root.hThread = NULL; started = true;
        emit("started", ",\"previousSuspendCount\":%lu", result); continue;
      }
      if (kind == 'O') { int result = observe(frame); if (result) return result; continue; }
      if (kind == 'I' && command.size() == 1) {
        collect(); accounting("inspect", true); retainedWaits("inspect", true); snapshot("inspect");
        std::vector<DWORD> current; memberList("inspect", current); emit("inspection-complete"); continue;
      }
      if (kind == 'V' && settlementPending && command.size() == 1) {
        accounting("node-settlement", true); retainedWaits("node-settlement", true); snapshot("node-settlement");
        std::vector<DWORD> current; memberList("node-settlement", current);
        emit("settlement-observed"); dropHandles(); return 0;
      }
      if (kind == 'T') { int result = stop(frame); if (result == -1) continue; return result; }
      if (kind == 'R') {
        auto deadline = frame.u64();
        if (!frame.end() || operationDeadline || now() >= deadline) return errorExit("release-frame-state", ERROR_INVALID_DATA);
        rootExit(); if (!rootReported) return errorExit("release-before-root-exit", ERROR_INVALID_STATE);
        accounting("natural-release", true); retainedWaits("natural-release", true);
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
        BOOL ok = SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof limits);
        if (!ok) return uncertain("release", deadline);
        CloseHandle(job); job = NULL;
        emit("released", ",\"killOnClose\":false,\"deadlineMs\":%llu,\"terminationClaim\":false", deadline);
        return 0;
      }
      return errorExit("unknown-command", ERROR_INVALID_DATA);
    }
    { std::lock_guard<std::mutex> lock(queueMutex); if (readerEnded) return errorExit("control-eof", readerError); }
    if (WaitForSingleObject(available, 1) == WAIT_FAILED) return errorExit("main-wait", GetLastError());
  }
}
