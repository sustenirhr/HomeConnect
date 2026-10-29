// Sends text messages through Africa's Talking (https://africastalking.com), which reaches every Kenyan network.
// Set AT_USERNAME and AT_API_KEY, plus AT_SENDER_ID if you have a registered sender name. Use AT_USERNAME=sandbox
// with a sandbox key to test without sending real messages.
// Without these settings the message is printed to the server console so the app can be tried locally;
// in production that is refused, because codes would never reach anyone.

// Trimmed because a pasted key often carries a stray space or line break, which Africa's Talking rejects.
const USERNAME = process.env.AT_USERNAME?.trim();
const API_KEY = process.env.AT_API_KEY?.trim();
const SENDER_ID = process.env.AT_SENDER_ID?.trim();
const PRODUCTION = process.env.NODE_ENV === 'production';
const ENDPOINT =
  USERNAME === 'sandbox' ? 'https://api.sandbox.africastalking.com/version1/messaging' : 'https://api.africastalking.com/version1/messaging';

// Africa's Talking needs international format: 0712 345 678 becomes +254712345678.
function international(phone) {
  if (phone.startsWith('+')) return phone;
  if (phone.startsWith('254')) return `+${phone}`;
  if (phone.startsWith('0')) return `+254${phone.slice(1)}`;
  return `+${phone}`;
}

async function sendSms(phone, message) {
  if (!USERNAME || !API_KEY) {
    if (PRODUCTION) throw new Error('SMS is not configured: set AT_USERNAME and AT_API_KEY');
    console.log(`[sms to ${phone}] ${message}`);
    return;
  }
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { apiKey: API_KEY, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: USERNAME, to: international(phone), message, ...(SENDER_ID ? { from: SENDER_ID } : {}) }),
    signal: AbortSignal.timeout(10_000),
  });
  // Errors such as a bad key come back as plain text, not JSON, so read the text first.
  const text = await res.text().catch(() => '');
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  const recipient = data?.SMSMessageData?.Recipients?.[0];
  if (!res.ok || !recipient || recipient.status !== 'Success') {
    const reason = recipient?.status ?? data?.SMSMessageData?.Message ?? text.slice(0, 200);
    // Enough to spot a wrong username or a mis-pasted key without logging the key itself.
    const account = `username "${USERNAME}", key ${API_KEY.length} characters ending ${API_KEY.slice(-4)}`;
    throw new Error(`SMS failed: ${res.status} ${reason} (${account})`);
  }
}

// Logs in once at startup (no text is sent) so a bad username or key shows up in the logs straight away.
async function checkSmsAccount() {
  if (!USERNAME || !API_KEY) return;
  const account = `username "${USERNAME}", key ${API_KEY.length} characters starting ${API_KEY.slice(0, 5)} ending ${API_KEY.slice(-4)}`;
  try {
    const res = await fetch(`${ENDPOINT.replace('/messaging', '/user')}?username=${encodeURIComponent(USERNAME)}`, {
      headers: { apiKey: API_KEY, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (res.ok) console.log(`[sms check] Africa's Talking login OK (${account}): ${text.slice(0, 200)}`);
    else console.error(`[sms check] Africa's Talking login FAILED: ${res.status} ${text.slice(0, 200)} (${account})`);
  } catch (err) {
    console.error(`[sms check] could not reach Africa's Talking: ${err.message}`);
  }
}

module.exports = { sendSms, checkSmsAccount };
