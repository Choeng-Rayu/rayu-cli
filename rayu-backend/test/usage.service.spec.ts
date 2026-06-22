import { UsageService } from '../src/usage/usage.service'

// DB-free unit test: the month-window math + query shape for the per-feature
// usage counter that backs GET /usage/features (CLI soft per-feature limit).
describe('UsageService.featureUsageThisMonth', () => {
  function make(count: number) {
    const prisma = { usageEvent: { count: jest.fn(async () => count) } }
    const users = {} as never
    return { svc: new UsageService(prisma as never, users), prisma }
  }

  it('returns 0 without querying when there are no mapped tools', async () => {
    const { svc, prisma } = make(5)
    await expect(svc.featureUsageThisMonth(1, [])).resolves.toBe(0)
    expect(prisma.usageEvent.count).not.toHaveBeenCalled()
  })

  it('counts the mapped tools since the start of the current UTC month', async () => {
    const { svc, prisma } = make(7)
    await expect(
      svc.featureUsageThisMonth(42, ['GenerateImage']),
    ).resolves.toBe(7)

    const arg = (prisma.usageEvent.count as jest.Mock).mock.calls[0][0]
    expect(arg.where.userId).toBe(42)
    expect(arg.where.tool).toEqual({ in: ['GenerateImage'] })

    const now = new Date()
    const expectedStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    )
    expect(arg.where.createdAt.gte instanceof Date).toBe(true)
    expect(arg.where.createdAt.gte.getTime()).toBe(expectedStart.getTime())
    // Window start must be midnight UTC on the 1st.
    expect(arg.where.createdAt.gte.getUTCDate()).toBe(1)
    expect(arg.where.createdAt.gte.getUTCHours()).toBe(0)
  })
})
