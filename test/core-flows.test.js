import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import request from "supertest";
import { MongoMemoryServer } from "mongodb-memory-server";

import { createTestApp, authHeaders, tokenForUuid } from "./helpers/create-test-app.js";
import { User } from "../server/models/User.js";
import { Message } from "../server/models/Message.js";
import { Group } from "../server/models/Group.js";
import { ChatSetting } from "../server/models/ChatSetting.js";

let mongoServer;
let app;

const syncUser = async ({ uuid, email, firstName, lastName }) => {
  const res = await request(app)
    .post("/api/users/sync")
    .set("Authorization", `Bearer ${tokenForUuid(uuid)}`)
    .send({
      user: {
        uuid,
        email,
        first_name: firstName,
        last_name: lastName,
        profile_picture_url: null,
      },
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  return res.body.user;
};

test.before(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri(), { dbName: "lovechatty_test" });
  app = createTestApp();
});

test.after(async () => {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }
});

test.beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}),
    Message.deleteMany({}),
    Group.deleteMany({}),
    ChatSetting.deleteMany({}),
  ]);
});

test("auth sync + me + profile update", async () => {
  await syncUser({
    uuid: "user-alice",
    email: "alice@example.com",
    firstName: "Alice",
    lastName: "Doe",
  });

  const me = await request(app)
    .get("/api/users/me")
    .set(authHeaders("user-alice"));

  assert.equal(me.status, 200);
  assert.equal(me.body.user.uuid, "user-alice");
  assert.equal(me.body.user.display_name, "Alice Doe");

  const update = await request(app)
    .patch("/api/users/me/profile")
    .set(authHeaders("user-alice"))
    .send({
      bio: "Builder and tester",
      website_url: "example.com",
      social_links: { github: "github.com/alice" },
    });

  assert.equal(update.status, 200);
  assert.equal(update.body.user.bio, "Builder and tester");
  assert.equal(update.body.user.website_url, "https://example.com");
  assert.equal(update.body.user.social_links.github, "https://github.com/alice");
});

test("nickname settings save and list conversation settings", async () => {
  await syncUser({ uuid: "user-alice", email: "alice@example.com", firstName: "Alice", lastName: "Doe" });

  const save = await request(app)
    .put("/api/settings?peer_uuid=user-bob")
    .set(authHeaders("user-alice"))
    .send({ custom_nickname: "Dog", theme: "default" });

  assert.equal(save.status, 200);
  assert.equal(save.body.settings.custom_nickname, "Dog");

  const list = await request(app)
    .get("/api/settings/conversations")
    .set(authHeaders("user-alice"));

  assert.equal(list.status, 200);
  assert.equal(Array.isArray(list.body.conversation_settings), true);
  assert.equal(list.body.conversation_settings[0].peer_uuid, "user-bob");
  assert.equal(list.body.conversation_settings[0].custom_nickname, "Dog");
});

test("direct message send and unread/read flow", async () => {
  await syncUser({ uuid: "user-alice", email: "alice@example.com", firstName: "Alice", lastName: "Doe" });
  await syncUser({ uuid: "user-bob", email: "bob@example.com", firstName: "Bob", lastName: "Ray" });

  const send = await request(app)
    .post("/api/messages")
    .set(authHeaders("user-alice"))
    .send({ receiver_id: "user-bob", content: "Hello Bob" });

  assert.equal(send.status, 201);
  assert.equal(send.body.message.sender_id, "user-alice");
  assert.equal(send.body.message.receiver_id, "user-bob");

  const bobListBefore = await request(app)
    .get("/api/users")
    .set(authHeaders("user-bob"));
  assert.equal(bobListBefore.status, 200);
  const aliceForBobBefore = bobListBefore.body.users.find((u) => u.uuid === "user-alice");
  assert.equal(aliceForBobBefore.unread_count, 1);
  assert.equal(aliceForBobBefore.last_message_preview, "Hello Bob");

  const markRead = await request(app)
    .post("/api/messages/user-alice/read")
    .set(authHeaders("user-bob"))
    .send({});
  assert.equal(markRead.status, 200);
  assert.equal(markRead.body.updated, 1);

  const bobListAfter = await request(app)
    .get("/api/users")
    .set(authHeaders("user-bob"));
  const aliceForBobAfter = bobListAfter.body.users.find((u) => u.uuid === "user-alice");
  assert.equal(aliceForBobAfter.unread_count, 0);
});

test("group messaging send/list/read works via group:<uuid> route", async () => {
  await syncUser({ uuid: "user-alice", email: "alice@example.com", firstName: "Alice", lastName: "Doe" });
  await syncUser({ uuid: "user-bob", email: "bob@example.com", firstName: "Bob", lastName: "Ray" });

  await Group.create({
    uuid: "group-test-1",
    name: "Test Group",
    createdByUuid: "user-alice",
    memberUuids: ["user-alice", "user-bob"],
  });

  const send = await request(app)
    .post("/api/messages")
    .set(authHeaders("user-alice"))
    .send({ receiver_id: "group:group-test-1", content: "Hello group" });

  assert.equal(send.status, 201);
  assert.equal(send.body.message.group_id, "group-test-1");
  assert.deepEqual(send.body.message.read_by_uuids, ["user-alice"]);

  const listForBob = await request(app)
    .get("/api/messages/group:group-test-1")
    .set(authHeaders("user-bob"));

  assert.equal(listForBob.status, 200);
  assert.equal(listForBob.body.messages.length, 1);
  assert.equal(listForBob.body.messages[0].content, "Hello group");
  assert.equal(listForBob.body.messages[0].group_id, "group-test-1");
  assert.equal(listForBob.body.messages[0].read_by_uuids.includes("user-bob"), true);
});
