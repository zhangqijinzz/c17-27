const STORAGE_KEY = 'story-architect.document.v1';

/**
 * 存储服务。subscribe 投递“共享存储发生变化”的通知：
 * 浏览器原生 storage 事件只在其它标签页触发；内存实现模拟多标签页时，
 * 写入方会收到一次与自己已保存内容一致的回声，由上层按版本号自行忽略。
 */
export interface StorageService {
  read(): string | null;
  write(value: string): void;
  remove(): void;
  subscribe(listener: StorageChangeListener): () => void;
}

export interface StorageChange {
  /** 变更后的值；null 表示该键已被删除 */
  value: string | null;
}

export type StorageChangeListener = (change: StorageChange) => void;

export class BrowserStorageService implements StorageService {
  private readonly listeners = new Set<StorageChangeListener>();
  private readonly windowHandler = (event: StorageEvent): void => {
    if (event.storageArea !== window.localStorage || event.key !== STORAGE_KEY) return;
    this.listeners.forEach((listener) => listener({ value: event.newValue }));
  };

  constructor() {
    window.addEventListener('storage', this.windowHandler);
  }

  read(): string | null {
    return window.localStorage.getItem(STORAGE_KEY);
  }

  write(value: string): void {
    window.localStorage.setItem(STORAGE_KEY, value);
    // storage 事件不会在写入方标签页触发，无需通知本页订阅者。
  }

  remove(): void {
    window.localStorage.removeItem(STORAGE_KEY);
  }

  subscribe(listener: StorageChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * 内存存储，测试用。多个 service 挂到同一个 bus 上，
 * 即代表多个标签页共享同一块本地存储。
 */
export class MemoryStorageService implements StorageService {
  constructor(private readonly bus: MemoryStorageBus = new MemoryStorageBus()) {}

  read(): string | null {
    return this.bus.value;
  }

  write(value: string): void {
    this.bus.commit(value);
  }

  remove(): void {
    this.bus.commit(null);
  }

  subscribe(listener: StorageChangeListener): () => void {
    return this.bus.subscribe(listener);
  }
}

export class MemoryStorageBus {
  private internalValue: string | null = null;
  private readonly listeners = new Set<StorageChangeListener>();
  private pending: string | null = null;
  private flushScheduled = false;

  get value(): string | null {
    return this.internalValue;
  }

  subscribe(listener: StorageChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  commit(value: string | null): void {
    if (this.internalValue === value) return;
    this.internalValue = value;
    // 异步派发并在同一轮内合并：与浏览器 storage 事件的跨标签页时序一致，
    // 一次操作中的多处连续写入只投递最终态。
    this.pending = value;
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      const finalValue = this.pending;
      this.pending = null;
      this.listeners.forEach((listener) => listener({ value: finalValue }));
    });
  }
}
