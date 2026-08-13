// Fetch with retries for flaky networks.
const DEFAULT_RETRIES = 3;
const BASE_DELAY_MS = 250;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(url, options = {}) {
  const retries = options.retries ?? DEFAULT_RETRIES;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.status >= 500) throw new Error(`status ${res.status}`);
      if (!res.ok) return res; // client errors are not retryable
      return res;
    } catch (error) {
      lastError = error;
      await sleep(BASE_DELAY_MS * 2 ** attempt + Math.random() * 100);
    }
  }
  throw lastError;
}
