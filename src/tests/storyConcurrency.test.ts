import { describe, expect, it } from 'vitest';
import { createStarterStory } from '../models/story';
import { createEnvelope, fingerprintStory } from '../models/storyRevision';
import type { StoryEnvelope } from '../models/storyRevision';import { LocalStoryRepository } from '../repositories/storyRepository';
import { MemoryStorageBackend, MemoryStorageService } from '../services/storageService';
import { StoryViewModel } from '../viewmodels/storyViewModel';

interface TabPair {
  backend: MemoryStorageBackend;
  a: StoryViewModel;
  b: StoryViewModel;
}

function flush(): Promise<void> {
  // 等微任务队列里的存储事件派发完
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function openTwoTabs(): TabPair {
  const backend = new MemoryStorageBackend();
  const a = new StoryViewModel(new LocalStoryRepository(new MemoryStorageService(backend)));
  const b = new StoryViewModel(new LocalStoryRepository(new MemoryStorageService(backend)));
  a.initialize();
  b.initialize();
  return { backend, a, b };
}

describe('story repository optimistic concurrency', () => {
  it('commits on top of the base and reports divergence for stale writers', () => {
    const backend = new MemoryStorageBackend();
    const repoA = new LocalStoryRepository(new MemoryStorageService(backend));
    const repoB = new LocalStoryRepository(new MemoryStorageService(backend));

    const first = createStarterStory();
    const saved = repoA.commit(first, null);
    expect(saved.kind).toBe('committed');
    if (saved.kind !== 'committed') throw new Error('commit failed');
    const revision = saved.payload.revision;

    // A、B 都基于同一个修订各自修改：A 先提交正常，B 的陈旧提交被标记 diverged，
    // 但 B 的版本也落了盘（localStorage 语义），且返回里带着被覆盖的对面修订
    const fromA = { ...first, title: 'A 改的标题', updatedAt: new Date().toISOString() };
    const fromB = { ...first, title: 'B 改的标题', updatedAt: new Date().toISOString() };
    expect(repoA.commit(fromA, revision).kind).toBe('committed');
    const stale = repoB.commit(fromB, revision);
    expect(stale.kind).toBe('diverged');
    if (stale.kind !== 'diverged') throw new Error('expected diverged');
    expect(stale.remote.status).toBe('present');
    if (stale.remote.status !== 'present') throw new Error('expected present remote');
    // 被覆盖的对面修订快照保留在返回里，供冲突面板展示
    expect(stale.remote.document.title).toBe('A 改的标题');
    expect(stale.payload.parentRevision).toBe(stale.remote.revision);
    // 存储此刻是 B 写入的新版本
    expect(JSON.parse(backend.read() ?? '{}').document.title).toBe('B 改的标题');
  });

  it('treats a stale write with identical content as convergence, not divergence', () => {
    const backend = new MemoryStorageBackend();
    const repoA = new LocalStoryRepository(new MemoryStorageService(backend));
    const base = createStarterStory();
    const saved = repoA.commit(base, null);
    if (saved.kind !== 'committed') throw new Error('commit failed');

    // 第二个仓库在同一修订上构造内容逐字相同的文档（仅 updatedAt 不同）
    const repoB = new LocalStoryRepository(new MemoryStorageService(backend));
    const identical = { ...base, updatedAt: new Date().toISOString() };
    const result = repoB.commit(identical, saved.payload.revision);
    // 指纹相同意味着修订相同，这种"陈旧写入"不应造成分叉
    expect(result.kind).toBe('committed');
  });

  it('replace writes a resolution envelope unconditionally', () => {
    const backend = new MemoryStorageBackend();
    const repo = new LocalStoryRepository(new MemoryStorageService(backend));
    const payload = repo.replace(createStarterStory());
    const read = readEnvelope(backend);
    expect(read.revision).toBe(payload.revision);
    expect(read.resolved).toBe(true);
  });
});

function readEnvelope(backend: MemoryStorageBackend): { revision: string; resolved: boolean } {
  return JSON.parse(backend.read() ?? '{}') as { revision: string; resolved: boolean };
}

describe('multi-tab view model coordination', () => {
  it('fast-forwards an idle tab to the version saved elsewhere', async () => {
    const { a, b } = openTwoTabs();
    a.addCharacter('阿洛', '修复师');
    await flush();
    expect(b.snapshot.status).not.toBe('conflict');
    expect(b.snapshot.story?.characters.some((character) => character.name === '阿洛')).toBe(true);
    // B 已经收敛，基准修订与 A 一致
    expect(fingerprintStory(b.snapshot.story!)).toBe(fingerprintStory(a.snapshot.story!));
  });

  it('keeps both drafts and opens a conflict when both tabs edited the same base', async () => {
    const { a, b } = openTwoTabs();
    // A 先建立共同基线并让 B 收敛
    a.addCharacter('基线角色', '');
    await flush();

    // A、B 在事件到达前基于同一祖先各自提交：B 直接读到了 A 的新修订（diverged），
    // A 收到 B 的事件时，B 的 parent 正是 A 的修订——这是正常演进，A 直接快进，不打扰
    a.addCharacter('角色甲', '甲的身份');
    b.addCharacter('角色乙', '乙的身份');
    expect(b.snapshot.status).toBe('conflict');

    await flush();
    expect(a.snapshot.status).not.toBe('conflict');
    expect(a.snapshot.story?.characters.some((character) => character.name === '角色乙')).toBe(true);

    // 分叉只存在于 B（它的提交覆盖了刚读到的 A 修订）；B 面板里两份草稿都在
    expect(b.snapshot.story?.characters.some((character) => character.name === '角色乙')).toBe(true);
    const localTexts = b.snapshot.conflict!.localChanges.map((line) => line.text).join(' ');
    const remoteTexts = b.snapshot.conflict!.remoteChanges.map((line) => line.text).join(' ');
    expect(localTexts).toContain('角色乙');
    expect(remoteTexts).toContain('角色甲');
    // 哪边更新有明确标记（时间戳只用于展示，不参与判定）
    expect(typeof b.snapshot.conflict!.remoteNewer).toBe('boolean');

    // B 选择保留自己的：打 resolved 写回，A 已在 B 的版本上，不受影响，两边一致
    b.resolveUseLocal();
    await flush();
    expect(a.snapshot.status).not.toBe('conflict');
    expect(b.snapshot.status).not.toBe('conflict');
    expect(fingerprintStory(a.snapshot.story!)).toBe(fingerprintStory(b.snapshot.story!));
  });

  it('opens a conflict when a revision that bypasses my latest revision arrives', async () => {
    const { backend, a, b } = openTwoTabs();
    a.addCharacter('基线角色', '');
    await flush();
    // A 在基线之上再保存两个修订；然后第三个标签页直接拿最初基线、绕过 A 的修订写回
    a.addCharacter('角色甲', '');
    await flush();
    // 第三个标签页直接拿最初基线、用 null 父修订写回（模拟绕过 A 最新修订的外部覆盖）
    const bypassDoc = { ...b.snapshot.story!, title: '绕过 A 的标题' };
    const bypass = createEnvelope(bypassDoc, null);
    new MemoryStorageService(backend).write(`${JSON.stringify(bypass)} `);
    await flush();
    // A 的修订被绕过：不能静默快进丢掉「角色甲」，必须弹冲突
    expect(a.snapshot.status).toBe('conflict');
    expect(a.snapshot.story?.characters.some((character) => character.name === '角色甲')).toBe(true);
    expect(a.snapshot.conflict?.remoteDocument?.title).toBe('绕过 A 的标题');
  });

  it('drops the local draft cleanly when choosing the remote version', async () => {
    const { a, b } = openTwoTabs();
    a.addCharacter('基线角色', '');
    await flush();
    a.addCharacter('角色甲', '');
    b.addCharacter('角色乙', '');
    // B 的提交覆盖了刚读到的 A 修订，直接进入冲突
    expect(b.snapshot.status).toBe('conflict');

    b.resolveUseRemote();
    expect(b.snapshot.story?.characters.some((character) => character.name === '角色甲')).toBe(true);
    expect(b.snapshot.story?.characters.some((character) => character.name === '角色乙')).toBe(false);
    await flush();
    expect(fingerprintStory(a.snapshot.story!)).toBe(fingerprintStory(b.snapshot.story!));
  });

  it('recognizes a single multi-field operation as one revision', async () => {
    const { a, b } = openTwoTabs();
    // addClue 同时改 clues 和 scenes，B 只收到一次变更通知并整体快进
    a.addClue('铜罗盘刻痕', 'scene-storm', '');
    await flush();
    expect(b.snapshot.status).not.toBe('conflict');
    expect(b.snapshot.story?.clues.some((clue) => clue.title === '铜罗盘刻痕')).toBe(true);
    expect(b.snapshot.story?.scenes.find((scene) => scene.id === 'scene-storm')?.clueIds).toContain(
      b.snapshot.story!.clues.find((clue) => clue.title === '铜罗盘刻痕')!.id,
    );
  });

  it('converges silently when the remote saved byte-identical content', async () => {
    const { backend, a, b } = openTwoTabs();
    a.addCharacter('基线角色', '');
    await flush();
    // A 保存一个修订；模拟「另一标签页写回与 A 内容逐字相同、但字符串不同的信封」
    a.addCharacter('同名角色', '相同身份');
    new MemoryStorageService(backend).write(`${backend.read()!} `);
    await flush();
    // 指纹一致：没有任何冲突面板，两边收敛
    expect(a.snapshot.status).not.toBe('conflict');
    expect(b.snapshot.status).not.toBe('conflict');
    expect(fingerprintStory(a.snapshot.story!)).toBe(fingerprintStory(b.snapshot.story!));
  });

  it('moves a clean tab to the deleted-project page without losing recoverable content', async () => {
    const { a, b } = openTwoTabs();
    a.addCharacter('先写点东西', '');
    await flush();
    // 两边都已收敛且干净，B 删除项目
    b.deleteProject();
    await flush();
    expect(a.snapshot.status).toBe('missing');
    expect(a.snapshot.story).toBeNull();
    expect(a.canRestoreDeleted).toBe(true);

    // 恢复：项目回到存储，B 随之收敛
    a.restoreDeletedProject();
    await flush();
    expect(a.snapshot.status).not.toBe('missing');
    expect(b.snapshot.story?.characters.some((character) => character.name === '先写点东西')).toBe(true);
  });

  it('keeps writing in the other tab alive when the project is deleted concurrently', async () => {
    const { a, b } = openTwoTabs();
    a.addCharacter('共同基线', '');
    await flush();
    // B 先删除项目，A 在删除事件到达前还在同一基线上继续编辑并尝试保存
    b.deleteProject();
    a.addCharacter('A 还在写的新角色', '');

    // A 没有崩，草稿还在内存里，并被要求选择
    expect(a.snapshot.status).toBe('conflict');
    expect(a.snapshot.story?.characters.some((character) => character.name === 'A 还在写的新角色')).toBe(true);
    expect(a.snapshot.conflict?.remoteKind).toBe('missing');
    const remoteTexts = a.snapshot.conflict!.remoteChanges.map((line) => line.text).join(' ');
    expect(remoteTexts).toContain('删除');

    // 延迟到达的删除事件不能把已经在冲突面板上的 A 带去 missing 页
    await flush();
    expect(a.snapshot.status).toBe('conflict');

    // A 选择用自己的内容恢复，B 随之收敛，项目重新存在
    a.resolveUseLocal();
    await flush();
    expect(b.snapshot.status).not.toBe('missing');
    expect(b.snapshot.story?.characters.some((character) => character.name === 'A 还在写的新角色')).toBe(true);
  });

  it('refreshes the conflict if the remote side changes again while the dialog is open', async () => {
    const { a, b } = openTwoTabs();
    a.addCharacter('基线角色', '');
    await flush();
    a.addCharacter('角色甲', '');
    b.addCharacter('角色乙', '');
    // B 是提交时直接发现分叉的一方
    expect(b.snapshot.status).toBe('conflict');

    // 冲突还没解决，A 又删了项目：面板切换成删除型冲突
    a.deleteProject();
    await flush();
    expect(b.snapshot.status).toBe('conflict');
    expect(b.snapshot.conflict?.remoteKind).toBe('missing');
    // B 用自己的草稿恢复，A 收到新内容后退出删除页
    b.resolveUseLocal();
    await flush();
    expect(a.snapshot.story?.characters.some((character) => character.name === '角色乙')).toBe(true);
  });

  it('never prompts an untouched tab, it just fast-forwards', async () => {
    const { a, b } = openTwoTabs();
    a.addCharacter('基线角色', '');
    await flush();
    // B 停在干净基线不动，A 继续编辑并保存，B 应静默快进而不是弹冲突
    a.addCharacter('又一个角色', '');
    await flush();
    expect(b.snapshot.status).not.toBe('conflict');
    expect(b.snapshot.story?.characters.some((character) => character.name === '又一个角色')).toBe(true);
  });
});

describe('envelope round trip', () => {
  it('stays unwritten until the first real edit, then writes a valid envelope', () => {
    const idle = openTwoTabs();
    expect(idle.backend.read()).toBeNull(); // 仅打开不编辑不落盘
    const pair = openTwoTabs();
    pair.a.addCharacter('落盘角色', '');
    const raw = pair.backend.read();
    expect(raw).not.toBeNull();
    const envelope = JSON.parse(raw!) as StoryEnvelope;
    expect(envelope.kind).toBe('story-architect.envelope/v1');
    expect(envelope.revision).toBe(fingerprintStory(envelope.document));
  });
});
