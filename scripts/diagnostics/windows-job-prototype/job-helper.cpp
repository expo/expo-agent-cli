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
    emit("observer", ",\"phase\":\"%s\",\"pid\":%lu,\"created\":\"%llu\",\"token\":\"%s\",\"member\":%s,\"wait\":%lu,\"error\":%lu", phase, o.pid, o.created, o.token.c_str(), o.member ? "true" : "false", wait, e);
  }
  return pending;
}
static void heldDrop() {
  DWORD before = 0, beforeError = 0, after = 0, afterError = 0;
  bool beforeOk = count(&before, &beforeError, job);
  for (auto& o : observers) { CloseHandle(o.handle); o.handle = NULL; }
  observers.clear();
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
      emit("candidate", ",\"active\":0,\"rootWait\":%lu,\"knownUnsignaled\":%u,\"deadlineMs\":%llu", rootWait, pending, deadline);
      if (fault == L"malformed-stop") { char bad[] = "{malformed\n"; DWORD error; transfer(true, bad, sizeof bad - 1, &error); Sleep(INFINITE); }
      if (fault == L"withhold-stop") Sleep(INFINITE);
      if (fault == L"invalid-ack") { emit("stopped"); Sleep(INFINITE); }
      emit("stopped", ",\"active\":0,\"rootWait\":%lu,\"knownUnsignaled\":%u,\"deadlineMs\":%llu", rootWait, pending, deadline);
      if (negative) {
        for (auto& o : observers) if (WaitForSingleObject(o.handle, 0) == WAIT_TIMEOUT) { BOOL ok = TerminateProcess(o.handle, 42); emit("negative-cleanup", ",\"pid\":%lu,\"created\":\"%llu\",\"ok\":%s,\"error\":%lu", o.pid, o.created, ok ? "true" : "false", ok ? 0 : GetLastError()); WaitForSingleObject(o.handle, 2000); }
      }
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
int wmain(int argc, wchar_t** argv) {
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
      if (kind == 'T') return stop(f);
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
