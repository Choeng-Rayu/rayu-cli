import { BadRequestException, NotFoundException } from '@nestjs/common'
import type { HostedModel, Plan } from '@prisma/client'
import { AdminService } from './admin.service'
import type { PrismaService } from '../prisma/prisma.service'
import type { PlansService } from '../plans/plans.service'
import type { ModelsService } from '../models/models.service'
import type { AppSettingsService } from '../settings/app-settings.service'
import type { UsageService } from '../usage/usage.service'
import type { UsersService } from '../users/users.service'

// Model access is edited per PLAN but stored per MODEL, so one submit rewrites
// several rows. These tests pin the properties that make that safe: all-or-
// nothing writes, no unrelated rows touched, and a bad code changing nothing.

type Row = Pick<HostedModel, 'code' | 'allowedPlanCodes'>

function model(code: string, planCodes: string[]): Row {
  return { code, allowedPlanCodes: planCodes as unknown as HostedModel['allowedPlanCodes'] }
}

function makeService(rows: Row[], plan: Partial<Plan> | null = { code: 'pro', name: 'Pro' }) {
  // Writes mutate the in-memory rows so the service's post-write re-read sees the
  // new state, exactly as it would against the database.
  const update = jest.fn((args: { where: { code: string }; data: { allowedPlanCodes: string[] } }) => {
    const row = rows.find((r) => r.code === args.where.code)
    if (row) {
      row.allowedPlanCodes = args.data.allowedPlanCodes as unknown as HostedModel['allowedPlanCodes']
    }
    return Promise.resolve(args)
  })
  // Mirrors PrismaService.$transaction(ops[]): the operations are already
  // in-flight promises, so awaiting them all is the faithful stand-in.
  const $transaction = jest.fn((ops: Promise<unknown>[]) => Promise.all(ops))
  const prisma = { hostedModel: { update }, $transaction }
  const plans = {
    findByCode: jest.fn(() => Promise.resolve(plan)),
    getLimits: jest.fn(() => ({ maxDailyTurns: null, creditsPerPeriod: null, topUpEnabled: false })),
    getResolvedFeatures: jest.fn(() => ({})),
  }
  const models = {
    findAll: jest.fn(() => Promise.resolve(rows)),
    allowedCodes: (m: Row) => (Array.isArray(m.allowedPlanCodes) ? (m.allowedPlanCodes as string[]) : []),
  }
  const service = new AdminService(
    {} as unknown as UsersService,
    {} as unknown as UsageService,
    prisma as unknown as PrismaService,
    plans as unknown as PlansService,
    models as unknown as ModelsService,
    {} as unknown as AppSettingsService,
  )
  return { service, update, $transaction }
}

describe('AdminService.setPlanModels', () => {
  it('grants and revokes in a single transaction', async () => {
    const { service, update, $transaction } = makeService([
      model('keep', ['pro', 'max']),
      model('grant', ['max']),
      model('revoke', ['pro', 'max']),
    ])

    await service.setPlanModels('pro', ['keep', 'grant'])

    expect($transaction).toHaveBeenCalledTimes(1)
    const written = new Map(
      update.mock.calls.map(([a]) => [a.where.code, a.data.allowedPlanCodes]),
    )
    expect([...written.keys()].sort()).toEqual(['grant', 'revoke'])
    expect(written.get('grant')).toEqual(['max', 'pro'])
    expect(written.get('revoke')).toEqual(['max'])
  })

  it('does not touch a model whose membership is unchanged', async () => {
    const { service, update, $transaction } = makeService([
      model('a', ['pro']),
      model('b', []),
    ])
    const res = await service.setPlanModels('pro', ['a'])
    expect(update).not.toHaveBeenCalled()
    expect($transaction).not.toHaveBeenCalled()
    expect(res.changedModels).toBe(0)
  })

  it('leaves other plans on a model alone', async () => {
    const { service, update } = makeService([model('shared', ['free', 'basic', 'pro'])])
    await service.setPlanModels('pro', [])
    expect(update.mock.calls[0][0].data.allowedPlanCodes).toEqual(['free', 'basic'])
  })

  it('revoking every model is a valid state', async () => {
    const { service, update } = makeService([model('a', ['pro']), model('b', ['pro'])])
    const res = await service.setPlanModels('pro', [])
    expect(res.allowedModelCodes).toEqual([])
    expect(update).toHaveBeenCalledTimes(2)
  })

  it('rejects an unknown model code WITHOUT writing anything', async () => {
    const { service, update, $transaction } = makeService([model('a', [])])
    await expect(service.setPlanModels('pro', ['a', 'ghost'])).rejects.toThrow(
      BadRequestException,
    )
    expect(update).not.toHaveBeenCalled()
    expect($transaction).not.toHaveBeenCalled()
  })

  it('rejects an unknown plan', async () => {
    const { service } = makeService([model('a', [])], null)
    await expect(service.setPlanModels('nope', [])).rejects.toThrow(NotFoundException)
  })
})
