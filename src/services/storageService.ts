const STORAGE_KEY = 'story-architect.document.v1';

export type StorageChangeKind = 'present' | 'missing';

export interface StorageChangeEvent {
  kind: StorageChangeKind;
  value: string | null;
}

type StorageListener = (event: StorageChangeEvent) => void;

export interface StorageService {
  read(): string | null;
  write(value: string): void;
  remove(): void;
  /** 订阅同一来源（其它标签页）引起的变更；本页自己的写入不回调 */
  observe(listener: StorageListener): () => void;
}

export class BrowserStorageService implements StorageService {
  read(): string | null {
    return window.localStorage.getItem(STORAGE_KEY);
  }

  write(value: string): void {
    // 值没变就不写，避免无意义的存储事件
    if (window.localStorage.getItem(STORAGE_KEY) === value) return;
    window.localStorage.setItem(STORAGE_KEY, value);
  }

  remove(): void {
    window.localStorage.removeItem(STORAGE_KEY);
  }

  observe(listener: StorageListener): () => void {
    const handler = (event: StorageEvent) => {
      if (event.key !== null && event.key !== STORAGE_KEY) return;
      listener({
        kind: event.newValue === null ? 'missing' : 'present',
        value: event.newValue,
      });
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }
}

/**
 * 内存存储后端：同一个 backendKey 的服务共享数据，模拟「同一浏览器的多个标签页」。
 * 与浏览器一致：只通知「其它」服务实例，写入者自身永不收到自己写入的事件，
 * 通知通过宏任务派发（对齐 storage 事件的异步时序）。
 */
export class MemoryStorageBackend {
  private static readonly backends = new Map<string, MemoryStorageBackend>();

  static shared(key: string = STORAGE_KEY): MemoryStorageBackend {
    let backend = this.backends.get(key);
    if (!backend) {
      backend = new MemoryStorageBackend();
      this.backends.set(key, backend);
    }
    return backend;
  }

  private value: string | null = null;
  private readonly listeners = new Map<StorageService, StorageListener>();

  read(): string | null {
    return this.value;
  }

  write(owner: StorageService, value: string): boolean {
    if (this.value === value) return false;
    this.value = value;
    this.broadcast(owner, 'present', value);
    return true;
  }

  erase(owner: StorageService): void {
    if (this.value === null) return;
    this.value = null;
    this.broadcast(owner, 'missing', null);
  }

  connect(owner: StorageService, listener: StorageListener): () => void {
    this.listeners.set(owner, listener);
    return () => {
      this.listeners.delete(owner);
    };
  }

  private broadcast(owner: StorageService, kind: StorageChangeKind, value: string | null): void {
    const targets = [...this.listeners.entries()].filter(([service]) => service !== owner);
    for (const [, listener] of targets) {
      const event: StorageChangeEvent = { kind, value };
      setTimeout(() => listener(event), 0);
    }
  }
}

export class MemoryStorageService implements StorageService {
  private readonly backend: MemoryStorageBackend;

  constructor(backend: MemoryStorageBackend = MemoryStorageBackend.shared()) {
    this.backend = backend;
  }

  read(): string | null {
    return this.backend.read();
  }

  write(value: string): void {
    this.backend.write(this, value);
  }

  remove(): void {
    this.backend.erase(this);
  }

  observe(listener: StorageListener): () => void {
    return this.backend.connect(this, listener);
  }
}
