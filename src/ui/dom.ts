/** 极简 DOM 构建辅助，避免引入框架。 */
type HProps<K extends keyof HTMLElementTagNameMap> =
  & Partial<Omit<HTMLElementTagNameMap[K], 'style' | 'dataset'>>
  & {
    class?: string;
    style?: string | Partial<CSSStyleDeclaration>;
    dataset?: Record<string, string>;
  };

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: HProps<K> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    if (k === 'dataset') {
      Object.assign(el.dataset, v);
    } else if (k === 'class') {
      el.className = v as string;
    } else if (k === 'style' && typeof v === 'string') {
      el.setAttribute('style', v);
    } else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else {
      (el as unknown as Record<string, unknown>)[k] = v;
    }
  }
  for (const child of children) {
    el.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

export function mount(node: HTMLElement, parent: HTMLElement = document.getElementById('app')!): void {
  parent.replaceChildren(node);
}
