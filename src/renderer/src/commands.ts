/**
 * Tiny command bus: each tab registers its handlers, and the global keyboard
 * handler dispatches shortcuts to whichever tab is active — regardless of
 * where focus currently is. A handler may return `false` to say "not handled",
 * letting the key fall through to its default behaviour.
 */
type Handler = () => void | boolean | Promise<void>

export interface TabCommands {
  save?: Handler
  run?: Handler
  runAll?: Handler
  format?: Handler
  refresh?: Handler
  find?: Handler
  selectAll?: Handler
  copySelection?: Handler
  addFilter?: Handler
  removeFilter?: Handler
  escape?: Handler
  addRow?: Handler
  removeNewRow?: Handler
  deleteRows?: Handler
}

const registry = new Map<string, TabCommands>()

export function registerTabCommands(tabId: string, cmds: TabCommands): () => void {
  registry.set(tabId, cmds)
  return () => {
    if (registry.get(tabId) === cmds) registry.delete(tabId)
  }
}

export function runTabCommand(tabId: string | null | undefined, name: keyof TabCommands): boolean {
  if (!tabId) return false
  const fn = registry.get(tabId)?.[name]
  if (!fn) return false
  return fn() !== false
}

/** True when focus is somewhere typing happens (inputs, the SQL editor, a grid cell editor) */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  if (tag === 'INPUT') {
    // row checkboxes, radio buttons and buttons take focus when clicked but nobody types in them
    const type = (el as HTMLInputElement).type
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type)
  }
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if ((el as HTMLElement).isContentEditable) return true
  return !!el.closest('.monaco-editor')
}
