import { ArrowUpIcon, SquareIcon } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';

import type { RendererController, RendererState } from '../controller';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';

export function Composer({
  controller,
  state,
  name,
}: {
  controller: RendererController;
  state: RendererState;
  name: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const run = state.app?.activeRun;
  const enabled = state.availability === 'ready' && state.app?.activeProfileId != null;
  const canSend = enabled && run == null && state.busy === null && state.composer.trim() !== '';
  useLayoutEffect(() => {
    const input = ref.current;
    if (input === null) return;
    input.style.height = 'auto';
    input.style.height = `${String(Math.min(input.scrollHeight, 200))}px`;
  }, [state.composer]);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) void controller.send();
      }}
      className="flex flex-col gap-2"
    >
      <div className="rounded-xl border p-2 focus-within:ring-2 focus-within:ring-ring/50">
        <label htmlFor="message" className="sr-only">
          Message
        </label>
        <Textarea
          ref={ref}
          id="message"
          rows={1}
          className="max-h-50 min-h-10 resize-none border-0 shadow-none focus-visible:ring-0"
          disabled={!enabled}
          placeholder={`Message ${name}…`}
          value={state.composer}
          onChange={(event) => {
            controller.setComposer(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (canSend) void controller.send();
          }}
        />
        <div className="flex items-center justify-between gap-2 px-1 pt-1">
          <p className="text-xs text-muted-foreground">
            Enter to send · Shift+Enter for a new line
          </p>
          {run != null ? (
            <Button
              type="button"
              size="icon-sm"
              aria-label="Stop response"
              disabled={state.busy !== null}
              onClick={() => {
                void controller.stop();
              }}
            >
              <SquareIcon />
            </Button>
          ) : (
            <Button type="submit" size="icon-sm" aria-label="Send" disabled={!canSend}>
              <ArrowUpIcon />
            </Button>
          )}
        </div>
      </div>
      <p role="status" className="text-center text-xs text-muted-foreground">
        {!enabled
          ? 'Service unavailable'
          : run != null
            ? state.busy === 'stop'
              ? 'Stopping…'
              : 'Agent responding…'
            : state.busy === 'send'
              ? 'Sending…'
              : 'Ready · one continuous transcript'}
      </p>
    </form>
  );
}
