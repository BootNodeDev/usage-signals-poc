export function requireEnv(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `Environment variable ${name} is not set. Locally run with --env-file=local.env; ` +
        'on Vercel add it in the project settings.',
    )
  }
  return value
}

// Umami's deployment is closed to the public; this header lets our own server-side calls through.
export function umamiAccessHeaders() {
  const secret = process.env.UMAMI_BYPASS_SECRET
  return secret ? { 'x-vercel-protection-bypass': secret } : {}
}
