import type { StoryStats } from '../models/story';
import type { SyncState } from '../viewmodels/storyViewModel';
import type { StoryViewModel } from '../viewmodels/storyViewModel';

interface SidebarProps {
  viewModel: StoryViewModel;
  stats: StoryStats;
}

const syncLabels: Record<SyncState, { text: string; cls: string }> = {
  synced: { text: '● 本地自动保存 · 已同步', cls: 'saved-state' },
  pending: { text: '● 保存失败，编辑仅保留在本页', cls: 'saved-state state-pending' },
  conflict: { text: '⚠ 另一标签页存在冲突，待选择', cls: 'saved-state state-conflict' },
  deleted: { text: '○ 项目已删除', cls: 'saved-state state-deleted' },
};

export function Sidebar({ viewModel, stats }: SidebarProps) {
  const { story, activeSection, syncState } = viewModel.snapshot;
  const sync = syncLabels[syncState];
  return (
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">✦</span><span>StoryArchitect</span></div>
      <div className="project-switcher"><span className="eyebrow">当前项目</span><strong>{story?.title ?? '已删除'}</strong><span className="project-dot" /></div>
      <nav className="side-nav" aria-label="主要导航">
        <button className={activeSection === 'overview' ? 'nav-item active' : 'nav-item'} onClick={() => viewModel.setSection('overview')}><span>◈</span>故事总览</button>
        <button className={activeSection === 'characters' ? 'nav-item active' : 'nav-item'} onClick={() => viewModel.setSection('characters')}><span>♧</span>人物关系</button>
        <button className={activeSection === 'clues' ? 'nav-item active' : 'nav-item'} onClick={() => viewModel.setSection('clues')}><span>⌁</span>伏笔关系</button>
      </nav>
      <div className="sidebar-bottom">
        <div className="mini-progress"><div><span>结构完成度</span><b>{stats.completion}%</b></div><div className="progress-track"><span style={{ width: `${stats.completion}%` }} /></div></div>
        <button className="reset-link" onClick={() => viewModel.resetProject()}>↻ 恢复示例项目</button>
        <button
          className="reset-link delete-link"
          onClick={() => {
            if (window.confirm('确定删除当前项目？其它打开着的标签页会收到删除通知。')) viewModel.deleteProject();
          }}
        >
          ✕ 删除当前项目
        </button>
        <span className={sync.cls}>{sync.text}</span>
      </div>
    </aside>
  );
}
