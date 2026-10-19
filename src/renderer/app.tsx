import { SettingsIcon } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';

import type { RendererBridge } from '../shared/contracts';
import { Composer } from './components/composer';
import { Conversation } from './components/conversation';
import { providerNames } from './components/profile-form';
import { Settings } from './components/settings';
import { Alert, AlertDescription, AlertTitle } from './components/ui/alert';
import { Button } from './components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './components/ui/select';
import { RendererController } from './controller';

export function App({ bridge }: { bridge?: Partial<RendererBridge> }) {
  const [controller] = useState(() => new RendererController(bridge ?? window.myAgent));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [settings, setSettings] = useState(false);
  const [switchTo, setSwitchTo] = useState<string | null>(null);
  const app = state.app;
  const ready = state.availability === 'ready';
  const profiles = app?.profiles ?? [];
  const active = profiles.find((profile) => profile.id === app?.activeProfileId);
  const target = profiles.find((profile) => profile.id === switchTo);
  useEffect(() => {
    void controller.start();
    return () => {
      controller.dispose();
    };
  }, [controller]);
  useEffect(() => {
    const query = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.classList.toggle('dark', query.matches);
    apply();
    query.addEventListener('change', apply);
    return () => {
      query.removeEventListener('change', apply);
    };
  }, []);
  return (
    <main className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
      <header className="flex h-13 shrink-0 items-center gap-2 border-b px-3 sm:px-4">
        <h1 className="text-sm font-semibold">Assistant</h1>
        <span className="hidden text-xs text-muted-foreground sm:inline">One conversation</span>
        <div className="flex-1" />
        <Select
          value={app?.activeProfileId ?? null}
          items={[
            { value: null, label: 'Choose an agent' },
            ...profiles.map((p) => ({ value: p.id, label: p.name })),
          ]}
          disabled={!ready || state.busy !== null || app?.activeRun != null}
          onValueChange={(id) => {
            if (id !== null && id !== app?.activeProfileId) setSwitchTo(id);
          }}
        >
          <SelectTrigger aria-label="Active agent" className="max-w-48 min-w-0">
            <SelectValue className="min-w-0 truncate" />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false} className="w-64 max-w-[calc(100vw-2rem)]">
            <SelectGroup>
              {profiles.map((profile) => (
                <SelectItem key={profile.id} value={profile.id}>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{profile.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {providerNames[profile.kind]}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Settings"
          onClick={() => {
            setSettings(true);
          }}
        >
          <SettingsIcon />
        </Button>
      </header>
      {state.availability !== 'ready' && (
        <div className="mx-auto w-full max-w-3xl px-4 pt-4">
          <Alert>
            <AlertTitle>
              {state.availability === 'loading'
                ? 'Loading conversation…'
                : 'Application service unavailable'}
            </AlertTitle>
            <AlertDescription>
              {state.availability === 'scaffold'
                ? 'This build exposes the foundation bridge. Agent settings and chat become available when the application service is connected.'
                : state.availability === 'loading'
                  ? 'Reading saved application state.'
                  : 'The bridge could not provide a ready application. Try loading it again.'}
              {state.availability === 'unavailable' && (
                <Button
                  variant="outline"
                  onClick={() => {
                    void controller.start();
                  }}
                >
                  Try again
                </Button>
              )}
            </AlertDescription>
          </Alert>
        </div>
      )}
      <Conversation messages={app?.messages ?? []} />
      <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-4">
        {state.error !== null && (
          <Alert variant="destructive" className="mb-3">
            <AlertTitle>Request failed</AlertTitle>
            <AlertDescription>
              {state.error}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setSettings(true);
                  }}
                >
                  Open settings
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    controller.clearError();
                  }}
                >
                  Dismiss
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}
        <Composer controller={controller} state={state} name={active?.name ?? 'agent'} />
      </div>
      {settings && (
        <Settings
          controller={controller}
          onClose={() => {
            setSettings(false);
          }}
          onSelect={(id) => {
            setSettings(false);
            setSwitchTo(id);
          }}
        />
      )}
      <Dialog
        open={target !== undefined}
        onOpenChange={(open) => {
          if (!open) setSwitchTo(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Switch to {target?.name}?</DialogTitle>
            <DialogDescription>
              Your single transcript is retained. The app carries earlier conversation context to
              this agent within the provider’s limits. Each profile has its own native session;
              available context may differ.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setSwitchTo(null);
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={state.busy !== null || app?.activeRun != null}
              onClick={() => {
                if (target !== undefined) {
                  void controller.selectProfile(target.id);
                  setSwitchTo(null);
                }
              }}
            >
              Switch agent
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
