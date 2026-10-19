import { useEffect, useState } from 'react';

import { Button } from './components/ui/button';

export function App() {
  const [status, setStatus] = useState('Loading foundation…');

  useEffect(() => {
    let active = true;

    void window.myAgent.getState().then(
      () => {
        if (active) setStatus('Repository foundation');
      },
      () => {
        if (active) setStatus('Unable to read application state');
      },
    );
    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="flex min-h-svh flex-col bg-background text-foreground">
      <header className="border-b px-6 py-4 font-semibold">my-agent</header>
      <section className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-3 px-6">
        <p className="text-sm text-muted-foreground" role="status">
          {status}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">One conversation, your agents.</h1>
        <p className="text-muted-foreground">
          This scaffold is ready for the approved chat interface. Provider connections and durable
          history are still to be implemented.
        </p>
        <div>
          <Button disabled>Chat coming next</Button>
        </div>
      </section>
    </main>
  );
}
