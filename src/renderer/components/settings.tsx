import { PlusIcon } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';

import type { ProfileSummary, ProviderKind } from '../../shared/contracts';
import type { RendererController } from '../controller';
import { ProfileEditor } from '../profile-editor';
import { ProfileForm, providerNames } from './profile-form';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Field, FieldGroup, FieldLabel } from './ui/field';
import { Input } from './ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';

export function Settings({
  controller,
  onClose,
  onSelect,
}: {
  controller: RendererController;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [editor, setEditor] = useState(() => {
    const profiles = state.app?.profiles ?? [];
    const first = profiles.find((p) => p.id === state.app?.activeProfileId) ?? profiles[0];
    return first === undefined ? null : new ProfileEditor(first);
  });
  const [pending, setPending] = useState<{ action: () => void } | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ProviderKind>('codex');
  const ready = state.availability === 'ready';
  const busy = state.busy !== null;
  const profiles = state.app?.profiles ?? [];
  function leave(action: () => void) {
    if (busy) return;
    if (editor !== null && !editor.requestLeave()) setPending({ action });
    else action();
  }
  function choose(profile: ProfileSummary) {
    leave(() => {
      setEditor(new ProfileEditor(profile));
    });
  }
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (editor !== null && !editor.requestLeave()) event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => {
      window.removeEventListener('beforeunload', handler);
    };
  }, [editor]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) leave(onClose);
      }}
    >
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-4xl"
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Configure your agents and one continuous conversation.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="agents" className="min-h-0 flex-1">
          <TabsList>
            <TabsTrigger value="agents">Agents</TabsTrigger>
            <TabsTrigger value="conversation">Conversation</TabsTrigger>
          </TabsList>
          <TabsContent value="agents" className="min-h-0 overflow-y-auto">
            {!ready ? (
              <Alert>
                <AlertTitle>Application service unavailable</AlertTitle>
                <AlertDescription>
                  Profile editing requires the full application bridge.
                </AlertDescription>
              </Alert>
            ) : (
              <div className="flex min-h-0 flex-col gap-4 sm:flex-row">
                <nav aria-label="Agent profiles" className="flex shrink-0 flex-col gap-2 sm:w-44">
                  <div className="sm:hidden">
                    <Select
                      value={editor?.getSnapshot().draft.id ?? null}
                      items={profiles.map((p) => ({ value: p.id, label: p.name }))}
                      disabled={busy}
                      onValueChange={(id) => {
                        const p = profiles.find((p) => p.id === id);
                        if (p !== undefined) choose(p);
                      }}
                    >
                      <SelectTrigger aria-label="Edit agent profile" className="w-full">
                        <SelectValue placeholder="New profile" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {profiles.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="hidden flex-col gap-1 sm:flex">
                    {profiles.map((p) => (
                      <Button
                        key={p.id}
                        variant={p.id === editor?.getSnapshot().draft.id ? 'secondary' : 'ghost'}
                        disabled={busy}
                        className="h-auto justify-start py-2 text-left"
                        onClick={() => {
                          choose(p);
                        }}
                      >
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate">{p.name}</span>
                          <span className="text-xs text-muted-foreground">
                            {providerNames[p.kind]}
                            {p.id === state.app?.activeProfileId ? ' · Active' : ''}
                          </span>
                        </span>
                      </Button>
                    ))}
                  </div>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      leave(() => {
                        setName('');
                        setAdding(true);
                      });
                    }}
                  >
                    <PlusIcon data-icon="inline-start" />
                    Add profile
                  </Button>
                </nav>
                <div className="min-w-0 flex-1">
                  {editor === null ? (
                    <p className="py-6 text-sm text-muted-foreground">
                      Add an agent profile to begin.
                    </p>
                  ) : (
                    <EditorPane
                      key={editor.getSnapshot().draft.id}
                      editor={editor}
                      controller={controller}
                      onSelect={(id) => {
                        leave(() => {
                          onSelect(id);
                        });
                      }}
                      onDeleted={() => {
                        const first = controller.getSnapshot().app?.profiles[0];
                        setEditor(first === undefined ? null : new ProfileEditor(first));
                      }}
                    />
                  )}
                </div>
              </div>
            )}
          </TabsContent>
          <TabsContent value="conversation" className="flex flex-col gap-4 py-4 text-sm">
            <h2 className="font-medium">Single transcript</h2>
            <p className="text-muted-foreground">
              The application retains one permanent conversation. Switching profiles keeps the
              transcript and carries available earlier context within the provider’s limits.
            </p>
            <p className="text-muted-foreground">
              Native sessions are profile-specific. Context availability can differ between
              providers and does not guarantee unlimited history.
            </p>
          </TabsContent>
        </Tabs>
        <div className="flex justify-end border-t pt-3">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              leave(onClose);
            }}
          >
            Close settings
          </Button>
        </div>
      </DialogContent>
      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>Your profile edits have not been saved.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setPending(null);
              }}
            >
              Keep editing
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const action = pending?.action;
                setPending(null);
                editor?.revert();
                action?.();
              }}
            >
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add agent profile</DialogTitle>
            <DialogDescription>
              Create a named Codex, Claude Code, or Local ACP profile.
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim() === '') return;
              setEditor(
                new ProfileEditor(
                  {
                    id: crypto.randomUUID(),
                    name: name.trim(),
                    kind,
                    executable: kind === 'codex' ? 'codex' : kind === 'claude-code' ? 'claude' : '',
                    args: [],
                    env: [],
                  },
                  true,
                ),
              );
              setAdding(false);
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="new-name">Profile name</FieldLabel>
                <Input
                  id="new-name"
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                  }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="new-kind">Agent type</FieldLabel>
                <Select
                  value={kind}
                  onValueChange={(value) => {
                    if (value !== null) setKind(value);
                  }}
                  items={Object.entries(providerNames).map(([value, label]) => ({ value, label }))}
                >
                  <SelectTrigger id="new-kind" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {Object.entries(providerNames).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setAdding(false);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={name.trim() === ''}>
                Add profile
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}

function EditorPane({
  editor,
  controller,
  onSelect,
  onDeleted,
}: {
  editor: ProfileEditor;
  controller: RendererController;
  onSelect: (id: string) => void;
  onDeleted: () => void;
}) {
  const { draft, dirty, errors, inputEpoch } = useSyncExternalStore(
    editor.subscribe,
    editor.getSnapshot,
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [notice, setNotice] = useState<{ draft: typeof draft; text: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const busy = state.busy !== null;
  const valid = Object.keys(errors).length === 0;
  const exists = state.app?.profiles.some((p) => p.id === draft.id) === true;
  const active = state.app?.activeProfileId === draft.id;
  async function save() {
    if (await editor.save(controller)) setNotice(null);
  }
  async function test() {
    if (!valid) return;
    const result = await controller.testConnection(draft);
    setNotice({
      draft,
      text: result.ok
        ? 'Connection test succeeded for this draft.'
        : 'Connection test failed. Check the executable, arguments, and environment.',
    });
  }
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-medium wrap-anywhere">
            {draft.name || 'Untitled profile'}
            {dirty ? ' · Unsaved' : ''}
          </h2>
          <p className="text-xs text-muted-foreground">{providerNames[draft.kind]}</p>
        </div>
        {active ? (
          <Badge variant="secondary">Active</Badge>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={busy || dirty || !exists || state.app?.activeRun != null}
            onClick={() => {
              onSelect(draft.id);
            }}
          >
            Use this agent
          </Button>
        )}
      </div>
      {state.error !== null && (
        <Alert variant="destructive">
          <AlertTitle>Request failed</AlertTitle>
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      <ProfileForm key={inputEpoch} editor={editor} controller={controller} disabled={busy} />
      <p role="status" className="text-sm text-muted-foreground">
        {state.busy === 'test'
          ? 'Testing connection…'
          : notice?.draft === draft
            ? notice.text
            : 'Connection not tested for this draft.'}
      </p>
      <div className="flex flex-wrap gap-2 border-t pt-4">
        <Button
          disabled={busy || !dirty || !valid}
          onClick={() => {
            void save();
          }}
        >
          {state.busy === 'save' ? 'Saving…' : 'Save profile'}
        </Button>
        <Button
          variant="outline"
          disabled={busy || !dirty}
          onClick={() => {
            editor.revert();
            setNotice(null);
          }}
        >
          Revert
        </Button>
        <Button
          variant="outline"
          disabled={busy || !valid || state.app?.activeRun != null}
          onClick={() => {
            void test();
          }}
        >
          Test connection
        </Button>
        {exists && (
          <Button
            variant="destructive"
            disabled={busy || active || state.app?.activeRun != null}
            onClick={() => {
              setDeleting(true);
            }}
          >
            Delete profile
          </Button>
        )}
      </div>
      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {draft.name}?</DialogTitle>
            <DialogDescription>
              This removes the inactive profile. Its historical messages remain in the single
              transcript.{dirty ? ' Unsaved changes to this profile will also be discarded.' : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setDeleting(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                void controller.deleteProfile(draft.id).then((deleted) => {
                  if (deleted) onDeleted();
                });
              }}
            >
              Delete profile
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
