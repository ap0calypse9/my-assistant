import { Daytona } from '@daytona/sdk'

const main = async () => {
  const apiKey = process.env.DAYTONA_API_KEY?.trim()
  if (!apiKey) {
    throw new Error(
      'DAYTONA_API_KEY is required. Create an API key at https://app.daytona.io/dashboard/keys and set it in your shell or local .env file.',
    )
  }

  const daytona = new Daytona({ apiKey })
  let sandbox: Awaited<ReturnType<typeof daytona.v0.create>> | undefined

  try {
    sandbox = await daytona.v0.create({ language: 'typescript' })
    const response = await sandbox.process.codeRun(
      'console.log("Hello World")',
      undefined,
      60,
    )
    const output = response.artifacts?.stdout ?? response.result

    process.stdout.write(output)
    if (output.length > 0 && !output.endsWith('\n')) {
      process.stdout.write('\n')
    }

    if (response.exitCode !== 0) {
      throw new Error(`Hello World program exited with code ${response.exitCode}`)
    }
  } finally {
    if (sandbox) {
      await daytona.v0.delete(sandbox, 60, true)
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
