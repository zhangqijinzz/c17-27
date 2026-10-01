import type { StoryCharacter, StoryClue, StoryDocument, StoryScene } from './story';
import { orderedScenes } from './storyRules';

/**
 * 三方对比：以共同基线 base 为参照，
 * 分别算出“本标签页这一份”和“存储里那一份”相对基线动了什么。
 * 判断依据是实体内容，而不是时间戳——一次操作里多处字段同时变化，
 * 每一处都会被独立识别出来，不会被当成一次盲覆盖。
 */

export type ChangeKind = 'added' | 'removed' | 'changed';
export type EntityKind = 'project' | 'character' | 'scene' | 'clue';

export interface FieldChange {
  field: string;
  label: string;
  baseValue: string;
  nextValue: string;
}

export interface EntityChange {
  kind: ChangeKind;
  entity: EntityKind;
  /** 项目固定为其 id；人物/场景/伏笔为各自实体 id */
  id: string;
  name: string;
  fields: FieldChange[];
}

export interface StoryDiff {
  changes: EntityChange[];
}

export interface DiffNames {
  characters: Map<string, string>;
  scenes: Map<string, string>;
  clues: Map<string, string>;
}

export const projectEntityId = '__project__';

interface EntityView {
  id: string;
  name: string;
  fields: Record<string, unknown>;
}

const fieldLabels: Record<EntityKind, Record<string, string>> = {
  project: {
    title: '项目标题',
    status: '完成状态',
  },
  character: {
    name: '姓名',
    role: '身份 / 角色弧',
    color: '标识色',
  },
  scene: {
    title: '场景标题',
    order: '时间顺序',
    summary: '场景摘要',
    conflict: '核心冲突',
    characterIds: '出场人物',
    clueIds: '关联伏笔',
  },
  clue: {
    title: '伏笔名称',
    setupSceneId: '埋下场景',
    payoffSceneId: '回收场景',
  },
};

/** 项目级视图状态与元数据不参与差异比较。 */
const ignoredProjectFields = new Set(['version', 'id', 'selectedSceneId', 'updatedAt']);
const ignoredEntityFields: Record<EntityKind, Set<string>> = {
  project: ignoredProjectFields,
  character: new Set(['id']),
  scene: new Set(['id']),
  clue: new Set(['id']),
};

export function buildNames(story: StoryDocument | null): DiffNames {
  return {
    characters: new Map(story?.characters.map((item) => [item.id, item.name]) ?? []),
    scenes: new Map(story?.scenes.map((item) => [item.id, item.title]) ?? []),
    clues: new Map(story?.clues.map((item) => [item.id, item.title]) ?? []),
  };
}

export function diffStories(base: StoryDocument | null, next: StoryDocument | null): StoryDiff {
  if (base === null && next === null) return { changes: [] };
  if (base === null && next !== null) return { changes: [wholeProjectChange('added', next)] };
  if (base !== null && next === null) return { changes: [wholeProjectChange('removed', base)] };
  return {
    changes: [
      ...diffProject(base as StoryDocument, next as StoryDocument),
      ...diffCollections('character', (base as StoryDocument).characters, (next as StoryDocument).characters),
      ...diffCollections('scene', orderedScenes(base as StoryDocument), orderedScenes(next as StoryDocument)),
      ...diffCollections('clue', (base as StoryDocument).clues, (next as StoryDocument).clues),
    ],
  };
}

/** 两边是否改动了同一个实体（用于判定冲突焦点）。 */
export function overlapKeys(local: StoryDiff, remote: StoryDiff): Set<string> {
  const remoteKeys = new Set(remote.changes.map((change) => keyOf(change)));
  return new Set(local.changes.map((change) => keyOf(change)).filter((key) => remoteKeys.has(key)));
}

export function keyOf(change: EntityChange): string {
  return `${change.entity}:${change.id}`;
}

export function describeChange(change: EntityChange): string {
  const target = change.entity === 'project' ? '项目' : change.name;
  const kindLabel = change.kind === 'added' ? '新增' : change.kind === 'removed' ? '删除' : '修改';
  if (change.kind !== 'changed' || change.fields.length === 0) {
    return `${kindLabel}${entityLabel(change.entity)}「${target}」`;
  }
  const fieldText = change.fields.map((field) => field.label).join('、');
  return `${kindLabel}${entityLabel(change.entity)}「${target}」的 ${fieldText}`;
}

/** 把字段里的外键 id 解析成可读名称。 */
export function resolveFieldValue(field: string, rawValue: string, names: DiffNames): string {
  if (field === 'status') return rawValue === 'complete' ? '已完成' : '草稿';
  if (field === 'color') return rawValue || '（默认）';
  if (field === 'characterIds') return resolveIdList(rawValue, names.characters);
  if (field === 'clueIds') return resolveIdList(rawValue, names.clues);
  if (field === 'setupSceneId' || field === 'payoffSceneId') {
    return rawValue ? names.scenes.get(rawValue) ?? '未知场景' : '待回收';
  }
  return rawValue;
}

function entityLabel(entity: EntityKind): string {
  return entity === 'project' ? '' : entity === 'character' ? '人物' : entity === 'scene' ? '场景' : '伏笔';
}

function resolveIdList(rawValue: string, names: Map<string, string>): string {
  if (!rawValue) return '（无）';
  const ids = rawValue.split(',').filter(Boolean);
  return ids.map((id) => names.get(id) ?? `已删除项 ${id.slice(-4)}`).join('、');
}

function wholeProjectChange(kind: ChangeKind, story: StoryDocument): EntityChange {
  return { kind, entity: 'project', id: projectEntityId, name: story.title, fields: [] };
}

function diffProject(base: StoryDocument, next: StoryDocument): EntityChange[] {
  const changed = diffFields('project', projectView(base).fields, projectView(next).fields);
  return changed.length === 0
    ? []
    : [{ kind: 'changed', entity: 'project', id: projectEntityId, name: next.title, fields: changed }];
}

function diffCollections<T extends StoryCharacter | StoryScene | StoryClue>(
  entity: EntityKind,
  baseItems: T[],
  nextItems: T[],
): EntityChange[] {
  const baseMap = new Map(baseItems.map((item) => [item.id, item]));
  const nextMap = new Map(nextItems.map((item) => [item.id, item]));
  const changes: EntityChange[] = [];

  for (const [id, nextItem] of nextMap) {
    const baseItem = baseMap.get(id);
    if (!baseItem) {
      changes.push({ kind: 'added', entity, id, name: displayName(nextItem), fields: [] });
      continue;
    }
    const fields = diffFields(entity, toView(baseItem).fields, toView(nextItem).fields);
    if (fields.length > 0) {
      changes.push({ kind: 'changed', entity, id, name: displayName(nextItem), fields });
    }
  }
  for (const [id, baseItem] of baseMap) {
    if (!nextMap.has(id)) changes.push({ kind: 'removed', entity, id, name: displayName(baseItem), fields: [] });
  }
  return changes;
}

function diffFields(entity: EntityKind, baseFields: Record<string, unknown>, nextFields: Record<string, unknown>): FieldChange[] {
  const ignored = ignoredEntityFields[entity];
  const labels = fieldLabels[entity];
  const result: FieldChange[] = [];
  for (const [field, nextValue] of Object.entries(nextFields)) {
    if (ignored.has(field) || !(field in labels)) continue;
    const baseValue = baseFields[field];
    if (formatRaw(baseValue) !== formatRaw(nextValue)) {
      result.push({
        field,
        label: labels[field] ?? field,
        baseValue: formatRaw(baseValue),
        nextValue: formatRaw(nextValue),
      });
    }
  }
  return result;
}

function projectView(story: StoryDocument): EntityView {
  return { id: projectEntityId, name: story.title, fields: { ...story } };
}

function toView(item: StoryCharacter | StoryScene | StoryClue): EntityView {
  return { id: item.id, name: displayName(item), fields: { ...item } };
}

function displayName(item: StoryCharacter | StoryScene | StoryClue): string {
  return 'name' in item ? item.name : item.title;
}

function formatRaw(value: unknown): string {
  if (Array.isArray(value)) return value.join(',');
  if (value === undefined || value === null) return '';
  return String(value);
}
