static std::wstring fixturePath(const std::wstring& dir, const std::wstring& name) { return dir + L"\\" + name; }
static bool fixtureExists(const std::wstring& dir, const std::wstring& name) { return GetFileAttributesW(fixturePath(dir, name).c_str()) != INVALID_FILE_ATTRIBUTES; }
static void fixtureLog(const std::wstring& dir, const std::wstring& name, const char* event, const char* format = "", ...) {
  char suffix[2048]; va_list args; va_start(args, format); vsnprintf(suffix, sizeof suffix, format, args); va_end(args);
  char line[2304]; int n = snprintf(line, sizeof line, "{\"event\":\"%s\",\"timeMs\":%llu,\"tickMs\":%llu,\"pid\":%lu%s}\n", event, now(), GetTickCount64(), GetCurrentProcessId(), suffix);
  HANDLE output = CreateFileW(fixturePath(dir, name).c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  if (output == INVALID_HANDLE_VALUE) ExitProcess(97);
  DWORD written; BOOL ok = WriteFile(output, line, static_cast<DWORD>(n), &written, NULL); CloseHandle(output);
  if (!ok || written != static_cast<DWORD>(n)) ExitProcess(98);
}
static std::wstring fixtureQuote(const std::wstring& value) {
  std::wstring output = L"\""; size_t slashes = 0;
  for (wchar_t c : value) {
    if (c == L'\\') { ++slashes; continue; }
    output.append(c == L'"' ? slashes * 2 + 1 : slashes, L'\\'); slashes = 0; output += c;
  }
  output.append(slashes * 2, L'\\'); return output + L"\"";
}
static int nativeSleeper(int argc, wchar_t** argv) {
  if (argc != 6) return 89;
  std::wstring dir = argv[2], id = argv[3]; DWORD lifetime = wcstoul(argv[4], NULL, 10);
  DWORD e; auto created = creation(GetCurrentProcess(), &e);
  fixtureLog(dir, L"birth-" + id + L".jsonl", "native-first-instruction", ",\"created\":\"%llu\",\"creationError\":%lu,\"attempt\":%ls", created, e, argv[5]);
  Sleep(lifetime); return 0;
}
static int nativeCreator(int argc, wchar_t** argv) {
  if (argc != 5) return 89;
  std::wstring dir = argv[2], id = argv[3]; bool nested = wcscmp(argv[4], L"nested") == 0;
  std::wstring logName = L"creator-" + id + L".jsonl";
  wchar_t executable[32768]; if (!GetModuleFileNameW(NULL, executable, 32768)) return 89;
  HANDLE inner = nested ? CreateJobObjectW(NULL, NULL) : NULL;
  if (nested && !inner) return 88;
  std::vector<HANDLE> held;
  unsigned attempt = 0;
  auto spawnOne = [&](const char* phase, DWORD lifetime) {
    ++attempt; auto began = now();
    fixtureLog(dir, logName, "create-begin", ",\"phase\":\"%s\",\"attempt\":%u", phase, attempt);
    std::wstring childId = id + L"-" + std::to_wstring(attempt);
    std::wstring line = fixtureQuote(executable) + L" --native-sleeper " + fixtureQuote(dir) + L" " + fixtureQuote(childId) + L" " + std::to_wstring(lifetime) + L" " + std::to_wstring(attempt);
    STARTUPINFOEXW si = {}; si.StartupInfo.cb = nested ? sizeof si : sizeof(STARTUPINFOW);
    SIZE_T bytes = 0; DWORD flags = 0;
    if (nested) {
      InitializeProcThreadAttributeList(NULL, 1, 0, &bytes);
      si.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(HeapAlloc(GetProcessHeap(), 0, bytes));
      if (!si.lpAttributeList || !InitializeProcThreadAttributeList(si.lpAttributeList, 1, 0, &bytes) || !UpdateProcThreadAttribute(si.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &inner, sizeof inner, NULL, NULL)) ExitProcess(88);
      flags = EXTENDED_STARTUPINFO_PRESENT;
    }
    PROCESS_INFORMATION child = {};
    BOOL ok = CreateProcessW(executable, line.data(), NULL, NULL, FALSE, flags, NULL, dir.c_str(), &si.StartupInfo, &child);
    DWORD error = ok ? 0 : GetLastError();
    if (si.lpAttributeList) { DeleteProcThreadAttributeList(si.lpAttributeList); HeapFree(GetProcessHeap(), 0, si.lpAttributeList); }
    DWORD creationError = 0; auto created = ok ? creation(child.hProcess, &creationError) : 0;
    fixtureLog(dir, logName, "create-attempt", ",\"phase\":\"%s\",\"attempt\":%u,\"beganMs\":%llu,\"ok\":%s,\"error\":%lu,\"childPid\":%lu,\"created\":\"%llu\",\"creationError\":%lu,\"nested\":%s", phase, attempt, began, ok ? "true" : "false", error, child.dwProcessId, created, creationError, nested ? "true" : "false");
    if (ok) { CloseHandle(child.hThread); held.push_back(child.hProcess); }
  };
  spawnOne("initial", 20000); spawnOne("initial", 20000);
  DWORD creationError; auto created = creation(GetCurrentProcess(), &creationError);
  fixtureLog(dir, logName, "creator-ready", ",\"created\":\"%llu\",\"creationError\":%lu,\"nested\":%s", created, creationError, nested ? "true" : "false");
  bool churnDone = false; auto expiry = now() + 20000;
  while (now() < expiry && !fixtureExists(dir, L"shutdown")) {
    if (fixtureExists(dir, L"churn") && !churnDone) {
      churnDone = true;
      for (int i = 0; i < 8; ++i) { spawnOne("churn", 75); Sleep(1); }
      for (size_t i = 2; i < held.size(); ++i) {
        DWORD wait = WaitForSingleObject(held[i], 5000), error = wait == WAIT_FAILED ? GetLastError() : 0;
        DWORD ce; auto identity = creation(held[i], &ce);
        fixtureLog(dir, logName, "retired-child", ",\"childPid\":%lu,\"created\":\"%llu\",\"creationError\":%lu,\"wait\":%lu,\"error\":%lu", GetProcessId(held[i]), identity, ce, wait, error);
      }
      fixtureLog(dir, logName, "churn-done");
    }
    if (fixtureExists(dir, L"race")) spawnOne("racing", 75);
    Sleep(1);
  }
  for (HANDLE process : held) CloseHandle(process);
  if (inner) CloseHandle(inner);
  return 0;
}
