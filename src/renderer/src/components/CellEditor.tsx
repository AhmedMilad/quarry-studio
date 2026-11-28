import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RenderEditCellProps } from 'react-data-grid'

let measureCtx: CanvasRenderingContext2D | null = null
function textWidth(text: string, font: string): number {
  measureCtx ??= document.createElement('canvas').getContext('2d')
  if (!measureCtx) return 0
  measureCtx.font = font
  return measureCtx.measureText(text).width
}

/**
 * Cell editor that selects the whole value on open (like the stock rdg editor) but keeps a blinking
 * caret visible. Browsers don't paint the native caret while a range is selected, so while the
 * selection is non-empty we draw our own at the selection's focus end; once it collapses the native
 * caret takes over.
 */
export function CellEditor<R, SR>({
  row,
  column,
  onRowChange,
  onClose,
  nullable = true
}: RenderEditCellProps<R, SR> & { nullable?: boolean }) {
  const ref = useRef<HTMLInputElement>(null)
  const [caretX, setCaretX] = useState<number | null>(null)
  const [blinkKey, setBlinkKey] = useState(0)
  const value = (row as Record<string, unknown>)[column.key]

  const update = useCallback(() => {
    const el = ref.current
    if (!el || document.activeElement !== el) return setCaretX(null)
    const { selectionStart: s, selectionEnd: e, selectionDirection: dir } = el
    if (s == null || e == null || s === e) return setCaretX(null)
    const pos = dir === 'backward' ? s : e
    const cs = getComputedStyle(el)
    const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    const x = parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth) +
      textWidth(el.value.slice(0, pos), font) - el.scrollLeft
    setCaretX(Math.min(Math.max(x, 1), el.clientWidth - 1))
    setBlinkKey((k) => k + 1) // restart the blink so the caret is solid right after it moves
  }, [])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.select()
    update()
  }, [update])

  useEffect(() => {
    document.addEventListener('selectionchange', update)
    return () => document.removeEventListener('selectionchange', update)
  }, [update])

  // commit NULL and close the editor (an empty box would save an empty string, which is not NULL)
  const setNull = (): void => onRowChange({ ...row, [column.key]: null }, true)

  return (
    <div className="cell-editor">
      <input
        ref={ref}
        className={`rdg-text-editor${value == null ? ' is-null' : ''}${nullable ? ' has-null-btn' : ''}`}
        value={value == null ? '' : String(value)}
        placeholder={value == null ? 'NULL' : ''}
        onChange={(e) => onRowChange({ ...row, [column.key]: e.target.value })}
        onKeyDown={(e) => {
          if (nullable && (e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyN') {
            e.preventDefault()
            e.stopPropagation()
            setNull()
          }
        }}
        onScroll={update}
        onBlur={() => onClose(true, false)}
      />
      {caretX != null && <span key={blinkKey} className="cell-editor-caret" style={{ left: caretX }} />}
      {nullable && (
        <button
          type="button"
          className="cell-editor-null"
          title="Set to NULL (Ctrl+Shift+N)"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()} // keep focus in the input so the editor doesn't close first
          onClick={setNull}
        >
          NULL
        </button>
      )}
    </div>
  )
}
