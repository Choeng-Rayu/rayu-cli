import { useEffect, useMemo, useState } from 'react'

import type {
  McpServerView,
  McpConnectionUiView,
  RuntimeAgentView,
  RuntimeCommandView,
  RuntimePluginView,
  RuntimeSkillView,
  RuntimeSectionView,
  RuntimeToolView,
} from '../../shared/webviewProtocol.js'

export function RuntimeCenter({
  initialSection,
  commands,
  tools,
  mcpServers,
  mcpConnectionUi,
  agents,
  plugins,
  skills,
  workflows,
  onClose,
  onUseCommand,
  onRefreshMcp,
  onReconnectMcp,
  onToggleMcp,
  onAuthenticateMcp,
  onClearMcpAuth,
  onPasteMcpCallback,
}: {
  initialSection: RuntimeSectionView
  commands: RuntimeCommandView[]
  tools: RuntimeToolView[]
  mcpServers: McpServerView[]
  mcpConnectionUi: McpConnectionUiView
  agents: RuntimeAgentView[]
  plugins: RuntimePluginView[]
  skills: RuntimeSkillView[]
  workflows: RuntimeSkillView[]
  onClose: () => void
  onUseCommand: (name: string) => void
  onRefreshMcp: () => void
  onReconnectMcp: (serverName: string) => void
  onToggleMcp: (serverName: string, enabled: boolean) => void
  onAuthenticateMcp: (serverName: string) => void
  onClearMcpAuth: (serverName: string) => void
  onPasteMcpCallback: (serverName: string) => void
}): JSX.Element {
  const [tab, setTab] = useState<RuntimeSectionView>(initialSection)
  const [query, setQuery] = useState('')
  useEffect(() => {
    if (tab === 'mcp') onRefreshMcp()
  }, [tab, onRefreshMcp])
  const needle = query.trim().toLowerCase()
  const matches = (parts: Array<string | undefined>) =>
    !needle || parts.some(part => part?.toLowerCase().includes(needle))

  const counts = useMemo(() => ({
    commands: commands.length,
    tools: tools.length,
    mcp: mcpServers.length,
    // `skills` is the complete catalogue and already contains workflow entries.
    skills: skills.length,
    agents: agents.length,
    plugins: plugins.length,
  }), [commands, tools, mcpServers, skills, workflows, agents, plugins])

  return (
    <section id="rayucode-runtime-center" className="rc-runtime-center" aria-label="Rayu runtime">
      <header className="rc-runtime-center-head">
        <div>
          <strong>Rayu runtime</strong>
          <div className="rc-runtime-center-subtitle">
            Shared commands, tools, MCP, skills, agents, and plugins
          </div>
        </div>
        <button type="button" className="rc-text-button" onClick={onClose} aria-label="Close runtime center">
          Close
        </button>
      </header>

      <div className="rc-runtime-tabs" role="tablist" aria-label="Runtime resources">
        {(Object.keys(counts) as RuntimeSectionView[]).map(item => (
          <button
            type="button"
            role="tab"
            aria-selected={tab === item}
            className={`rc-runtime-tab${tab === item ? ' rc-runtime-tab-active' : ''}`}
            key={item}
            onClick={() => setTab(item)}
          >
            {title(item)} <span>{counts[item]}</span>
          </button>
        ))}
      </div>

      <label className="rc-runtime-search">
        <span className="rc-sr-only">Search runtime resources</span>
        <input
          type="search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder={`Search ${title(tab).toLowerCase()}…`}
        />
      </label>

      <div className="rc-runtime-list" role="tabpanel">
        {tab === 'commands' ? commands
          .filter(command => matches([command.name, command.description, command.origin]))
          .map(command => (
            <RuntimeRow
              key={command.name}
              title={`/${command.name}`}
              detail={command.description}
              meta={`${command.origin} · ${surfaceLabel(command)}`}
              disabled={!command.available}
              disabledReason={command.unavailableReason}
              onActivate={() => onUseCommand(command.name)}
            />
          )) : null}

        {tab === 'tools' ? tools
          .filter(tool => matches([tool.name, tool.source, tool.serverName]))
          .map(tool => (
            <RuntimeRow
              key={`${tool.source}:${tool.serverName ?? ''}:${tool.name}`}
              title={tool.name}
              detail={tool.serverName ? `Provided by ${tool.serverName}` : undefined}
              meta={[tool.source, tool.deferred ? 'deferred' : '', tool.requiresUserInteraction ? 'interactive' : ''].filter(Boolean).join(' · ')}
            />
          )) : null}

        {tab === 'mcp' ? (
          <>
            <div className="rc-runtime-list-actions">
              <button type="button" className="rc-text-button" onClick={onRefreshMcp}>Refresh connections</button>
            </div>
            {mcpConnectionUi.load === 'loading' ? (
              <p className="rc-runtime-mcp-state" role="status">Checking MCP connections…</p>
            ) : null}
            {mcpConnectionUi.load === 'idle' ? (
              <p className="rc-runtime-mcp-state" role="status">Loading MCP connections…</p>
            ) : null}
            {mcpConnectionUi.load === 'error' ? (
              <div className="rc-runtime-mcp-state" role="alert">
                Could not check MCP connections: {mcpConnectionUi.error ?? 'Unknown error.'}
                <button type="button" className="rc-text-button" onClick={onRefreshMcp}>Retry</button>
              </div>
            ) : null}
            {mcpConnectionUi.auth ? (
              <div className="rc-runtime-mcp-state" role="status">
                <strong>{mcpConnectionUi.auth.serverName}</strong>: {authStageLabel(mcpConnectionUi.auth.stage)}
                {mcpConnectionUi.auth.message ? <p>{mcpConnectionUi.auth.message}</p> : null}
                {mcpConnectionUi.auth.stage === 'waiting' || mcpConnectionUi.auth.stage === 'error' ? (
                  <button type="button" className="rc-text-button" onClick={() => onPasteMcpCallback(mcpConnectionUi.auth!.serverName)}>
                    Paste redirect URL
                  </button>
                ) : null}
                {mcpConnectionUi.auth.stage === 'error' ? (
                  <button type="button" className="rc-text-button" onClick={() => onAuthenticateMcp(mcpConnectionUi.auth!.serverName)}>
                    Retry authentication
                  </button>
                ) : null}
              </div>
            ) : null}
            {mcpConnectionUi.load === 'ready' && mcpServers.length === 0 ? (
              <p className="rc-runtime-mcp-state">No MCP servers are connected in this session.</p>
            ) : null}
            {mcpServers.filter(server => matches([server.name, server.status, server.error])).map(server => (
              <RuntimeRow
                key={server.name}
                title={server.name}
                detail={server.error}
                meta={server.status}
                actions={
                  <>
                    {server.status === 'needs-auth' ? (
                      <button type="button" className="rc-text-button" onClick={() => onAuthenticateMcp(server.name)}>Authenticate</button>
                    ) : server.status !== 'connected' && server.status !== 'disabled' ? (
                      <button type="button" className="rc-text-button" onClick={() => onReconnectMcp(server.name)}>Reconnect</button>
                    ) : null}
                    {server.status === 'connected' && server.supportsOAuth ? (
                      <button type="button" className="rc-text-button" onClick={() => onClearMcpAuth(server.name)}>Clear auth</button>
                    ) : null}
                    <button
                      type="button"
                      className="rc-text-button"
                      onClick={() => onToggleMcp(server.name, server.status === 'disabled')}
                    >
                      {server.status === 'disabled' ? 'Enable' : 'Disable'}
                    </button>
                  </>
                }
              />
            ))}
          </>
        ) : null}

        {tab === 'skills' ? [...workflows, ...skills.filter(skill => !skill.workflow)]
          .filter(skill => matches([skill.name, skill.description, skill.source]))
          .map(skill => (
            <RuntimeRow
              key={`${skill.workflow ? 'workflow' : 'skill'}:${skill.source}:${skill.name}`}
              title={`/${skill.name}`}
              detail={skill.description}
              meta={`${skill.workflow ? 'workflow' : 'skill'} · ${skill.source}`}
              onActivate={() => onUseCommand(skill.name)}
            />
          )) : null}

        {tab === 'agents' ? agents
          .filter(agent => matches([agent.name, agent.description, agent.source, agent.model]))
          .map(agent => (
            <RuntimeRow
              key={`${agent.source}:${agent.name}`}
              title={agent.name}
              detail={agent.description}
              meta={[agent.source, agent.model, agent.background ? 'background' : 'foreground'].filter(Boolean).join(' · ')}
            />
          )) : null}

        {tab === 'plugins' ? plugins
          .filter(plugin => matches([plugin.name, plugin.description, plugin.source]))
          .map(plugin => (
            <RuntimeRow
              key={`${plugin.source}:${plugin.name}`}
              title={plugin.name}
              detail={plugin.description}
              meta={[plugin.enabled ? 'enabled' : 'disabled', plugin.version, ...plugin.components].filter(Boolean).join(' · ')}
            />
          )) : null}
      </div>
    </section>
  )
}

function authStageLabel(stage: NonNullable<McpConnectionUiView['auth']>['stage']): string {
  switch (stage) {
    case 'opening': return 'Opening browser authorization…'
    case 'waiting': return 'Waiting for browser authorization…'
    case 'finishing': return 'Finishing authentication…'
    case 'connected': return 'Connected.'
    case 'error': return 'Connection needs attention.'
  }
}

function RuntimeRow({
  title: rowTitle,
  detail,
  meta,
  disabled = false,
  disabledReason,
  onActivate,
  actions,
}: {
  title: string
  detail?: string
  meta?: string
  disabled?: boolean
  disabledReason?: string
  onActivate?: () => void
  actions?: JSX.Element
}): JSX.Element {
  return (
    <article className={`rc-runtime-row${disabled ? ' rc-runtime-row-disabled' : ''}`}>
      <div className="rc-runtime-row-copy">
        {onActivate && !disabled ? (
          <button type="button" className="rc-runtime-row-title" onClick={onActivate}>{rowTitle}</button>
        ) : <strong className="rc-runtime-row-title-static">{rowTitle}</strong>}
        {detail ? <div className="rc-runtime-row-detail">{detail}</div> : null}
        <div className="rc-runtime-row-meta">{disabledReason ?? meta}</div>
      </div>
      {actions ? <div className="rc-runtime-row-actions">{actions}</div> : null}
    </article>
  )
}

function title(tab: RuntimeSectionView): string {
  return tab === 'mcp' ? 'MCP' : tab[0]!.toUpperCase() + tab.slice(1)
}

function surfaceLabel(command: RuntimeCommandView): string {
  if (!command.available) return 'unavailable'
  if (command.surface === 'prompt') return command.workflow ? 'workflow' : 'prompt'
  if (command.surface === 'panel') return 'Rayucode panel'
  return command.surface === 'terminal_only' ? 'terminal only' : 'direct action'
}
