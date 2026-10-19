import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
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
}

export interface ProcessTransport {
  /** One UTF-8 line, without the newline. Bounded queued writes. */
  send(line: string): void;
  /** Idempotent; resolves after the owned child closes, including failed startup. */
  close(): Promise<void>;
}

const OUTPUT_BYTES = 8 * 1024 * 1024;
const STDERR_BYTES = 256 * 1024;

function launch(profile: ResolvedProfile): ChildProcessWithoutNullStreams {
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
            MY_AGENT_PROCESS_LAUNCH: JSON.stringify({ executable, args, cwd: profile.cwd }),
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
  const child = launch(profile);
  let closed = false;
  let closing: Promise<void> | undefined;
  let failed = false;
  let frame = Buffer.alloc(0);
  let outputBytes = 0;
  let stderrBytes = 0;
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
    options.onFailure(fault);
    closing ??= closeChild();
    void closing.catch(() => {
      /* The owner observes shutdown errors through close(). */
    });
  };
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
  child.on('close', () => {
    closed = true;
    resolveClosed();
    fail();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    // Drain but never retain or log diagnostics. Excess diagnostics retire the process.
    stderrBytes += chunk.length;
    if (stderrBytes > STDERR_BYTES) fail();
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

  async function closeChild() {
    if (hasClosed()) return;
    child.stdin.end();
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

  return {
    send(line) {
      if (
        failed ||
        closing !== undefined ||
        closed ||
        Buffer.byteLength(line) > MAX_FRAME_BYTES ||
        child.stdin.writableLength + Buffer.byteLength(line) > MAX_FRAME_BYTES * 2
      ) {
        throw new ProviderFault();
      }
      child.stdin.write(`${line}\n`);
    },
    close() {
      closing ??= closeChild();
      return closing;
    },
  };
}
