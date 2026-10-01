// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { BrowserStorageService } from '../services/storageService';
import { LocalStoryRepository } from '../repositories/storyRepository';
import { StoryViewModel } from '../viewmodels/storyViewModel';
import { createEnvelope } from '../models/storyRevision';

describe('real browser storage event wiring', () => {
  it('reacts to window storage events dispatched by another tab', () => {
    window.localStorage.clear();
    const events: string[] = [];
    const a = new StoryViewModel(new LocalStoryRepository(new BrowserStorageService()));
    a.initialize();
    a.addCharacter('阿洛', '修复师');
    events.push(`after edit A=${a.snapshot.status}`);

    // 模拟另一个标签页写入信封，再向本窗口派发 storage 事件（浏览器的真实行为）
    const baseRevision = JSON.parse(window.localStorage.getItem('story-architect.document.v1')!).revision;
    const next = { ...a.snapshot.story!, title: '另一标签页改的标题' };
    const raw = JSON.stringify(createEnvelope(next, baseRevision));
    window.localStorage.setItem('story-architect.document.v1', raw);
    window.dispatchEvent(new StorageEvent('storage', { key: 'story-architect.document.v1', newValue: raw, oldValue: null }));
    events.push(`after remote event A=${a.snapshot.status} title=${a.snapshot.story?.title}`);
    expect(a.snapshot.story?.title).toBe('另一标签页改的标题');

    // 模拟另一标签页删除项目
    window.localStorage.removeItem('story-architect.document.v1');
    window.dispatchEvent(new StorageEvent('storage', { key: 'story-architect.document.v1', newValue: null, oldValue: raw }));
    events.push(`after delete event A=${a.snapshot.status}`);
    expect(a.snapshot.status).toBe('missing');
    expect(a.canRestoreDeleted).toBe(true);
    console.log(events.join('\n'));
  });
});
