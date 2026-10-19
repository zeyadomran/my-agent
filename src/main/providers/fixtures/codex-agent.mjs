// Controlled external app-server boundary. All persistence belongs to the test cwd.
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const behavior = JSON.parse(readFileSync('behavior.json', 'utf8'));
const journal = process.env.CODEX_FIXTURE_JOURNAL;
if (!journal) throw new Error('Missing owned fixture journal');
const record = (entry) => appendFileSync(journal, `${JSON.stringify(entry)}\n`);
record({ pid: process.pid, instance: randomUUID(), args: process.argv.slice(2) });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const result = (id, value) => send({ id, result: value });
const error = (id, code) =>
  send({ id, error: { code, message: behavior.errorText ?? 'Controlled fixture failure' } });
const notify = (method, params) => send({ method, params });
let initialized = false;
let ready = false;
let active;
let outstandingApproval;
let pendingProbe;
const sessionPath = 'native-session.json';
const sessions = existsSync(sessionPath) ? JSON.parse(readFileSync(sessionPath, 'utf8')) : {};
const save = () => writeFileSync(sessionPath, JSON.stringify(sessions));

function setup(params, threadId) {
  if (
    params.sandbox !== 'read-only' ||
    params.approvalPolicy !== 'never' ||
    params.approvalsReviewer !== 'user' ||
    params.config?.['features.hooks'] !== false ||
    params.config?.['features.plugins'] !== false ||
    params.config?.['skills.include_instructions'] !== false ||
    params.config?.mcp_servers?.fixture?.enabled !== false
  )
    throw new Error('Missing chat policy');
  return {
    thread: { id: threadId, turns: [] },
    model: behavior.wrongModel ? 'other-model' : (params.model ?? 'fixture-model'),
    modelProvider: 'fixture',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: {
      type: behavior.unsafeSandbox ? 'dangerFullAccess' : 'readOnly',
      networkAccess: false,
    },
  };
}

function finish(status) {
  const { threadId, turnId, itemId } = active;
  if (status === 'completed') {
    notify('item/agentMessage/delta', {
      threadId,
      turnId,
      itemId,
      delta: 'Fixture ',
    });
    notify('item/agentMessage/delta', {
      threadId,
      turnId,
      itemId,
      delta: 'reply',
    });
    notify('item/completed', {
      threadId,
      turnId,
      item: { type: 'agentMessage', id: itemId, text: 'Fixture reply.' },
    });
  }
  const items =
    status === 'completed' ? [{ type: 'agentMessage', id: itemId, text: 'Fixture reply.' }] : [];
  sessions[threadId].turns.push({ id: turnId, items, status });
  save();
  notify('turn/completed', { threadId, turn: { id: turnId, status, items } });
  active = undefined;
}

createInterface({ input: process.stdin }).on('line', (line) => {
  try {
    const message = JSON.parse(line);
    if ('jsonrpc' in message) throw new Error('Codex dialect must omit jsonrpc');
    if (!('method' in message)) {
      if (message.id !== outstandingApproval || message.result?.decision !== 'decline')
        throw new Error('Unexpected approval');
      record({ refusedApproval: true });
      if (pendingProbe) {
        result(pendingProbe.id, pendingProbe.setup);
        pendingProbe = undefined;
      }
      return;
    }
    const { id, method, params } = message;
    record({ method, params });
    if (method === 'initialize') {
      if (initialized || params.clientInfo?.name !== 'my-agent') throw new Error('Handshake');
      initialized = true;
      if (behavior.startupFailure) {
        error(id, -32603);
        return;
      }
      result(id, { userAgent: 'codex_cli_rs/0.163.0', platformOs: 'fixture' });
      return;
    }
    if (!initialized) throw new Error('Not initialized');
    if (method === 'initialized') {
      ready = true;
      return;
    }
    if (!ready) throw new Error('Missing initialized notification');
    switch (method) {
      case 'config/read':
        result(id, {
          config: {
            mcp_servers: { fixture: { command: 'never-executed' } },
            plugins: { 'fixture@catalog': { enabled: true } },
            skills: { config: [] },
          },
        });
        break;
      case 'account/read':
        result(id, {
          account: behavior.noAuth ? null : { type: 'chatgpt' },
          requiresOpenaiAuth: true,
        });
        break;
      case 'thread/start': {
        if (!Array.isArray(params.environments) || params.environments.length !== 0)
          throw new Error('Environment access enabled');
        const threadId = randomUUID();
        sessions[threadId] = { turns: [] };
        save();
        if (behavior.probeApproval) {
          pendingProbe = { id, setup: setup(params, threadId) };
          outstandingApproval = 'approval-probe';
          send({
            id: outstandingApproval,
            method: 'item/commandExecution/requestApproval',
            params: { threadId },
          });
        } else result(id, setup(params, threadId));
        break;
      }
      case 'thread/read':
        if (behavior.stale || !sessions[params.threadId]) error(id, -32600);
        else result(id, { thread: { id: params.threadId, turns: [] } });
        break;
      case 'thread/resume':
        if (!sessions[params.threadId]) error(id, -32600);
        else result(id, setup(params, params.threadId));
        break;
      case 'turn/start': {
        if (
          active ||
          !sessions[params.threadId] ||
          !Array.isArray(params.environments) ||
          params.environments.length !== 0 ||
          params.approvalPolicy !== 'never' ||
          params.sandboxPolicy?.type !== 'readOnly' ||
          params.sandboxPolicy?.networkAccess !== false ||
          params.input?.[0]?.type !== 'text'
        )
          throw new Error('Invalid chat turn');
        const turnId = randomUUID();
        const itemId = randomUUID();
        active = { threadId: params.threadId, turnId, itemId };
        result(id, { turn: { id: turnId, status: 'inProgress', items: [] } });
        if (behavior.exitDuringTurn) {
          process.exit(0);
          break;
        }
        if (behavior.malformed) {
          process.stdout.write('not-json\n');
          break;
        }
        notify('turn/started', {
          threadId: behavior.wrongThread ? 'other-thread' : params.threadId,
          turn: { id: turnId, status: 'inProgress', items: [] },
        });
        if (behavior.approval) {
          outstandingApproval = 'approval-1';
          send({
            id: outstandingApproval,
            method: 'item/commandExecution/requestApproval',
            params: {
              threadId: params.threadId,
              turnId,
              itemId,
            },
          });
          break;
        }
        notify('item/started', {
          threadId: params.threadId,
          turnId,
          item: {
            type: behavior.tool ? 'commandExecution' : 'agentMessage',
            id: itemId,
            text: '',
          },
        });
        if (behavior.stall)
          notify('item/agentMessage/delta', {
            threadId: params.threadId,
            turnId,
            itemId,
            delta: 'Waiting',
          });
        if (!behavior.stall && !behavior.tool) finish(behavior.failedTurn ? 'failed' : 'completed');
        break;
      }
      case 'turn/interrupt':
        if (!active || params.threadId !== active.threadId || params.turnId !== active.turnId)
          throw new Error('Wrong interrupt owner');
        record({ interrupted: true });
        result(id, {});
        finish('interrupted');
        break;
      default:
        error(id, -32601);
    }
  } catch {
    // Keep external failure text sanitized; never echo received data.
    process.stderr.write('Controlled fixture protocol failure\n');
    process.exitCode = 1;
    process.stdin.destroy();
  }
});
