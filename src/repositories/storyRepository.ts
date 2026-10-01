import { createStarterStory, type StoryDocument } from '../models/story';
import {
  parsePersisted,
  serializeEnvelope,
  serializeTombstone,
  type PersistedState,
} from '../models/storyEnvelope';
import type { StorageChange, StorageService } from '../services/storageService';

export interface StoryRepository {
  /** 读取存储当前状态（不存在 / 损坏 / 墓碑 / 文档）。 */
  readState(): PersistedState;
  /**
   * CAS 保存：只有当存储里的 revision 仍等于 expectedRevision 时才写入。
   * 返回 true 表示写入成功；false 表示别处已经先改过，调用方必须走冲突流程，
   * 绝不能直接覆盖。
   */
  commit(story: StoryDocument, expectedRevision: number): boolean;
  /** CAS 删除：同样带期望值，写入墓碑而非清空存储。 */
  delete(expectedRevision: number): boolean;
  /** 不受版本约束的强制写入（恢复示例项目 / 冲突裁决落地时使用）。 */
  forceCommit(story: StoryDocument, revision: number): void;
  subscribe(listener: (change: StorageChange) => void): () => void;
}

export class LocalStoryRepository implements StoryRepository {
  constructor(private readonly storage: StorageService) {}

  readState(): PersistedState {
    return parsePersisted(this.storage.read());
  }

  commit(story: StoryDocument, expectedRevision: number): boolean {
    const current = parsePersisted(this.storage.read());
    const currentRevision = current === 'empty' ? -1 : current === 'invalid' ? -1 : current.revision;
    if (currentRevision !== expectedRevision) return false;
    this.storage.write(serializeEnvelope(expectedRevision + 1, forStorage(story)));
    return true;
  }

  delete(expectedRevision: number): boolean {
    const current = parsePersisted(this.storage.read());
    if (current === 'invalid' || current === 'empty' || current.revision !== expectedRevision) return false;
    this.storage.write(serializeTombstone(expectedRevision + 1, new Date().toISOString()));
    return true;
  }

  forceCommit(story: StoryDocument, revision: number): void {
    this.storage.write(serializeEnvelope(revision, forStorage(story)));
  }

  subscribe(listener: (change: StorageChange) => void): () => void {
    return this.storage.subscribe(listener);
  }
}

export function loadStoryOrStarter(state: PersistedState): StoryDocument {
  if (state !== 'invalid' && state !== 'empty' && state.kind === 'story') return state.story;
  return createStarterStory();
}

/** selectedSceneId 是各标签页自己的视图状态，不进存储，避免制造假冲突。 */
function forStorage(story: StoryDocument): StoryDocument {
  if (!story.selectedSceneId) return story;
  return {
    version: story.version,
    id: story.id,
    title: story.title,
    status: story.status,
    characters: story.characters,
    scenes: story.scenes,
    clues: story.clues,
    updatedAt: story.updatedAt,
  };
}
