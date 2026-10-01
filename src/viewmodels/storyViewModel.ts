import {
  characterColors,
  createId,
  createStarterStory,
  type StoryCharacter,
  type StoryClue,
  type StoryDocument,
  type StoryScene,
} from '../models/story';
import { getStats, getTimelineWarning, orderedScenes, validateName } from '../models/storyRules';
import { parsePersisted, normalizeLoadedStory, type PersistedState } from '../models/storyEnvelope';
import {
  buildNames,
  diffStories,
  overlapKeys,
  type DiffNames,
  type EntityChange,
} from '../models/storyDiff';
import type { StorageChange } from '../services/storageService';
import type { StoryRepository } from '../repositories/storyRepository';

export type ViewModelStatus = 'loading' | 'ready' | 'editing' | 'error' | 'completed' | 'deleted';
export type SyncState = 'synced' | 'pending' | 'conflict' | 'deleted';

/** 冲突中“另一边”的固化快照；本标签页这一侧始终取最新在手内容。 */
export interface ConflictRemote {
  revision: number;
  story: StoryDocument | null;
  deletedAt: string | null;
}

export interface ConflictState {
  /** 两边共同的祖先版本内容；null 表示项目原本还不存在 */
  base: StoryDocument | null;
  localBaseRevision: number;
  remote: ConflictRemote;
}

export interface ConflictSideView {
  exists: boolean;
  revision: number | null;
  updatedAt: string | null;
  changes: EntityChange[];
  changeCount: number;
}

export interface ConflictView {
  conflict: ConflictState;
  local: ConflictSideView;
  remote: ConflictSideView;
  /** 两边都动过的实体 key（如 scene:xxx），用于醒目标出冲突焦点 */
  overlapKeys: Set<string>;
  localNames: DiffNames;
  remoteNames: DiffNames;
}

export interface StoryViewState {
  status: ViewModelStatus;
  story: StoryDocument | null;
  stats: ReturnType<typeof getStats>;
  notice: string;
  error: string;
  search: string;
  activeSection: 'overview' | 'characters' | 'clues';
  syncState: SyncState;
  conflict: ConflictState | null;
  knownRevision: number;
  remoteNotice: string;
}

type Listener = () => void;

const ABSENT_REVISION = -1;

export class StoryViewModel {
  private state: StoryViewState = {
    status: 'loading',
    story: null,
    stats: { characters: 0, scenes: 0, clues: 0, unresolvedClues: 0, completion: 0 },
    notice: '',
    error: '',
    search: '',
    activeSection: 'overview',
    syncState: 'synced',
    conflict: null,
    knownRevision: ABSENT_REVISION,
    remoteNotice: '',
  };
  private readonly listeners = new Set<Listener>();
  /** 本地工作副本分叉时所基于的已保存内容，冲突时作为三方对比的 base。 */
  private base: StoryDocument | null = null;
  private dirty = false;
  private initialized = false;

  constructor(private readonly repository: StoryRepository) {}

  get snapshot(): StoryViewState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.repository.subscribe((change) => this.handleExternalChange(change));
    try {
      this.adoptPersisted(this.repository.readState(), { initial: true });
    } catch {
      this.setState({ status: 'error', error: '故事读取失败，请重置为示例项目。' });
    }
  }

  setSearch(search: string): void {
    this.setState({ search });
  }

  setSection(activeSection: StoryViewState['activeSection']): void {
    this.setState({ activeSection });
  }

  dismissRemoteNotice(): void {
    if (this.state.remoteNotice) this.setState({ remoteNotice: '' });
  }

  /** 只是切换选中场景，属于本标签页的视图状态，不写存储、不制造版本。 */
  selectScene(sceneId: string): void {
    const story = this.requireStory();
    this.setState({ story: { ...story, selectedSceneId: sceneId } });
  }

  addCharacter(name: string, role: string): void {
    const cleanName = validateName(name);
    if (cleanName === '至少输入 2 个字') {
      this.setState({ notice: cleanName });
      return;
    }
    const story = this.requireStory();
    const character: StoryCharacter = {
      id: createId('character'),
      name: cleanName,
      role: role.trim() || '待定义角色',
      color: characterColors[story.characters.length % characterColors.length],
    };
    this.mutate((current) => ({ ...current, characters: [...current.characters, character] }));
    this.setState({ notice: `已加入人物「${character.name}」` });
  }

  addScene(title: string, summary: string): void {
    const cleanTitle = validateName(title);
    if (cleanTitle === '至少输入 2 个字') {
      this.setState({ notice: cleanTitle });
      return;
    }
    const story = this.requireStory();
    const scene: StoryScene = {
      id: createId('scene'),
      title: cleanTitle,
      order: story.scenes.length + 1,
      summary: summary.trim() || '还没有写下这一幕发生了什么。',
      conflict: '',
      characterIds: [],
      clueIds: [],
    };
    this.mutate((current) => ({ ...current, scenes: [...current.scenes, scene], selectedSceneId: scene.id }));
    this.setState({ notice: `已创建场景「${scene.title}」` });
  }

  updateScene(sceneId: string, patch: Partial<Pick<StoryScene, 'title' | 'summary' | 'conflict'>>): void {
    this.mutate((story) => ({
      ...story,
      scenes: story.scenes.map((scene) => (scene.id === sceneId ? { ...scene, ...patch } : scene)),
    }), false);
  }

  toggleCharacter(sceneId: string, characterId: string): void {
    this.mutate((story) => ({
      ...story,
      scenes: story.scenes.map((scene) => {
        if (scene.id !== sceneId) return scene;
        const hasCharacter = scene.characterIds.includes(characterId);
        return { ...scene, characterIds: hasCharacter ? scene.characterIds.filter((id) => id !== characterId) : [...scene.characterIds, characterId] };
      }),
    }));
  }

  moveScene(sceneId: string, direction: 'up' | 'down'): void {
    const scenes = orderedScenes(this.requireStory());
    const index = scenes.findIndex((scene) => scene.id === sceneId);
    const nextIndex = direction === 'up' ? index - 1 : index + 1;
    if (index < 0 || nextIndex < 0 || nextIndex >= scenes.length) return;
    [scenes[index], scenes[nextIndex]] = [scenes[nextIndex], scenes[index]];
    this.mutate((story) => ({ ...story, scenes: scenes.map((scene, sceneIndex) => ({ ...scene, order: sceneIndex + 1 })) }));
    this.setState({ notice: '时间线顺序已更新' });
  }

  addClue(title: string, setupSceneId: string, payoffSceneId: string): void {
    const cleanTitle = validateName(title);
    if (cleanTitle === '至少输入 2 个字') {
      this.setState({ notice: cleanTitle });
      return;
    }
    if (!setupSceneId) {
      this.setState({ notice: '请先选择伏笔埋下的场景' });
      return;
    }
    const clue: StoryClue = { id: createId('clue'), title: cleanTitle, setupSceneId, payoffSceneId };
    this.mutate((story) => ({
      ...story,
      clues: [...story.clues, clue],
      scenes: story.scenes.map((scene) => scene.id === setupSceneId ? { ...scene, clueIds: [...scene.clueIds, clue.id] } : scene),
    }));
    this.setState({ notice: payoffSceneId ? '伏笔关系已建立' : '伏笔已记录，等待回收' });
  }

  completeProject(): void {
    this.mutate((story) => ({ ...story, status: 'complete' }));
    this.setState({ status: 'completed', notice: '项目已标记为完成，仍可继续编辑' });
  }

  resetProject(): void {
    // 恢复示例属于显式裁决：不受版本约束，强制落到一个新版本，
    // 其它标签页随后通过存储事件收敛到同一份。
    const story = createStarterStory();
    const nextRevision = Math.max(this.state.knownRevision, this.readCurrentRevision()) + 1;
    this.repository.forceCommit({ ...story, updatedAt: new Date().toISOString() }, nextRevision);
    this.base = { ...story };
    this.dirty = false;
    this.setState({
      status: 'ready',
      story: { ...story },
      stats: getStats(story),
      notice: '已恢复示例项目',
      error: '',
      conflict: null,
      syncState: 'synced',
      knownRevision: nextRevision,
      remoteNotice: '',
    });
  }

  /** 删除项目走 CAS：若别处已经先改过，不会静默删掉新版本，而是进入冲突流程。 */
  deleteProject(): void {
    if (this.state.conflict) {
      this.setState({ notice: '请先在冲突提示里选择保留哪一份，再删除项目。' });
      return;
    }
    const currentRevision = this.readCurrentRevision();
    if (currentRevision !== this.state.knownRevision) {
      this.openConflict(this.repository.readState());
      return;
    }
    try {
      if (!this.repository.delete(this.state.knownRevision)) {
        this.openConflict(this.repository.readState());
        return;
      }
    } catch {
      this.setState({ status: 'error', error: '删除失败，当前内容仍保留在页面中。' });
      return;
    }
    this.base = null;
    this.dirty = false;
    this.setState({
      status: 'deleted',
      story: null,
      stats: { characters: 0, scenes: 0, clues: 0, unresolvedClues: 0, completion: 0 },
      syncState: 'deleted',
      knownRevision: this.state.knownRevision + 1,
      notice: '',
      conflict: null,
    });
  }

  /** 冲突弹窗用：两边各自相对共同基线动了什么，本地侧实时计算，包含尚未落盘的输入。 */
  get conflictView(): ConflictView | null {
    const conflict = this.state.conflict;
    if (!conflict) return null;
    const localStory = this.state.story;
    const localChanges = diffStories(conflict.base, localStory).changes;
    const remoteChanges = diffStories(conflict.base, conflict.remote.story).changes;
    return {
      conflict,
      local: {
        exists: localStory !== null,
        revision: this.state.knownRevision === ABSENT_REVISION ? null : this.state.knownRevision,
        updatedAt: localStory?.updatedAt ?? null,
        changes: localChanges,
        changeCount: localChanges.length,
      },
      remote: {
        exists: conflict.remote.story !== null,
        revision: conflict.remote.revision === ABSENT_REVISION ? null : conflict.remote.revision,
        updatedAt: conflict.remote.story?.updatedAt ?? conflict.remote.deletedAt ?? null,
        changes: remoteChanges,
        changeCount: remoteChanges.length,
      },
      overlapKeys: overlapKeys({ changes: localChanges }, { changes: remoteChanges }),
      localNames: buildNames(localStory),
      remoteNames: buildNames(conflict.remote.story),
    };
  }

  /** 裁决：继续用本标签页这一份，强制写成新版本，两边随后收敛。 */
  resolveKeepLocal(): void {
    const conflict = this.state.conflict;
    const story = this.state.story;
    if (!conflict || !story) return;
    const nextRevision = Math.max(conflict.remote.revision, this.state.knownRevision) + 1;
    this.repository.forceCommit({ ...story, updatedAt: new Date().toISOString() }, nextRevision);
    this.base = { ...story };
    this.dirty = false;
    this.setState({
      conflict: null,
      syncState: 'synced',
      knownRevision: nextRevision,
      status: story.status === 'complete' ? 'completed' : this.state.status === 'deleted' ? 'ready' : this.state.status,
      notice: '已采用本标签页的内容，其它标签页将自动同步。',
      error: '',
    });
  }

  /** 裁决：放弃本地未保存的改动，采用存储里那一份（可能是“已删除”）。 */
  resolveUseRemote(): void {
    const conflict = this.state.conflict;
    if (!conflict) return;
    this.adoptPersisted(
      conflict.remote.story
        ? { kind: 'story', revision: conflict.remote.revision, story: conflict.remote.story }
        : { kind: 'tombstone', revision: conflict.remote.revision, deletedAt: conflict.remote.deletedAt ?? new Date().toISOString() },
      { notice: '已采用其它标签页的最新内容。' },
    );
    this.setState({ conflict: null });
  }

  get visibleCharacters(): StoryCharacter[] {
    const story = this.requireStory();
    const keyword = this.state.search.trim().toLowerCase();
    return story.characters.filter((character) => `${character.name}${character.role}`.toLowerCase().includes(keyword));
  }

  get visibleScenes(): StoryScene[] {
    const story = this.requireStory();
    const keyword = this.state.search.trim().toLowerCase();
    return orderedScenes(story).filter((scene) => `${scene.title}${scene.summary}${scene.conflict}`.toLowerCase().includes(keyword));
  }

  get selectedScene(): StoryScene | null {
    const story = this.state.story;
    return story?.scenes.find((scene) => scene.id === story.selectedSceneId) ?? null;
  }

  get timelineWarning(): string | null {
    const story = this.state.story;
    return story ? getTimelineWarning(story) : null;
  }

  private requireStory(): StoryDocument {
    if (!this.state.story) throw new Error('故事尚未初始化');
    return this.state.story;
  }

  /** 所有编辑操作的唯一入口：更新在手内容，并尝试带版本号保存。 */
  private mutate(updater: (story: StoryDocument) => StoryDocument, showEditing = true): void {
    const story = { ...updater(this.requireStory()), updatedAt: new Date().toISOString() };
    this.dirty = true;
    const expectedRevision = this.state.knownRevision;
    let casSuccess = false;
    try {
      casSuccess = this.repository.commit(story, expectedRevision);
    } catch {
      // 存储异常（如空间不足）：内容保留在页面中，但不碰存储里的新版本。
      this.setState({ story, stats: getStats(story), status: showEditing ? 'editing' : this.state.status, syncState: 'pending', error: '保存失败，但当前编辑仍保留在页面中。' });
      return;
    }
    if (casSuccess) {
      this.base = { ...story };
      this.dirty = false;
      this.setState({
        story,
        stats: getStats(story),
        status: showEditing ? 'editing' : this.state.status,
        syncState: 'synced',
        knownRevision: expectedRevision + 1,
        error: '',
      });
      return;
    }
    // CAS 失败：存储已被别处改动。本地内容原样保留，进入冲突流程，绝不覆盖。
    const remote = this.repository.readState();
    this.setState({ story, stats: getStats(story), status: showEditing ? 'editing' : this.state.status });
    this.openConflict(remote);
  }

  private handleExternalChange(change: StorageChange): void {
    const remote = parsePersisted(change.value);
    if (remote === 'invalid') return;
    const remoteRevision = remote === 'empty' ? this.state.knownRevision : remote.revision;
    if (remoteRevision <= this.state.knownRevision && !this.state.conflict) return;

    if (this.state.conflict) {
      // 冲突未裁决期间另一边又写了：刷新弹窗中的“另一边”，本地内容不动。
      if (remoteRevision <= this.state.conflict.remote.revision) return;
      this.setState({
        conflict: {
          ...this.state.conflict,
          remote: {
            revision: remoteRevision,
            story: remote !== 'empty' && remote.kind === 'story' ? remote.story : null,
            deletedAt: remote !== 'empty' && remote.kind === 'tombstone' ? remote.deletedAt : new Date().toISOString(),
          },
        },
      });
      return;
    }

    if (this.dirty) {
      // 自己手里有还没和存储对齐的改动：不能静默覆盖，交给作者裁决。
      this.openConflict(remote);
      return;
    }

    // 本标签页是干净的：直接收敛到存储里的最新状态。
    if (remote === 'empty') {
      this.markDeleted(this.state.knownRevision);
      return;
    }
    const previousStory = this.state.story;
    const notice = previousStory ? '其它标签页改动了项目，已为你同步到最新。' : '';
    this.adoptPersisted(remote, { notice, preserveSelectionFrom: previousStory });
  }

  private openConflict(remote: PersistedState): void {
    if (remote === 'invalid') {
      this.setState({ status: 'error', error: '存储内容异常，无法与别处的改动合并，请先恢复示例项目。' });
      return;
    }
    const normalized: ConflictRemote = remote === 'empty'
      ? { revision: Math.max(this.state.knownRevision, 0), story: null, deletedAt: new Date().toISOString() }
      : remote.kind === 'story'
        ? { revision: remote.revision, story: remote.story, deletedAt: null }
        : { revision: remote.revision, story: null, deletedAt: remote.deletedAt };
    const conflict: ConflictState = {
      base: this.base,
      localBaseRevision: this.state.knownRevision,
      remote: normalized,
    };
    const remoteDeleted = normalized.story === null;
    this.setState({
      conflict,
      syncState: 'conflict',
      status: this.state.status === 'deleted' ? 'editing' : this.state.status,
      notice: remoteDeleted ? '项目已在其它标签页被删除。' : '项目已在其它标签页被修改。',
    });
  }

  private adoptPersisted(
    state: PersistedState,
    options: { initial?: boolean; notice?: string; preserveSelectionFrom?: StoryDocument | null },
  ): void {
    if (state === 'invalid') {
      this.setState({ status: 'error', error: '本地存储的内容已损坏，请恢复为示例项目。' });
      return;
    }
    if (state === 'empty') {
      if (options.initial) {
        // 首次打开：把示例项目落成第 0 版，让所有标签页拥有真实的共同基线，
        // 之后的每次分叉才能逐实体对比。
        const story = createStarterStory();
        this.repository.forceCommit(story, 0);
        this.base = { ...story };
        this.dirty = false;
        this.setState({
          status: 'ready',
          story,
          stats: getStats(story),
          syncState: 'synced',
          knownRevision: 0,
          error: '',
        });
        return;
      }
      // 运行期存储被清空：按“已删除”对待，不覆盖任何东西。
      this.markDeleted(this.state.knownRevision);
      return;
    }
    if (state.kind === 'tombstone') {
      this.markDeleted(state.revision);
      return;
    }
    let story = normalizeLoadedStory(state.story);
    if (options.preserveSelectionFrom) {
      const stillExists = story.scenes.some((scene) => scene.id === options.preserveSelectionFrom?.selectedSceneId);
      story = stillExists ? { ...story, selectedSceneId: options.preserveSelectionFrom.selectedSceneId } : story;
    }
    this.base = { ...story };
    this.dirty = false;
    this.setState({
      status: story.status === 'complete' ? 'completed' : 'ready',
      story,
      stats: getStats(story),
      syncState: 'synced',
      knownRevision: state.revision,
      error: '',
      conflict: null,
      remoteNotice: options.initial ? '' : options.notice ?? this.state.remoteNotice,
    });
  }

  private markDeleted(revision: number): void {
    this.base = null;
    this.dirty = false;
    this.setState({
      status: 'deleted',
      story: null,
      stats: { characters: 0, scenes: 0, clues: 0, unresolvedClues: 0, completion: 0 },
      syncState: 'deleted',
      knownRevision: revision,
      conflict: null,
      notice: '',
    });
  }

  private readCurrentRevision(): number {
    const current = this.repository.readState();
    return current === 'empty' || current === 'invalid' ? ABSENT_REVISION : current.revision;
  }

  private setState(patch: Partial<StoryViewState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}
