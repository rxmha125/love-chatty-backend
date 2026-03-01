import webpush from "web-push";
import { config } from "../config.js";
import { User } from "../models/User.js";

const hasPushConfig = Boolean(
  config.webPushPublicKey && config.webPushPrivateKey && config.webPushSubject,
);

if (hasPushConfig) {
  webpush.setVapidDetails(
    config.webPushSubject,
    config.webPushPublicKey,
    config.webPushPrivateKey,
  );
}

const toWebPushSubscription = (subscription) => ({
  endpoint: subscription.endpoint,
  expirationTime:
    typeof subscription.expirationTime === "number" ? subscription.expirationTime : null,
  keys: {
    p256dh: subscription.keys?.p256dh || "",
    auth: subscription.keys?.auth || "",
  },
});

const asPayload = (payload = {}) =>
  JSON.stringify({
    title: payload.title || "LoveChatty",
    body: payload.body || "",
    icon: payload.icon || "/logo_new.png",
    badge: payload.badge || "/favicon.ico",
    tag: payload.tag || undefined,
    renotify: Boolean(payload.renotify),
    requireInteraction: Boolean(payload.requireInteraction),
    data: payload.data || {},
    actions: Array.isArray(payload.actions) ? payload.actions : [],
  });

export const sendPushToUser = async (userUuid, payload) => {
  if (!hasPushConfig || !userUuid) {
    return {
      delivered: 0,
      failed: 0,
      disabled: !hasPushConfig,
    };
  }

  const user = await User.findOne({ uuid: userUuid });
  if (!user || !Array.isArray(user.pushSubscriptions) || user.pushSubscriptions.length === 0) {
    return { delivered: 0, failed: 0, disabled: false };
  }

  let delivered = 0;
  let failed = 0;
  const invalidEndpoints = new Set();
  const payloadBody = asPayload(payload);

  for (const subscription of user.pushSubscriptions) {
    try {
      await webpush.sendNotification(toWebPushSubscription(subscription), payloadBody);
      delivered += 1;
    } catch (error) {
      failed += 1;
      const statusCode = Number(error?.statusCode || 0);
      if ((statusCode === 404 || statusCode === 410) && subscription.endpoint) {
        invalidEndpoints.add(subscription.endpoint);
      }
    }
  }

  if (invalidEndpoints.size > 0) {
    user.pushSubscriptions = user.pushSubscriptions.filter(
      (item) => !invalidEndpoints.has(item.endpoint),
    );
    await user.save();
  }

  return {
    delivered,
    failed,
    disabled: false,
  };
};

