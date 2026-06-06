import React, { useCallback, useEffect, useState } from 'react'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import {
  setupTerminal,
  shouldOfferTerminalSetup,
} from '../commands/terminalSetup/terminalSetup.js'
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import { Box, Newline, Text, useTheme } from '../ink.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import { env } from '../utils/env.js'
import type { ThemeSetting } from '../utils/theme.js'
import { RayuProviderSetup } from './RayuProviderSetup.js'
import { hasConfiguredProvider } from '../utils/rayuConfig.js'
import { Select } from './CustomSelect/select.js'
import { WelcomeV2 } from './LogoV2/WelcomeV2.js'
import { PressEnterToContinue } from './PressEnterToContinue.js'
import { ThemePicker } from './ThemePicker.js'
import { OrderedList } from './ui/OrderedList.js'

// Rayu is bring-your-own-key: every provider (OpenAI-compatible endpoints and
// AWS Bedrock) is configured through RayuProviderSetup. There is no direct
// Anthropic provider and no Anthropic OAuth flow.
type StepId = 'theme' | 'provider' | 'security' | 'terminal-setup'

interface OnboardingStep {
  id: StepId
  component: React.ReactNode
}

type Props = {
  onDone(): void
}

export function Onboarding({ onDone }: Props): React.ReactNode {
  const [currentStepIndex, setCurrentStepIndex] = useState(0)
  const [theme, setTheme] = useTheme()

  useEffect(() => {
    logEvent('tengu_began_setup', {})
  }, [])

  function goToNextStep() {
    if (currentStepIndex < steps.length - 1) {
      const nextIndex = currentStepIndex + 1
      setCurrentStepIndex(nextIndex)
      logEvent('tengu_onboarding_step', {
        stepId: steps[nextIndex]
          ?.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    } else {
      onDone()
    }
  }

  function handleThemeSelection(newTheme: ThemeSetting) {
    setTheme(newTheme)
    goToNextStep()
  }

  const exitState = useExitOnCtrlCDWithKeybindings()

  const themeStep = (
    <Box marginX={1}>
      <ThemePicker
        onThemeSelect={handleThemeSelection}
        showIntroText={true}
        helpText="To change this later, run /theme"
        hideEscToCancel={true}
        skipExitHandling={true}
      />
    </Box>
  )

  const securityStep = (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>Security notes:</Text>
      <Box flexDirection="column" width={70}>
        {/**
         * OrderedList misnumbers items when rendering conditionally,
         * so put all items in the if/else
         */}
        <OrderedList>
          <OrderedList.Item>
            <Text>Rayu can make mistakes</Text>
            <Text dimColor wrap="wrap">
              You should always review Rayu&apos;s responses, especially when
              <Newline />
              running code.
              <Newline />
            </Text>
          </OrderedList.Item>
          <OrderedList.Item>
            <Text>
              Due to prompt injection risks, only use it with code you trust
            </Text>
            <Text dimColor wrap="wrap">
              Keep provider credentials scoped and review generated changes
              before applying them.
              <Newline />
            </Text>
          </OrderedList.Item>
        </OrderedList>
      </Box>
      <PressEnterToContinue />
    </Box>
  )

  const steps: OnboardingStep[] = []
  steps.push({ id: 'theme', component: themeStep })

  // Prompt for provider + API key when none is configured yet.
  // RayuProviderSetup handles all provider kinds (openai-compatible, bedrock).
  // Run /connect any time to add or switch providers.
  if (!hasConfiguredProvider()) {
    steps.push({
      id: 'provider',
      component: <RayuProviderSetup onDone={goToNextStep} />,
    })
  }

  steps.push({ id: 'security', component: securityStep })

  if (shouldOfferTerminalSetup()) {
    steps.push({
      id: 'terminal-setup',
      component: (
        <Box flexDirection="column" gap={1} paddingLeft={1}>
          <Text bold>Use RAYU&apos;s terminal setup?</Text>
          <Box flexDirection="column" width={70} gap={1}>
            <Text>
              For the optimal coding experience, enable the recommended settings
              <Newline />
              for your terminal:{' '}
              {env.terminal === 'Apple_Terminal'
                ? 'Option+Enter for newlines and visual bell'
                : 'Shift+Enter for newlines'}
            </Text>
            <Select
              options={[
                {
                  label: 'Yes, use recommended settings',
                  value: 'install',
                },
                {
                  label: 'No, maybe later with /terminal-setup',
                  value: 'no',
                },
              ]}
              onChange={(value: string) => {
                if (value === 'install') {
                  // Errors already logged in setupTerminal, just swallow and proceed
                  void setupTerminal(theme)
                    .catch(() => {})
                    .finally(goToNextStep)
                } else {
                  goToNextStep()
                }
              }}
              onCancel={() => goToNextStep()}
            />
            <Text dimColor>
              {exitState.pending ? (
                <>Press {exitState.keyName} again to exit</>
              ) : (
                <>Enter to confirm · Esc to skip</>
              )}
            </Text>
          </Box>
        </Box>
      ),
    })
  }

  const currentStep = steps[currentStepIndex]

  // Handle Enter on security step and Escape on terminal-setup step
  const handleSecurityContinue = useCallback(() => {
    if (currentStepIndex === steps.length - 1) {
      onDone()
    } else {
      goToNextStep()
    }
  }, [currentStepIndex, steps.length, onDone])

  const handleTerminalSetupSkip = useCallback(() => {
    goToNextStep()
  }, [currentStepIndex, steps.length, onDone])

  useKeybindings(
    {
      'confirm:yes': handleSecurityContinue,
    },
    {
      context: 'Confirmation',
      isActive: currentStep?.id === 'security',
    },
  )

  useKeybindings(
    {
      'confirm:no': handleTerminalSetupSkip,
    },
    {
      context: 'Confirmation',
      isActive: currentStep?.id === 'terminal-setup',
    },
  )

  return (
    <Box flexDirection="column">
      <WelcomeV2 />
      <Box flexDirection="column" marginTop={1}>
        {currentStep?.component}
        {exitState.pending && (
          <Box padding={1}>
            <Text dimColor>Press {exitState.keyName} again to exit</Text>
          </Box>
        )}
      </Box>
    </Box>
  )
}
