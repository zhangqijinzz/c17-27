import type { StoryDocument } from '../models/story';
import {
  createEnvelope,
  fingerprintStory,
  readStoredStory,
  type StoredStory,
  type StoryPayload,
} from '../models/storyRevision';
import type { StorageChangeEvent, StorageService } from '../services/storageService';

export interface CommitDiverged {
  kind: 'diverged';
  payload: StoryPayload;
  /** 提交前存储里的对面修订（用于立即给出冲突面板） */
  remote: StoredStory;
}

export type CommitResult = { kind: 'committed'; payload: StoryPayload } | CommitDiverged;

export interface StoryRepository {
  /** 读取当前存储；空存储返回 missing */
  readStored(): StoredStory;
  /**
   * 乐观并发提交：
   * - 存储修订与基准一致（或存储为空）：正常提交，信封记录 parent 链；
   * - 存储里已是对面的分叉修订：
   *   · 内容逐字一致 → 视为已收敛（committed，不重复写入）；
   *   · 内容不同 → 本页版本仍写入（localStorage 后写也会落盘），返回 diverged，
   *     让上层立即弹冲突，由作者选择收敛方向。
   */
  commit(story: StoryDocument, expectedRevision: string | null): CommitResult;
  /** 冲突解决后的收敛写入：无条件覆盖并打 resolved 标记，其它标签页看到后直接对齐 */
  replace(story: StoryDocument): StoryPayload;
  remove(): void;
  observeExternalChanges(listener: (event: StorageChangeEvent) => void): () => void;
}

export class LocalStoryRepository implements StoryRepository {
  constructor(private readonly storage: StorageService) {}

  readStored(): StoredStory {
    return readStoredStory(this.storage.read());
  }

  commit(story: StoryDocument, expectedRevision: string | null): CommitResult {
    const current = this.readStored();
    const contentRevision = fingerprintStory(story);
    if (current.status === 'present') {
      if (current.revision === contentRevision) {
        // 内容逐字一致：无需写入，直接视为已收敛
        return { kind: 'committed', payload: { revision: current.revision, parentRevision: current.parentRevision, document: current.document } };
      }
      if (current.revision !== expectedRevision) {
        const envelope = createEnvelope(story, current.revision);
        this.storage.write(JSON.stringify(envelope));
        return { kind: 'diverged', payload: this.toPayload(envelope), remote: current };
      }
    } else if (expectedRevision !== null) {
      // 我基于一个已存在的修订编辑，提交时项目已被另一标签页删除：
      // 写入本页版本（项目被恢复），但标记分叉，由作者确认是否接受「恢复」而不是静默覆盖删除
      const envelope = createEnvelope(story, expectedRevision);
      this.storage.write(JSON.stringify(envelope));
      return { kind: 'diverged', payload: this.toPayload(envelope), remote: { status: 'missing' } };
    }
    const envelope = createEnvelope(story, expectedRevision);
    this.storage.write(JSON.stringify(envelope));
    return { kind: 'committed', payload: this.toPayload(envelope) };
  }

  replace(story: StoryDocument): StoryPayload {
    const envelope = createEnvelope(story, null, true);
    this.storage.write(JSON.stringify(envelope));
    return this.toPayload(envelope);
  }

  remove(): void {
    this.storage.remove();
  }

  observeExternalChanges(listener: (event: StorageChangeEvent) => void): () => void {
    return this.storage.observe(listener);
  }

  private toPayload(envelope: ReturnType<typeof createEnvelope>): StoryPayload {
    return { revision: envelope.revision, parentRevision: envelope.parentRevision, document: envelope.document };
  }
}
