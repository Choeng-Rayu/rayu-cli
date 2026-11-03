import { useMemo, useState } from 'react'

import type { McpElicitationView } from '../../shared/webviewProtocol.js'

export interface McpElicitationStackProps {
  requests: readonly McpElicitationView[]
  onRespond: (
    requestId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>,
  ) => void
  onOpenExternal: (url: string) => void
}

/**
 * One blocking MCP interaction, projected from the shared elicitation protocol.
 * Form values stay in component memory and are sent only in the correlated response.
 */
export function McpElicitationStack({
  requests,
  onRespond,
  onOpenExternal,
}: McpElicitationStackProps): JSX.Element | null {
  const request = requests[0]
  if (!request) return null

  return (
    <div className="rc-approvals">
      {request.mode === 'url' ? (
        <UrlElicitation
          key={request.requestId}
          request={request}
          onRespond={onRespond}
          onOpenExternal={onOpenExternal}
        />
      ) : (
        <FormElicitation
          key={request.requestId}
          request={request}
          onRespond={onRespond}
        />
      )}
      {requests.length > 1 ? (
        <p className="rc-approvals-more" role="status">
          {requests.length - 1} more MCP {requests.length === 2 ? 'request' : 'requests'} waiting
        </p>
      ) : null}
    </div>
  )
}

function UrlElicitation({
  request,
  onRespond,
  onOpenExternal,
}: {
  request: McpElicitationView
  onRespond: McpElicitationStackProps['onRespond']
  onOpenExternal: (url: string) => void
}): JSX.Element {
  return (
    <section
      className="rc-permission rc-question-card"
      role="alertdialog"
      aria-label={`${request.serverName} requests browser interaction`}
    >
      <header className="rc-permission-head">
        <span className="rc-permission-title">{request.serverName} requests your input</span>
      </header>
      <p className="rc-permission-body">{request.message}</p>
      {request.url ? <code className="rc-permission-label">{safeDisplayUrl(request.url)}</code> : null}
      <div className="rc-permission-actions">
        <button
          type="button"
          className="rc-button"
          onClick={() => onRespond(request.requestId, 'decline')}
        >
          Decline
        </button>
        {request.url ? (
          <button
            type="button"
            className="rc-button rc-button-primary"
            onClick={() => {
              onOpenExternal(request.url!)
              onRespond(request.requestId, 'accept')
            }}
          >
            Open in browser
          </button>
        ) : (
          <button
            type="button"
            className="rc-button"
            onClick={() => onRespond(request.requestId, 'cancel')}
          >
            Cancel
          </button>
        )}
      </div>
    </section>
  )
}

function FormElicitation({
  request,
  onRespond,
}: {
  request: McpElicitationView
  onRespond: McpElicitationStackProps['onRespond']
}): JSX.Element {
  const schema = useMemo(() => asRecord(request.requestedSchema) ?? {}, [request.requestedSchema])
  const properties = useMemo(() => asRecord(schema.properties) ?? {}, [schema])
  const required = useMemo(
    () => new Set(Array.isArray(schema.required) ? schema.required.filter(isString) : []),
    [schema],
  )
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(
      Object.entries(properties).flatMap(([name, raw]) => {
        const definition = asRecord(raw)
        return definition && definition.default !== undefined
          ? [[name, definition.default]]
          : []
      }),
    ),
  )

  const missingRequired = [...required].some(name => {
    const value = values[name]
    return value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
  })

  return (
    <form
      className="rc-permission rc-question-card"
      role="alertdialog"
      aria-label={`${request.serverName} requests form input`}
      onSubmit={event => {
        event.preventDefault()
        if (!missingRequired) onRespond(request.requestId, 'accept', values)
      }}
    >
      <header className="rc-permission-head">
        <span className="rc-permission-title">{request.serverName} requests your input</span>
      </header>
      <p className="rc-permission-body">{request.message}</p>

      {Object.entries(properties).map(([name, raw]) => {
        const definition = asRecord(raw) ?? {}
        const title = isString(definition.title) ? definition.title : name
        const description = isString(definition.description) ? definition.description : ''
        const options = Array.isArray(definition.enum) ? definition.enum : null
        const type = isString(definition.type) ? definition.type : 'string'
        const value = values[name]

        return (
          <fieldset className="rc-question" key={name}>
            <legend>
              {title}
              {required.has(name) ? <span className="rc-question-count">Required</span> : null}
            </legend>
            {description ? <p className="rc-permission-body rc-muted">{description}</p> : null}
            {type === 'boolean' ? (
              <label className="rc-question-option">
                <input
                  type="checkbox"
                  checked={value === true}
                  onChange={event => setValues(current => ({
                    ...current,
                    [name]: event.target.checked,
                  }))}
                />
                <span className="rc-question-option-copy">Enabled</span>
              </label>
            ) : options ? (
              <div className="rc-question-options">
                {options.map((option, index) => {
                  const optionValue = primitive(option)
                  return (
                    <label className="rc-question-option" key={`${name}-${index}`}>
                      <input
                        type="radio"
                        name={`${request.requestId}-${name}`}
                        checked={value === optionValue}
                        onChange={() => setValues(current => ({
                          ...current,
                          [name]: optionValue,
                        }))}
                      />
                      <span className="rc-question-option-copy">{String(optionValue)}</span>
                    </label>
                  )
                })}
              </div>
            ) : (
              <label className="rc-question-other">
                <span>{title}</span>
                <input
                  type={isSensitiveField(name, definition) ? 'password' : type === 'number' || type === 'integer' ? 'number' : 'text'}
                  required={required.has(name)}
                  value={typeof value === 'string' || typeof value === 'number' ? value : ''}
                  onChange={event => {
                    const next = type === 'number' || type === 'integer'
                      ? event.target.value === ''
                        ? ''
                        : Number(event.target.value)
                      : event.target.value
                    setValues(current => ({ ...current, [name]: next }))
                  }}
                />
              </label>
            )}
          </fieldset>
        )
      })}

      <div className="rc-permission-actions">
        <button
          type="button"
          className="rc-button"
          onClick={() => onRespond(request.requestId, 'decline')}
        >
          Decline
        </button>
        <button
          type="submit"
          className="rc-button rc-button-primary"
          disabled={missingRequired}
        >
          Submit
        </button>
      </div>
    </form>
  )
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function primitive(value: unknown): string | number | boolean | null {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value
    : null
}

function isSensitiveField(name: string, definition: Record<string, unknown>): boolean {
  const format = isString(definition.format) ? definition.format.toLowerCase() : ''
  return format === 'password' || /(?:password|secret|token|api[_-]?key)/i.test(name)
}

function safeDisplayUrl(raw: string): string {
  try {
    const url = new URL(raw)
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch {
    return raw
  }
}
