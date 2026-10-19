/* refresh only the bits that depend on typed values (keeps focus) */
function refreshSettingsMeta() {
  const s = state.settings;
  if (!s || s.tab !== 'agents') return;
  const d = draftOf(s.selectedId),
    errs = errorsOf(d),
    dirty = isDirty(d.id);
  const lp = $('#launchPreview');
  if (lp) lp.textContent = launchPreview(d);
  const fh = $('#fhName');
  if (fh) fh.textContent = d.name || 'Untitled';
  const dn = $('#dirtyNote');
  if (dn)
    dn.textContent = dirty
      ? 'Unsaved changes'
      : d.id === state.activeId
        ? 'Saved changes restart the active agent.'
        : '';
  const sv = document.querySelector('[data-act="save"]');
  if (sv) sv.disabled = !(dirty && !Object.keys(errs).length);
  const rv = document.querySelector('[data-act="revert"]');
  if (rv) rv.disabled = !dirty;
  const tb = document.querySelector('[data-act="test"]');
  if (tb)
    tb.disabled =
      !!Object.keys(errs).length || (s.tests[d.id] && s.tests[d.id].state === 'starting');
  // nav labels + dirty dots
  const item = document.querySelector(`.nav-item[data-id="${d.id}"]`);
  if (item) {
    item.querySelector('.stack span').textContent = d.name || 'Untitled';
    const dot = item.querySelector('.dirty');
    if (dirty && !dot)
      item.insertAdjacentHTML('beforeend', '<span class="dirty" title="Unsaved changes"></span>');
    if (!dirty && dot) dot.remove();
  }
  const opt = document.querySelector(`[data-act="sel-profile-mobile"] option[value="${d.id}"]`);
  if (opt) opt.textContent = `${d.name || 'Untitled'}${dirty ? ' •' : ''} — ${TYPE[d.type].label}`;
  // inline field errors appear on blur (full re-render) to avoid stealing focus
}

function rerenderSettingsKeepFocus(focusSel) {
  const scroll = $('.s-scroll');
  const top = scroll ? scroll.scrollTop : 0;
  renderLayer();
  const sc = $('.s-scroll');
  if (sc) sc.scrollTop = top;
  if (focusSel) {
    const f = document.querySelector(focusSel);
    if (f) {
      f.focus();
      if (f.setSelectionRange && f.type !== 'password') {
        const n = f.value.length;
        f.setSelectionRange(n, n);
      }
    }
  }
}

function runTest(id) {
  const d = draftOf(id),
    s = state.settings;
  s.tests[id] = { state: 'starting', text: 'Starting…', sub: `Launching ${d.executable} (mock)` };
  rerenderSettingsKeepFocus();
  setTimeout(() => {
    if (!state.settings) return;
    const exe = d.executable.trim();
    let r;
    if (/missing|notfound|bad/i.test(exe))
      r = {
        state: 'error',
        text: 'Couldn’t start the process',
        sub: `Mock: spawn ${exe} ENOENT. Check the path or PATH.`,
      };
    else if (d.type === 'acp')
      r = {
        state: 'connected',
        text: 'Connected',
        sub: `Mock: ACP initialize succeeded. Agent reported “${d.name}”. Process stopped after test.`,
      };
    else
      r = {
        state: 'connected',
        text: 'Connected',
        sub: `Mock: ${TYPE[d.type].label} responded and is signed in. Process stopped after test.`,
      };
    s.tests[id] = r;
    if (state.settings && state.settings.selectedId === id && state.settings.tab === 'agents')
      rerenderSettingsKeepFocus();
  }, 1100);
}

function saveProfile(id) {
  const d = draftOf(id),
    p = prof(id);
  const keep = { status: p.status, session: p.session };
  Object.assign(p, clone(d), keep);
  p.env.forEach((e) => (e.show = false));
  delete state.settings.drafts[id];
  if (id === state.activeId) {
    p.status = 'starting';
    setTimeout(() => {
      if (p.status === 'starting') {
        p.status = 'connected';
        renderAll();
      }
    }, 900);
  }
  toast(`Saved “${p.name}”.${id === state.activeId ? ' Restarting agent (mock).' : ''}`);
  renderAll();
}

function addProfileDialog() {
  openDialog({
    title: 'Add agent profile',
    body: `<p class="desc">Profiles are named launch configurations. You can have more than one of each type.</p>
      <div class="field" style="margin-top:16px">
        <label class="label" for="np-name">Name</label>
        <input class="input" id="np-name" placeholder="e.g. Work Codex">
      </div>
      <div class="field">
        <span class="label">Type</span>
        <div class="radio-cards" role="radiogroup">
          <label class="radio-card"><input type="radio" name="np-type" value="codex"><div><div>Codex</div><small>OpenAI Codex CLI, installed on this computer.</small></div></label>
          <label class="radio-card"><input type="radio" name="np-type" value="claude"><div><div>Claude Code</div><small>Anthropic Claude Code CLI, installed on this computer.</small></div></label>
          <label class="radio-card"><input type="radio" name="np-type" value="acp" checked><div><div>Local ACP agent</div><small>Any program that speaks the Agent Client Protocol over stdio.</small></div></label>
        </div>
      </div>`,
    confirm: 'Add profile',
    onConfirm: () => {
      const type = document.querySelector('input[name="np-type"]:checked').value;
      const name =
        $('#np-name').value.trim() || (type === 'acp' ? 'New local agent' : TYPE[type].label);
      const p = {
        id: nid('p_'),
        type,
        name,
        executable: TYPE[type].exeDefault,
        home: '',
        model: '',
        cwd: '',
        args: [],
        env: [],
        status: 'idle',
        session: null,
      };
      state.profiles.push(p);
      if (state.settings) {
        state.settings.tab = 'agents';
        state.settings.selectedId = p.id;
      }
      renderAll();
      setTimeout(() => {
        const f = $('#f-exe');
        f && f.focus();
      }, 0);
    },
  });
}

/* ---------------- layer (settings + dialogs) ---------------- */
function renderLayer() {
  let html = '';
  if (state.settings) html += renderSettings();
  if (state.dialog) {
    const d = state.dialog;
    html += `<div class="overlay top" data-act="overlay-dlg"><div class="dialog" id="dlg" role="alertdialog" aria-modal="true" aria-labelledby="dlgTitle">
      <h2 id="dlgTitle">${esc(d.title)}</h2>${d.body}
      ${d.note ? `<p class="err">${esc(d.note)}</p>` : ''}
      <div class="footer"><button class="btn btn-outline" data-act="dlg-cancel">Cancel</button>
      <button class="btn ${d.destructive ? 'btn-destructive' : 'btn-default'}" data-act="dlg-ok" ${d.disabled ? 'disabled' : ''}>${esc(d.confirm)}</button></div>
    </div></div>`;
  }
  $('#layer').innerHTML = html;
}

function renderAll() {
  renderHeader();
  renderMenu();
  renderComposer();
  renderTranscript();
  renderLayer();
  syncProto();
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/* ---------------- prototype controls ---------------- */
function syncProto() {
  document.querySelectorAll('[data-proto]').forEach((b) => {
    const k = b.dataset.proto,
      v = b.dataset.v;
    const cur =
      k === 'view'
        ? state.view
        : k === 'theme'
          ? $('#app').classList.contains('dark')
            ? 'dark'
            : 'light'
          : active().status === 'error'
            ? 'error'
            : 'connected';
    b.setAttribute('aria-pressed', String(cur === v));
  });
}
document.querySelector('.proto').addEventListener('click', (e) => {
  const b = e.target.closest('[data-proto]');
  if (!b) return;
  const k = b.dataset.proto,
    v = b.dataset.v;
  if (k === 'theme') $('#app').classList.toggle('dark', v === 'dark');
  if (k === 'status') active().status = v;
  if (k === 'view') {
    finishStream(true);
    state.view = v;
    state.messages = v === 'empty' ? [] : seedMessages();
    state.forceScroll = true;
  }
  renderAll();
});
