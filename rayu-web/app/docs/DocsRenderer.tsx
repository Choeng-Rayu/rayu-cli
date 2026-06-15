'use client'

import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const markdownComponents = {
  h1: ({ children, ...props }: any) => (
    <h1 style={{
      fontSize: '2.25rem',
      fontWeight: '900',
      fontFamily: 'Orbitron, sans-serif',
      color: '#ffffff',
      marginTop: '1rem',
      marginBottom: '1.5rem',
      borderBottom: '1px solid var(--border)',
      paddingBottom: '0.5rem',
      letterSpacing: '-0.02em',
    }} {...props}>
      {children}
    </h1>
  ),
  h2: ({ children, ...props }: any) => (
    <h2 style={{
      fontSize: '1.6rem',
      fontWeight: '700',
      fontFamily: 'Orbitron, sans-serif',
      color: 'var(--green)',
      marginTop: '2.5rem',
      marginBottom: '1rem',
    }} {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }: any) => (
    <h3 style={{
      fontSize: '1.2rem',
      fontWeight: '600',
      fontFamily: 'Orbitron, sans-serif',
      color: '#ffffff',
      marginTop: '2rem',
      marginBottom: '0.75rem',
    }} {...props}>
      {children}
    </h3>
  ),
  p: ({ children, ...props }: any) => (
    <p style={{
      fontSize: '1rem',
      lineHeight: '1.7',
      color: 'var(--text)',
      marginBottom: '1.25rem',
      fontFamily: 'Inter, sans-serif',
    }} {...props}>
      {children}
    </p>
  ),
  a: ({ children, href, ...props }: any) => {
    // If the link is a relative markdown link, let's rewrite it to point to the correct docs page
    let resolvedHref = href
    if (href && href.endsWith('.md') && !href.startsWith('http')) {
      resolvedHref = `/docs/${href.replace(/\.md$/, '')}`
    }
    return (
      <a
        href={resolvedHref}
        style={{
          color: 'var(--green)',
          textDecoration: 'none',
          borderBottom: '1px dashed var(--green)',
          transition: 'opacity 0.2s ease',
        }}
        onMouseOver={(e) => (e.currentTarget.style.opacity = '0.8')}
        onMouseOut={(e) => (e.currentTarget.style.opacity = '1')}
        {...props}
      >
        {children}
      </a>
    )
  },
  ul: ({ children, ...props }: any) => (
    <ul style={{
      paddingLeft: '1.5rem',
      marginBottom: '1.25rem',
      listStyleType: 'disc',
    }} {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }: any) => (
    <ol style={{
      paddingLeft: '1.5rem',
      marginBottom: '1.25rem',
      listStyleType: 'decimal',
    }} {...props}>
      {children}
    </ol>
  ),
  li: ({ children, ...props }: any) => (
    <li style={{
      marginBottom: '0.5rem',
      color: 'var(--text)',
      fontSize: '1rem',
      lineHeight: '1.6',
    }} {...props}>
      {children}
    </li>
  ),
  code: ({ className, children, ...props }: any) => {
    const match = /language-(\w+)/.exec(className || '')
    const isInline = !match
    const codeString = String(children).replace(/\n$/, '')

    if (isInline) {
      return (
        <code style={{
          fontFamily: 'DM Mono, monospace',
          backgroundColor: 'rgba(255, 255, 255, 0.06)',
          color: 'var(--green)',
          padding: '2px 6px',
          borderRadius: '4px',
          fontSize: '0.9rem',
        }} {...props}>
          {codeString}
        </code>
      )
    }

    return (
      <pre style={{
        backgroundColor: 'var(--bg3)',
        border: '1px solid var(--border)',
        borderRadius: '8px',
        padding: '1.25rem',
        overflowX: 'auto',
        marginBottom: '1.5rem',
      }}>
        <code style={{
          fontFamily: 'DM Mono, monospace',
          color: 'var(--green)',
          fontSize: '0.9rem',
          lineHeight: '1.5',
          backgroundColor: 'transparent',
          padding: 0,
        }} className={className} {...props}>
          {codeString}
        </code>
      </pre>
    )
  },
  table: ({ children, ...props }: any) => (
    <div style={{ overflowX: 'auto', marginBottom: '1.5rem' }}>
      <table style={{
        width: '100%',
        borderCollapse: 'separate',
        borderSpacing: 0,
        background: 'var(--bg2)',
        border: '1px solid var(--border)',
        borderRadius: '8px',
        overflow: 'hidden',
      }} {...props}>
        {children}
      </table>
    </div>
  ),
  thead: ({ children, ...props }: any) => (
    <thead style={{
      background: 'var(--bg3)',
    }} {...props}>
      {children}
    </thead>
  ),
  tbody: ({ children, ...props }: any) => (
    <tbody {...props}>
      {children}
    </tbody>
  ),
  tr: ({ children, ...props }: any) => (
    <tr style={{
      borderBottom: '1px solid var(--border)',
    }} {...props}>
      {children}
    </tr>
  ),
  th: ({ children, ...props }: any) => (
    <th style={{
      padding: '0.75rem 1rem',
      textAlign: 'left',
      color: 'var(--text)',
      fontFamily: 'Orbitron, sans-serif',
      fontSize: '0.8rem',
      letterSpacing: '1px',
      fontWeight: '600',
      textTransform: 'uppercase',
      borderBottom: '1px solid var(--border)',
    }} {...props}>
      {children}
    </th>
  ),
  td: ({ children, ...props }: any) => (
    <td style={{
      padding: '0.75rem 1rem',
      fontSize: '0.9rem',
      color: 'var(--text)',
      borderBottom: '1px solid var(--border)',
    }} {...props}>
      {children}
    </td>
  ),
  blockquote: ({ children, ...props }: any) => (
    <blockquote style={{
      borderLeft: '4px solid var(--green)',
      paddingLeft: '1rem',
      marginLeft: 0,
      marginRight: 0,
      marginTop: '1.5rem',
      marginBottom: '1.5rem',
      backgroundColor: 'rgba(0, 255, 136, 0.02)',
      borderRadius: '0 4px 4px 0',
      paddingTop: '0.5rem',
      paddingBottom: '0.5rem',
    }} {...props}>
      {children}
    </blockquote>
  ),
}

export default function DocsRenderer({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {content}
    </ReactMarkdown>
  )
}
