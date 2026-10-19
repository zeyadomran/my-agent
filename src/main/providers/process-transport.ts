import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { TextDecoder } from 'node:util';

import type { ResolvedProfile } from '../../shared/contracts';
import { ProviderFault } from './fault';
import { resolveLaunch } from './launch';
import { MAX_FRAME_BYTES } from './limits';
import windowsSupervisor from './windows-supervisor.ps1?raw';

export interface ProcessTransportOptions {
  onLine(line: string): void;
  onFailure(fault: ProviderFault): void;
  /** Natural exit after streams drain; when supplied, the consumer interprets exit status. */
  onExit?(code: number | null, signal: NodeJS.Signals | null): void;
}

export interface ProcessTransport {
  /** Native process created under ownership. Startup has a separate 30 second bound. */
  readonly ready: Promise<void>;
  /** One UTF-8 line, without the newline. Bounded queued writes. */
  send(line: string): void;
  /** EOF only. Does not start a forced-retirement deadline; later sends are rejected. */
  endInput(): void;
  /** Idempotent; resolves after the owned child closes, including failed startup. */
  close(): Promise<void>;
}

const OUTPUT_BYTES = 8 * 1024 * 1024;
const STDERR_BYTES = 256 * 1024;

function launch(profile: ResolvedProfile, readyToken: string): ChildProcessWithoutNullStreams {
  try {
    const { executable, args, env } = resolveLaunch(profile);
    if (process.platform === 'win32') {
      const supervisor = resolve(
        process.env.SystemRoot ?? 'C:/Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      );
      return spawn(
        supervisor,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(windowsSupervisor, 'utf16le').toString('base64'),
        ],
        {
          cwd: profile.cwd,
          env: {
            ...env,
            MY_AGENT_PROCESS_LAUNCH: JSON.stringify({
              executable,
              args,
              cwd: profile.cwd,
              readyToken,
            }),
          },
          windowsHide: true,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
    }
    return spawn(executable, args, {
      cwd: profile.cwd,
      env,
      shell: false,
      windowsHide: true,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    throw new ProviderFault('unavailable');
  }
}

export function createProcessTransport(
  profile: ResolvedProfile,
  options: ProcessTransportOptions,
): ProcessTransport {
  // An opaque per-launch supervisor marker shares stderr, never the provider wire.
  const readyToken = `my-agent-ready:${randomUUID()}\n`;
  const child = launch(profile, readyToken);
  let closed = false;
  let closing: Promise<void> | undefined;
  let failed = false;
  let inputEnded = false;
  let frame = Buffer.alloc(0);
  let outputBytes = 0;
  let stderrBytes = 0;
  let startupTail = Buffer.alloc(0);
  let started = false;
  let resolveReady: () => void = () => {
    /* Bound before process events. */
  };
  let rejectReady: (fault: ProviderFault) => void = () => {
    /* Bound before process events. */
  };
  const ready = new Promise<void>((resolveStartup, rejectStartup) => {
    resolveReady = resolveStartup;
    rejectReady = rejectStartup;
  });
  // Raw streaming consumers may not need ready; failures still go through onFailure.
  void ready.catch(() => {
    /* Avoid an unobserved promise rejection. */
  });
  const markReady = () => {
    if (failed || closing !== undefined) return;
    started = true;
    startupTail = Buffer.alloc(0);
    clearTimeout(startupDeadline);
    resolveReady();
  };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let resolveClosed: () => void = () => {
    /* Bound before asynchronous process events. */
  };
  const didClose = new Promise<void>((resolveClose) => {
    resolveClosed = resolveClose;
  });
  const hasClosed = () => closed;
  const hasFailed = () => failed;
  const fail = (fault = new ProviderFault()) => {
    if (failed || closing !== undefined) return;
    failed = true;
    clearTimeout(startupDeadline);
    rejectReady(fault);
    options.onFailure(fault);
    closing ??= closeChild();
    void closing.catch(() => {
      /* The owner observes shutdown errors through close(). */
    });
  };
  const startupDeadline = setTimeout(() => {
    fail(new ProviderFault('unavailable'));
  }, 30_000);
  child.on('spawn', () => {
    if (process.platform !== 'win32') markReady();
  });
  child.on('error', () => {
    fail(new ProviderFault('unavailable'));
  });
  child.stdin.on('error', () => {
    fail();
  });
  child.stdout.on('error', () => {
    fail();
  });
  child.stderr.on('error', () => {
    fail();
  });
  child.on('exit', () => {
    // POSIX descendants keep the original detached process group. Windows uses
    // a Job Object whose handle is owned by the supervisor, never a reused PID.
    if (process.platform !== 'win32' && child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* Group already empty. */
      }
    }
  });
  child.on('close', (code, signal) => {
    closed = true;
    resolveClosed();
    if (started && !failed && closing === undefined && options.onExit !== undefined)
      options.onExit(code, signal);
    else fail();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    // Drain but never retain or log diagnostics. Excess diagnostics retire the process.
    stderrBytes += chunk.length;
    if (stderrBytes > STDERR_BYTES) {
      fail();
      return;
    }
    if (process.platform === 'win32' && !started && !failed && closing === undefined) {
      const candidate = Buffer.concat([startupTail, chunk]);
      if (candidate.includes(readyToken)) markReady();
      else
        startupTail = Buffer.from(
          candidate.subarray(Math.max(0, candidate.length - readyToken.length + 1)),
        );
    }
  });
  child.stdout.on('data', (chunk: Buffer) => {
    if (failed || closing !== undefined) return;
    outputBytes += chunk.length;
    if (outputBytes > OUTPUT_BYTES) {
      fail();
      return;
    }
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      if (frame.length + part.length > MAX_FRAME_BYTES) {
        fail();
        return;
      }
      frame = Buffer.concat([frame, part]);
      if (newline === -1) return;
      try {
        const line = decoder.decode(frame);
        frame = Buffer.alloc(0);
        options.onLine(line);
      } catch {
        fail();
        return;
      }
      if (hasFailed()) return;
      start = newline + 1;
    }
  });
  child.stdout.on('end', () => {
    if (frame.length === 0 || failed || closing !== undefined) return;
    try {
      const line = decoder.decode(frame);
      frame = Buffer.alloc(0);
      options.onLine(line);
    } catch {
      fail();
    }
  });

  async function closeChild() {
    clearTimeout(startupDeadline);
    rejectReady(new ProviderFault());
    if (hasClosed()) return;
    endInput();
    // Give cooperative agents EOF first. No arbitrary sleep: race the close event.
    let grace: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      didClose,
      new Promise<void>((resolveGrace) => {
        grace = setTimeout(resolveGrace, 200);
      }),
    ]);
    clearTimeout(grace);
    if (hasClosed()) return;
    const pid = child.pid;
    if (pid !== undefined) {
      if (process.platform === 'win32') {
        // Closing the supervisor's sole Job Object handle retires the entire tree.
        child.kill('SIGKILL');
      } else {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    }
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        didClose,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new ProviderFault());
          }, 5000);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
  }

  function endInput() {
    if (inputEnded) return;
    inputEnded = true;
    child.stdin.end();
  }

  return {
    ready,
    send(line) {
      if (
        failed ||
        inputEnded ||
        closing !== undefined ||
        closed ||
        Buffer.byteLength(line) > MAX_FRAME_BYTES ||
        child.stdin.writableLength + Buffer.byteLength(line) > MAX_FRAME_BYTES * 2
      ) {
        throw new ProviderFault();
      }
      child.stdin.write(`${line}\n`);
    },
    endInput,
    close() {
      closing ??= closeChild();
      return closing;
    },
  };
}
