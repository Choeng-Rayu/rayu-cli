/**
 * The "what do you want to do?" menu shown when a Rayu credit limit blocks a turn.
 *
 * # What it is for
 *
 * Rayu paces a plan's credit allowance: hitting the rolling session window or the
 * week stops new requests until that window rolls. The user has three legitimate
 * responses, and the point of this menu is that they can pick one without leaving
 * the terminal:
 *
 *   1. turn the pacing off and keep working ("use all credits"),
 *   2. move to a bigger allowance (upgrade),
 *   3. wait for the window.
 *
 * # Why the state comes from the engine rather than from an argument
 *
 * `REPL.tsx` submits this command from the rate-limit notice in the transcript, so
 * no argument carries the limit. The limit was already published into the shared
 * limits state when the gateway refused (see
 * `services/rayuAuth/rayuRateLimit.ts`), so the menu reads it back — one source of
 * truth, and no chance of describing a different limit than the one just hit.
 *
 * # Why "use all credits" is not just a link
 *
 * The switch is a real setting (`users.limit_mode`) behind an authenticated
 * endpoint the CLI can already reach, so the action performs it and re-runs the
 * blocked turn — rather than sending the user to a browser to do it by hand.
 */
import React, { useCallback, useMemo, useState } from 'react'
import type {
  CommandResultDisplay,
  LocalJSXCommandContext,
} from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import type { ToolUseContext } from '../../Tool.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import {
  type OptionWithDescription,
  Select,
} from '../../components/CustomSelect/select.js'
import { Text } from '../../ink.js'
import { currentLimits } from '../../services/claudeAiLimits.js'
import {
  clearRayuPacingLimit,
  describeRayuPacing,
  formatPacingReset,
  rayuPacingLimitFromLimits,
  setRayuLimitMode,
  type RayuPacingLimit,
} from '../../services/rayuAuth/rayuRateLimit.js'
import {
  getRayuDashboardUrl,
  getRayuPlansUrl,
} from '../../services/rayuAuth/rayuSession.js'
import { openBrowser } from '../../utils/browser.js'

type MenuAction = 'full-credits' | 'upgrade' | 'cancel'

type Props = {
  onDone: LocalJSXCommandOnDone
}

function RateLimitOptionsMenu({ onDone }: Props): React.ReactNode {
  const [busy, setBusy] = useState<MenuAction | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // Read once per render. `currentLimits` is module state that only changes when a
  // new status is published, so this is the same value the notice rendered from.
  const limit: RayuPacingLimit | null = rayuPacingLimitFromLimits(currentLimits)

  // On a TEAM the pacing switch is org-admin-only, so the first option becomes an
  // explanation rather than an action: offering a member a control they have no
  // permission to use would send them to a dashboard where the setting is not
  // theirs to change.
  const isTeam = limit?.scope === 'team'

  const options = useMemo<OptionWithDescription<MenuAction>[]>(() => {
    const waitLabel =
      limit?.resetsAt != null
        ? `Stop and wait for the limit to reset (${formatPacingReset(limit.resetsAt)})`
        : 'Stop and wait for the limit to reset'
    const primary: OptionWithDescription<MenuAction> = isTeam
      ? {
          label: 'Ask your team admin to turn off pacing',
          value: 'full-credits',
          description:
            'Your team\u2019s allowance is paced per member. Only a team admin can turn that off.',
        }
      : {
          label: 'Use all credits (turn off pacing)',
          value: 'full-credits',
          description:
            'Spend this period\u2019s whole allowance now, with no session or weekly window. Same credits \u2014 just no waiting.',
        }
    return [
      primary,
      {
        label: 'Upgrade your plan',
        value: 'upgrade',
        description: 'See plans with a larger allowance.',
      },
      {
        label: waitLabel,
        value: 'cancel',
        description: 'Nothing changes; the window rolls on its own.',
      },
    ]
  }, [limit, isTeam])

  const handleCancel = useCallback(() => {
    onDone(undefined, { display: 'skip' satisfies CommandResultDisplay })
  }, [onDone])

  const handleSelect = useCallback(
    (value: string) => {
      const action = value as MenuAction

      if (action === 'cancel') {
        handleCancel()
        return
      }

      if (action === 'upgrade') {
        // The SAME builder the rate-limit messages use, so the page this opens is
        // character-for-character the link the user was already shown.
        const url = getRayuPlansUrl()
        setBusy('upgrade')
        void openBrowser(url).then((opened) => {
          setBusy(null)
          onDone(
            opened
              ? `Opened ${url} in your browser.`
              : `See plans with a larger allowance at ${url}`,
            { display: 'system' satisfies CommandResultDisplay },
          )
        })
        return
      }

      // Team members cannot flip the team's switch (it is org-admin-only), so this
      // reports where the setting lives rather than calling an endpoint that would
      // fail — or worse, silently succeed against the member's OWN unrelated mode.
      if (isTeam) {
        onDone(
          `Your team\u2019s credit pacing is set by a team admin. Ask them to turn it ` +
            `off at ${getRayuDashboardUrl()} (Team \u2192 credit pacing), or wait for ` +
            `the window to reset.`,
          { display: 'system' satisfies CommandResultDisplay },
        )
        return
      }

      // 'full-credits': perform the switch, then re-run the blocked turn.
      // `shouldQuery` is what makes that retry happen — without it the user would
      // flip the setting and still have to retype their message.
      setBusy('full-credits')
      void setRayuLimitMode('full_credits').then((result) => {
        setBusy(null)
        if (!result.ok) {
          setNotice(result.error)
          return
        }
        // The published limit is stale the moment the switch is applied: leaving it
        // in place would keep rendering "limit reached" for the rest of the session.
        clearRayuPacingLimit()
        onDone(
          'Pacing is off — using all credits. Your whole allowance is available now. ' +
            'The gateway applies this within a few seconds, so a retry may need one ' +
            'more attempt.',
          { display: 'system' satisfies CommandResultDisplay, shouldQuery: true },
        )
      })
    },
    [handleCancel, onDone],
  )

  // A failure is surfaced in place, not as a toast: the menu owns the screen while
  // it is open, and a message that appears underneath it is not read.
  const body =
    notice !== null ? (
      <Text>{notice}</Text>
    ) : busy !== null ? (
      <Text>{busy === 'upgrade' ? 'Opening plans…' : 'Turning off pacing…'}</Text>
    ) : limit === null ? (
      // Not a Rayu window (an Anthropic subscription limit, or nothing at all):
      // there is no Rayu advice to offer, and an empty menu would be worse than
      // none. Say so rather than rendering a dead choice list.
      <Text>No Rayu credit limit is currently blocking you.</Text>
    ) : (
      // No JSX type argument: `Select` is published through the React compiler
      // output, whose signature is untyped, so the option union is carried by
      // `options` instead (the handler takes the raw string and narrows it).
      <Select
        options={options}
        onChange={handleSelect}
        visibleOptionCount={options.length}
      />
    )

  const subtitle = limit ? describeRayuPacing(limit) : undefined
  return (
    <Dialog
      title={
        limit
          ? "You've reached your Rayu credit limit"
          : 'Rayu credit limits'
      }
      {...(subtitle ? { subtitle } : {})}
      onCancel={handleCancel}
      color="suggestion"
    >
      {body}
    </Dialog>
  )
}

/**
 * Entry point required by the `local-jsx` command contract.
 *
 * `context` is accepted but unused: every action here goes through a service the
 * menu already holds (the credits API, the browser helper) rather than through
 * tool or session state, so threading it in would be dead weight.
 */
export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: ToolUseContext & LocalJSXCommandContext,
): Promise<React.ReactNode> {
  return <RateLimitOptionsMenu onDone={onDone} />
}
