// Sends text messages through Africa's Talking (https://africastalking.com), which reaches every Kenyan network.
// Set AT_USERNAME and AT_API_KEY, plus AT_SENDER_ID if you have a registered sender name. Use AT_USERNAME=sandbox
// with a sandbox key to test without sending real messages.
// Without these settings the message is printed to the server console so the app can be tried locally;
// in production that is refused, because codes would never reach anyone.

const USERNAME = process.env.AT_USERNAME;
const API_KEY = process.env.AT_API_KEY;
const SENDER_ID = process.env.AT_SENDER_ID;
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
  const data = await res.json().catch(() => null);
  const recipient = data?.SMSMessageData?.Recipients?.[0];
  if (!res.ok || !recipient || recipient.status !== 'Success') {
    throw new Error(`SMS failed: ${res.status} ${recipient?.status ?? data?.SMSMessageData?.Message ?? ''}`);
  }
}

module.exports = { sendSms };
