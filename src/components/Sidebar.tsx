import type { StoryStats } from '../models/story';
import type { StoryViewModel } from '../viewmodels/storyViewModel';

interface SidebarProps {
  viewModel: StoryViewModel;
  stats: StoryStats;
}

export function Sidebar({ viewModel, stats }: SidebarProps) {
  const { story, activeSection } = viewModel.snapshot;
  const requestDelete = () => {
    if (window.confirm('确定删除当前项目吗？其它标签页会立即收到通知，删除前的内容仍可在本次会话恢复。')) {
      viewModel.deleteProject();
    }
  };
  return (
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">✦</span><span>StoryArchitect</span></div>
      <div className="project-switcher"><span className="eyebrow">当前项目</span><strong>{story?.title ?? '（空）'}</strong><span className="project-dot" /></div>
      <nav className="side-nav" aria-label="主要导航">
        <button className={activeSection === 'overview' ? 'nav-item active' : 'nav-item'} onClick={() => viewModel.setSection('overview')}><span>◈</span>故事总览</button>
        <button className={activeSection === 'characters' ? 'nav-item active' : 'nav-item'} onClick={() => viewModel.setSection('characters')}><span>♧</span>人物关系</button>
        <button className={activeSection === 'clues' ? 'nav-item active' : 'nav-item'} onClick={() => viewModel.setSection('clues')}><span>⌁</span>伏笔关系</button>
      </nav>
      <div className="sidebar-bottom">
        <div className="mini-progress"><div><span>结构完成度</span><b>{stats.completion}%</b></div><div className="progress-track"><span style={{ width: `${stats.completion}%` }} /></div></div>
        <div className="sidebar-links">
          <button className="reset-link" onClick={() => viewModel.resetProject()}>↻ 恢复示例项目</button>
          <button className="reset-link danger" onClick={requestDelete}>✕ 删除当前项目</button>
        </div>
        <span className={`saved-state${viewModel.snapshot.status === 'conflict' ? ' danger' : ''}`}>{viewModel.savedIndicator}</span>
      </div>
    </aside>
  );
}
