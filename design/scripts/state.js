/* ==================================================================
   Mock-only prototype. Nothing here launches processes, reads files,
   or talks to any agent. All values are fake.
================================================================== */
const ICON = {
  chevron: '<path d="m6 9 6 6 6-6"/>',
  up: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff:
    '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><path d="m2 2 20 20"/>',
  settings:
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  loader: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
};
const ic = (n, cls = '') =>
  `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[n]}</svg>`;
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const $ = (s) => document.querySelector(s);
let uid = 100;
const nid = (p) => p + uid++;

const TYPE = {
  codex: { label: 'Codex', exeLabel: 'Codex executable', exeDefault: 'codex' },
  claude: { label: 'Claude Code', exeLabel: 'Claude Code executable', exeDefault: 'claude' },
  acp: { label: 'Local ACP agent', exeLabel: 'Command', exeDefault: '' },
};

const state = {
  view: 'populated',
  activeId: 'p_claude',
  profiles: [
    {
      id: 'p_codex',
      type: 'codex',
      name: 'Codex',
      executable: 'codex',
      home: '',
      model: '',
      cwd: './workspace',
      args: [],
      env: [],
      status: 'idle',
      session: { resumable: true, when: 'Yesterday' },
    },
    {
      id: 'p_claude',
      type: 'claude',
      name: 'Claude Code',
      executable: 'claude',
      model: '',
      cwd: './workspace',
      args: [],
      env: [],
      status: 'connected',
      session: { resumable: true, when: 'Today' },
    },
    {
      id: 'p_acp',
      type: 'acp',
      name: 'My local agent',
      executable: 'node',
      model: '',
      cwd: './agents/local-agent',
      args: ['./dist/index.js', '--acp', '--log-level', 'info'],
      env: [
        { key: 'LOG_LEVEL', value: 'info', show: false },
        { key: 'MY_AGENT_TOKEN', value: 'mock-token-not-real', show: false },
      ],
      status: 'idle',
      session: null,
    },
  ],
  messages: [],
  forceScroll: true,
  stream: null,
  context: 38,
  settings: null, // { tab, selectedId, drafts: {id: draft}, tests: {id: {state, text, sub}} }
  menu: null,
  dialog: null,
};
const prof = (id) => state.profiles.find((p) => p.id === id);
const active = () => prof(state.activeId);

function seedMessages() {
  return [
    { t: 'divider', text: 'Yesterday' },
    { t: 'divider', text: 'Codex · new session' },
    {
      t: 'user',
      text: 'Can you help me plan dinners for this week? Vegetarian, about 30 minutes each.',
    },
    {
      t: 'asst',
      agent: 'p_codex',
      time: '7:12 PM',
      text: `Here's a simple plan that reuses ingredients so shopping stays small:

- **Mon** — Chickpea and spinach curry with rice
- **Tue** — Black bean tacos with quick pickled onions
- **Wed** — Pesto pasta with roasted cherry tomatoes
- **Thu** — Halloumi and vegetable sheet-pan bake
- **Fri** — Fried rice with leftover vegetables and eggs

Want a grocery list grouped by aisle?`,
    },
    { t: 'user', text: 'Yes please, grouped by aisle.' },
    {
      t: 'asst',
      agent: 'p_codex',
      time: '7:13 PM',
      text: `**Produce:** spinach, red onion, limes, cherry tomatoes, zucchini, bell peppers, garlic, ginger
**Pantry:** chickpeas, black beans, coconut milk, rice, pasta, curry paste, tortillas
**Dairy & eggs:** halloumi, eggs, parmesan
**Frozen:** peas, mixed vegetables`,
    },
    { t: 'divider', text: 'Today' },
    {
      t: 'divider',
      text: 'Switched to Claude Code · new session',
      sub: 'Claude Code didn’t see earlier messages from Codex.',
    },
    {
      t: 'user',
      text: "Draft a short message to my landlord asking to move Thursday's inspection to next Tuesday afternoon.",
    },
    {
      t: 'asst',
      agent: 'p_claude',
      time: '9:02 AM',
      text: `Here's a draft:

Hi Sam, would it be possible to move Thursday's inspection to next Tuesday afternoon? Anytime after 1 PM works for me. Sorry for the short notice, and thanks for being flexible.

Want it more formal, or shorter for a text message?`,
    },
    { t: 'user', text: 'Also, a PowerShell one-liner to list the 10 largest files in Downloads.' },
    {
      t: 'asst',
      agent: 'p_claude',
      time: '9:04 AM',
      text: `\`\`\`
Get-ChildItem "./downloads" -File -Recurse |
  Sort-Object Length -Descending |
  Select-Object -First 10 Name, @{n='MB';e={[math]::Round($_.Length/1MB,1)}}
\`\`\`
Remove \`-Recurse\` if you only want the top-level folder.`,
    },
  ];
}
state.messages = seedMessages();

/* ---------------- tiny markdown renderer (mock) ---------------- */
function md(src) {
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const out = [];
  const lines = src.split('\n');
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('```')) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^- /.test(l)) {
      const items = [];
      while (i < lines.length && /^- /.test(lines[i]))
        items.push(`<li>${inline(lines[i++].slice(2))}</li>`);
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    if (!l.trim()) {
      i++;
      continue;
    }
    const buf = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].startsWith('```') &&
      !/^- /.test(lines[i])
    )
      buf.push(inline(lines[i++]));
    out.push(`<p>${buf.join('<br>')}</p>`);
  }
  return out.join('');
}
