import type { StoryCharacter, StoryClue, StoryDocument, StoryScene } from './story';
import { sanitizeStory } from './storyRules';

/**
 * 多标签页协同的核心模型：
 * - revision 是文档「内容」的指纹，不是时间戳。同一次操作里多处内容一起变化，
 *   仍然只产生一个新修订；只改 updatedAt / selectedSceneId 不会产生新修订。
 * - envelope 把内容指纹和文档一起落盘，供保存时做乐观并发比对（CAS）。
 */

export const ENVELOPE_KIND = 'story-architect.envelope/v1';

export interface StoryEnvelope {
  kind: typeof ENVELOPE_KIND;
  revision: string;
  /** 本修订基于哪个修订提交（修订链，用于区分「续在我后面」与「覆盖了我」） */
  parentRevision: string | null;
  /** 由冲突解决动作写入：其它标签页收到后直接收敛，不再追问 */
  resolved?: boolean;
  document: StoryDocument;
}

export interface StoryPayload {
  revision: string;
  parentRevision: string | null;
  document: StoryDocument;
}

export type StoredStory =
  | { status: 'present'; revision: string; parentRevision: string | null; resolved: boolean; document: StoryDocument }
  | { status: 'missing' }
  | { status: 'corrupt' };

/**
 * 参与指纹计算的字段。updatedAt 只用于展示「哪边更新」，
 * selectedSceneId 是本地面板选中状态，二者都不构成内容修订。
 */
function canonicalCore(story: StoryDocument): string {
  // updatedAt 只用于展示「哪边更新」，selectedSceneId 是本地面板状态，都不参与修订指纹
  const { version, id, title, status, characters, scenes, clues } = story;
  return canonicalize({ version, id, title, status, characters, scenes, clues });
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** cyrb53 的 53 位安全整数实现，输出稳定的 16 进制内容指纹 */
function stableHash(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i += 1) {
    const char = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ char, 2654435761);
    h2 = Math.imul(h2 ^ char, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const safe = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return safe.toString(16).padStart(14, '0');
}

export function fingerprintStory(story: StoryDocument): string {
  return stableHash(canonicalCore(story));
}

export function createEnvelope(
  document: StoryDocument,
  parentRevision: string | null,
  resolved = false,
): StoryEnvelope {
  return { kind: ENVELOPE_KIND, revision: fingerprintStory(document), parentRevision, resolved, document };
}

/** 解析落盘内容：新信封、旧版裸文档（按指纹兼容）、空、损坏四种情况 */
export function readStoredStory(raw: string | null): StoredStory {
  if (raw === null) return { status: 'missing' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'corrupt' };
  }
  if (parsed !== null && typeof parsed === 'object') {
    const candidate = parsed as Partial<StoryEnvelope>;
    if (candidate.kind === ENVELOPE_KIND) {
      const document = sanitizeStory(candidate.document);
      if (document && typeof candidate.revision === 'string') {
        return {
          status: 'present',
          revision: candidate.revision,
          parentRevision: typeof candidate.parentRevision === 'string' ? candidate.parentRevision : null,
          resolved: candidate.resolved === true,
          document,
        };
      }
      return { status: 'corrupt' };
    }
  }
  const legacy = sanitizeStory(parsed);
  if (legacy) {
    return { status: 'present', revision: fingerprintStory(legacy), parentRevision: null, resolved: false, document: legacy };
  }
  return { status: 'corrupt' };
}

/* ----------------------- 内容差异（相对共同基线） ----------------------- */

export interface EntityUpdate {
  id: string;
  name: string;
  fields: string[];
}

export interface CollectionChange<T> {
  added: T[];
  removed: T[];
  updated: EntityUpdate[];
}

export interface StoryChangeSet {
  projectFields: string[];
  characters: CollectionChange<StoryCharacter>;
  scenes: CollectionChange<StoryScene>;
  clues: CollectionChange<StoryClue>;
}

const CHARACTER_FIELD_LABELS: Record<string, string> = {
  name: '姓名',
  role: '身份',
  color: '颜色',
};

const SCENE_FIELD_LABELS: Record<string, string> = {
  title: '标题',
  summary: '概述',
  conflict: '冲突',
  order: '顺序',
  characterIds: '出场人物',
  clueIds: '关联伏笔',
};

const CLUE_FIELD_LABELS: Record<string, string> = {
  title: '标题',
  setupSceneId: '埋下场景',
  payoffSceneId: '回收场景',
};

const SCENE_SET_FIELDS = ['characterIds', 'clueIds'];

function diffCollection<T extends { id: string }>(
  baseItems: T[],
  nextItems: T[],
  nameOf: (item: T) => string,
  labels: Record<string, string>,
  setFields: readonly string[] = [],
): CollectionChange<T> {
  const baseMap = new Map(baseItems.map((item) => [item.id, item]));
  const added = nextItems.filter((item) => !baseMap.has(item.id));
  const removed = baseItems.filter((item) => !nextItems.some((next) => next.id === item.id));
  const updated: EntityUpdate[] = [];
  for (const item of nextItems) {
    const before = baseMap.get(item.id);
    if (!before) continue;
    const changedFields = new Set<string>();
    const keys = new Set([...Object.keys(before), ...Object.keys(item)]);
    for (const key of keys) {
      if (key === 'id') continue;
      const beforeValue = (before as Record<string, unknown>)[key];
      const nextValue = (item as Record<string, unknown>)[key];
      const changed = setFields.includes(key)
        ? JSON.stringify([...(beforeValue as string[])].sort()) !== JSON.stringify([...(nextValue as string[])].sort())
        : JSON.stringify(beforeValue) !== JSON.stringify(nextValue);
      if (changed && labels[key]) changedFields.add(labels[key]);
    }
    if (changedFields.size > 0) {
      updated.push({ id: item.id, name: nameOf(item), fields: [...changedFields] });
    }
  }
  return { added, removed, updated };
}

export function diffStories(base: StoryDocument, next: StoryDocument): StoryChangeSet {
  const projectFields: string[] = [];
  if (base.title !== next.title) projectFields.push('项目标题');
  if (base.status !== next.status) projectFields.push('完成状态');
  return {
    projectFields,
    characters: diffCollection(base.characters, next.characters, (item) => item.name, CHARACTER_FIELD_LABELS),
    scenes: diffCollection(base.scenes, next.scenes, (item) => item.title, SCENE_FIELD_LABELS, SCENE_SET_FIELDS),
    clues: diffCollection(base.clues, next.clues, (item) => item.title, CLUE_FIELD_LABELS),
  };
}

/** 另一侧把项目整个删掉时，差异 = 基线里的全部内容都被移除 */
export function deletionChangeSet(base: StoryDocument): StoryChangeSet {
  return {
    projectFields: [],
    characters: { added: [], removed: base.characters, updated: [] },
    scenes: { added: [], removed: base.scenes, updated: [] },
    clues: { added: [], removed: base.clues, updated: [] },
  };
}

export function hasChanges(changes: StoryChangeSet): boolean {
  return (
    changes.projectFields.length > 0 ||
    changes.characters.added.length > 0 ||
    changes.characters.removed.length > 0 ||
    changes.characters.updated.length > 0 ||
    changes.scenes.added.length > 0 ||
    changes.scenes.removed.length > 0 ||
    changes.scenes.updated.length > 0 ||
    changes.clues.added.length > 0 ||
    changes.clues.removed.length > 0 ||
    changes.clues.updated.length > 0
  );
}

export type ChangeCategory = '项目' | '人物' | '场景' | '伏笔';

export interface ChangeLine {
  category: ChangeCategory;
  text: string;
}

function collectionLines<T>(
  category: ChangeCategory,
  label: string,
  changes: CollectionChange<T>,
  nameOf: (item: T) => string,
): ChangeLine[] {
  const lines: ChangeLine[] = [];
  changes.added.forEach((item) => lines.push({ category, text: `新增${label}「${nameOf(item)}」` }));
  changes.removed.forEach((item) => lines.push({ category, text: `删除${label}「${nameOf(item)}」` }));
  changes.updated.forEach((item) => lines.push({ category, text: `修改${label}「${item.name}」的${item.fields.join('、')}` }));
  return lines;
}

/** 把差异翻译成作者能直接读懂的条目 */
export function summarizeChanges(changes: StoryChangeSet): ChangeLine[] {
  const lines: ChangeLine[] = [];
  changes.projectFields.forEach((field) => lines.push({ category: '项目', text: `修改了${field}` }));
  lines.push(...collectionLines('人物', '人物', changes.characters, (item) => item.name));
  lines.push(...collectionLines('场景', '场景', changes.scenes, (item) => item.title));
  lines.push(...collectionLines('伏笔', '伏笔', changes.clues, (item) => item.title));
  return lines;
}

export function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}
