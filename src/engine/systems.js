// Ordered system registry supporting update, tier rebuild, and disposal lifecycles.

export class SystemRegistry {
  constructor() {
    this._list = [];
    this._map = new Map();
  }

  register(name, system) {
    if (this._map.has(name)) {
      const idx = this._list.findIndex((e) => e.name === name);
      if (idx >= 0) this._list[idx].system = system;
    } else {
      this._list.push({ name, system });
    }
    this._map.set(name, system);
    return system;
  }

  get(name) {
    return this._map.get(name) ?? null;
  }

  has(name) {
    return this._map.has(name);
  }

  names() {
    return this._list.map((e) => e.name);
  }

  entries() {
    return this._list.slice();
  }

  update(frame) {
    for (let i = 0; i < this._list.length; i++) {
      this._list[i].system.update?.(frame);
    }
  }

  setTier(tier, ctx) {
    for (let i = 0; i < this._list.length; i++) {
      this._list[i].system.setTier?.(tier, ctx);
    }
  }

  dispose() {
    for (let i = this._list.length - 1; i >= 0; i--) {
      this._list[i].system.dispose?.();
    }
    this._list.length = 0;
    this._map.clear();
  }
}
