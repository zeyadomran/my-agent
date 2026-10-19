import type { ProfileDraft, ProfileSummary, Result } from '../shared/contracts';
import type { RendererController } from './controller';

export function profileDraft(profile: ProfileSummary): ProfileDraft {
  return { ...profile, args: [...profile.args], env: profile.env.map(({ name }) => ({ name })) };
}

function normalizeDraft(draft: ProfileDraft): ProfileDraft {
  const { cwd, model, ...rest } = draft;
  return {
    ...rest,
    ...(cwd === undefined || cwd.trim() === '' ? {} : { cwd }),
    ...(model === undefined || model.trim() === '' ? {} : { model }),
  };
}

export function validateDraft(draft: ProfileDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (draft.name.trim() === '') errors.name = 'Name is required.';
  if (draft.executable.trim() === '') errors.executable = 'Executable is required.';
  for (const field of ['name', 'executable', 'cwd', 'model'] as const) {
    if (draft[field]?.includes('\0') === true) errors[field] = 'Null characters are not allowed.';
  }
  draft.args.forEach((arg, index) => {
    if (arg.includes('\0')) errors[`arg.${String(index)}`] = 'Null characters are not allowed.';
  });
  const names = new Set<string>();
  draft.env.forEach((entry, index) => {
    const key = `env.${String(index)}`;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name))
      errors[key] = 'Use letters, numbers and underscores; start with a letter or underscore.';
    else if (names.has(entry.name.toUpperCase())) errors[key] = 'Duplicate variable name.';
    names.add(entry.name.toUpperCase());
    if (entry.value?.includes('\0') === true) errors[key] = 'Null characters are not allowed.';
  });
  return errors;
}

export class ProfileEditor {
  private state: {
    draft: ProfileDraft;
    dirty: boolean;
    errors: Record<string, string>;
    inputEpoch: number;
  };
  private baseline: ProfileSummary;
  private listeners = new Set<() => void>();
  constructor(
    profile: ProfileSummary,
    private isNew = false,
  ) {
    this.baseline = profile;
    const draft = profileDraft(profile);
    this.state = { draft, dirty: isNew, errors: validateDraft(draft), inputEpoch: 0 };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  edit(patch: Partial<Omit<ProfileDraft, 'id'>>) {
    this.replaceDraft({ ...this.state.draft, ...patch });
  }
  private replaceDraft(draft: ProfileDraft) {
    this.state = {
      draft,
      inputEpoch: this.state.inputEpoch,
      dirty: this.isNew || JSON.stringify(draft) !== JSON.stringify(profileDraft(this.baseline)),
      errors: validateDraft(draft),
    };
    this.listeners.forEach((listener) => {
      listener();
    });
  }
  requestLeave() {
    return !this.state.dirty;
  }
  revert() {
    this.state = { ...this.state, inputEpoch: this.state.inputEpoch + 1 };
    this.replaceDraft(profileDraft(this.baseline));
  }
  saved(profile: ProfileSummary) {
    this.baseline = profile;
    this.isNew = false;
    this.revert();
  }
  async testConnection(controller: RendererController): Promise<Result<null>> {
    const { draft } = this.state;
    if (Object.keys(validateDraft(draft)).length !== 0) return { ok: false, code: 'invalid-input' };
    return controller.testConnection(normalizeDraft(draft));
  }
  async save(controller: RendererController): Promise<boolean> {
    const { draft } = this.state;
    if (Object.keys(validateDraft(draft)).length !== 0) return false;
    const app = await controller.saveProfile(normalizeDraft(draft));
    const saved = app?.profiles.find((profile) => profile.id === draft.id);
    if (saved === undefined) return false;
    if (this.state.draft === draft) this.saved(saved);
    return true;
  }
  renameEnvironment(index: number, name: string) {
    this.edit({
      env: this.state.draft.env.map((entry, i) => (i === index ? { name, value: '' } : entry)),
    });
  }
  hasStoredValue(name: string) {
    return this.baseline.env.some((entry) => entry.name === name && entry.hasValue);
  }
}
