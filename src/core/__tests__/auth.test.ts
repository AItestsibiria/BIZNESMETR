import { Channel } from '@prisma/client'

describe('auth whitelist', () => {
  const ORIGINAL_ENV = process.env

  beforeEach(() => {
    jest.resetModules()
    process.env = { ...ORIGINAL_ENV }
  })

  afterAll(() => {
    process.env = ORIGINAL_ENV
  })

  it('rejects everyone when the whitelist is empty', async () => {
    process.env.ALLOWED_TELEGRAM_USER_IDS = ''
    const { isAllowed } = await import('../auth')
    expect(isAllowed(Channel.TELEGRAM, '123')).toBe(false)
  })

  it('admits ids that are in the whitelist', async () => {
    process.env.ALLOWED_TELEGRAM_USER_IDS = '111, 222 ,333'
    const { isAllowed } = await import('../auth')
    expect(isAllowed(Channel.TELEGRAM, '222')).toBe(true)
    expect(isAllowed(Channel.TELEGRAM, '999')).toBe(false)
  })

  it('rejects non-numeric ids for telegram', async () => {
    process.env.ALLOWED_TELEGRAM_USER_IDS = '111'
    const { isAllowed } = await import('../auth')
    expect(isAllowed(Channel.TELEGRAM, 'abc')).toBe(false)
  })
})
