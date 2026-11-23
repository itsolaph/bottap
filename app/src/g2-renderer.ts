import { formatRelativeAge, type G2ViewState } from '@bottap/shared'

export interface G2Frame {
  readonly body: string
  readonly footer: string
}

const MAX_LINE_LEN = 44

function fitLine(text: string, maxLen = MAX_LINE_LEN): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= maxLen) return clean
  return clean.slice(0, maxLen - 3).trimEnd() + '...'
}

export function renderG2Frame(state: G2ViewState, nowMs = Date.now()): G2Frame {
  switch (state.screen) {
    case 'loading':
      return {
        body: 'BOTTAP · ON-DUTY\n\nConnecting to self-hosted gateway...',
        footer: '2x tap: exit',
      }

    case 'offline':
      return {
        body: [
          'BOTTAP · OFFLINE',
          '',
          fitLine(state.message),
          'Check gateway URL on phone.',
        ].join('\n'),
        footer: 'tap: retry  ·  2x: exit',
      }

    case 'unpaired':
      return {
        body: [
          'BOTTAP · NOT PAIRED',
          '',
          'Open BotTap companion on phone',
          'to pair your Telegram gateway.',
        ].join('\n'),
        footer: 'tap: refresh  ·  2x: exit',
      }

    case 'empty':
      return {
        body: [
          `BOTTAP · 0 PENDING${state.mode === 'demo' ? ' [DEMO]' : ''}`,
          '',
          `All clear (${state.allowlistCount} allowlisted bots).`,
          'Only inline callback buttons appear here.',
        ].join('\n'),
        footer: 'tap: refresh  ·  2x: exit',
      }

    case 'queue': {
      const total = state.items.length
      const lines: string[] = [
        `BOTTAP · ${total} PENDING (${state.cursor + 1}/${total})`,
      ]

      // Show a sliding window of up to 3 queue entries; expand alert line on the focused item
      const windowSize = 3
      const start = Math.max(0, Math.min(state.cursor - 1, total - windowSize))
      const end = Math.min(total, start + windowSize)

      for (let i = start; i < end; i += 1) {
        const item = state.items[i]!
        const age = formatRelativeAge(item.sentAt, nowMs)
        const isCurrent = i === state.cursor
        const prefix = isCurrent ? '> ' : '  '
        const btnTag = `${item.buttons.length}b`
        lines.push(fitLine(`${prefix}@${item.bot} · ${age} · ${btnTag}`))
        if (isCurrent) {
          lines.push(fitLine(`  ${item.line}`))
        }
      }

      return {
        body: lines.join('\n'),
        footer: 'tap: open  ·  swipe: next  ·  2x: exit',
      }
    }

    case 'buttons': {
      const item = state.items[state.itemIndex]!
      const age = formatRelativeAge(item.sentAt, nowMs)
      const lines: string[] = [
        fitLine(`@${item.bot} · ${age}`),
        fitLine(item.line),
        '',
      ]

      // Display sliding window of up to 3 buttons cleanly on 576x288
      const maxVisible = 3
      const start = Math.max(
        0,
        Math.min(state.buttonIndex - 1, Math.max(0, item.buttons.length - maxVisible)),
      )
      const end = Math.min(item.buttons.length, start + maxVisible)

      for (let i = start; i < end; i += 1) {
        const btn = item.buttons[i]!
        const cursor = i === state.buttonIndex ? '> ' : '  '
        const badge = btn.requiresPassword
          ? '[2FA] '
          : btn.danger
            ? '[!] '
            : '[ ] '
        const hint = btn.danger && !btn.requiresPassword ? ' (2x)' : ''
        lines.push(fitLine(`${cursor}${badge}${btn.label}${hint}`))
      }

      return {
        body: lines.join('\n'),
        footer: 'tap: press  ·  swipe: cycle  ·  2x: back',
      }
    }

    case 'danger_confirm': {
      const item = state.items[state.itemIndex]!
      const btn = item.buttons[state.buttonIndex]!
      return {
        body: [
          '!! DANGER BUTTON (bg_danger) !!',
          fitLine(`@${item.bot}`),
          fitLine(item.line),
          '',
          fitLine(`Action: ${btn.label}`),
          '>>> PRESS AGAIN TO CONFIRM <<<',
        ].join('\n'),
        footer: 'tap: CONFIRM  ·  swipe/2x: cancel',
      }
    }

    case 'pressing':
      return {
        body: [
          'SENDING CALLBACK...',
          '',
          fitLine(`@${state.item.bot}`),
          fitLine(`> ${state.button.label}`),
        ].join('\n'),
        footer: 'Waiting for bot callback answer...',
      }

    case 'result':
      return {
        body: [
          fitLine(`${state.timedOut ? 'LOGGED (TIMEOUT)' : 'CONFIRMED'} · @${state.bot}`),
          fitLine(`Button: ${state.buttonLabel}`),
          '',
          fitLine(state.headline),
          state.detail !== state.headline ? fitLine(state.detail) : '',
        ]
          .filter((l, idx) => idx === 2 || l.length > 0)
          .join('\n'),
        footer: 'Returning to queue...  ·  tap: now',
      }

    case 'refusal':
      return {
        body: [
          'BLOCKED ON GLASSES',
          '',
          fitLine(state.headline),
          fitLine(`@${state.bot} · ${state.buttonLabel}`),
          fitLine(state.detail),
        ].join('\n'),
        footer: 'tap or 2x: back to queue',
      }
  }
}
