import { useSyncExternalStore } from 'react'

/**
 * 表示言語（日本語 / 英語）
 * 文言はその場で t('日本語', 'English') と並べて書く。言語を切り替えると App から下が描き直される
 */
export type Lang = 'ja' | 'en'

const STORAGE_KEY = 'solgpu.lang'
const listeners = new Set<() => void>()

function initialLang(): Lang {
  // ?lang=en / ?lang=ja を最優先（共有リンク用）→ 前回の選択 → ブラウザの言語
  try {
    const q = new URLSearchParams(window.location.search).get('lang')
    if (q === 'ja' || q === 'en') return q
  } catch {
    /* 無視 */
  }
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'ja' || saved === 'en') return saved
  } catch {
    /* 保存できない環境 */
  }
  return typeof navigator !== 'undefined' && !navigator.language?.toLowerCase().startsWith('ja') ? 'en' : 'ja'
}

let lang: Lang = initialLang()
if (typeof document !== 'undefined') document.documentElement.lang = lang

export const getLang = () => lang

export function setLang(next: Lang) {
  if (next === lang) return
  lang = next
  document.documentElement.lang = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    /* 保存できない環境 */
  }
  listeners.forEach((fn) => fn())
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** 現在の言語（切り替えで再描画される） */
export const useLang = () => useSyncExternalStore(subscribe, getLang)

/** 現在の言語に合わせて文言を選ぶ */
export const t = (ja: string, en: string) => (lang === 'ja' ? ja : en)

/** 日付などの表示に使うロケール */
export const locale = () => (lang === 'ja' ? 'ja-JP' : 'en-US')
