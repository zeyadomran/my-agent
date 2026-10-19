/* ---------------- settings ---------------- */
const clone = (p) => JSON.parse(JSON.stringify(p));
function openSettings(id) {
  state.menu = null;
  renderMenu();
  state.settings = { tab: 'agents', selectedId: id || state.activeId, drafts: {}, tests: {} };
  renderLayer();
}
function draftOf(id) {
  const s = state.settings;
  if (!s.drafts[id]) s.drafts[id] = clone(prof(id));
  return s.drafts[id];
}
function isDirty(id) {
  const d = state.settings.drafts[id];
  if (!d) return false;
  const strip = (x) =>
    JSON.stringify({ ...x, status: 0, session: 0, env: x.env.map((e) => [e.key, e.value]) });
  return strip(d) !== strip(prof(id));
}
function errorsOf(d) {
  const e = {};
  if (!d.name.trim()) e.name = 'Name is required.';
  if (!d.executable.trim())
    e.executable = d.type === 'acp' ? 'Command is required.' : 'Executable is required.';
  const seen = {};
  d.env.forEach((r, i) => {
    if (!r.key.trim()) {
      if (r.value) e['env' + i] = 'Variable name is required.';
      return;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(r.key))
      e['env' + i] = 'Use letters, numbers and underscores; can’t start with a number.';
    else if (seen[r.key.toUpperCase()]) e['env' + i] = 'Duplicate variable name.';
    seen[r.key.toUpperCase()] = true;
  });
  return e;
}
const quote = (a) => (a === '' ? '""' : /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
function launchPreview(d) {
  const parts = [quote(d.executable || '<command>')];
  if (d.type === 'acp') d.args.forEach((a) => parts.push(quote(a)));
  else parts.push(d.type === 'codex' ? 'app-server' : '<managed by app>');
  let s = parts.join(' ');
  const envs = d.env.filter((r) => r.key.trim());
  if (envs.length)
    s += `\n\n+ ${envs.length} environment variable${envs.length > 1 ? 's' : ''}: ${envs.map((r) => r.key + '=••••').join(', ')}`;
  if (d.cwd.trim()) s += `\n  in ${d.cwd}`;
  return s;
}

function renderSettings() {
  const s = state.settings;
  const navItems = state.profiles
    .map((p) => {
      const d = s.drafts[p.id] || p;
      return `<button class="nav-item" data-act="sel-profile" data-id="${p.id}" aria-current="${p.id === s.selectedId}">
      <span class="dot ${p.status}"></span>
      <span class="stack"><span>${esc(d.name || 'Untitled')}</span><small>${TYPE[p.type].label}${p.id === state.activeId ? ' · Active' : ''}</small></span>
      ${isDirty(p.id) ? '<span class="dirty" title="Unsaved changes"></span>' : ''}
    </button>`;
    })
    .join('');
  const mobileNav = `<select class="select" data-act="sel-profile-mobile" aria-label="Agent profile">
      ${state.profiles.map((p) => `<option value="${p.id}" ${p.id === s.selectedId ? 'selected' : ''}>${esc((s.drafts[p.id] || p).name || 'Untitled')}${isDirty(p.id) ? ' •' : ''} — ${TYPE[p.type].label}</option>`).join('')}
    </select>
    <button class="btn btn-outline btn-icon" data-act="add-profile" aria-label="Add agent profile">${ic('plus')}</button>`;

  let main;
  if (s.tab === 'conversation') {
    main = `<div class="s-scroll">
      <div class="section">
        <h4>Transcript</h4>
        <p class="hint">There is exactly one conversation. Every message is appended to a local file as it happens.</p>
        <dl class="kv">
          <dt>Location</dt><dd class="mono" style="font-size:13px">./data/transcript.jsonl</dd>
          <dt>Size</dt><dd>${state.messages.length} entries · 18 KB (mock)</dd>
        </dl>
        <div style="margin-top:14px"><button class="btn btn-outline btn-sm" data-act="toast" data-msg="Mock: would reveal transcript.jsonl in the file manager.">Show in folder</button></div>
      </div>
      <div class="section">
        <h4>Context</h4>
        <p class="hint">When an agent's context fills up, older turns can be summarized for that agent. The full transcript always stays on disk.</p>
        <div class="setting-row">
          <div class="t"><div>Compact automatically when nearly full</div><p class="hint" style="margin-top:2px">Planned. Not part of the first version.</p></div>
          <button class="switch" role="switch" aria-checked="false" disabled aria-label="Compact automatically"></button>
        </div>
      </div>
    </div>`;
  } else {
    const p = prof(s.selectedId),
      d = draftOf(s.selectedId),
      errs = errorsOf(d),
      T = TYPE[d.type];
    const test = s.tests[d.id];
    const isActive = d.id === state.activeId;
    const st = test ? test.state : p.status;
    const stTitle = test
      ? test.text
      : {
          connected: 'Connected',
          idle: 'Not running',
          error: 'Last start failed',
          starting: 'Starting…',
        }[p.status];
    const stSub = test
      ? test.sub
      : p.status === 'connected'
        ? 'Running with the saved configuration.'
        : p.status === 'error'
          ? 'Mock: process exited with code 1.'
          : 'Starts when you switch to this agent, or test it here.';
    main = `<div class="s-scroll">
      <div class="form-head">
        <div class="t"><h3 id="fhName">${esc(d.name || 'Untitled')}</h3><p>${T.label}</p></div>
        ${isActive ? `<span class="badge badge-secondary">Active</span>` : `<button class="btn btn-outline btn-sm" data-act="use-agent" data-id="${d.id}">Use this agent</button>`}
      </div>

      <div class="section">
        <div class="field">
          <label class="label" for="f-name">Name</label>
          <input class="input" id="f-name" data-f="name" value="${esc(d.name)}" aria-invalid="${!!errs.name}">
          ${errs.name ? `<p class="err">${errs.name}</p>` : ''}
        </div>
      </div>

      <div class="section">
        <h4>Launch</h4>
        <p class="hint">${d.type === 'acp' ? 'The app starts this command and talks to it over ACP (stdio). Nothing runs through a shell.' : `The app starts ${T.label} with this executable and manages its own launch arguments.`}</p>
        <div class="field">
          <label class="label" for="f-exe">${T.exeLabel}</label>
          <input class="input mono" id="f-exe" data-f="executable" value="${esc(d.executable)}" placeholder="${d.type === 'acp' ? 'e.g. node, python, or ./bin/agent' : T.exeDefault}" aria-invalid="${!!errs.executable}" spellcheck="false">
          ${errs.executable ? `<p class="err">${errs.executable}</p>` : `<p class="hint">${d.type === 'acp' ? 'A program name on PATH or an absolute path.' : `Leave as “${T.exeDefault}” to use the one on PATH.`}</p>`}
        </div>
        ${
          d.type === 'acp'
            ? `
        <div class="field">
          <span class="label" id="lbl-args">Arguments</span>
          <p class="hint" style="margin:-2px 0 10px">One literal argument per row, in launch order. No quoting needed.</p>
          <div class="rows" role="list" aria-labelledby="lbl-args">
            ${
              d.args.length
                ? d.args
                    .map(
                      (a, i) => `<div class="row" role="listitem">
                <span class="idx">${i + 1}</span>
                <input class="input mono" data-arg="${i}" value="${esc(a)}" aria-label="Argument ${i + 1}" spellcheck="false">
                <button class="btn btn-ghost btn-icon" data-act="rm-arg" data-i="${i}" aria-label="Remove argument ${i + 1}">${ic('x')}</button>
              </div>`,
                    )
                    .join('')
                : `<div class="row-empty">No arguments.</div>`
            }
          </div>
          <button class="btn btn-outline btn-sm add-row" data-act="add-arg">${ic('plus')} Add argument</button>
        </div>`
            : ''
        }
        <div class="${d.type === 'acp' ? '' : 'grid2'}" style="margin-top:16px">
          ${
            d.type === 'codex'
              ? `<div class="field">
            <label class="label" for="f-home">CODEX_HOME</label>
            <input class="input mono" id="f-home" data-f="home" value="${esc(d.home)}" placeholder="Default (~/.codex)" spellcheck="false">
          </div>`
              : ''
          }
          ${
            d.type !== 'acp'
              ? `<div class="field">
            <label class="label" for="f-model">Model</label>
            <input class="input" id="f-model" data-f="model" value="${esc(d.model)}" placeholder="Default from ${T.label} config">
          </div>`
              : ''
          }
          <div class="field" ${d.type === 'claude' ? '' : d.type === 'codex' ? 'style="grid-column:1/-1"' : ''}>
            <label class="label" for="f-cwd">Working directory</label>
            <input class="input mono" id="f-cwd" data-f="cwd" value="${esc(d.cwd)}" placeholder="Default: your home folder" spellcheck="false">
          </div>
        </div>
      </div>

      <div class="section">
        <h4>Environment variables</h4>
        <p class="hint">Added to the app's environment when this agent starts. Values are hidden by default.</p>
        <div class="rows">
          ${
            d.env.length
              ? d.env
                  .map(
                    (r, i) => `<div class="env-row">
              <input class="input mono env-key" data-env-key="${i}" value="${esc(r.key)}" placeholder="NAME" aria-label="Variable ${i + 1} name" aria-invalid="${!!errs['env' + i]}" spellcheck="false">
              <input class="input mono" data-env-val="${i}" type="${r.show ? 'text' : 'password'}" value="${esc(r.value)}" placeholder="value" aria-label="Variable ${i + 1} value" autocomplete="off" spellcheck="false">
              <button class="btn btn-ghost btn-icon" data-act="toggle-env" data-i="${i}" aria-label="${r.show ? 'Hide' : 'Show'} value" aria-pressed="${r.show}">${ic(r.show ? 'eyeOff' : 'eye')}</button>
              <button class="btn btn-ghost btn-icon" data-act="rm-env" data-i="${i}" aria-label="Remove variable ${i + 1}">${ic('trash')}</button>
              ${errs['env' + i] ? `<p class="err env-err">${errs['env' + i]}</p>` : ''}
            </div>`,
                  )
                  .join('')
              : `<div class="row-empty">No environment variables.</div>`
          }
        </div>
        <button class="btn btn-outline btn-sm add-row" data-act="add-env">${ic('plus')} Add variable</button>
      </div>

      <div class="section">
        <h4>Launch preview</h4>
        <p class="hint">What will run, for checking. Values are masked.</p>
        <pre class="preview-cmd mono" id="launchPreview">${esc(launchPreview(d))}</pre>
      </div>

      <div class="section">
        <h4>Connection</h4>
        <p class="hint">Tests the settings shown here, including unsaved changes.</p>
        <div class="status-line">
          <div class="msgtxt">${st === 'starting' ? ic('loader', 'spin') + ' ' : `<span class="dot ${st}"></span>`}${esc(stTitle)}<small>${esc(stSub)}</small></div>
          <button class="btn btn-outline btn-sm" data-act="test" ${st === 'starting' || Object.keys(errs).length ? 'disabled' : ''}>Test connection</button>
        </div>
      </div>
    </div>
    <div class="s-foot">
      <button class="btn btn-ghost btn-ghost-destructive btn-sm" data-act="del-profile" ${isActive ? 'disabled title="Switch to another agent first"' : ''}>${ic('trash')} Delete profile</button>
      <span class="grow" id="dirtyNote">${isDirty(d.id) ? 'Unsaved changes' : isActive ? 'Saved changes restart the active agent.' : ''}</span>
      <button class="btn btn-outline btn-sm" data-act="revert" ${isDirty(d.id) ? '' : 'disabled'}>Revert</button>
      <button class="btn btn-default btn-sm" data-act="save" ${isDirty(d.id) && !Object.keys(errs).length ? '' : 'disabled'}>Save</button>
    </div>`;
  }

  return `<div class="overlay full" data-act="overlay-settings">
    <div class="dialog settings" role="dialog" aria-modal="true" aria-labelledby="settingsTitle">
      <button class="btn btn-ghost btn-icon btn-sm close" data-act="close-settings" aria-label="Close">${ic('x')}</button>
      <div class="s-head">
        <h2 id="settingsTitle">Settings</h2>
        <div class="tabs" role="tablist">
          <button role="tab" aria-selected="${s.tab === 'agents'}" data-act="tab" data-tab="agents">Agents</button>
          <button role="tab" aria-selected="${s.tab === 'conversation'}" data-act="tab" data-tab="conversation">Conversation</button>
        </div>
      </div>
      <div class="s-body">
        ${
          s.tab === 'agents'
            ? `<nav class="s-nav" aria-label="Agent profiles">${navItems}
          <button class="btn btn-ghost btn-sm add" data-act="add-profile">${ic('plus')} Add profile</button></nav>
          <div class="s-nav-mobile">${mobileNav}</div>`
            : ''
        }
        <div class="s-main">${main}</div>
      </div>
    </div>
  </div>`;
}
