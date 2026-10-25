import { Fragment, type ReactNode } from 'react'

/**
 * 轻量 Markdown 渲染（无第三方依赖）：
 * 支持 # 标题、**粗体**、*斜体*、`行内代码`、```代码块```、- / 1. 列表、> 引用、--- 分隔线、[链接](url)
 * 只用于 AI 助手消息气泡，渲染成普通 DOM，不执行 HTML。
 */

const BORDER = 'hsl(var(--border, 240 6% 25%))'
const FIELD_BG = 'hsl(var(--background, 240 10% 8%))'
const PRIMARY = 'hsl(var(--primary, 199 89% 48%))'

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  // 依次匹配 行内代码 / 粗体 / 斜体 / 链接
  const pattern = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  let index = 0
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index))
    const key = `${keyPrefix}-i${index++}`
    if (match[2] !== undefined) {
      // ![alt](url) → 缩略图
      nodes.push(
        <a key={key} href={match[2]} target="_blank" rel="noreferrer" style={{ display: 'inline-block', margin: '2px 4px 2px 0' }}>
          <img
            src={match[2]}
            alt={match[1] || ''}
            style={{ maxWidth: 132, maxHeight: 132, borderRadius: 4, border: `1px solid ${BORDER}`, display: 'block' }}
          />
          {match[1] ? <span style={{ display: 'block', fontSize: 9, opacity: 0.7, maxWidth: 132, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{match[1]}</span> : null}
        </a>,
      )
    } else if (match[3] !== undefined) {
      nodes.push(
        <code key={key} style={{ background: FIELD_BG, border: `1px solid ${BORDER}`, borderRadius: 3, padding: '0 3px' }}>
          {match[3]}
        </code>,
      )
    } else if (match[4] !== undefined) {
      nodes.push(<strong key={key}>{match[4]}</strong>)
    } else if (match[5] !== undefined) {
      nodes.push(<em key={key}>{match[5]}</em>)
    } else if (match[6] !== undefined && match[7] !== undefined) {
      nodes.push(
        <a key={key} href={match[7]} target="_blank" rel="noreferrer" style={{ color: PRIMARY, textDecoration: 'underline' }}>
          {match[6]}
        </a>,
      )
    }
    lastIndex = pattern.lastIndex
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))
  return nodes
}

export function AgentMarkdown({ text }: { text: string }) {
  const lines = String(text ?? '').split('\n')
  const blocks: ReactNode[] = []
  let listBuffer: Array<{ ordered: boolean; depth: number; text: string }> = []
  let codeBuffer: string[] | null = null
  let codeLang = ''

  const flushList = () => {
    if (!listBuffer.length) return
    const items = listBuffer
    listBuffer = []
    blocks.push(
      <ul key={`list-${blocks.length}`} style={{ margin: '2px 0 2px 0', paddingLeft: 16, listStyle: 'none' }}>
        {items.map((item, i) => (
          <li key={`li-${i}`} style={{ display: 'flex', gap: 4, marginLeft: (item.depth - 1) * 10 }}>
            <span style={{ color: PRIMARY, flexShrink: 0 }}>{item.ordered ? `${i + 1}.` : '•'}</span>
            <span style={{ minWidth: 0 }}>{renderInline(item.text, `li-${blocks.length}-${i}`)}</span>
          </li>
        ))}
      </ul>,
    )
  }

  const flushCode = () => {
    if (codeBuffer === null) return
    const body = codeBuffer.join('\n')
    codeBuffer = null
    blocks.push(
      <pre
        key={`code-${blocks.length}`}
        style={{
          background: FIELD_BG,
          border: `1px solid ${BORDER}`,
          borderRadius: 4,
          padding: '4px 6px',
          margin: '3px 0',
          overflowX: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {codeLang ? <div style={{ opacity: 0.6, fontSize: 9, marginBottom: 2 }}>{codeLang}</div> : null}
        <code>{body}</code>
      </pre>,
    )
  }

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    const fence = line.match(/^\s*```(.*)$/)
    if (fence) {
      if (codeBuffer === null) {
        flushList()
        codeBuffer = []
        codeLang = String(fence[1] ?? '').trim()
      } else {
        flushCode()
        codeLang = ''
      }
      continue
    }
    if (codeBuffer !== null) {
      codeBuffer.push(line)
      continue
    }
    if (!line.trim()) {
      flushList()
      blocks.push(<div key={`sp-${blocks.length}`} style={{ height: 4 }} />)
      continue
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    if (heading) {
      flushList()
      const level = heading[1].length
      const size = level <= 2 ? 13 : 12
      blocks.push(
        <div key={`h-${blocks.length}`} style={{ fontSize: size, fontWeight: 600, margin: '4px 0 2px' }}>
          {renderInline(heading[2], `h-${blocks.length}`)}
        </div>,
      )
      continue
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushList()
      blocks.push(<hr key={`hr-${blocks.length}`} style={{ border: 0, borderTop: `1px solid ${BORDER}`, margin: '4px 0' }} />)
      continue
    }
    const quote = line.match(/^\s*>\s?(.*)$/)
    if (quote) {
      flushList()
      blocks.push(
        <div
          key={`q-${blocks.length}`}
          style={{ borderLeft: `2px solid ${BORDER}`, paddingLeft: 6, opacity: 0.85, margin: '2px 0' }}
        >
          {renderInline(quote[1], `q-${blocks.length}`)}
        </div>,
      )
      continue
    }
    const listItem = line.match(/^(\s*)([-*+•]|\d+[.)])\s+(.*)$/)
    if (listItem) {
      const depth = Math.min(3, Math.floor(listItem[1].replace(/\t/g, '  ').length / 2) + 1)
      listBuffer.push({ ordered: /\d/.test(listItem[2]), depth, text: listItem[3] })
      continue
    }
    flushList()
    blocks.push(
      <div key={`p-${blocks.length}`} style={{ margin: '1px 0' }}>
        {renderInline(line, `p-${blocks.length}`)}
      </div>,
    )
  }
  flushList()
  flushCode()

  return <div className="easy-agent-markdown">{blocks.map((block, i) => <Fragment key={`b-${i}`}>{block}</Fragment>)}</div>
}
