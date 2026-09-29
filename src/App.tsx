import { CharacterPanel } from './components/CharacterPanel';
import { CluePanel } from './components/CluePanel';
import { SceneInspector } from './components/SceneInspector';
import { Sidebar } from './components/Sidebar';
import { TimelineBoard } from './components/TimelineBoard';
import { useStoryViewModel } from './hooks/useStoryViewModel';

function App() {
  const viewModel = useStoryViewModel();
  const snapshot = viewModel.snapshot;
  if (snapshot.status === 'loading' || !snapshot.story) return <div className="app-loading"><span className="brand-mark">✦</span><p>正在打开故事工作台…</p></div>;
  const sectionLabel = snapshot.activeSection === 'characters' ? '人物关系' : snapshot.activeSection === 'clues' ? '伏笔关系' : '故事总览';
  return <div className="app-shell"><Sidebar viewModel={viewModel} stats={snapshot.stats} /><main className="main-content"><header className="topbar"><div><span className="eyebrow">STORY LAB / {sectionLabel}</span><h1>{snapshot.story.title}</h1></div><div className="topbar-actions"><label className="search-box"><span>⌕</span><input aria-label="搜索故事结构" value={snapshot.search} onChange={(event) => viewModel.setSearch(event.target.value)} placeholder="搜索人物、场景…" /></label><button className="complete-button" onClick={() => viewModel.completeProject()}>{snapshot.status === 'completed' ? '✓ 已完成' : '标记完成'}</button></div></header><div className="content-wrap">{snapshot.notice && <div className="notice" role="status">✦ {snapshot.notice}</div>}{snapshot.error && <div className="error-banner" role="alert">{snapshot.error} <button onClick={() => viewModel.resetProject()}>恢复示例</button></div>}<div className="stats-row"><div><span>人物</span><strong>{snapshot.stats.characters}</strong></div><div><span>场景</span><strong>{snapshot.stats.scenes}</strong></div><div><span>伏笔</span><strong>{snapshot.stats.clues}</strong></div><div className={snapshot.stats.unresolvedClues > 0 ? 'stat-alert' : ''}><span>待回收</span><strong>{snapshot.stats.unresolvedClues}</strong></div><div className="completion-stat"><span>结构完成度</span><strong>{snapshot.stats.completion}%</strong><div className="progress-track"><span style={{ width: `${snapshot.stats.completion}%` }} /></div></div></div><div className="work-grid"><div className="workspace-column"><TimelineBoard viewModel={viewModel} scenes={viewModel.visibleScenes} /><div className="lower-grid"><CharacterPanel viewModel={viewModel} characters={viewModel.visibleCharacters} /><CluePanel viewModel={viewModel} scenes={viewModel.visibleScenes} /></div></div><SceneInspector viewModel={viewModel} scene={viewModel.selectedScene} characters={snapshot.story.characters} /></div></div></main></div>;
}

export default App;
