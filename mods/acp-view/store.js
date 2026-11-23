// A pane's bookkeeping (folder, session id, bridge info), in that pane copy's
// own localStorage. Herdr keeps it per copy and across restarts; each pane is
// opened with a unique `id` prop so two panes never share one.

export class Store {
  get(key) {
    try {
      const v = localStorage.getItem(`acp-view:${key}`);
      return v ? JSON.parse(v) : null;
    } catch {
      return null;
    }
  }

  set(key, value) {
    try {
      if (value === null || value === undefined) localStorage.removeItem(`acp-view:${key}`);
      else localStorage.setItem(`acp-view:${key}`, JSON.stringify(value));
    } catch {}
  }
}
