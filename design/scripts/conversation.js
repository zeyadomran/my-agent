/* ---------------- header ---------------- */
function renderHeader() {
  const a = active();
  $('#header').innerHTML = `
    <span class="title">Assistant</span>
    <span class="sub">· saved locally</span>
    <span class="spacer"></span>
    <button class="btn btn-outline btn-sm agent-trigger" data-act="menu-agent" aria-haspopup="menu" aria-expanded="${state.menu === 'agent'}">
      <span class="dot ${a.status}"></span><span class="name">${esc(a.name)}</span>${ic('chevron')}
    </button>
    <button class="btn btn-ghost btn-icon btn-sm" data-act="menu-more" aria-label="More" aria-haspopup="menu">${ic('more')}</button>
    <button class="btn btn-ghost btn-icon btn-sm" data-act="open-settings" aria-label="Settings">${ic('settings')}</button>`;
}

const statusText = (s) =>
  ({ connected: 'Connected', starting: 'Starting…', error: 'Error', idle: 'Not running' })[s];

function renderMenu() {
  const old = $('#menu');
  if (old) old.remove();
  if (!state.menu) return;
  const el = document.createElement('div');
  el.className = 'menu';
  el.id = 'menu';
  el.setAttribute('role', 'menu');
  if (state.menu === 'agent') {
    el.innerHTML =
      `<div class="menu-label">Agent</div>` +
      state.profiles
        .map(
          (p) => `
      <button class="menu-item" role="menuitemradio" aria-checked="${p.id === state.activeId}" data-act="pick-agent" data-id="${p.id}">
        <span class="dot ${p.status}"></span>
        <span class="stack"><span>${esc(p.name)}</span><small>${TYPE[p.type].label} · ${statusText(p.status)}</small></span>
        ${p.id === state.activeId ? `<span class="check">${ic('check')}</span>` : ''}
      </button>`,
        )
        .join('') +
      `
      <div class="separator"></div>
      <button class="menu-item" data-act="open-settings">${ic('settings')} Manage agents…</button>`;
  } else {
    el.innerHTML = `
      <div class="menu-label">Context <span class="muted" style="font-weight:400">· ${state.context}% used</span></div>
      <div class="progress"><div style="width:${state.context}%"></div></div>
      <button class="menu-item" data-act="compact">Compact context now<span class="meta">Planned</span></button>
      <div class="separator"></div>
      <button class="menu-item" data-act="toast" data-msg="Mock: would reveal transcript.jsonl in the file manager.">Show transcript file</button>`;
  }
  $('#app').appendChild(el);
  const trig = $(state.menu === 'agent' ? '[data-act="menu-agent"]' : '[data-act="menu-more"]');
  const ar = $('#app').getBoundingClientRect(),
    tr = trig.getBoundingClientRect();
  el.style.top = tr.bottom - ar.top + 4 + 'px';
  el.style.right = Math.max(8, ar.right - tr.right) + 'px';
  el.style.maxWidth = ar.width - 16 + 'px';
}

/* ---------------- transcript ---------------- */
function renderTranscript() {
  const box = $('#transcript');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  if (!state.messages.length) {
    const a = active();
    box.innerHTML = `<div class="empty">
      <h2>Start the conversation</h2>
      <p>This is your one conversation. It's saved on this computer and picks up where you left off.</p>
      <p style="margin-top:8px"><span class="badge"><span class="dot ${a.status}"></span>${esc(a.name)}</span></p>
    </div>`;
    return;
  }
  box.innerHTML = `<div class="column">${state.messages
    .map((m) => {
      if (m.t === 'divider')
        return `<div class="divider" role="separator"><span class="txt">${esc(m.text)}${m.sub ? `<small>${esc(m.sub)}</small>` : ''}</span></div>`;
      if (m.t === 'user')
        return `<div class="msg user"><div class="bubble">${esc(m.text)}</div></div>`;
      if (m.t === 'error')
        return `<div class="failed" role="alert">${ic('alert')}<span>Not delivered to ${esc(prof(m.agent) ? prof(m.agent).name : 'agent')}</span>
      <button class="btn btn-ghost" data-act="resend" data-i="${state.messages.indexOf(m)}">Edit &amp; resend</button></div>`;
      const p = prof(m.agent);
      const body = m.pending
        ? `<div class="typing" aria-label="Agent is responding"><span></span><span></span><span></span></div>`
        : `<div class="prose ${m.streaming ? 'caret' : ''}">${md(m.text)}</div>`;
      return `<div class="msg asst"><div class="meta"><span class="who">${esc(p ? p.name : 'Agent')}</span><span class="time">${esc(m.time || '')}</span></div>
      ${body}${m.stopped ? `<div class="stopped">Stopped</div>` : ''}</div>`;
    })
    .join('')}</div>`;
  if (nearBottom || state.stream || state.forceScroll) box.scrollTop = box.scrollHeight;
  state.forceScroll = false;
}

/* ---------------- composer ---------------- */
function renderComposer() {
  const a = active();
  const streaming = !!state.stream;
  const banner =
    a.status === 'error'
      ? `<div class="alert destructive" role="alert">${ic('alert')}
      <div class="a-title">${esc(a.name)} isn't running</div>
      <div class="a-desc">The process exited during startup (mock: exit code 1). Check the command and environment in settings.</div>
      <div class="a-actions"><button class="btn btn-outline btn-sm" data-act="retry">Retry</button><button class="btn btn-outline btn-sm" data-act="open-settings" data-id="${a.id}">Open agent settings</button></div></div>`
      : '';
  const prev = $('#composerInput');
  const val = prev ? prev.value : '';
  $('#composerWrap').innerHTML = `${banner}
    <div class="composer">
      <label class="sr-only" for="composerInput">Message</label>
      <textarea id="composerInput" rows="1" placeholder="Message ${esc(a.name)}…">${esc(val)}</textarea>
      <div class="bar">
        <p class="hint"><span class="kbd-hint">Enter to send · Shift+Enter for a new line</span></p>
        ${
          streaming
            ? `<button class="btn btn-default btn-icon btn-sm" data-act="stop" aria-label="Stop response"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none"/></svg></button>`
            : `<button class="btn btn-default btn-icon btn-sm" data-act="send" aria-label="Send" ${val.trim() ? '' : 'disabled'}>${ic('up')}</button>`
        }
      </div>
    </div>`;
  autosize();
}
function autosize() {
  const t = $('#composerInput');
  if (!t) return;
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 200) + 'px';
}
function nowTime() {
  return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

const REPLIES = [
  (p) =>
    `This is a mock reply from **${p.name}**. In the real app the agent's output streams in here, token by token.\n\nPress the stop button while it's typing to see how an interrupted reply looks.`,
  (p) =>
    `Sure. A few quick options:\n\n- Keep it short and direct\n- Add a little context first\n- Ask a follow-up question\n\n(Mock text, nothing was sent to ${p.name}.)`,
];
let replyIdx = 0;

function send() {
  const t = $('#composerInput');
  const text = t.value.trim();
  if (!text || state.stream) return;
  const a = active();
  if (state.view === 'empty') state.view = 'populated';
  state.messages.push({ t: 'user', text });
  state.forceScroll = true;
  t.value = '';
  if (a.status === 'error') {
    state.messages.push({ t: 'error', agent: a.id, text });
    renderComposer();
    renderTranscript();
    return;
  }
  const m = { t: 'asst', agent: a.id, time: nowTime(), text: '', pending: true };
  state.messages.push(m);
  const full = REPLIES[replyIdx++ % REPLIES.length](a);
  let i = 0;
  state.stream = { m, timer: null };
  state.stream.timer = setTimeout(function tick() {
    m.pending = false;
    m.streaming = true;
    i = Math.min(full.length, i + 3);
    m.text = full.slice(0, i);
    renderTranscript();
    if (i >= full.length) return finishStream();
    state.stream.timer = setTimeout(tick, 28);
  }, 700);
  state.context = Math.min(95, state.context + 2);
  renderComposer();
  renderTranscript();
  $('#composerInput').focus();
}
function finishStream(stopped) {
  if (!state.stream) return;
  clearTimeout(state.stream.timer);
  const m = state.stream.m;
  m.streaming = false;
  if (stopped) {
    if (m.pending) {
      m.pending = false;
      m.text = '';
    }
    m.stopped = true;
  }
  state.stream = null;
  renderComposer();
  renderTranscript();
}

/* ---------------- agent switching ---------------- */
function requestSwitch(id) {
  if (id === state.activeId) return;
  const p = prof(id),
    cur = active();
  const resume = p.session && p.session.resumable;
  openDialog({
    title: `Switch to ${p.name}?`,
    body: `<p class="desc">Your conversation stays right here. ${esc(p.name)} has its own session, so it won't see what you discussed with ${esc(cur.name)}.</p>
      <p class="desc">${resume ? `Its previous session (${esc(p.session.when.toLowerCase())}) will be resumed.` : `A new ${esc(p.name)} session will be started.`}</p>`,
    confirm: 'Switch agent',
    disabled: !!state.stream,
    note: state.stream ? 'Stop the current response first.' : '',
    onConfirm: () => {
      state.activeId = id;
      state.forceScroll = true;
      if (state.view === 'empty') state.view = 'populated';
      state.messages.push({
        t: 'divider',
        text: `Switched to ${p.name} · ${resume ? 'resumed session' : 'new session'}`,
        sub: resume
          ? `Messages sent to other agents since then aren't in its context.`
          : `${p.name} didn’t see earlier messages.`,
      });
      p.session = p.session || { resumable: true, when: 'Today' };
      p.status = 'starting';
      renderAll();
      setTimeout(() => {
        if (p.status === 'starting') {
          p.status = 'connected';
          renderAll();
        }
      }, 900);
    },
  });
}

/* ---------------- generic dialogs ---------------- */
function openDialog(d) {
  state.dialog = d;
  renderLayer();
  setTimeout(() => {
    const b = document.querySelector('#dlg [data-act="dlg-ok"]');
    b && b.focus();
  }, 0);
}
function closeDialog() {
  state.dialog = null;
  renderLayer();
}
