import { open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { makeDirectory, records } from './harness';

test('a live fixture journal exposes only completely published records', async () => {
  const directory = await makeDirectory();
  const journal = join(directory, 'journal.jsonl');
  // Hold the real publication boundary after file creation, before the append.
  const writer = await open(journal, 'a');
  try {
    expect(await records(journal, { live: true })).toEqual([]);
    await expect(records(journal)).rejects.toBeInstanceOf(SyntaxError);
    // No newline means the append is still in flight, even if JSON is parseable.
    await writer.write('{"method":"initialize"}');
    expect(await records(journal, { live: true })).toEqual([]);
    await writer.write('\n');
    expect(await records(journal, { live: true })).toEqual([{ method: 'initialize' }]);
    await writer.write('{"method":');
    expect(await records(journal, { live: true })).toEqual([{ method: 'initialize' }]);
    await expect(records(journal)).rejects.toBeInstanceOf(SyntaxError);
    await writer.write('"session/new"}\n');
    expect(await records(journal)).toEqual([{ method: 'initialize' }, { method: 'session/new' }]);
  } finally {
    await writer.close();
  }
});

test('fixture journal read failures retain only a safe filesystem classification', async () => {
  const directory = await makeDirectory();
  await expect(records(directory, { live: true })).rejects.toMatchObject({
    code: 'EISDIR',
    message: 'Fixture journal read failed (EISDIR)',
  });
});

test('a malformed published record fails with its phase and without journal content', async () => {
  const journal = join(await makeDirectory(), 'journal.jsonl');
  await writeFile(journal, '{"method":"initialize","private":"synthetic canary" broken}\n');
  await expect(records(journal, { live: true })).rejects.toMatchObject({
    name: 'SyntaxError',
    message: 'Fixture journal parse failed (published record)',
  });
});
