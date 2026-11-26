// Trusted editor guide for the authenticated Streamable HTTP endpoint.
// Clients connect through the one-click server-side writer; live config status is inspected without modification.
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { editorBootstrapInfo } from '../../agent/editor-credential';
import { useExternalAutoApprove } from '../../agent/external-auto-approve';
import { theme, themeAlpha } from '../../theme';
import { useT } from '../../i18n/locale';
import { Icon } from '../icons';
import claudeSvg from '../../../assets/vendor-icons/claude-color.svg?raw';
import codexPng from '../../../assets/vendor-icons/codex-color.png';
import cursorPng from '../../../assets/vendor-icons/cursor-color.png';
import antigravityPng from '../../../assets/vendor-icons/antigravity-color.png';

type ClientId = 'claude' | 'codex' | 'cursor' | 'antigravity';
type ClientConnectionStatus = 'connected' | 'outdated' | 'not-configured' | 'invalid-config';

interface ClientStatusEntry {
  client: ClientId;
  status: ClientConnectionStatus;
  path: string;
}

interface ClientSnippet {
  client: ClientId;
  logo: ReactElement;
  name: string;
  desc: string;
}

function clientSnippets(): ClientSnippet[] {
  return [
    {
      client: 'claude',
      logo: <span aria-hidden className="cc-vendor-icon" style={{ color: '#d97757', width: 26, height: 26, fontSize: 26, display: 'inline-flex' }} dangerouslySetInnerHTML={{ __html: claudeSvg }} />,
      name: 'Claude Code',
      desc: '写入 ~/.claude.json，支持一键直连。',
    },
    {
      client: 'codex',
      logo: <ClientLogo src={codexPng} alt="Codex" />,
      name: 'Codex',
      desc: '写入 ~/.codex/config.toml 并同步环境变量。',
    },
    {
      client: 'cursor',
      logo: <ClientLogo src={cursorPng} alt="Cursor" />,
      name: 'Cursor',
      desc: '写入 ~/.cursor/mcp.json 全局配置。',
    },
    {
      client: 'antigravity',
      logo: <ClientLogo src={antigravityPng} alt="Antigravity" />,
      name: 'Antigravity',
      desc: '写入 ~/.gemini/antigravity/mcp_config.json。',
    },
  ];
}

function ClientLogo({ src, alt }: { src: string; alt: string }) {
  return (
    <img
      src={src}
      alt={alt}
      aria-hidden
      style={{ width: 26, height: 26, borderRadius: 6, objectFit: 'contain', flex: '0 0 auto', background: theme.panel, border: `0.5px solid ${theme.borderLight}` }}
    />
  );
}

function connectErrorMessage(t: ReturnType<typeof useT>, error: string): string {
  if (error === 'config-parse-error') return t('目标配置文件不是有效 JSON，为避免覆盖未写入。');
  if (error === 'config-write-error') return t('写入配置文件失败。');
  if (error === 'codex-cli-failed') return t('执行 codex mcp add 失败。');
  return t('连接失败');
}

function StatusBadge({ status, loading }: { status?: ClientConnectionStatus; loading?: boolean }) {
  const t = useT();
  if (loading && !status) {
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          padding: '2px 8px',
          borderRadius: 999,
          fontSize: 11,
          fontWeight: 550,
          background: theme.panel,
          color: theme.textDim,
          border: `1px solid ${theme.border}`,
        }}
      >
        {t('检测中…')}
      </span>
    );
  }
  const effective: ClientConnectionStatus = status ?? 'not-configured';
  const isConnected = effective === 'connected';
  const isOutdated = effective === 'outdated';
  const isInvalid = effective === 'invalid-config';
  const label = isConnected
    ? t('已连接')
    : isInvalid
      ? t('配置异常')
      : isOutdated
        ? t('配置已过期')
        : t('未连接');
  const color = isConnected
    ? theme.success
    : isInvalid
      ? theme.danger
      : isOutdated
        ? theme.gold
        : theme.textDim;
  const background = isConnected
    ? 'color-mix(in srgb, var(--cc-success) 16%, transparent)'
    : isInvalid
      ? 'color-mix(in srgb, var(--cc-danger) 15%, transparent)'
      : isOutdated
        ? 'color-mix(in srgb, var(--cc-gold) 15%, transparent)'
        : theme.panel;
  const borderColor = isConnected
    ? 'color-mix(in srgb, var(--cc-success) 45%, transparent)'
    : isInvalid
      ? 'color-mix(in srgb, var(--cc-danger) 45%, transparent)'
      : isOutdated
        ? 'color-mix(in srgb, var(--cc-gold) 45%, transparent)'
        : theme.border;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        background,
        color,
        border: `1px solid ${borderColor}`,
      }}
    >
      {isConnected && <Icon name="check" size={11} strokeWidth={2.4} />}
      {label}
    </span>
  );
}

function ConnectButton({
  client,
  existingStatus,
  onStatus,
  onConnected,
}: {
  client: ClientId;
  existingStatus?: ClientConnectionStatus;
  onStatus: (message: string, ok: boolean) => void;
  onConnected: () => void;
}) {
  const t = useT();
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  useEffect(() => {
    if (state !== 'done') return;
    const timer = window.setTimeout(() => setState('idle'), 3500);
    return () => window.clearTimeout(timer);
  }, [state]);
  const busy = state === 'busy';
  const isConnected = existingStatus === 'connected';
  const needsUpdate = existingStatus === 'outdated' || existingStatus === 'invalid-config';
  const idleLabel = isConnected
    ? t('重新写入')
    : needsUpdate
      ? t('更新配置')
      : t('立即连接');
  const label = busy
    ? t('写入中…')
    : state === 'done'
      ? t('连接成功')
      : state === 'error'
        ? t('重试连接')
        : idleLabel;
  const isQuietSecondary = state === 'idle' && isConnected;
  const background = state === 'done'
    ? 'color-mix(in srgb, var(--cc-success) 18%, var(--cc-panel))'
    : state === 'error'
      ? theme.hover
      : isQuietSecondary
        ? theme.panel
        : `linear-gradient(135deg, ${theme.accent}, ${theme.accentDeep})`;
  const border = state === 'done'
    ? '1px solid color-mix(in srgb, var(--cc-success) 55%, transparent)'
    : state === 'error'
      ? '1px solid color-mix(in srgb, var(--cc-danger) 55%, transparent)'
      : isQuietSecondary
        ? `1px solid ${theme.borderLight}`
        : '1px solid transparent';
  const color = state === 'done'
    ? theme.success
    : state === 'error'
      ? theme.danger
      : isQuietSecondary
        ? theme.textMuted
        : theme.onAccent;
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setState('busy');
        onStatus('', true);
        void fetch('/api/external-agent/connect-client', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client }),
        })
          .then(async (response) => {
            const data: unknown = await response.json().catch(() => null);
            const result = data as { ok?: boolean; paths?: string[]; error?: string } | null;
            if (response.ok && result?.ok) {
              setState('done');
              const paths = (result.paths ?? []).join('、');
              onStatus(
                t(
                  client === 'codex'
                    ? '配置已写入（{paths}），新开终端生效'
                    : '配置已写入（{paths}），重启客户端生效',
                  { paths },
                ),
                true,
              );
              onConnected();
            } else {
              setState('error');
              onStatus(connectErrorMessage(t, result?.error ?? ''), false);
            }
          })
          .catch(() => {
            setState('error');
            onStatus(connectErrorMessage(t, ''), false);
          });
      }}
      style={{
        flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '6px 13px', border, borderRadius: 999,
        background,
        boxShadow: isQuietSecondary || state === 'error' || state === 'done' ? 'none' : `0 2px 8px ${themeAlpha.shadow(0.25)}`,
        color,
        fontSize: 12, fontWeight: 600, cursor: busy ? 'default' : 'pointer',
        opacity: busy ? 0.7 : 1,
      }}
    >
      <Icon name={state === 'done' ? 'check' : 'plug'} size={state === 'done' ? 12 : 11} />
      {label}
    </button>
  );
}

const cardStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 8,
  background: theme.panelAlt, border: `1px solid ${theme.border}`,
  borderRadius: 12, padding: '12px 14px',
};

const endpointStyle: React.CSSProperties = {
  margin: 0, padding: '8px 11px', border: 'none', borderRadius: 10,
  background: theme.inset, color: theme.textMuted, fontSize: 11.5, lineHeight: 1.5,
  fontFamily: 'Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace',
  whiteSpace: 'nowrap', overflowX: 'auto', userSelect: 'text',
};

export function McpGuideContent({ showAutoApprove = true }: { showAutoApprove?: boolean }) {
  const t = useT();
  const [autoApproveExternal, setAutoApproveExternal] = useExternalAutoApprove();
  const fallbackEndpoint = `${window.location.origin}/api/external-mcp/mcp`;
  const [mcpToken, setMcpToken] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState(false);
  const [endpoint, setEndpoint] = useState(fallbackEndpoint);
  const [discoveryPath, setDiscoveryPath] = useState('~/.openchatcut/discovery.json');
  const [clientStatuses, setClientStatuses] = useState<Partial<Record<ClientId, ClientConnectionStatus>>>({});
  const [statusLoading, setStatusLoading] = useState(true);
  const [connectStatus, setConnectStatus] = useState<Record<string, { message: string; ok: boolean }>>({});

  const refreshClientStatus = useCallback(() => {
    void fetch('/api/external-agent/client-status')
      .then(async (response) => {
        if (!response.ok) return;
        const data = (await response.json().catch(() => null)) as {
          ok?: boolean;
          endpoint?: string;
          discoveryPath?: string;
          clients?: ClientStatusEntry[];
        } | null;
        if (!data?.ok) return;
        if (typeof data.endpoint === 'string' && data.endpoint) setEndpoint(data.endpoint);
        if (typeof data.discoveryPath === 'string' && data.discoveryPath) setDiscoveryPath(data.discoveryPath);
        if (Array.isArray(data.clients)) {
          const next: Partial<Record<ClientId, ClientConnectionStatus>> = {};
          for (const entry of data.clients) next[entry.client] = entry.status;
          setClientStatuses(next);
        }
      })
      .catch(() => {})
      .finally(() => setStatusLoading(false));
  }, []);

  useEffect(() => {
    let active = true;
    void editorBootstrapInfo().then(
      (info) => {
        if (!active) return;
        setMcpToken(info.mcpToken);
        refreshClientStatus();
      },
      () => {
        if (!active) return;
        setTokenError(true);
        setStatusLoading(false);
      },
    );
    return () => { active = false; };
  }, [refreshClientStatus]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>{t('端点地址')}</span>
          <span style={{ color: theme.textMuted, fontSize: 11 }}>{t('自动发现文件：{path}', { path: discoveryPath })}</span>
        </div>
        <pre style={endpointStyle}>{endpoint}</pre>
      </div>

      {showAutoApprove && (
        <label style={{ ...cardStyle, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14, cursor: 'pointer' }}>
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <strong style={{ fontSize: 12.5 }}>{t('自动允许所有外部操作（免反复确认）')}</strong>
            <span style={{ color: theme.textMuted, fontSize: 11.5, lineHeight: 1.45 }}>
              {t('开启后，外部客户端的工程修改与工具调用将直接生效，不再逐步提示确认。')}
            </span>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="cc-switch"
            checked={autoApproveExternal}
            onChange={(event) => setAutoApproveExternal(event.target.checked)}
            aria-label={t('自动允许所有外部操作')}
          />
        </label>
      )}

      {mcpToken ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {clientSnippets().map((snippet) => {
            const status = clientStatuses[snippet.client];
            const isConnected = status === 'connected';
            return (
              <div
                key={snippet.name}
                style={{
                  ...cardStyle,
                  border: isConnected
                    ? '1px solid color-mix(in srgb, var(--cc-success) 32%, var(--cc-border))'
                    : `1px solid ${theme.border}`,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {snippet.logo}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{snippet.name}</span>
                      <StatusBadge status={status} loading={statusLoading} />
                    </div>
                    <span style={{ color: theme.textMuted, fontSize: 11.5 }}>{t(snippet.desc)}</span>
                  </div>
                  <div style={{ marginLeft: 'auto' }}>
                    <ConnectButton
                      client={snippet.client}
                      existingStatus={status}
                      onStatus={(message, ok) => setConnectStatus((prev) => ({ ...prev, [snippet.client]: { message, ok } }))}
                      onConnected={refreshClientStatus}
                    />
                  </div>
                </div>
                {connectStatus[snippet.client]?.message ? (
                  <div style={{ color: connectStatus[snippet.client].ok ? theme.success : theme.danger, fontSize: 11.5 }}>
                    {connectStatus[snippet.client].message}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ color: tokenError ? theme.danger : theme.textMuted, fontSize: 12 }}>
          {tokenError ? t('无法读取 MCP 连接令牌，请从受信任的编辑器窗口重试。') : t('正在读取 MCP 连接令牌…')}
        </div>
      )}
    </div>
  );
}

export function McpGuideDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const dialog = (
    <div className="cc-modal-backdrop" onPointerDown={onClose}>
      <div
        className="cc-modal"
        style={{ width: 600, gap: 12, maxHeight: 'calc(100vh - 64px)', overflowY: 'auto' }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            aria-hidden
            style={{
              width: 36, height: 36, borderRadius: 10, flex: '0 0 auto',
              background: `linear-gradient(135deg, ${theme.accent}, ${theme.accentDeep})`,
              boxShadow: `0 4px 12px ${themeAlpha.shadow(0.35)}`,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: theme.onAccent,
            }}
          >
            <Icon name="plug" size={18} />
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <strong style={{ fontSize: 14 }}>{t('外部 Agent 接入 (MCP)')}</strong>
            <span style={{ color: theme.textMuted, fontSize: 11.5 }}>
              {t('Streamable HTTP · 一键写入主流客户端配置')}
            </span>
          </div>
          <button type="button" onClick={onClose} style={{ marginLeft: 'auto', padding: '5px 14px', borderRadius: 999 }}>{t('关闭')}</button>
        </div>

        <McpGuideContent showAutoApprove />
      </div>
    </div>
  );
  return typeof document !== 'undefined' ? createPortal(dialog, document.body) : dialog;
}
