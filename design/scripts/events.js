/* ---------------- events ---------------- */
const app = $('#app');
app.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  // close open menu on any outside click
  if (state.menu && !e.target.closest('#menu') && !(t && /^menu-/.test(t.dataset.act))) {
    state.menu = null;
    renderMenu();
    renderHeader();
  }
  if (!t) return;
  const act = t.dataset.act,
    s = state.settings;
  switch (act) {
    case 'menu-agent':
    case 'menu-more': {
      const m = act === 'menu-agent' ? 'agent' : 'more';
      state.menu = state.menu === m ? null : m;
      renderHeader();
      renderMenu();
      break;
    }
    case 'pick-agent':
      state.menu = null;
      renderHeader();
      renderMenu();
      requestSwitch(t.dataset.id);
      break;
    case 'open-settings':
      openSettings(t.dataset.id);
      break;
    case 'compact':
      state.menu = null;
      renderMenu();
      if (state.stream) {
        toast('Stop the current response first.');
        break;
      }
      state.messages.push({
        t: 'divider',
        text: `Context compacted for ${active().name}`,
        sub: 'Older turns were summarized for the agent. The full transcript is still saved.',
      });
      state.context = 12;
      state.forceScroll = true;
      renderAll();
      break;
    case 'toast':
      state.menu = null;
      renderMenu();
      toast(t.dataset.msg);
      break;
    case 'send':
      send();
      break;
    case 'stop':
      finishStream(true);
      break;
    case 'resend': {
      const i = +t.dataset.i,
        m = state.messages[i];
      state.messages.splice(i - 1, 2);
      renderTranscript();
      const ta = $('#composerInput');
      ta.value = m.text;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.focus();
      break;
    }
    case 'retry': {
      const a = active();
      a.status = 'starting';
      renderAll();
      setTimeout(() => {
        a.status = 'connected';
        renderAll();
        toast(`${a.name} started (mock).`);
      }, 900);
      break;
    }
    case 'dlg-cancel':
      closeDialog();
      break;
    case 'overlay-dlg':
      if (e.target === t) closeDialog();
      break;
    case 'dlg-ok': {
      const d = state.dialog;
      state.dialog = null;
      d.onConfirm && d.onConfirm();
      renderLayer();
      break;
    }
    // settings
    case 'overlay-settings':
      if (e.target !== t) break; /* fallthrough */
    case 'close-settings': {
      const dirty = state.profiles.filter((p) => isDirty(p.id));
      if (dirty.length)
        openDialog({
          title: 'Discard unsaved changes?',
          body: `<p class="desc">You have unsaved changes to ${dirty.map((p) => '“' + esc(state.settings.drafts[p.id].name || 'Untitled') + '”').join(', ')}.</p>`,
          confirm: 'Discard',
          destructive: true,
          onConfirm: () => {
            state.settings = null;
          },
        });
      else {
        state.settings = null;
        renderLayer();
      }
      break;
    }
    case 'tab':
      s.tab = t.dataset.tab;
      rerenderSettingsKeepFocus();
      break;
    case 'sel-profile':
      s.selectedId = t.dataset.id;
      rerenderSettingsKeepFocus();
      break;
    case 'add-profile':
      addProfileDialog();
      break;
    case 'use-agent':
      requestSwitch(t.dataset.id);
      break;
    case 'add-arg': {
      const d = draftOf(s.selectedId);
      d.args.push('');
      rerenderSettingsKeepFocus(`[data-arg="${d.args.length - 1}"]`);
      break;
    }
    case 'rm-arg': {
      const d = draftOf(s.selectedId);
      d.args.splice(+t.dataset.i, 1);
      rerenderSettingsKeepFocus();
      break;
    }
    case 'add-env': {
      const d = draftOf(s.selectedId);
      d.env.push({ key: '', value: '', show: false });
      rerenderSettingsKeepFocus(`[data-env-key="${d.env.length - 1}"]`);
      break;
    }
    case 'rm-env': {
      const d = draftOf(s.selectedId);
      d.env.splice(+t.dataset.i, 1);
      rerenderSettingsKeepFocus();
      break;
    }
    case 'toggle-env': {
      const d = draftOf(s.selectedId);
      const r = d.env[+t.dataset.i];
      r.show = !r.show;
      rerenderSettingsKeepFocus(`[data-act="toggle-env"][data-i="${t.dataset.i}"]`);
      break;
    }
    case 'test':
      runTest(s.selectedId);
      break;
    case 'revert':
      delete s.drafts[s.selectedId];
      delete s.tests[s.selectedId];
      rerenderSettingsKeepFocus();
      break;
    case 'save':
      saveProfile(s.selectedId);
      break;
    case 'del-profile': {
      const p = prof(s.selectedId);
      openDialog({
        title: `Delete “${p.name}”?`,
        body: `<p class="desc">This removes the profile and its saved settings. The conversation transcript is not affected.</p>`,
        confirm: 'Delete profile',
        destructive: true,
        onConfirm: () => {
          state.profiles = state.profiles.filter((x) => x.id !== p.id);
          delete s.drafts[p.id];
          s.selectedId = state.activeId;
          renderAll();
          toast(`Deleted “${p.name}”.`);
        },
      });
      break;
    }
  }
});

app.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'composerInput') {
    autosize();
    const b = document.querySelector('[data-act="send"]');
    if (b) b.disabled = !t.value.trim();
    return;
  }
  const s = state.settings;
  if (!s) return;
  const d = draftOf(s.selectedId);
  if (t.dataset.f) d[t.dataset.f] = t.value;
  else if (t.dataset.arg !== undefined) d.args[+t.dataset.arg] = t.value;
  else if (t.dataset.envKey !== undefined) d.env[+t.dataset.envKey].key = t.value;
  else if (t.dataset.envVal !== undefined) d.env[+t.dataset.envVal].value = t.value;
  else return;
  delete s.tests[d.id];
  refreshSettingsMeta();
});
// show validation on blur
app.addEventListener('focusout', (e) => {
  const t = e.target;
  const s = state.settings;
  if (!s || !(t.dataset.f || t.dataset.envKey !== undefined)) return;
  const next = e.relatedTarget;
  setTimeout(() => {
    if (!state.settings || state.dialog) return;
    const sel =
      next && next.id
        ? '#' + next.id
        : next && next.dataset.arg !== undefined
          ? `[data-arg="${next.dataset.arg}"]`
          : next && next.dataset.envKey !== undefined
            ? `[data-env-key="${next.dataset.envKey}"]`
            : next && next.dataset.envVal !== undefined
              ? `[data-env-val="${next.dataset.envVal}"]`
              : null;
    if (next && next.dataset && next.dataset.act) return; // let the click handler re-render
    rerenderSettingsKeepFocus(sel);
  }, 0);
});
app.addEventListener('change', (e) => {
  if (e.target.dataset.act === 'sel-profile-mobile') {
    state.settings.selectedId = e.target.value;
    rerenderSettingsKeepFocus();
  }
});
app.addEventListener('keydown', (e) => {
  if (e.target.id === 'composerInput' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
  if (e.key === 'Escape') {
    if (state.menu) {
      state.menu = null;
      renderMenu();
      renderHeader();
    } else if (state.dialog) closeDialog();
    else if (state.settings) document.querySelector('[data-act="close-settings"]').click();
  }
});

renderAll();
