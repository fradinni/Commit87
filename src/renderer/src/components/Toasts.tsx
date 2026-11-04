import { CheckCircle2, Info, XCircle, X } from 'lucide-react'
import { useStore } from '../store'

export function Toasts() {
  const toasts = useStore((state) => state.toasts)
  const dismiss = useStore((state) => state.dismissToast)
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`}>
          <span className="toast-icon">
            {toast.kind === 'success' ? <CheckCircle2 size={16} /> : toast.kind === 'error' ? <XCircle size={16} /> : <Info size={16} />}
          </span>
          <span className="toast-message">{toast.message}</span>
          <button onClick={() => dismiss(toast.id)} aria-label="Dismiss">
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}
