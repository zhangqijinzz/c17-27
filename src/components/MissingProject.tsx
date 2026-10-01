import type { StoryViewModel } from '../viewmodels/storyViewModel';

interface MissingProjectProps {
  viewModel: StoryViewModel;
}

export function MissingProject({ viewModel }: MissingProjectProps) {
  const canRestore = viewModel.canRestoreDeleted;
  return (
    <div className="app-shell">
      <main className="missing-page">
        <span className="brand-mark">✦</span>
        <span className="eyebrow">PROJECT / 已删除</span>
        <h1>这个项目刚在另一个标签页里被删除</h1>
        <p>
          本标签页没有未保存的改动，因此没有发生覆盖或冲突。删除前的内容仍暂时保留在本次会话里，
          你可以把它恢复回去，也可以确认删除、从示例项目重新开始。
        </p>
        <div className="missing-actions">
          <button className="conflict-primary" onClick={() => viewModel.restoreDeletedProject()} disabled={!canRestore}>
            恢复删除前的内容
          </button>
          <button className="conflict-primary ghost" onClick={() => viewModel.resetProject()}>
            确认删除，从示例项目开始
          </button>
        </div>
        {!canRestore && <p className="missing-hint">会话里没有可恢复的内容，只能从示例项目重新开始。</p>}
      </main>
    </div>
  );
}
