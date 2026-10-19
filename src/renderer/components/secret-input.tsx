import { EyeIcon, EyeOffIcon, XIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { EnvironmentDraft } from '../../shared/contracts';
import type { RendererController } from '../controller';
import { Button } from './ui/button';
import { Input } from './ui/input';

/** Revealed values live only in this intentional input, never in the app/controller state. */
export function SecretInput({
  entry,
  index,
  profileId,
  stored,
  controller,
  onChange,
  disabled,
}: {
  entry: EnvironmentDraft;
  index: number;
  profileId: string;
  stored: boolean;
  controller: RendererController;
  onChange: (value: string | undefined) => void;
  disabled: boolean;
}) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const retained = entry.value === undefined;
  const reveal = async () => {
    if (show) {
      setShow(false);
      setRevealed(null);
      return;
    }
    if (!retained || !stored) {
      setShow(true);
      return;
    }
    setLoading(true);
    const result = await controller.revealEnvironmentValue(profileId, entry.name);
    if (!alive.current) return;
    setLoading(false);
    if (result.ok) {
      setRevealed(result.value);
      setShow(true);
    }
  };
  return (
    <div className="flex min-w-0 items-center gap-1">
      <Input
        aria-label={`Environment value ${String(index + 1)}`}
        type={show ? 'text' : 'password'}
        autoComplete="off"
        spellCheck={false}
        className="min-w-0 flex-1"
        disabled={disabled || loading}
        readOnly={retained && show && revealed !== null}
        placeholder={retained && stored ? 'Stored value retained' : 'Value'}
        value={retained ? (revealed ?? '') : entry.value}
        onChange={(event) => {
          setRevealed(null);
          onChange(event.target.value);
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`${show ? 'Hide' : 'Reveal'} value ${String(index + 1)}`}
        disabled={disabled || loading}
        onClick={() => {
          void reveal();
        }}
      >
        {show ? <EyeOffIcon /> : <EyeIcon />}
      </Button>
      {retained && stored ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || loading}
          onClick={() => {
            setRevealed(null);
            setShow(false);
            onChange('');
          }}
        >
          Replace
        </Button>
      ) : (
        stored && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Retain stored value ${String(index + 1)}`}
            disabled={disabled}
            onClick={() => {
              setRevealed(null);
              setShow(false);
              onChange(undefined);
            }}
          >
            <XIcon />
          </Button>
        )
      )}
    </div>
  );
}
