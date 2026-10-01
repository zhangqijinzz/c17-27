import { describe, expect, it } from 'vitest';
import { createStarterStory } from '../models/story';
import {
  createEnvelope,
  deletionChangeSet,
  diffStories,
  fingerprintStory,
  hasChanges,
  readStoredStory,
  summarizeChanges,
} from '../models/storyRevision';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('story revision fingerprint', () => {
  it('ignores updatedAt and selectedSceneId', () => {
    const story = createStarterStory();
    const later = { ...clone(story), updatedAt: new Date('2030-01-01').toISOString(), selectedSceneId: 'scene-storm' };
    expect(fingerprintStory(later)).toBe(fingerprintStory(story));
  });

  it('changes when content changes, even when several fields move in one operation', () => {
    const story = createStarterStory();
    const base = fingerprintStory(story);
    // 一次操作同时新增伏笔并修改场景关联（模拟 addClue）
    const updated: typeof story = {
      ...story,
      clues: [...story.clues, { id: 'clue-x', title: '铜罗盘', setupSceneId: 'scene-storm', payoffSceneId: '' }],
      scenes: story.scenes.map((scene) =>
        scene.id === 'scene-storm' ? { ...scene, clueIds: [...scene.clueIds, 'clue-x'] } : scene,
      ),
    };
    expect(fingerprintStory(updated)).not.toBe(base);
  });

  it('does not depend on key order of serialized input', () => {
    const story = createStarterStory();
    const reordered = {
      clues: clone(story.clues),
      scenes: clone(story.scenes),
      characters: clone(story.characters),
      status: story.status,
      title: story.title,
      id: story.id,
      version: 1,
      selectedSceneId: story.selectedSceneId,
      updatedAt: story.updatedAt,
    };
    expect(fingerprintStory(reordered as typeof story)).toBe(fingerprintStory(story));
  });

  it('reads envelopes and migrates bare legacy documents', () => {
    const story = createStarterStory();
    const envelope = createEnvelope(story, null);
    const fromEnvelope = readStoredStory(JSON.stringify(envelope));
    expect(fromEnvelope.status).toBe('present');
    if (fromEnvelope.status !== 'present') throw new Error('expected present');
    expect(fromEnvelope.revision).toBe(fingerprintStory(story));

    const legacy = readStoredStory(JSON.stringify(story));
    expect(legacy.status).toBe('present');
    if (legacy.status !== 'present') throw new Error('expected present');
    expect(legacy.revision).toBe(fingerprintStory(story));

    expect(readStoredStory(null).status).toBe('missing');
    expect(readStoredStory('{broken').status).toBe('corrupt');
    expect(readStoredStory(JSON.stringify({ version: 99 })).status).toBe('corrupt');
  });
});

describe('story diff', () => {
  it('reports multi-field and multi-entity changes relative to the common base', () => {
    const base = createStarterStory();
    const next = clone(base);
    next.title = '新的标题';
    next.characters[0].name = '米拉改名';
    next.scenes = next.scenes.filter((scene) => scene.id !== 'scene-storm');
    next.clues.push({ id: 'clue-new', title: '新伏笔', setupSceneId: base.scenes[0].id, payoffSceneId: '' });

    const changes = diffStories(base, next);
    expect(changes.projectFields).toEqual(['项目标题']);
    expect(changes.characters.updated[0].fields).toContain('姓名');
    expect(changes.scenes.removed).toHaveLength(1);
    expect(changes.clues.added).toHaveLength(1);

    const lines = summarizeChanges(changes).map((line) => line.text);
    expect(lines.some((text) => text.includes('项目标题'))).toBe(true);
    expect(lines.some((text) => text.includes('米拉改名') || text.includes('米拉'))).toBe(true);
    expect(lines.some((text) => text.includes('删除场景'))).toBe(true);
    expect(lines.some((text) => text.includes('新增伏笔'))).toBe(true);
  });

  it('treats unordered id-array edits the same regardless of element order', () => {
    const base = createStarterStory();
    const next = clone(base);
    next.scenes[0] = { ...base.scenes[0], characterIds: ['character-june', 'character-mira'] };
    const reversed = clone(base);
    reversed.scenes[0] = { ...base.scenes[0], characterIds: ['character-mira', 'character-june'] };
    expect(hasChanges(diffStories(next, reversed))).toBe(false);
  });

  it('describes deletion as removal of every tracked entity', () => {
    const base = createStarterStory();
    const changes = deletionChangeSet(base);
    expect(changes.characters.removed).toHaveLength(2);
    expect(changes.scenes.removed).toHaveLength(2);
    expect(changes.clues.removed).toHaveLength(1);
    expect(summarizeChanges(changes).length).toBeGreaterThan(0);
  });
});
