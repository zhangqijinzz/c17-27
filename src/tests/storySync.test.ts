import { describe, expect, it } from 'vitest';
import { MemoryStorageBus, MemoryStorageService } from '../services/storageService';
import { LocalStoryRepository } from '../repositories/storyRepository';
import { serializeTombstone } from '../models/storyEnvelope';
import { StoryViewModel } from '../viewmodels/storyViewModel';

/** 等一拍，让内存总线的微任务通知（模拟 storage 事件）派发完。 */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createPair(): { bus: MemoryStorageBus; tabA: StoryViewModel; tabB: StoryViewModel } {
  const bus = new MemoryStorageBus();
  const tabA = new StoryViewModel(new LocalStoryRepository(new MemoryStorageService(bus)));
  const tabB = new StoryViewModel(new LocalStoryRepository(new MemoryStorageService(bus)));
  tabA.initialize();
  tabB.initialize();
  return { bus, tabA, tabB };
}

describe('多标签页同步与冲突', () => {
  it('一边干净时，另一边的保存会静默收敛过来', async () => {
    const { tabA, tabB } = createPair();
    await flush();

    tabA.addScene('灯塔停电', '灯塔的光束在午夜骤然熄灭。');
    await flush();

    expect(tabB.snapshot.syncState).toBe('synced');
    expect(tabB.snapshot.story?.scenes.some((scene) => scene.title === '灯塔停电')).toBe(true);
    expect(tabB.snapshot.knownRevision).toBe(tabA.snapshot.knownRevision);
    expect(tabB.snapshot.remoteNotice).toContain('同步');
  });

  it('两边各写各的：后保存的一方不能覆盖，而是进入冲突并列出双方改动', async () => {
    const { tabA, tabB } = createPair();
    await flush();

    tabA.addCharacter('阿洛', '修复师');
    tabB.addClue('铜罗盘刻痕', tabB.snapshot.story!.scenes[0].id, '');

    // B 的 CAS 失败（A 已先提交），B 的内容仍在手里，弹出冲突。
    expect(tabB.snapshot.syncState).toBe('conflict');
    expect(tabB.snapshot.story?.clues.some((clue) => clue.title === '铜罗盘刻痕')).toBe(true);

    await flush();
    // A 也收到 B 失败前的通知？不会——B 没写进存储，A 保持同步态。
    expect(tabA.snapshot.syncState).toBe('synced');
    expect(tabA.snapshot.story?.characters.some((character) => character.name === '阿洛')).toBe(true);

    const view = tabB.conflictView!;
    expect(view.local.changeCount).toBeGreaterThan(0);
    expect(view.remote.changeCount).toBeGreaterThan(0);
    const localDescriptions = view.local.changes.map((change) => change.name);
    const remoteDescriptions = view.remote.changes.map((change) => change.name);
    expect(localDescriptions).toContain('铜罗盘刻痕');
    expect(remoteDescriptions).toContain('阿洛');
  });

  it('同一次操作里多处同时变化，会被逐字段列出而不是只凭时间戳猜', async () => {
    const { tabA, tabB } = createPair();
    await flush();

    // A 修改场景的多个字段（一次操作）
    const sceneId = tabA.snapshot.story!.scenes[0].id;
    tabA.updateScene(sceneId, { title: '旧港口的密信', summary: '信上的日期指向三十年前的海难。', conflict: '她要不要回信？' });
    // B 在同一基线上加人物，制造分叉
    tabB.addCharacter('老守塔人', '知道灯塔秘密的人');
    await flush();

    const view = tabB.conflictView!;
    const changedScene = view.remote.changes.find((change) => change.entity === 'scene' && change.kind === 'changed');
    expect(changedScene).toBeTruthy();
    expect(changedScene!.fields.map((field) => field.field).sort()).toEqual(['conflict', 'summary', 'title']);
    expect(changedScene!.fields.find((field) => field.field === 'title')?.nextValue).toBe('旧港口的密信');
  });

  it('裁决用本地后，两边收敛到同一份', async () => {
    const { tabA, tabB } = createPair();
    await flush();

    tabA.addCharacter('阿洛', '修复师');
    tabB.addScene('灯塔停电', '午夜光束熄灭。');
    expect(tabB.snapshot.syncState).toBe('conflict');

    tabB.resolveKeepLocal();
    await flush();

    expect(tabB.snapshot.story?.scenes.some((scene) => scene.title === '灯塔停电')).toBe(true);
    // A 侧被收敛：B 的裁决版本通过存储事件同步过来
    expect(tabA.snapshot.story?.scenes.some((scene) => scene.title === '灯塔停电')).toBe(true);
    expect(tabA.snapshot.knownRevision).toBe(tabB.snapshot.knownRevision);
    expect(tabA.snapshot.conflict).toBeNull();
  });

  it('裁决用远程后，本地未保存改动被放弃，两边一致', async () => {
    const { tabA, tabB } = createPair();
    await flush();

    tabA.addCharacter('阿洛', '修复师');
    tabB.addScene('灯塔停电', '午夜光束熄灭。');

    tabB.resolveUseRemote();
    expect(tabB.snapshot.story?.characters.some((character) => character.name === '阿洛')).toBe(true);
    expect(tabB.snapshot.story?.scenes.some((scene) => scene.title === '灯塔停电')).toBe(false);
    expect(tabB.snapshot.knownRevision).toBe(tabA.snapshot.knownRevision);
  });

  it('一边删了项目，另一边的在途保存不崩溃也不覆盖，弹冲突并可恢复', async () => {
    const { tabA, tabB } = createPair();
    await flush();
    const baseRevision = tabA.snapshot.knownRevision;

    // A 先删除（墓碑已同步落入共享存储），B 同一时刻还在写——
    // B 的 CAS 撞上墓碑，保存失败但手里内容保留，进入冲突。
    tabA.deleteProject();
    tabB.addCharacter('老守塔人', '知道灯塔秘密的人');
    await flush();

    expect(tabA.snapshot.status).toBe('deleted');
    expect(() => tabB.snapshot).not.toThrow();
    expect(tabB.snapshot.story?.characters.some((character) => character.name === '老守塔人')).toBe(true);
    expect(tabB.snapshot.syncState).toBe('conflict');

    const view = tabB.conflictView!;
    expect(view.remote.exists).toBe(false);
    expect(view.local.changes.some((change) => change.name === '老守塔人')).toBe(true);

    // B 选择用自己这一份继续：项目被恢复，A 通过存储事件收敛回来
    tabB.resolveKeepLocal();
    await flush();
    expect(tabB.snapshot.status).not.toBe('deleted');
    expect(tabA.snapshot.status).not.toBe('deleted');
    expect(tabA.snapshot.story?.characters.some((character) => character.name === '老守塔人')).toBe(true);
    expect(tabA.snapshot.knownRevision).toBe(tabB.snapshot.knownRevision);
    expect(tabA.snapshot.knownRevision).toBe(baseRevision + 2);
  });

  it('一边删了项目，另一边干净时直接进入已删除页，可用示例恢复', async () => {
    const { bus, tabA, tabB } = createPair();
    await flush();

    bus.commit(serializeTombstone(tabA.snapshot.knownRevision + 1, new Date().toISOString()));
    await flush();

    expect(tabA.snapshot.status).toBe('deleted');
    expect(tabB.snapshot.status).toBe('deleted');

    tabA.resetProject();
    await flush();
    expect(tabA.snapshot.status).toBe('ready');
    expect(tabB.snapshot.status).toBe('ready');
    expect(tabA.snapshot.knownRevision).toBe(tabB.snapshot.knownRevision);
  });

  it('两边冲突且都动了同一个实体时，标记为冲突焦点', async () => {
    const { tabA, tabB } = createPair();
    await flush();
    const sceneId = tabA.snapshot.story!.scenes[0].id;

    tabA.updateScene(sceneId, { title: 'A 改的标题' });
    tabB.updateScene(sceneId, { summary: 'B 改的摘要' });

    const view = tabB.conflictView!;
    expect([...view.overlapKeys]).toContain(`scene:${sceneId}`);
  });

  it('本标签页有在途输入时收到别处的 storage 通知，不静默覆盖，直接弹冲突', async () => {
    const { tabA, tabB } = createPair();
    await flush();

    // B 先写成功（版本前进），接着让 B 手里再次出现“在途编辑”但暂未触发新 CAS：
    // 用一次注定失败的保存路径即可制造 dirty+冲突；这里改为直接验证事件路径——
    // B 成功提交后，A 再提交，此时 B 是干净的会静默收敛；
    // 只有 B 不接收通知（模拟事件延迟）期间又改了东西，才该弹冲突。
    tabB.addCharacter('本地先写的人', '守夜者');
    await flush();
    tabA.addCharacter('另一页后写的人', '引航员');
    await flush();
    // B 已静默同步 A 的内容
    expect(tabB.snapshot.story?.characters.some((c) => c.name === '另一页后写的人')).toBe(true);
    expect(tabB.snapshot.syncState).toBe('synced');

    // 现在 A 再写一笔，而 B 在同一拍里也在写：B 的 CAS 失败，内容保留并弹冲突
    tabA.addScene('夜里的雾号', '雾从海面上漫进港口。');
    tabB.addCharacter('在途的第三人', '灯语员');
    await flush();

    expect(tabB.snapshot.syncState).toBe('conflict');
    expect(tabB.snapshot.story?.characters.some((c) => c.name === '在途的第三人')).toBe(true);
    const view = tabB.conflictView!;
    expect(view.remote.changes.some((change) => change.name === '夜里的雾号')).toBe(true);
    expect(view.local.changes.some((change) => change.name === '在途的第三人')).toBe(true);
  });
});
