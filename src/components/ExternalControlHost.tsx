import { useEffect, type ReactNode } from 'react';
import type { AgentContext } from '../agent/context';
import { useExternalAgentBridge } from '../agent/useExternalAgentBridge';
import type { TimelineState } from '../editor/types';
import { useT } from '../i18n/locale';
import { ExternalProposalCard } from './chat/ExternalProposalCard';

export function ExternalControlDock({ visible, children }: { visible: boolean; children: ReactNode }) {
  const t = useT();
  if (!visible) return null;
  return <section className="cc-external-control-dock" aria-label={t('外部控制确认')}>
    <div className="cc-external-control-heading"><strong>{t('外部操作确认')}</strong><span>{t('先查看修改，再决定是否应用。')}</span></div>
    <div className="cc-external-control-body">{children}</div>
  </section>;
}

/** External MCP control belongs to the editor, not to an embedded AI chat. */
export function ExternalControlHost({ ctx, projectId, onPreviewState }: {
  ctx: AgentContext;
  projectId: string;
  onPreviewState: (state: TimelineState | null) => void;
}) {
  const external = useExternalAgentBridge(ctx, projectId);
  useEffect(() => {
    if (!external.proposal) onPreviewState(null);
  }, [external.proposal, onPreviewState]);
  const visible = Boolean(external.error || external.proposal || external.pendingGuard);
  return (
    <ExternalControlDock visible={visible}>
      <ExternalProposalCard external={external} onPreviewState={onPreviewState} />
    </ExternalControlDock>
  );
}
