import { authenticate } from './auth.mjs';
import { writeConfig, getConfigPath } from './config.mjs';

const PLATFORM_URL = process.env.RR_PLATFORM_URL || 'https://api.robotresources.ai';

/**
 * Generate an API key via the platform API.
 */
export async function createApiKey(accessToken) {
  const res = await fetch(`${PLATFORM_URL}/v1/keys`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ name: `cli-${new Date().toISOString().slice(0, 10)}` }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create API key (${res.status}): ${body}`);
  }

  const { data } = await res.json();
  return data;
}

export async function login() {
  console.log('\n  ██ Robot Resources — Login\n');
  console.log('  Opening GitHub in your browser...');

  try {
    const { access_token, user } = await authenticate();

    console.log(`  ✓ Authenticated as ${user.user_metadata?.user_name || user.email}`);
    console.log('  Generating API key...');

    const key = await createApiKey(access_token);

    writeConfig({
      api_key: key.key,
      key_id: key.id,
      key_name: key.name,
      user_email: user.email,
      user_name: user.user_metadata?.user_name || null,
    });

    console.log(`  ✓ API key saved to ${getConfigPath()}`);
    console.log(`\n  You're all set. Router and Scraper will pick up the key automatically.\n`);
  } catch (err) {
    console.error(`\n  ✗ Login failed: ${err.message}\n`);
    process.exit(1);
  }
}
