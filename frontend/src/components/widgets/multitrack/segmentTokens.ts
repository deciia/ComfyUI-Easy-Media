import type { ProjectResource } from './agentStore'

export interface BoundToken {
  id: string
  type: 'Subject' | 'Picture' | 'Audio' | 'Video'
  token: string
  name: string
  /** 子资源来自哪个主体 */
  via?: string
  resource: ProjectResource
}

const hasPictureFile = (resource: ProjectResource) => Boolean(String(resource.imageFile ?? '').trim())

/**
 * 绑定清单 → 令牌（唯一实现，Modal 与 AgentRail 共用）。
 *
 * 规则：
 * - 每个绑定的 Subject 先占 <Subject n>，它的子资源紧随其后按「图片→音频→视频」各自编号；
 * - 只有带文件的 Picture 才占 <Picture n>，与 imagesFromBoundIds 提交给工作流的 images 顺序一致，
 *   保证「提示词里的 <Picture 2>」就是「工作流里的第 2 张图」；
 * - 直接绑定的 Picture/Audio/Video 也按同一计数器编号。
 */
export function resolveBoundTokens(boundIds: string[], pool: ProjectResource[]): BoundToken[] {
  const byId = new Map(pool.map((resource) => [resource.id, resource]))
  const counters: Record<string, number> = { Subject: 0, Picture: 0, Audio: 0, Video: 0 }
  const next = (type: 'Subject' | 'Picture' | 'Audio' | 'Video') => {
    counters[type] = (counters[type] ?? 0) + 1
    return `<${type} ${counters[type]}>`
  }
  const out: BoundToken[] = []
  const seen = new Set<string>()
  /** 同一份媒体（同一文件）或同一资源只编号一次：子图与直接绑定重复时不再占两个号 */
  const keyOf = (resource: ProjectResource) =>
    `${resource.type}:${resource.imageFile ?? resource.audioFile ?? resource.videoFile ?? resource.id}`
  const take = (resource: ProjectResource, via?: string) => {
    if (resource.type === 'Subject') {
      if (seen.has(resource.id)) return
      seen.add(resource.id)
      out.push({ id: resource.id, type: 'Subject', token: next('Subject'), name: resource.name, resource })
      return
    }
    if (resource.type !== 'Picture' && resource.type !== 'Audio' && resource.type !== 'Video') return
    if (resource.type === 'Picture' && !hasPictureFile(resource)) return
    const key = keyOf(resource)
    if (seen.has(key)) return
    seen.add(key)
    out.push({ id: resource.id, type: resource.type, token: next(resource.type), name: resource.name, via, resource })
  }

  for (const id of boundIds) {
    const resource = byId.get(id)
    if (!resource) continue
    take(resource)
    if (resource.type !== 'Subject') continue
    for (const childId of resource.childResourceIds ?? []) {
      const child = byId.get(childId)
      if (!child || child.type === 'Subject') continue
      take(child, resource.name)
    }
  }
  return out
}
