import { readFile } from 'node:fs/promises';

import { expect, test } from 'vitest';

import type { ProviderEvent } from '../../shared/contracts';
import { createAcpAdapter } from './acp';
import { assertRetired, records, scenario } from './fixtures/harness';

test('handoff preserves whole messages and discloses bounded history without truncating current input', async () => {
  const { request, journal } = await scenario();
  const adapter = createAcpAdapter();
  const content = `Message prefix ${'x'.repeat(20_000)} message suffix`;
  const historyMessage = {
    id: 'history',
    role: 'user' as const,
    status: 'complete' as const,
    content,
    profile: null,
    createdAt: '',
    updatedAt: '',
  };
  const transcript = [historyMessage];
  try {
    const events: ProviderEvent[] = [];
    const run = adapter
      .run({ ...request, transcript }, new AbortController().signal)
      [Symbol.asyncIterator]();
    expect((await run.next()).value).toMatchObject({ type: 'session' });
    expect((await records(journal)).some((entry) => entry.method === 'session/prompt')).toBe(false);
    for (let next = await run.next(); next.done !== true; next = await run.next())
      events.push(next.value);
    expect(events.at(-1)).toEqual({ type: 'completed' });
    expect((await readFile(journal, 'utf8')).includes(content)).toBe(true);
    await assertRetired(journal);
    const excessive = transcript.map((message) => ({
      ...message,
      content: 'large'.repeat(60_000),
    }));
    const over: ProviderEvent[] = [];
    for await (const event of adapter.run(
      { ...request, transcript: excessive },
      new AbortController().signal,
    ))
      over.push(event);
    expect(over.at(-1)).toEqual({ type: 'completed' });
    expect(over).toContainEqual({
      type: 'context',
      handoff: { omittedMessages: 1, includedMessages: 0 },
    });
    expect(
      (await records(journal)).filter((entry) => entry.method === 'session/prompt'),
    ).toHaveLength(2);
    expect(excessive[0]?.content.length).toBe(300_000);
    await assertRetired(journal);
    // Raw text fits, but historical JSON nested inside the RPC envelope does not.
    const escaped = [
      { ...historyMessage, content: '"\\'.repeat(40_000) },
      { ...historyMessage, id: 'recent', content: 'Recent whole message' },
    ];
    const bounded = adapter
      .run({ ...request, transcript: escaped }, new AbortController().signal)
      [Symbol.asyncIterator]();
    expect((await bounded.next()).value).toEqual({
      type: 'context',
      handoff: { omittedMessages: 1, includedMessages: 1 },
    });
    // Consuming a notice does not acknowledge the separate native checkpoint.
    expect(
      (await records(journal)).filter((entry) => entry.method === 'session/prompt'),
    ).toHaveLength(2);
    expect((await bounded.next()).value).toMatchObject({ type: 'session' });
    expect(
      (await records(journal)).filter((entry) => entry.method === 'session/prompt'),
    ).toHaveLength(2);
    const boundedEvents: ProviderEvent[] = [];
    for (let next = await bounded.next(); next.done !== true; next = await bounded.next())
      boundedEvents.push(next.value);
    expect(boundedEvents.at(-1)).toEqual({ type: 'completed' });
    const boundedLine =
      (await readFile(journal, 'utf8'))
        .trim()
        .split('\n')
        .filter((line) => line.includes('session/prompt'))
        .at(-1) ?? '';
    expect(Buffer.byteLength(boundedLine)).toBeLessThanOrEqual(256 * 1024);
    expect(boundedLine).toContain('Context handoff limit: 1 earlier message(s) omitted');
    expect(boundedLine).toContain('Recent whole message');
    expect(boundedLine).toContain(request.prompt);
    await assertRetired(journal);
    const tooLarge: ProviderEvent[] = [];
    for await (const event of adapter.run(
      { ...request, prompt: '\\'.repeat(131_072) },
      new AbortController().signal,
    ))
      tooLarge.push(event);
    expect(tooLarge).toEqual([{ type: 'failed', code: 'input-too-large' }]);
    expect(
      (await records(journal)).filter((entry) => entry.method === 'session/prompt'),
    ).toHaveLength(3);
    await assertRetired(journal);
  } finally {
    await adapter.dispose();
  }
});
