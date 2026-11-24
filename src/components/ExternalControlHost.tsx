import { useEffect, type ReactNode } from 'react';
import type { AgentContext } from '../agent/context';
import { useExternalAgentBridge } from '../agent/useExternalAgentBridge';
import type { TimelineState } from '../editor/types';
import { useT } from '../i18n/locale';
import { ExternalProposalCard } from './chat/ExternalProposalCard';

export function ExternalControlDock({ visible, headerAction, children }: { visible: boolean; headerAction?: ReactNode; children: ReactNode }) {
  const t = useT();
  if (!visible) return null;
  return <section className="cc-external-control-dock" aria-label={t('外部控制确认')}>
    <div className="cc-external-control-heading">
      <strong>{t('外部操作确认')}</strong>
      <span>{t('先查看修改，再决定是否应用。')}</span>
      {headerAction}
    </div>
    <div className="cc-external-control-body">{children}</div>
  </section>;
}

/** External MCP control belongs to the editor, not to an embedded AI chat. */
export function ExternalControlHost({ ctx, projectId, onPreviewState }: {
  ctx: AgentContext;
  projectId: string;
  onPreviewState: (state: TimelineState | null) => void;
}) {
  const t = useT();
  const external = useExternalAgentBridge(ctx, projectId);
  useEffect(() => {
    if (!external.proposal) onPreviewState(null);
  }, [external.proposal, onPreviewState]);
  const visible = Boolean(external.error || external.proposal || external.pendingGuard);
  return (
    <ExternalControlDock
      visible={visible}
      headerAction={
        <label className="cc-external-auto-toggle" title={t('开启后，外部客户端发起的操作与修改将直接生效，不再逐步确认')}>
          <span>{t('后续全部自动允许')}</span>
          <input
            type="checkbox"
            role="switch"
            className="cc-switch"
            checked={external.autoApprove}
            onChange={(event) => external.setAutoApprove(event.target.checked)}
            aria-label={t('后续全部自动允许')}
          />
        </label>
      }
    >
      <ExternalProposalCard external={external} onPreviewState={onPreviewState} />
    </ExternalControlDock>
  );
}
