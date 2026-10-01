import { formatTimestamp, type ChangeCategory, type ChangeLine } from '../models/storyRevision';
import type { ConflictState, StoryViewModel } from '../viewmodels/storyViewModel';

interface ConflictDialogProps {
  viewModel: StoryViewModel;
  conflict: ConflictState;
}

const CATEGORY_ORDER: ChangeCategory[] = ['项目', '人物', '场景', '伏笔'];

function ChangeList({ lines }: { lines: ChangeLine[] }) {
  if (lines.length === 0) {
    return <p className="conflict-empty">没有实质内容变化</p>;
  }
  const groups = CATEGORY_ORDER.map((category) => ({
    category,
    items: lines.filter((line) => line.category === category),
  })).filter((group) => group.items.length > 0);
  return (
    <ul className="conflict-changes">
      {groups.map((group) => (
        <li key={group.category}>
          <span className="conflict-group-label">{group.category}</span>
          <ul>
            {group.items.map((item, index) => (
              <li key={`${item.text}-${index}`}>{item.text}</li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

export function ConflictDialog({ viewModel, conflict }: ConflictDialogProps) {
  const remoteDeleted = conflict.remoteKind === 'missing';
  const remoteCorrupt = conflict.remoteKind === 'corrupt';
  const remoteReadable = !remoteCorrupt;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
      <div className="conflict-modal">
        <div className="conflict-header">
          <span className="eyebrow">SYNC / 多标签页冲突</span>
          <h2 id="conflict-title">这个项目在另一个标签页里被改过</h2>
          <p>
            两边从同一个版本各自修改，内容已经对不上。系统没有覆盖任何一边——请确认以哪一份继续，
            选择后两个标签页会自动收敛到同一份。
          </p>
        </div>

        <div className="conflict-cards">
          <section className="conflict-card local">
            <header>
              <div>
                <span className="conflict-side-label">本标签页</span>
                <strong>{conflict.localChanged ? '你在这里的未保存改动' : '本页内容（未改动）'}</strong>
              </div>
              <span className="conflict-time">最后编辑 {formatTimestamp(conflict.localTimestamp)}</span>
            </header>
            <ChangeList lines={conflict.localChanges} />
            <footer>
              <button className="conflict-primary" onClick={() => viewModel.resolveUseLocal()}>
                {remoteDeleted ? '用本页内容恢复项目' : '保留本页这一份'}
              </button>
              <span className="conflict-hint">
                {remoteDeleted
                  ? '把本页草稿重新写回存储，对面删除动作被撤回'
                  : '对面随后会自动同步到这一份'}
              </span>
            </footer>
          </section>

          <div className="conflict-versus" aria-hidden="true">VS</div>

          <section className={`conflict-card remote${conflict.remoteNewer ? ' newer' : ''}`}>
            <header>
              <div>
                <span className="conflict-side-label">
                  另一标签页
                  {conflict.remoteNewer && remoteReadable && <em className="newer-badge">更新</em>}
                </span>
                <strong>
                  {remoteDeleted ? '项目已被那边删除' : remoteCorrupt ? '那边的内容无法读取' : '对面保存的版本'}
                </strong>
              </div>
              <span className="conflict-time">
                {remoteReadable && !remoteDeleted ? `保存于 ${formatTimestamp(conflict.remoteTimestamp)}` : '存储中已不存在'}
              </span>
            </header>
            <ChangeList lines={conflict.remoteChanges} />
            <footer>
              <button
                className="conflict-primary ghost"
                onClick={() => viewModel.resolveUseRemote()}
                disabled={!remoteReadable}
              >
                {remoteDeleted ? '接受删除，放弃本页改动' : remoteCorrupt ? '对面不可读，无法采用' : '采用对面这一份'}
              </button>
              <span className="conflict-hint">
                {remoteReadable
                  ? (remoteDeleted
                      ? '本页进入已删除状态，删除前内容仍可在本次会话恢复'
                      : conflict.remoteNewer ? '这一份的保存时间更晚' : '本页改动将被对面的版本替换')
                  : '只能选择用本页内容恢复'}
              </span>
            </footer>
          </section>
        </div>

        <p className="conflict-foot-note">
          判断基于内容指纹而非保存时间：时间只用于提示哪边更新，即使两边时间戳相同或顺序相近，
          只要内容结构不同就会被识别为冲突。
        </p>
      </div>
    </div>
  );
}
