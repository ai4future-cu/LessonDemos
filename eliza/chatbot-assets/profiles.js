'use strict';

// Only named rule snapshots are stored. Keys and conversation text never enter this module.
(() => {
  const storageKey = 'chatbot-lab.my-elizas.v1';
  const limit = 3;
  function create(storage, validate = () => true) {
    let entries = [];
    let persistent = true;
    try {
      const saved = JSON.parse(storage.getItem(storageKey) || '[]');
      if (!Array.isArray(saved)) throw new Error('Invalid library');
      const seen = new Set();
      entries = saved.filter(entry => {
        try {
          if (!entry || typeof entry.id !== 'string' || seen.has(entry.id) ||
              typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 40 ||
              !entry.snapshot || entry.snapshot.schemaVersion !== 1 || !validate(entry.snapshot)) return false;
          seen.add(entry.id);
          return true;
        } catch { return false; }
      }).slice(0, limit).map(({id, name, snapshot}) => ({id, name, snapshot}));
    } catch { persistent = false; }
    const clone = value => JSON.parse(JSON.stringify(value));
    const persist = next => {
      try { storage.setItem(storageKey, JSON.stringify(next)); persistent = true; }
      catch { persistent = false; }
      entries = clone(next);
    };
    return {
      list: () => clone(entries),
      get: id => clone(entries.find(entry => entry.id === id) || null),
      isPersistent: () => persistent,
      save({id, name, snapshot}) {
        name = typeof name === 'string' ? name.trim() : '';
        if (!name || name.length > 40) throw new Error('Give your ELIZA a name of up to 40 characters.');
        if (!snapshot || !validate(snapshot)) throw new Error('These rules could not be saved.');
        const index = entries.findIndex(entry => entry.id === id);
        if (index < 0 && entries.length >= limit) throw new Error('You have 3 saved ELIZAs. Load one to update it, or delete a version in Save your ELIZA.');
        const entry = {id: index < 0 ? 'eliza-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10) : id, name, snapshot:clone(snapshot)};
        const next = clone(entries);
        if (index < 0) next.push(entry);
        else next[index] = entry;
        persist(next);
        return clone(entry);
      },
      remove(id) { persist(entries.filter(entry => entry.id !== id)); },
      restore(entry) {
        if (entries.length >= limit) throw new Error('Delete another version before restoring this ELIZA.');
        if (!entries.some(item => item.id === entry.id)) persist([...entries, clone(entry)]);
      }
    };
  }
  window.ElizaLibrary = {create, limit};
})();
