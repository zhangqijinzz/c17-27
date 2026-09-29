const STORAGE_KEY = 'story-architect.document.v1';

export interface StorageService {
  read(): string | null;
  write(value: string): void;
}

export class BrowserStorageService implements StorageService {
  read(): string | null {
    return window.localStorage.getItem(STORAGE_KEY);
  }

  write(value: string): void {
    window.localStorage.setItem(STORAGE_KEY, value);
  }
}

export class MemoryStorageService implements StorageService {
  private value: string | null = null;

  read(): string | null {
    return this.value;
  }

  write(value: string): void {
    this.value = value;
  }
}
