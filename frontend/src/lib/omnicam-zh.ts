/**
 * OmniCam 汉化层（运行时，不改 vendored bundle）
 *
 * 原理：OmniCam 的 UI 文案是英文原文渲染到 DOM 的，这里用「英→中」词表
 * 在运行时替换文本节点与常见属性（title/placeholder/aria-label/alt）。
 * OmniCam 升级后只要英文原文不变，词表继续有效。
 *
 * 只处理 OmniCam 的 DOM 子树（oc-* / majoor-omnicam），不影响 ComfyUI 本体。
 */

const ROOT_SELECTOR = [
  '.oc-director-node',
  '.majoor-omnicam',
  '.oc-workbench-window',
  '.oc-workbench-content',
  '.oc-modal-dialog',
  '.oc-modal',
  '.oc-stage',
  '.oc-director',
  '[data-omnicam-root]',
].join(',')

/** 英 → 中 词表（可持续追加；未收录的保持英文） */
import { OMNICAM_ZH_TABLE, OMNICAM_ZH_TABLE_EXTRA, OMNICAM_ZH_TABLE_EXTRA2 } from './omnicam-zh-table'

export const OMNICAM_ZH: Record<string, string> = {
  // ---------- 顶栏 / 菜单 ----------
  'OmniCam Director': 'OmniCam 导演',
  Scene: '场景',
  Viewport: '视口',
  View: '视图',
  Display: '显示',
  Camera: '相机',
  Motion: '运动',
  Shot: '镜头',
  Health: '健康',
  Timeline: '时间轴',
  Graph: '曲线',
  Sequence: '序列',
  Outliner: '大纲',
  Assets: '资产',
  Agent: '助手',
  Settings: '设置',
  Language: '语言',
  'Viewport language': '视口语言',
  'Follow ComfyUI': '跟随 ComfyUI',
  English: '英文',
  Playblast: '预演',
  'OPEN DIRECTOR': '打开导演台',
  'LIVE VIEW': '实时视图',
  '● REC': '● 录制',
  'Record the playblast without opening the editor': '不打开编辑器直接录制预演',
  'Omni Ref (Card + Grid + Depth)': '参考（卡片 + 网格 + 深度）',
  'Guide: Auto': '引导：自动',
  Ready: '就绪',
  READY: '就绪',

  // ---------- 视图类型 ----------
  Perspective: '透视',
  Top: '顶视',
  Front: '前视',
  Right: '右视',
  Left: '左视',
  Bottom: '底视',
  Back: '后视',
  ISO: '等轴',
  Orthographic: '正交',
  'All Views (Full 3D)': '全部视图（完整 3D）',
  Annotation: '标注',
  'Labels: Selected': '标签：选中',
  'Labels: All': '标签：全部',
  'Labels: None': '标签：无',
  'Lockout (Neutral Masking)': '锁定（中性遮罩）',
  'Manual Target': '手动目标',
  Angle: '角度',
  Path: '路径',
  Radar: '雷达',
  Grid: '网格',
  Wireframe: '线框',
  Solid: '实体',

  // ---------- 场景 / 大纲 ----------
  SCENE: '场景',
  CAMERAS: '相机',
  OBJECTS: '物体',
  LIGHTS: '灯光',
  CAMERA: '相机',
  OBJECT: '物体',
  'Add object': '添加物体',
  'Add object (+)': '添加物体 (+)',
  'Add Camera': '添加相机',
  'Add camera': '添加相机',
  'Add asset': '添加资产',
  'Add to scene': '加入场景',
  'Add props': '添加道具',
  'Add reference': '添加参考',
  'Add Audio': '添加音频',
  'Add marker': '添加标记',
  'Add marker at playhead': '在播放头处添加标记',
  'Active camera': '活动相机',
  'Active object': '活动物体',
  'Active playblast camera': '活动预演相机',
  'All cameras': '全部相机',
  'All objects shown': '显示全部物体',
  Hidden: '隐藏',
  Locked: '已锁定',
  Lock: '锁定',
  Unlock: '解锁',
  Search: '搜索',
  Filter: '筛选',
  All: '全部',
  None: '无',
  Subject: '主体',
  'Standing Neutral': '站立中性姿态',

  // ---------- 相机面板 ----------
  LENS: '镜头',
  'Sensor/Gate': '传感器/画幅',
  'Focal Length': '焦距',
  FOV: '视场角',
  'Quick Camera': '快速相机',
  Custom: '自定义',
  Transform: '变换',
  TRANSFORM: '变换',
  Position: '位置',
  'Target XYZ': '目标 XYZ',
  Rotation: '旋转',
  Roll: '滚转',
  'Look At': '看向',
  'Look at': '看向',
  'Manual Target (No Track)': '手动目标（不跟踪）',
  'Aim & track subject': '对准并跟踪主体',
  'Aim at Target Subject': '对准目标主体',
  'Aim Bone': '对准骨骼',
  'Aim at a bone inside the tracked rig instead of its origin': '对准跟踪骨骼内部而非原点',
  'Aim at the whole object': '对准整个物体',
  Key: '关键帧',
  'Key F': '关键帧 F',
  'Add Keyframe (I)': '添加关键帧 (I)',
  'Delete Keyframe': '删除关键帧',
  'Previous Key': '上一个关键帧',
  'Next Key': '下一个关键帧',
  'Previous Frame': '上一帧',
  'Next Frame': '下一帧',
  'First Frame': '第一帧',
  'Last Frame': '最后一帧',
  Play: '播放',
  Pause: '暂停',
  Loop: '循环',
  'Auto-Key': '自动关键帧',
  'Auto-Key: Records moves live while scrubbing/navigating': '自动关键帧：拖拽/移动时实时记录',

  // ---------- 运动 / 镜头 ----------
  MOTION: '运动',
  'Motion Path': '运动路径',
  'Apply camera path preset': '应用相机路径预设',
  'Camera path preset': '相机路径预设',
  'Add camera field': '添加相机通道',
  'Animated cameras': '已动画相机',
  'Animation clip': '动画片段',
  Animation: '动画',
  'Add Key': '添加关键帧',
  'Delete Keys': '删除关键帧',
  'Insert Key': '插入关键帧',
  'Ease': '缓动',
  Linear: '线性',
  'Ease In': '缓入',
  'Ease Out': '缓出',
  'Ease In Out': '缓入缓出',
  'Auto-split shots': '自动分镜',
  'Split into {count} shots': '拆分为 {count} 个镜头',
  'Shot Duration': '镜头时长',
  'Shot List': '镜头列表',

  // ---------- 预演 / 导出 ----------
  'Playblast frame': '预演帧',
  'Playblast outdated (re-record before compiling)': '预演已过期（编译前请重新录制）',
  'Director playblast': '导演台预演',
  Proxy: '代理',
  'Reference Source': '参考来源',
  Encoder: '编码器',
  'WebCodecs': 'WebCodecs',
  'Realtime fallback': '实时回退',
  'Video': '视频',
  'Export': '导出',
  'Import': '导入',
  'Importing {name}...': '正在导入 {name}…',
  'Imported {name}': '已导入 {name}',
  'Import failed': '导入失败',
  'Save': '保存',
  'Save as': '另存为',
  'Copy': '复制',
  'Copied': '已复制',
  'Apply': '应用',
  'Applying...': '正在应用…',
  'Applied.': '已应用。',
  'Cancel': '取消',
  'Close': '关闭',
  'Delete': '删除',
  'Remove': '移除',
  'Reset': '重置',
  'Defaults': '默认值',

  // ---------- 通用 ----------
  'Advanced': '高级',
  'Basic': '基础',
  'Auto': '自动',
  'Auto (node output)': '自动（节点输出）',
  'Enabled': '启用',
  'Disabled': '禁用',
  'Visible': '可见',
  'Invisible': '不可见',
  'Muted': '静音',
  'Solo': '独显',
  'Aligned': '对齐',
  'Aspect Ratio': '宽高比',
  'Frame Rate': '帧率',
  'FPS': '帧率',
  'Duration': '时长',
  'Frames': '帧',
  'Source': '来源',
  'Track': '轨迹',
  'Solve': '解算',
  'Refine': '细化',
  'Select': '选择',
  'Orbit': '环绕',
  'Pan': '平移',
  'Dolly': '推拉',
  'Zoom': '缩放',
  'Move': '移动',
  'Rotate': '旋转',
  'Scale': '缩放',
  'Focus': '聚焦',
  'Frame selected': '框选聚焦',
  'Unsaved changes': '未保存的改动',
  'Layout reset to defaults': '布局已重置为默认',
  'Cannot close Director while a playblast is recording': '录制预演时无法关闭导演台',
  'Language updated — reload the workflow to translate every label.': '语言已更新 — 重新加载工作流后全部文案生效。',
  'OmniCam Help': 'OmniCam 帮助',
  'Context Menu': '右键菜单',
  'No path issues detected': '未检测到轨迹问题',
  'No assets match this filter.': '没有符合筛选条件的资产。',
  'Loading assets...': '正在加载资产…',
  'Missing': '缺失',
  'Outdated': '已过期',
  'Ready to record': '可以开始录制',
  'Recording': '录制中',
  'Rendering': '渲染中',
  'Error': '错误',
  'Warning': '警告',
  'Info': '信息',
}

/** 合并词表：精选条目优先，全量表兜底 */
const TABLE: Record<string, string> = { ...OMNICAM_ZH_TABLE, ...OMNICAM_ZH_TABLE_EXTRA, ...OMNICAM_ZH_TABLE_EXTRA2, ...OMNICAM_ZH }

/** 动态文案规则（英文 → 中文），用于带数字的标签 */
const PATTERNS: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/^Camera (\d+)$/, (m) => `相机 ${m[1]}`],
  [/^Camera (\d+) · Key F(\d+)$/, (m) => `相机 ${m[1]} · 关键帧 F${m[2]}`],
  [/^Key F(\d+)$/, (m) => `关键帧 F${m[1]}`],
  [/^Scene (\d+)$/, (m) => `场景 ${m[1]}`],
  [/^Shot (\d+)$/, (m) => `镜头 ${m[1]}`],
  [/^(\d+) of (\d+)$/, (m) => `${m[1]} / ${m[2]}`],
  [/^Manual Target \(No Tracking\)$/, () => '手动目标（不跟踪）'],
  [/^Manual Target \(No Track\)$/, () => '手动目标（不跟踪）'],
  [/^Track: (.+)$/, (m) => `跟踪：${m[1]}`],
  [/^Aim: (.+)$/, (m) => `对准：${m[1]}`],
  [/^Camera (\d+) · Frame (\d+)$/, (m) => `相机 ${m[1]} · 第 ${m[2]} 帧`],
  [/^Camera (\d+) · (\d+) key · PLAYBLAST$/, (m) => `相机 ${m[1]} · ${m[2]} 个关键帧 · 预演`],
  [/^Camera (\d+) · (\d+) key$/, (m) => `相机 ${m[1]} · ${m[2]} 个关键帧`],
  [/^Camera (\d+) · F(\d+)$/, (m) => `相机 ${m[1]} · F${m[2]}`],
  [/^REC KEY @ F(\d+)$/, (m) => `录制关键帧 @ F${m[1]}`],
  [/^Camera Key @ (\d+)$/, (m) => `相机关键帧 @ ${m[1]}`],
  [/^(\d+) of (\d+) assets$/, (m) => `${m[1]} / ${m[2]} 个资产`],
  [/^(\d+) selected$/, (m) => `已选中 ${m[1]}`],
  [/^· (\d+) key$/, (m) => `· ${m[1]} 个关键帧`],
  [/^🎥 Camera (\d+)$/, (m) => `🎥 相机 ${m[1]}`],
  [/^Frame (\d+)$/, (m) => `第 ${m[1]} 帧`],
  [/^Currently animating camera: (.+)$/, (m) => `当前正在动画的相机：${TABLE[m[1].trim()] ?? m[1].trim()}`],
  [/^Currently animating object: (.+)$/, (m) => `当前正在动画的物体：${TABLE[m[1].trim()] ?? m[1].trim()}`],
  [/^(.+) changes at frame (\d+)$/, (m) => `${TABLE[m[1].trim()] ?? m[1].trim()} 在第 ${m[2]} 帧变化`],
  [/^Target: (.+)$/, (m) => `目标：${m[1]}`],
  [/^VIEW: (.+)$/, (m) => {
    const raw = m[1].trim()
    const titleCase = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase()
    return `视图：${OMNICAM_ZH[raw] ?? OMNICAM_ZH[titleCase] ?? raw}`
  }],
]

export function translateOmniCamText(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null
  const exact = TABLE[text]
  if (exact) return raw.replace(text, exact)
  for (const [pattern, build] of PATTERNS) {
    const match = text.match(pattern)
    if (match) return raw.replace(text, build(match))
  }
  return null
}

const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'] as const

const originalTextNodes = new WeakMap<Text, string>()
const originalAttrs = new WeakMap<Element, Record<string, string>>()
let observer: MutationObserver | null = null
let enabled = false
let scheduled = false
const pending = new Set<Node>()

function insideOmniCam(node: Node): boolean {
  const element = node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement
  if (!element) return false
  if (element.closest('script, style, textarea, pre, code')) return false
  return Boolean(element.closest(ROOT_SELECTOR))
}

function translateTextNode(node: Text): void {
  if (!insideOmniCam(node)) return
  const current = node.nodeValue ?? ''
  const translated = translateOmniCamText(current)
  if (!translated) return
  if (!originalTextNodes.has(node)) originalTextNodes.set(node, current)
  if (current !== translated) node.nodeValue = translated
}

function translateElementAttrs(element: Element): void {
  if (!element.closest(ROOT_SELECTOR)) return
  for (const attr of ATTRS) {
    const value = element.getAttribute(attr)
    if (!value) continue
    const translated = translateOmniCamText(value)
    if (!translated) continue
    const store = originalAttrs.get(element) ?? {}
    if (!(attr in store)) store[attr] = value
    originalAttrs.set(element, store)
    if (value !== translated) element.setAttribute(attr, translated)
  }
}

function processNode(node: Node): void {
  if (node.nodeType === Node.TEXT_NODE) {
    translateTextNode(node as Text)
    return
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return
  const element = node as Element
  if (!element.closest(ROOT_SELECTOR)) return
  translateElementAttrs(element)
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  let current: Node | null = walker.nextNode()
  while (current) {
    if (current.nodeType === Node.TEXT_NODE) translateTextNode(current as Text)
    else translateElementAttrs(current as Element)
    current = walker.nextNode()
  }
}

function flush(): void {
  scheduled = false
  const nodes = Array.from(pending)
  pending.clear()
  for (const node of nodes) processNode(node)
}

function schedule(node: Node): void {
  pending.add(node)
  if (scheduled) return
  scheduled = true
  window.requestAnimationFrame(flush)
}

function onMutations(mutations: MutationRecord[]): void {
  for (const mutation of mutations) {
    if (mutation.type === 'characterData' && mutation.target) schedule(mutation.target)
    if (mutation.type === 'attributes' && mutation.target) schedule(mutation.target)
    for (const node of Array.from(mutation.addedNodes)) schedule(node)
  }
}

/** 对整个文档里现存 OmniCam 子树做一次翻译（首次安装时用） */
function translateExisting(): void {
  const roots = document.querySelectorAll(ROOT_SELECTOR)
  roots.forEach((root) => processNode(root))
}

export function installOmniCamChinese(): void {
  if (typeof window === 'undefined' || enabled) return
  enabled = true
  translateExisting()
  observer = new MutationObserver(onMutations)
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...ATTRS],
  })
}

export function uninstallOmniCamChinese(): void {
  if (!enabled) return
  enabled = false
  observer?.disconnect()
  observer = null
  // 还原文本与属性
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  let current: Node | null = walker.nextNode()
  while (current) {
    if (current.nodeType === Node.TEXT_NODE) {
      const node = current as Text
      const original = originalTextNodes.get(node)
      if (original !== undefined && node.nodeValue !== original) node.nodeValue = original
    } else {
      const element = current as Element
      const store = originalAttrs.get(element)
      if (store) {
        for (const [attr, value] of Object.entries(store)) element.setAttribute(attr, value)
      }
    }
    current = walker.nextNode()
  }
}
