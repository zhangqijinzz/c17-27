import type { StoryDocument } from './story';
import { sanitizeStory } from './storyRules';

/**
 * 持久化信封：所有写入都带上单调递增的 revision。
 * 判断“哪边更新”以 revision 为准，而不是时间戳——
 * 同一次操作里同时改动多处内容，也只产生一个新版本。
 */
export const ENVELOPE_FORMAT = 'story-architect/envelope.v1';
export const TOMBSTONE_FORMAT = 'story-architect/tombstone.v1';

export interface StoryEnvelope {
  format: typeof ENVELOPE_FORMAT;
  revision: number;
  story: StoryDocument;
}

/** 项目被删除后留下墓碑，revision 继续递增，用于跨标签页收敛。 */
export interface StoryTombstone {
  format: typeof TOMBSTONE_FORMAT;
  revision: number;
  deletedAt: string;
}

export type PersistedRecord =
  | { kind: 'story'; revision: number; story: StoryDocument }
  | { kind: 'tombstone'; revision: number; deletedAt: string };

/** 'empty'：存储里没有项目；'invalid'：内容损坏，无法识别。 */
export type PersistedState = PersistedRecord | 'empty' | 'invalid';

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function parsePersisted(raw: string | null): PersistedState {
  if (raw === null) return 'empty';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'invalid';
  }
  if (!parsed || typeof parsed !== 'object') return 'invalid';
  const candidate = parsed as Record<string, unknown>;

  if (candidate.format === ENVELOPE_FORMAT) {
    if (!isRevision(candidate.revision)) return 'invalid';
    const story = sanitizeStory(candidate.story);
    if (!story) return 'invalid';
    return { kind: 'story', revision: candidate.revision, story: normalizeLoadedStory(story) };
  }

  if (candidate.format === TOMBSTONE_FORMAT) {
    if (!isRevision(candidate.revision) || typeof candidate.deletedAt !== 'string') return 'invalid';
    return { kind: 'tombstone', revision: candidate.revision, deletedAt: candidate.deletedAt };
  }

  // 兼容信封化之前直接存 StoryDocument 的旧数据，记为第 0 版。
  const legacy = sanitizeStory(parsed);
  if (legacy) return { kind: 'story', revision: 0, story: normalizeLoadedStory(legacy) };
  return 'invalid';
}

export function serializeEnvelope(revision: number, story: StoryDocument): string {
  const envelope: StoryEnvelope = { format: ENVELOPE_FORMAT, revision, story };
  return JSON.stringify(envelope);
}

export function serializeTombstone(revision: number, deletedAt: string): string {
  const tombstone: StoryTombstone = { format: TOMBSTONE_FORMAT, revision, deletedAt };
  return JSON.stringify(tombstone);
}

/** selectedSceneId 属于各标签页自己的视图状态，不参与持久化。 */
export function normalizeLoadedStory(story: StoryDocument): StoryDocument {
  if (story.selectedSceneId) return story;
  const firstScene = [...story.scenes].sort((a, b) => a.order - b.order)[0];
  return { ...story, selectedSceneId: firstScene?.id ?? '' };
}
