import { expect, it } from 'vitest';

import { profileDraft, ProfileEditor, validateDraft } from './profile-editor';

it('retains protected values by omission and validates literal launch drafts before submission', () => {
  const draft = profileDraft({
    id: 'owned',
    name: 'Local agent',
    kind: 'acp',
    executable: 'agent',
    args: ['--label', 'two words', ''],
    cwd: './workspace',
    env: [{ name: 'OWNED_VALUE', hasValue: true }],
  });
  expect(draft.env).toEqual([{ name: 'OWNED_VALUE' }]);
  expect(draft.args).toEqual(['--label', 'two words', '']);
  expect(validateDraft(draft)).toEqual({});
  expect(
    validateDraft({
      ...draft,
      name: '',
      env: [{ name: 'OWNED_VALUE' }, { name: 'owned_value', value: '' }],
    }),
  ).toEqual({ name: 'Name is required.', 'env.1': 'Duplicate variable name.' });
});

it('protects unsaved edits, reverts, and drops retained-value semantics when an environment name changes', () => {
  const original = {
    id: 'owned',
    name: 'Local agent',
    kind: 'acp' as const,
    executable: 'agent',
    args: [],
    env: [{ name: 'OWNED_VALUE', hasValue: true }],
  };
  const editor = new ProfileEditor(original);
  expect(editor.getSnapshot().dirty).toBe(false);
  editor.edit({ name: 'Renamed' });
  expect(editor.getSnapshot().dirty).toBe(true);
  expect(editor.requestLeave()).toBe(false);
  editor.revert();
  expect(editor.getSnapshot().draft.name).toBe('Local agent');
  expect(editor.requestLeave()).toBe(true);
  editor.renameEnvironment(0, 'NEW_VALUE');
  expect(editor.getSnapshot().draft.env).toEqual([{ name: 'NEW_VALUE', value: '' }]);
});
