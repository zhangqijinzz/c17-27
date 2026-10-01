import {
  characterColors,
  createId,
  createStarterStory,
  type StoryCharacter,
  type StoryClue,
  type StoryDocument,
  type StoryScene,
  type StoryStats,
} from '../models/story';
import {
  deletionChangeSet,
  diffStories,
  fingerprintStory,
  formatTimestamp,
  readStoredStory,
  summarizeChanges,
  type ChangeLine,
  type StoredStory,
} from '../models/storyRevision';
import { getStats, getTimelineWarning, orderedScenes, validateName } from '../models/storyRules';
import type { StoryRepository } from '../repositories/storyRepository';

export type ViewModelStatus = 'loading' | 'ready' | 'error' | 'completed' | 'conflict' | 'missing';

export interface ConflictState {
  remoteKind: 'present' | 'missing' | 'corrupt';
  remoteRevision: string | null;
  /** 对面文档快照：决策期间存储可能再变，仍以快照为准 */
  remoteDocument: StoryDocument | null;
  localTimestamp: string;
  remoteTimestamp: string | null;
  remoteNewer: boolean;
  localChanges: ChangeLine[];
  remoteChanges: ChangeLine[];
  localChanged: boolean;
  /** 冲突是否由本页提交时直接发现（此时存储里是本页版本，选「采用对面」需要写回） */
  remoteNeedsWriteBack: boolean;
}

export interface StoryViewState {
  status: ViewModelStatus;
  story: StoryDocument | null;
  stats: StoryStats;
  notice: string;
  error: string;
  search: string;
  activeSection: 'overview' | 'characters' | 'clues';
  conflict: ConflictState | null;
}

type Listener = () => void;

const ZERO_STATS: StoryStats = { characters: 0, scenes: 0, clues: 0, unresolvedClues: 0, completion: 0 };

export class StoryViewModel {
  private state: StoryViewState = {
    status: 'loading',
    story: null,
    stats: ZERO_STATS,
    notice: '',
    error: '',
    search: '',
    activeSection: 'overview',
    conflict: null,
  };
  private readonly listeners = new Set<Listener>();

  /** 我最后一次与存储对齐时的修订；null 表示存储里当时没有项目 */
  private baseRevision: string | null = null;
  /** 共同基线文档（baseRevision 对应的内容），作为差异对比的祖先 */
  private baseStory: StoryDocument | null = null;
  /** 本页最后一次写入/删除产生的回声，事件到达时据此识别并消费 */
  private pendingEcho: { kind: 'present'; revision: string } | { kind: 'missing' } | null = null;
  /** 当前冲突面板使用的共同祖先文档（分叉提交时保存被覆盖前的参考点） */
  private conflictAncestor: StoryDocument | null = null;
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
    this.repository.observeExternalChanges((event) => {
      this.handleExternalChange(event.kind === 'missing' ? null : event.value);
    });
    const stored = this.repository.readStored();
    if (stored.status === 'present') {
      this.adopt(stored.revision, stored.document, this.statusForDocument(stored.document));
    } else if (stored.status === 'missing') {
      // 全新环境：放入示例项目但不立即落盘，等作者真正动手
      const starter = createStarterStory();
      this.baseRevision = null;
      this.baseStory = starter;
      this.setState({ status: 'ready', story: starter, stats: getStats(starter), error: '', conflict: null });
    } else {
      this.setState({ status: 'error', error: '存储中的项目无法读取，可恢复为示例项目，本页不会覆盖损坏内容。' });
    }
  }

  setSearch(search: string): void {
    this.setState({ search });
  }

  setSection(activeSection: StoryViewState['activeSection']): void {
    this.setState({ activeSection });
  }

  selectScene(sceneId: string): void {
    this.updateStory((story) => ({ ...story, selectedSceneId: sceneId }));
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
    this.updateStory((current) => ({ ...current, characters: [...current.characters, character] }));
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
    this.updateStory((current) => ({ ...current, scenes: [...current.scenes, scene], selectedSceneId: scene.id }));
    this.setState({ notice: `已创建场景「${scene.title}」` });
  }

  updateScene(sceneId: string, patch: Partial<Pick<StoryScene, 'title' | 'summary' | 'conflict'>>): void {
    this.updateStory((story) => ({
      ...story,
      scenes: story.scenes.map((scene) => (scene.id === sceneId ? { ...scene, ...patch } : scene)),
    }));
  }

  toggleCharacter(sceneId: string, characterId: string): void {
    this.updateStory((story) => ({
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
    this.updateStory((story) => ({ ...story, scenes: scenes.map((scene, sceneIndex) => ({ ...scene, order: sceneIndex + 1 })) }));
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
    // 一次操作同时改动伏笔列表和场景的关联，只提交为同一个修订
    this.updateStory((story) => ({
      ...story,
      clues: [...story.clues, clue],
      scenes: story.scenes.map((scene) => scene.id === setupSceneId ? { ...scene, clueIds: [...scene.clueIds, clue.id] } : scene),
    }));
    this.setState({ notice: payoffSceneId ? '伏笔关系已建立' : '伏笔已记录，等待回收' });
  }

  completeProject(): void {
    if (!this.canEdit) return;
    this.updateStory((story) => ({ ...story, status: 'complete' }));
    this.setState({ status: 'completed', notice: '项目已标记为完成，仍可继续编辑' });
  }

  resetProject(): void {
    const starter = createStarterStory();
    try {
      const payload = this.repository.replace(starter);
      this.pendingEcho = { kind: 'present', revision: payload.revision };
      this.adopt(payload.revision, payload.document, 'ready');
      this.setState({ notice: '已恢复示例项目', error: '' });
    } catch {
      this.setState({ status: 'error', error: '保存失败，但当前编辑仍保留在页面中。' });
    }
  }

  deleteProject(): void {
    const current = this.state.story ?? this.baseStory;
    this.repository.remove();
    this.pendingEcho = { kind: 'missing' };
    this.baseRevision = null;
    this.baseStory = current;
    this.setState({ status: 'missing', story: null, stats: ZERO_STATS, conflict: null, notice: '', error: '' });
  }

  /** 冲突解决：采用另一标签页的版本 */
  resolveUseRemote(): void {
    const conflict = this.state.conflict;
    if (!conflict) return;
    if (conflict.remoteKind !== 'present' || !conflict.remoteDocument) {
      if (conflict.remoteKind === 'missing') {
        // 接受对面的删除：本页进入删除页，草稿丢弃，仍可从会话记忆恢复
        this.baseRevision = null;
        this.setState({ status: 'missing', story: null, stats: ZERO_STATS, conflict: null, notice: '', error: '' });
        return;
      }
      // 对面内容损坏且存储仍不可读：无法采用，提示改用本页版本
      this.setState({ status: 'conflict', error: '对面的内容无法读取，请选择保留本页版本。' });
      return;
    }
    const remoteDocument = conflict.remoteDocument;
    if (conflict.remoteNeedsWriteBack) {
      // 本页的 diverged 提交此刻仍是存储内容，需要把对面版本写回，对面标签页才会收敛
      try {
        const payload = this.repository.replace(remoteDocument);
        this.pendingEcho = { kind: 'present', revision: payload.revision };
        this.adopt(payload.revision, payload.document, this.statusForDocument(payload.document));
        this.setState({ notice: '已切换到另一标签页的版本，两边现在是同一份内容。' });
      } catch {
        this.setState({ status: 'error', error: '保存失败，本页草稿仍保留，请重试。' });
      }
      return;
    }
    // 对面版本本来就在存储里，直接对齐即可
    this.adopt(conflict.remoteRevision!, remoteDocument, this.statusForDocument(remoteDocument));
    this.setState({ notice: '已切换到另一标签页的版本，两边现在是同一份内容。' });
  }

  /** 冲突解决：保留本标签页的草稿，无条件写回并成为新修订 */
  resolveUseLocal(): void {
    const local = this.state.story;
    if (!local) return;
    const conflict = this.state.conflict;
    try {
      const payload = this.repository.replace(local);
      this.pendingEcho = { kind: 'present', revision: payload.revision };
      this.adopt(payload.revision, payload.document, this.statusForDocument(payload.document));
      this.setState({
        notice: conflict?.remoteKind === 'missing'
          ? '已用本标签页的内容恢复项目，另一标签页将同步到同一份。'
          : '已保留本标签页的版本，另一标签页将同步到同一份。',
      });
    } catch {
      this.setState({ status: 'error', error: '保存失败，草稿仍保留在页面中，请重试。' });
    }
  }

  /** 项目已在别处删除、本地没有未保存改动时，把本地记得的内容重新写回 */
  restoreDeletedProject(): void {
    const recovered = this.baseStory;
    if (!recovered) {
      this.resetProject();
      return;
    }
    try {
      const payload = this.repository.replace(recovered);
      this.pendingEcho = { kind: 'present', revision: payload.revision };
      this.adopt(payload.revision, payload.document, this.statusForDocument(payload.document));
      this.setState({ notice: '已恢复被删除的项目。' });
    } catch {
      this.setState({ status: 'error', error: '恢复失败，内容仍保留在本页，请重试。' });
    }
  }

  get canRestoreDeleted(): boolean {
    return this.baseStory !== null;
  }

  get canEdit(): boolean {
    return this.state.story !== null && this.state.status !== 'conflict';
  }

  get visibleCharacters(): StoryCharacter[] {
    const story = this.state.story;
    if (!story) return [];
    const keyword = this.state.search.trim().toLowerCase();
    return story.characters.filter((character) => `${character.name}${character.role}`.toLowerCase().includes(keyword));
  }

  get visibleScenes(): StoryScene[] {
    const story = this.state.story;
    if (!story) return [];
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

  get savedIndicator(): string {
    if (this.state.status === 'conflict') return '⚠ 存在冲突，等待选择';
    if (this.state.status === 'missing') return '○ 项目已被删除';
    if (this.state.status === 'error') return '⚠ 存储异常';
    return '● 本地自动保存';
  }

  private statusForDocument(document: StoryDocument): ViewModelStatus {
    return document.status === 'complete' ? 'completed' : 'ready';
  }

  private adopt(revision: string, document: StoryDocument, status: ViewModelStatus): void {
    this.baseRevision = revision;
    this.baseStory = document;
    this.conflictAncestor = null;
    this.setState({ status, story: document, stats: getStats(document), conflict: null, error: '' });
  }

  /** 另一个标签页改了存储 */
  private handleExternalChange(raw: string | null): void {
    if (!this.initialized) return;
    const remote = this.readRemote(raw);

    // 自己刚写入/删除后的回声：浏览器不会把 storage 事件派发给写入者自身，
    // 内存测试后端会派发，这里兼容两种实现。
    if (this.pendingEcho) {
      const echo = this.pendingEcho;
      if (echo.kind === 'present' && remote.status === 'present' && echo.revision === remote.revision) {
        this.pendingEcho = null;
        return;
      }
      if (echo.kind === 'missing' && remote.status === 'missing') {
        this.pendingEcho = null;
        return;
      }
      if (echo.kind === 'missing' && remote.status === 'present') {
        // 我删除后对面又写回了内容：退出删除页
        this.pendingEcho = null;
        this.adopt(remote.revision, remote.document, this.statusForDocument(remote.document));
        this.setState({ notice: '项目已在另一标签页恢复，本页已自动接回。' });
        return;
      }
      // present 回声未匹配：可能是对面正常的后续提交，也可能是覆盖——用修订链判断，不急于清空
    }

    const local = this.state.story;

    // 已在冲突面板上
    if (this.state.status === 'conflict') {
      if (local && remote.status === 'present') {
        // 对面写回的正是本页选择（resolved），或内容与本地逐字一致：收敛
        if (remote.resolved || remote.revision === fingerprintStory(local)) {
          this.pendingEcho = null;
          this.adopt(remote.revision, remote.document, this.statusForDocument(remote.document));
          if (remote.resolved) this.setState({ notice: '两边已收敛到同一份内容。' });
          return;
        }
      }
      // 对面又提交了别的修订：用同一共同祖先刷新面板
      this.openConflict(remote, { ancestor: this.conflictAncestor ?? this.baseStory });
      return;
    }

    if (!local) {
      // 本地处于 missing/error 页：对面新建/恢复了项目时自动接回来
      if (remote.status === 'present') {
        this.pendingEcho = null;
        this.adopt(remote.revision, remote.document, this.statusForDocument(remote.document));
        this.setState({ notice: '项目已在另一标签页恢复，本页已自动接回。' });
      }
      return;
    }

    if (remote.status === 'present') {
      if (remote.revision === fingerprintStory(local)) {
        // 内容逐字一致，静默收敛
        this.pendingEcho = null;
        this.adopt(remote.revision, remote.document, this.statusForDocument(remote.document));
        return;
      }
      if (remote.resolved) {
        // 对面在冲突面板上做出的选择：直接对齐，不再追问
        this.pendingEcho = null;
        this.adopt(remote.revision, remote.document, this.statusForDocument(remote.document));
        this.setState({ notice: '另一标签页已完成版本选择，本页已同步到同一份。' });
        return;
      }
      if (this.isLocalClean()) {
        // 对面的修订续在我当前基准之后（或我从未落盘）：正常演进，安全快进；
        // 修订链接不上说明它绕过了我的最新修订——分叉，让作者选择
        if (remote.parentRevision === this.baseRevision || this.baseRevision === null) {
          this.pendingEcho = null;
          this.adopt(remote.revision, remote.document, this.statusForDocument(remote.document));
          this.setState({ notice: '项目已在另一标签页更新，已自动同步。' });
        } else {
          this.pendingEcho = null;
          this.openConflict(remote, { ancestor: this.baseStory, remoteNeedsWriteBack: false });
        }
      } else {
        // 我手里有未保存改动，对面又提交了新修订：分叉冲突，双向展示
        this.pendingEcho = null;
        this.openConflict(remote, { ancestor: this.baseStory, remoteNeedsWriteBack: false });
      }
      return;
    }

    if (remote.status === 'missing') {
      this.pendingEcho = null;
      if (this.isLocalClean()) {
        // 我没有未保存改动：进入删除页，内容仍记在 baseStory 里可恢复
        this.baseRevision = null;
        this.setState({ status: 'missing', story: null, stats: ZERO_STATS, conflict: null, notice: '', error: '' });
      } else {
        this.openConflict(remote, { ancestor: this.baseStory });
      }
      return;
    }

    // 存储损坏：干净页面提示异常，有草稿则进入冲突，允许用本地内容修复
    this.pendingEcho = null;
    if (this.isLocalClean()) {
      this.setState({ status: 'error', error: '另一标签页写入了无法读取的内容，请选择恢复方式，本页不会覆盖它。' });
    } else {
      this.openConflict(remote, { ancestor: this.baseStory });
    }
  }

  private readRemote(raw: string | null): StoredStory {
    return readStoredStory(raw);
  }

  private isLocalClean(): boolean {
    const local = this.state.story;
    if (!local) return false;
    const base = this.baseStory;
    if (!base) return false;
    // 内容指纹相同即视为干净：updatedAt 等不参与修订的差异不算未保存改动
    return fingerprintStory(local) === fingerprintStory(base);
  }

  private openConflict(
    remote: StoredStory,
    options: { ancestor?: StoryDocument | null; remoteNeedsWriteBack?: boolean } = {},
  ): void {
    const local = this.state.story ?? this.baseStory;
    const ancestor = options.ancestor ?? this.baseStory;
    if (!local) return;
    this.conflictAncestor = ancestor;
    const remoteNeedsWriteBack = options.remoteNeedsWriteBack ?? false;

    let remoteKind: ConflictState['remoteKind'] = 'present';
    let remoteRevision: string | null = null;
    let remoteDocument: StoryDocument | null = null;
    let remoteTimestamp: string | null = null;
    let remoteChanges: ChangeLine[] = [];
    let remoteNewer = false;

    if (remote.status === 'present') {
      remoteKind = 'present';
      remoteRevision = remote.revision;
      remoteDocument = remote.document;
      remoteTimestamp = remote.document.updatedAt;
      // 有共同祖先就相对祖先展示；没有（修订链接不上的分叉）就双向互比
      remoteChanges = ancestor
        ? summarizeChanges(diffStories(ancestor, remote.document))
        : summarizeChanges(diffStories(local, remote.document)).map((line) => ({ ...line, text: `对面独有：${line.text}` }));
      remoteNewer = new Date(remote.document.updatedAt).getTime() > new Date(local.updatedAt).getTime();
    } else if (remote.status === 'missing') {
      remoteKind = 'missing';
      remoteChanges = ancestor
        ? [
            ...summarizeChanges(deletionChangeSet(ancestor)),
            { category: '项目', text: '整个项目已被删除' },
          ]
        : [{ category: '项目', text: '整个项目已被删除' }];
    } else {
      remoteKind = 'corrupt';
      remoteChanges = [{ category: '项目', text: '存储中的项目已损坏，无法读出对面的内容' }];
    }

    const localChanges = ancestor
      ? summarizeChanges(diffStories(ancestor, local))
      : summarizeChanges(diffStories(remote.status === 'present' ? remote.document : (this.baseStory ?? local), local))
          .map((line) => ({ ...line, text: `本页独有：${line.text}` }));
    const conflict: ConflictState = {
      remoteKind,
      remoteRevision,
      remoteDocument,
      localTimestamp: local.updatedAt,
      remoteTimestamp,
      remoteNewer,
      localChanges,
      remoteChanges,
      localChanged: localChanges.length > 0,
      remoteNeedsWriteBack,
    };
    this.setState({ status: 'conflict', conflict, error: '' });
  }

  private requireStory(): StoryDocument {
    if (!this.state.story) throw new Error('故事尚未初始化');
    return this.state.story;
  }

  private updateStory(updater: (story: StoryDocument) => StoryDocument): void {
    if (!this.canEdit) return;
    const stamped: StoryDocument = { ...updater(this.requireStory()), updatedAt: new Date().toISOString() };
    const localRevision = fingerprintStory(stamped);

    // 内容指纹没变（例如只是切换选中场景）：不落盘，也不产生修订
    if (localRevision === this.baseRevision) {
      this.baseStory = stamped;
      this.setState({ story: stamped, stats: getStats(stamped), error: '' });
      return;
    }

    // 新环境下还没落过盘，且实际内容仍是示例：只留在内存里
    if (this.baseRevision === null && this.baseStory && localRevision === fingerprintStory(this.baseStory)) {
      this.baseStory = stamped;
      this.setState({ story: stamped, stats: getStats(stamped), error: '' });
      return;
    }

    let result;
    // 提交前的共同基线：提交成功后 baseStory 会被替换，分叉分析必须用它
    const ancestorBeforeCommit = this.baseStory;
    try {
      result = this.repository.commit(stamped, this.baseRevision);
    } catch {
      this.setState({ status: 'error', error: '保存失败，但当前编辑仍保留在页面中。' });
      return;
    }

    if (result.kind === 'committed') {
      this.baseRevision = result.payload.revision;
      this.baseStory = result.payload.document;
      this.pendingEcho = { kind: 'present', revision: result.payload.revision };
      // 落盘成功即回到已保存状态（ready/completed）；editing 只用于尚未落盘的内存草稿
      this.setState({
        story: result.payload.document,
        stats: getStats(result.payload.document),
        status: this.statusForDocument(result.payload.document),
        conflict: null,
        error: '',
      });
      return;
    }

    // diverged：本页版本已落盘，但覆盖了对面尚未被本页看到的修订。
    // 两个草稿都已在存储里出现过、不会丢；以「本页 vs 对面」打开冲突让作者选择。
    this.baseRevision = result.payload.revision;
    this.baseStory = result.payload.document;
    this.pendingEcho = { kind: 'present', revision: result.payload.revision };
    this.setState({
      story: result.payload.document,
      stats: getStats(result.payload.document),
      status: this.statusForDocument(result.payload.document),
    });
    this.openConflict(result.remote, { ancestor: ancestorBeforeCommit, remoteNeedsWriteBack: true });
  }

  private setState(patch: Partial<StoryViewState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}

export { formatTimestamp };
