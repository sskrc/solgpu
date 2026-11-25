import type { ReactNode } from 'react'
import { Heading } from '@astryxdesign/core/Heading'
import { HStack } from '@astryxdesign/core/HStack'
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'

/** 各タブの見出し（タイトル・説明・右側の操作） */
export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <HStack gap={4} justify="between" align="end" wrap="wrap">
      <VStack gap={1}>
        <Heading level={1} type="display-3">
          {title}
        </Heading>
        {description && <Text color="secondary">{description}</Text>}
      </VStack>
      {actions}
    </HStack>
  )
}

/** ページ内の小見出し */
export function SectionTitle({ step, title, actions }: { step?: number; title: string; actions?: ReactNode }) {
  return (
    <HStack gap={3} justify="between" align="center" wrap="wrap">
      <HStack gap={2} align="center">
        {step !== undefined && (
          <Text type="label" color="accent" hasTabularNumbers>
            {String(step).padStart(2, '0')}
          </Text>
        )}
        <Heading level={2}>{title}</Heading>
      </HStack>
      {actions}
    </HStack>
  )
}
