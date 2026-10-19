# Fixed application code. Launch data travels only as JSON in the environment.
# Windows assigns the Job Object atomically at creation, before code can execute.
$ErrorActionPreference = 'Stop'
try {
  $launch = ConvertFrom-Json $env:MY_AGENT_PROCESS_LAUNCH
  [Environment]::SetEnvironmentVariable('MY_AGENT_PROCESS_LAUNCH', $null, 'Process')
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class OwnedAgentProcess {
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {
    public BASIC_LIMIT BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
    public int cb;
    public string lpReserved, lpDesktop, lpTitle;
    public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESSINFO {
    public IntPtr hProcess, hThread;
    public uint processId, threadId;
  }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX {
    public STARTUPINFO StartupInfo;
    public IntPtr AttributeList;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref EXTENDED_LIMIT info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnedSize);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string cwd, ref STARTUPINFOEX startup, out PROCESSINFO process);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  // Windows CRT argv quoting. No cmd.exe, expansion, or command interpretation.
  static string Quote(string value) {
    var result = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); }
      else { result.Append('\\', slashes); result.Append(c); }
      slashes = 0;
    }
    result.Append('\\', slashes * 2); result.Append('"');
    return result.ToString();
  }

  public static int Run(string executable, string[] args, string cwd) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception();
    PROCESSINFO process = new PROCESSINFO();
    IntPtr attributes = IntPtr.Zero, jobValue = IntPtr.Zero;
    bool attributesReady = false;
    try {
      var limits = new EXTENDED_LIMIT();
      limits.BasicLimitInformation.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE
      if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) throw new Win32Exception();
      var command = new StringBuilder(Quote(executable));
      foreach (string arg in args) command.Append(" ").Append(Quote(arg));
      IntPtr size = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
      attributes = Marshal.AllocHGlobal(size);
      if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref size)) throw new Win32Exception();
      attributesReady = true;
      jobValue = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobValue, job);
      // PROC_THREAD_ATTRIBUTE_JOB_LIST (Windows 10+). Atomic assignment avoids
      // orphaning even a suspended process if the supervisor is killed at startup.
      if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobValue, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
      var startup = new STARTUPINFOEX();
      startup.StartupInfo.cb = Marshal.SizeOf(startup); startup.StartupInfo.dwFlags = 0x100;
      startup.StartupInfo.hStdInput = GetStdHandle(-10); startup.StartupInfo.hStdOutput = GetStdHandle(-11); startup.StartupInfo.hStdError = GetStdHandle(-12);
      startup.AttributeList = attributes;
      if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080004, IntPtr.Zero, cwd, ref startup, out process)) throw new Win32Exception();
      if (ResumeThread(process.hThread) == uint.MaxValue) throw new Win32Exception();
      WaitForSingleObject(process.hProcess, uint.MaxValue);
      uint exitCode;
      if (!GetExitCodeProcess(process.hProcess, out exitCode)) throw new Win32Exception();
      return unchecked((int)exitCode);
    } finally {
      // Also retire descendants when the provider root exits early. No PID lookup.
      if (process.hProcess != IntPtr.Zero) TerminateProcess(process.hProcess, 1);
      CloseHandle(job);
      if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
      if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
      if (attributesReady) DeleteProcThreadAttributeList(attributes);
      if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if (jobValue != IntPtr.Zero) Marshal.FreeHGlobal(jobValue);
    }
  }
}
'@
  $exitCode = [OwnedAgentProcess]::Run([string]$launch.executable, [string[]]$launch.args, [string]$launch.cwd)
  exit $exitCode
} catch {
  # Do not render native exceptions, launch data, or inherited environment.
  exit 1
}
