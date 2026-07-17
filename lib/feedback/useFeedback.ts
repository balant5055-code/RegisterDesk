'use client'

// The one unified feedback hook (EA-4 S3). A thin facade over the EXISTING toast
// and confirm/prompt systems + the message catalog — it does NOT create a new
// feedback engine. Every module uses this for consistent wording + behavior.

import { useToast, type ToastOptions } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { msg, apiErrorMessage, type MessageKey } from './messages'

export function useFeedback() {
  const { showToast } = useToast()
  const { confirm, prompt } = useConfirm()

  const success = (key: MessageKey | string, options?: ToastOptions) => showToast(msg(key), 'success', options)
  const info    = (key: MessageKey | string, options?: ToastOptions) => showToast(msg(key), 'info', options)
  const warning = (key: MessageKey | string, options?: ToastOptions) => showToast(msg(key), 'warning', options)
  const error   = (err: unknown,             options?: ToastOptions) => showToast(apiErrorMessage(err), 'error', options)

  /** Standard async lifecycle: run the promise → success/error toast, standardized. */
  async function promise<T>(
    p: Promise<T>,
    msgs: { success?: MessageKey | string; error?: MessageKey | string } = {},
  ): Promise<T> {
    try {
      const result = await p
      if (msgs.success) success(msgs.success)
      return result
    } catch (e) {
      showToast(msgs.error ? msg(msgs.error) : apiErrorMessage(e), 'error')
      throw e
    }
  }

  return { success, info, warning, error, confirm, prompt, promise, toast: showToast }
}
