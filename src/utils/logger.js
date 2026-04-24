const REDACTED_KEYS = new Set(['cardToken', 'token', 'apiKey', 'api_key', 'secret', 'password', 'authorization']);

function redact(data) {
  if (!data || typeof data !== 'object') return data;
  if (Array.isArray(data)) return data.map(redact);
  const result = { ...data };
  for (const key of Object.keys(result)) {
    if (REDACTED_KEYS.has(key)) {
      result[key] = '[REDACTED]';
    } else if (typeof result[key] === 'object' && result[key] !== null) {
      result[key] = redact(result[key]);
    }
  }
  return result;
}

function log(level, context, message, data) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}] [${context}]`;
  if (data !== undefined) {
    console.log(prefix, message, JSON.stringify(redact(data)));
  } else {
    console.log(prefix, message);
  }
}

module.exports = { log };
