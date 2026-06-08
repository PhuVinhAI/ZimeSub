import StatusBadge, { type BadgeTone } from '@design-system/StatusBadge'
import type { ToolReport, ToolStatus } from '@api/tooling'
import type { Component } from 'solid-js'
import { Match, Show, Switch } from 'solid-js'

/**
 * One row of the Onboarding tool panel.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ mkvmerge                              [Sẵn sàng]  v84.0     │
 *   │ C:\Program Files\MKVToolNix\mkvmerge.exe                    │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * For `Outdated` we surface "current vs minimum" on a second line; for
 * `Missing` we explain where we looked.
 */
interface ToolRowProps {
  report: ToolReport
}

const tone: Record<ToolStatus, BadgeTone> = {
  Ready: 'accent',
  Outdated: 'warn',
  Missing: 'danger'
}

const badgeLabel: Record<ToolStatus, string> = {
  Ready: 'Sẵn sàng',
  Outdated: 'Cần cập nhật',
  Missing: 'Chưa cài'
}

const ToolRow: Component<ToolRowProps> = props => {
  return (
    <div class="flex flex-col gap-2 border-b-2 border-border px-6 py-5 last:border-b-0">
      <div class="flex items-center justify-between gap-4">
        <div class="flex items-baseline gap-3">
          <span class="font-mono text-base font-medium text-text">{props.report.name}</span>
          <Show when={props.report.detected_version}>
            {v => <span class="font-mono text-xs text-text-muted">v{v()}</span>}
          </Show>
        </div>
        <StatusBadge tone={tone[props.report.status]}>
          {badgeLabel[props.report.status]}
        </StatusBadge>
      </div>

      <Switch>
        <Match when={props.report.status === 'Ready' && props.report.resolved_path}>
          {p => <p class="font-mono text-xs break-all text-text-muted">{p()}</p>}
        </Match>

        <Match when={props.report.status === 'Outdated'}>
          <div class="flex flex-col gap-1">
            <Show when={props.report.resolved_path}>
              {p => <p class="font-mono text-xs break-all text-text-muted">{p()}</p>}
            </Show>
            <p class="text-xs text-warn">
              Phiên bản hiện tại{' '}
              <span class="font-mono">{props.report.detected_version ?? 'không đọc được'}</span>{' '}
              — yêu cầu tối thiểu{' '}
              <span class="font-mono">{props.report.minimum_version}</span>.
            </p>
          </div>
        </Match>

        <Match when={props.report.status === 'Missing'}>
          <p class="text-xs text-text-muted">
            Không tìm thấy trong PATH hoặc thư mục cài đặt mặc định trên Windows.
          </p>
        </Match>
      </Switch>
    </div>
  )
}

export default ToolRow
