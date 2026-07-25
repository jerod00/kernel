const fs = require("fs");
const webpush = require("web-push");

// Single-user, single-device by design (a personal admin PWA, not a
// multi-tenant product) — one subscription object overwritten on each new
// "Enable Notifications" tap is all that's needed. Persisted to the Fly
// volume (same one kernel.db lives on) so it survives deploys/restarts.
const SUBSCRIPTION_PATH = process.env.PUSH_SUBSCRIPTION_PATH || require("path").join(__dirname, ".push-subscription.json");

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_CONTACT_EMAIL = process.env.VAPID_CONTACT_EMAIL;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_CONTACT_EMAIL) {
  webpush.setVapidDetails(VAPID_CONTACT_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

function saveSubscription(subscription) {
  fs.writeFileSync(SUBSCRIPTION_PATH, JSON.stringify(subscription, null, 2), "utf8");
}

function loadSubscription() {
  try {
    return JSON.parse(fs.readFileSync(SUBSCRIPTION_PATH, "utf8"));
  } catch {
    return null;
  }
}

function clearSubscription() {
  try {
    fs.unlinkSync(SUBSCRIPTION_PATH);
  } catch {
    /* already gone */
  }
}

// Returns true if a push actually went out. A push service can reject an
// expired/revoked subscription (410 Gone, or 404) — that's the normal way a
// browser tells you it stopped listening (e.g. the PWA was uninstalled), not
// a bug, so it's handled by quietly clearing the stale subscription rather
// than surfacing an error.
async function sendPushNotification({ title, body, url }) {
  const subscription = loadSubscription();
  if (!subscription) return false;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    throw new Error("VAPID keys not configured on the server.");
  }
  try {
    await webpush.sendNotification(subscription, JSON.stringify({ title, body, url }));
    return true;
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      clearSubscription();
      return false;
    }
    throw err;
  }
}

module.exports = { saveSubscription, loadSubscription, clearSubscription, sendPushNotification, VAPID_PUBLIC_KEY };
