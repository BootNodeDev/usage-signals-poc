export function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Environment variable ${name} is not set. Locally run with --env-file=local.env; ` +
        'on Vercel add it in the project settings.',
    );
  }
  return value;
}
