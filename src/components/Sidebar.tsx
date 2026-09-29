import type { StoryStats } from '../models/story';
import type { StoryViewModel } from '../viewmodels/storyViewModel';

interface SidebarProps {
  viewModel: StoryViewModel;
  stats: StoryStats;
}

export function Sidebar({ viewModel, stats }: SidebarProps) {
  const { story, activeSection } = viewModel.snapshot;
  return (
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">✦</span><span>StoryArchitect</span></div>
      <div className="project-switcher"><span className="eyebrow">当前项目</span><strong>{story?.title ?? '正在加载…'}</strong><span className="project-dot" /></div>
      <nav className="side-nav" aria-label="主要导航">
        <button className={activeSection === 'overview' ? 'nav-item active' : 'nav-item'} onClick={() => viewModel.setSection('overview')}><span>◈</span>故事总览</button>
        <button className={activeSection === 'characters' ? 'nav-item active' : 'nav-item'} onClick={() => viewModel.setSection('characters')}><span>♧</span>人物关系</button>
        <button className={activeSection === 'clues' ? 'nav-item active' : 'nav-item'} onClick={() => viewModel.setSection('clues')}><span>⌁</span>伏笔关系</button>
      </nav>
      <div className="sidebar-bottom">
        <div className="mini-progress"><div><span>结构完成度</span><b>{stats.completion}%</b></div><div className="progress-track"><span style={{ width: `${stats.completion}%` }} /></div></div>
        <button className="reset-link" onClick={() => viewModel.resetProject()}>↻ 恢复示例项目</button>
        <span className="saved-state">● 本地自动保存</span>
      </div>
    </aside>
  );
}
