import {
  describeChange,
  keyOf,
  resolveFieldValue,
  type DiffNames,
  type EntityChange,
} from '../models/storyDiff';
import type { ConflictSideView, StoryViewModel } from '../viewmodels/storyViewModel';

interface ConflictDialogProps {
  viewModel: StoryViewModel;
}

export function ConflictDialog({ viewModel }: ConflictDialogProps) {
  const view = viewModel.conflictView;
  if (!view) return null;
  const { conflict, local, remote, overlapKeys, localNames, remoteNames } = view;
  const sameTime = local.updatedAt && remote.updatedAt && local.updatedAt === remote.updatedAt;
  const localNewer =
    local.updatedAt && remote.updatedAt ? new Date(local.updatedAt) > new Date(remote.updatedAt) : false;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
      <div className="conflict-dialog">
        <div className="conflict-header">
          <span className="eyebrow">SYNC CONFLICT / 多标签页冲突</span>
          <h2 id="conflict-title">这个项目在另一个标签页里被改过</h2>
          <p>
            两边从同一个版本分叉，已按实际内容列出各自的改动（共 {local.changeCount + remote.changeCount} 处），
            时间只作参考。请选择以哪一份继续，选择后两个标签页会自动收敛到同一份，未选中的改动将丢失。
          </p>
        </div>

        <div className="conflict-sides">
          <ConflictSide
            badge="本标签页"
            badgeClass="local"
            side={local}
            names={localNames}
            overlapKeys={overlapKeys}
            newerHint={!sameTime && localNewer ? '时间较新' : ''}
          />
          <div className="conflict-versus">VS</div>
          <ConflictSide
            badge="另一个标签页"
            badgeClass="remote"
            side={remote}
            names={remoteNames}
            overlapKeys={overlapKeys}
            newerHint={!sameTime && !localNewer ? '时间较新' : ''}
          />
        </div>

        <div className="conflict-actions">
          <button className="conflict-choose local-action" onClick={() => viewModel.resolveKeepLocal()}>
            {remote.exists ? '用本标签页的内容继续' : '用本标签页的内容恢复项目'}
          </button>
          <button className="conflict-choose remote-action" onClick={() => viewModel.resolveUseRemote()}>
            {remote.exists ? '采用另一个标签页的版本' : '接受删除，本页也清空'}
          </button>
        </div>
        <p className="conflict-foot">
          分歧基点：版本 {conflict.base ? formatRevision(conflict.localBaseRevision) : '（项目尚未保存）'} ·
          另一边当前：{remote.exists ? `版本 ${formatRevision(remote.revision)}` : '已删除'}
        </p>
      </div>
    </div>
  );
}

interface ConflictSideProps {
  badge: string;
  badgeClass: 'local' | 'remote';
  side: ConflictSideView;
  names: DiffNames;
  overlapKeys: Set<string>;
  newerHint: string;
}

function ConflictSide({ badge, badgeClass, side, names, overlapKeys, newerHint }: ConflictSideProps) {
  return (
    <section className={`conflict-side ${badgeClass} ${side.exists ? '' : 'is-deleted'}`}>
      <header>
        <div>
          <span className={`conflict-badge ${badgeClass}`}>{badge}</span>
          {newerHint && <span className="conflict-newer">{newerHint}</span>}
        </div>
        <span className="conflict-meta">
          {side.exists ? `版本 ${formatRevision(side.revision)}` : '项目已删除'}
          {side.updatedAt ? ` · ${formatTime(side.updatedAt)}` : ''}
        </span>
      </header>
      {!side.exists ? (
        <div className="conflict-deleted-note">这一侧把整个项目删除了。</div>
      ) : side.changes.length === 0 ? (
        <div className="conflict-empty">相对共同版本没有改动。</div>
      ) : (
        <ul className="conflict-change-list">
          {side.changes.map((change, index) => (
            <ChangeRow key={`${keyOf(change)}-${index}`} change={change} names={names} contested={overlapKeys.has(keyOf(change))} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ChangeRow({ change, names, contested }: { change: EntityChange; names: DiffNames; contested: boolean }) {
  return (
    <li className={`conflict-change kind-${change.kind}`}>
      <div className="change-head">
        <span className={`change-kind ${change.kind}`}>
          {change.kind === 'added' ? '新增' : change.kind === 'removed' ? '删除' : '修改'}
        </span>
        {contested && <span className="change-contested">⚠ 两边都动了</span>}
        <span>{describeChange(change).replace(/^(新增|删除|修改)/, '')}</span>
      </div>
      {change.kind === 'changed' && (
        <dl className="field-diff">
          {change.fields.map((field) => (
            <div key={field.field} className="field-diff-row">
              <dt>{field.label}</dt>
              <dd>
                <del>{resolveFieldValue(field.field, field.baseValue, names) || '（空）'}</del>
                <span className="field-arrow">→</span>
                <ins>{resolveFieldValue(field.field, field.nextValue, names) || '（空）'}</ins>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

function formatRevision(revision: number | null): string {
  return revision === null ? '未保存' : `#${revision}`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { hour12: false });
}
