import { PlusIcon, XIcon } from 'lucide-react';
import { useSyncExternalStore } from 'react';

import type { RendererController } from '../controller';
import type { ProfileEditor } from '../profile-editor';
import { SecretInput } from './secret-input';
import { Button } from './ui/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from './ui/field';
import { Input } from './ui/input';

export const providerNames = { codex: 'Codex', 'claude-code': 'Claude Code', acp: 'Local ACP' };

export function ProfileForm({
  editor,
  controller,
  disabled,
}: {
  editor: ProfileEditor;
  controller: RendererController;
  disabled: boolean;
}) {
  const { draft, errors } = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  function textField(
    field: 'name' | 'executable' | 'cwd' | 'model',
    label: string,
    description?: string,
  ) {
    const error = errors[field];
    return (
      <Field data-invalid={error !== undefined}>
        <FieldLabel htmlFor={`profile-${field}`}>{label}</FieldLabel>
        <Input
          id={`profile-${field}`}
          value={draft[field] ?? ''}
          aria-invalid={error !== undefined}
          aria-describedby={`${field}-description`}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            editor.edit({ [field]: event.target.value });
          }}
        />
        <FieldDescription id={`${field}-description`}>{description}</FieldDescription>
        {error !== undefined && <FieldError>{error}</FieldError>}
      </Field>
    );
  }
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <FieldGroup>
        {textField('name', 'Name')}
        <FieldSet>
          <FieldLegend>Launch</FieldLegend>
          <FieldDescription>
            Arguments are literal values in launch order. Nothing runs through a shell.
          </FieldDescription>
          {textField('executable', 'Executable', 'A program on PATH or the path to an executable.')}
          <FieldSet>
            <FieldLegend variant="label">Arguments</FieldLegend>
            {draft.args.map((arg, index) => (
              <Field key={index} data-invalid={errors[`arg.${String(index)}`] !== undefined}>
                <FieldLabel className="sr-only" htmlFor={`arg-${String(index)}`}>
                  Argument {index + 1}
                </FieldLabel>
                <div className="flex min-w-0 items-center gap-2">
                  <span className="text-xs text-muted-foreground">{index + 1}</span>
                  <Input
                    id={`arg-${String(index)}`}
                    value={arg}
                    aria-invalid={errors[`arg.${String(index)}`] !== undefined}
                    spellCheck={false}
                    onChange={(event) => {
                      editor.edit({
                        args: draft.args.map((value, i) =>
                          i === index ? event.target.value : value,
                        ),
                      });
                    }}
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove argument ${String(index + 1)}`}
                    onClick={() => {
                      editor.edit({ args: draft.args.filter((_, i) => i !== index) });
                    }}
                  >
                    <XIcon />
                  </Button>
                </div>
                {errors[`arg.${String(index)}`] !== undefined && (
                  <FieldError>{errors[`arg.${String(index)}`]}</FieldError>
                )}
              </Field>
            ))}
            <Button
              type="button"
              className="self-start"
              variant="outline"
              size="sm"
              onClick={() => {
                editor.edit({ args: [...draft.args, ''] });
              }}
            >
              <PlusIcon data-icon="inline-start" />
              Add argument
            </Button>
          </FieldSet>
          {textField(
            'cwd',
            'Working directory',
            'Optional. Relative paths use the app’s stable workspace base.',
          )}
          {textField(
            'model',
            'Model',
            'Optional. Provider support and access depend on the configured agent.',
          )}
        </FieldSet>
        <FieldSet>
          <FieldLegend>Environment</FieldLegend>
          <FieldDescription>
            Stored values stay protected. Omitted values are retained; Replace with an empty input
            explicitly clears a value.
          </FieldDescription>
          {draft.env.map((entry, index) => (
            <Field key={index} data-invalid={errors[`env.${String(index)}`] !== undefined}>
              <div className="flex min-w-0 items-center gap-2">
                <FieldLabel className="sr-only" htmlFor={`env-${String(index)}`}>
                  Environment name {index + 1}
                </FieldLabel>
                <Input
                  className="min-w-0 flex-1"
                  id={`env-${String(index)}`}
                  value={entry.name}
                  aria-invalid={errors[`env.${String(index)}`] !== undefined}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="VARIABLE_NAME"
                  onChange={(event) => {
                    editor.renameEnvironment(index, event.target.value);
                  }}
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove environment variable ${String(index + 1)}`}
                  onClick={() => {
                    editor.edit({ env: draft.env.filter((_, i) => i !== index) });
                  }}
                >
                  <XIcon />
                </Button>
              </div>
              <SecretInput
                key={entry.name}
                entry={entry}
                index={index}
                profileId={draft.id}
                stored={editor.hasStoredValue(entry.name)}
                controller={controller}
                disabled={disabled}
                onChange={(value) => {
                  editor.edit({
                    env: draft.env.map((row, i) =>
                      i === index
                        ? value === undefined
                          ? { name: row.name }
                          : { name: row.name, value }
                        : row,
                    ),
                  });
                }}
              />
              {errors[`env.${String(index)}`] !== undefined && (
                <FieldError>{errors[`env.${String(index)}`]}</FieldError>
              )}
            </Field>
          ))}
          <Button
            type="button"
            className="self-start"
            variant="outline"
            size="sm"
            onClick={() => {
              editor.edit({ env: [...draft.env, { name: '', value: '' }] });
            }}
          >
            <PlusIcon data-icon="inline-start" />
            Add variable
          </Button>
        </FieldSet>
        <FieldSet>
          <FieldLegend>Launch preview</FieldLegend>
          <pre className="overflow-x-auto rounded-lg border bg-muted p-3 text-xs whitespace-pre-wrap wrap-anywhere">
            {[
              `Executable: ${JSON.stringify(draft.executable)}`,
              `Arguments: ${JSON.stringify(draft.args)}`,
              `Working directory: ${JSON.stringify(draft.cwd ?? '') || 'Workspace base'}`,
              `Environment names: ${draft.env.map((row) => `${row.name}=****`).join(', ') || '(none)'}`,
            ].join('\n')}
          </pre>
        </FieldSet>
      </FieldGroup>
    </fieldset>
  );
}
