import { randomUUID } from "crypto";
import { Router } from "express";
import { requireAuth } from "../middleware/require-auth.js";
import { Group } from "../models/Group.js";
import { User } from "../models/User.js";
import { buildDisplayName, toClientUser } from "../utils/transformers.js";

const router = Router();

const createGroupUuid = () => {
  try {
    return randomUUID();
  } catch {
    return `group-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
};

const uniqueStrings = (values = []) =>
  Array.from(
    new Set(
      values
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );

const toClientGroup = (group, memberPreviewUsers = []) => ({
  id: group.uuid,
  uuid: group.uuid,
  type: "group",
  name: group.name || "Group",
  profile_picture_url: group.profilePictureUrl || null,
  created_by: group.createdByUuid,
  member_uuids: Array.isArray(group.memberUuids) ? group.memberUuids : [],
  members_count: Array.isArray(group.memberUuids) ? group.memberUuids.length : 0,
  member_previews: memberPreviewUsers.map((user) => ({
    uuid: user.uuid,
    display_name: buildDisplayName(user),
    profile_picture_url: user.profilePictureUrl || null,
  })),
  created_at: group.createdAt ? group.createdAt.toISOString() : null,
  updated_at: group.updatedAt ? group.updatedAt.toISOString() : null,
});

const loadMemberPreviewUsers = async (memberUuids = []) => {
  const previewIds = uniqueStrings(memberUuids).slice(0, 6);
  if (previewIds.length === 0) {
    return [];
  }
  const users = await User.find({ uuid: { $in: previewIds } });
  const byId = new Map(users.map((user) => [user.uuid, user]));
  return previewIds.map((uuid) => byId.get(uuid)).filter(Boolean);
};

router.get("/", requireAuth, async (req, res) => {
  const currentUserUuid = req.auth.userUuid;
  const groups = await Group.find({ memberUuids: currentUserUuid }).sort({ updatedAt: -1, createdAt: -1 });

  const payload = await Promise.all(
    groups.map(async (group) => {
      const memberUsers = await loadMemberPreviewUsers(group.memberUuids || []);
      return toClientGroup(group, memberUsers);
    }),
  );

  return res.json({
    success: true,
    groups: payload,
  });
});

router.post("/", requireAuth, async (req, res) => {
  const currentUserUuid = req.auth.userUuid;
  const name = String(req.body?.name || "").trim();
  const memberUuidsInput = Array.isArray(req.body?.member_uuids)
    ? req.body.member_uuids
    : Array.isArray(req.body?.memberUuids)
      ? req.body.memberUuids
      : [];

  if (!name) {
    return res.status(400).json({ success: false, message: "Group name is required" });
  }

  const uniqueMemberUuids = uniqueStrings([currentUserUuid, ...memberUuidsInput]).filter(
    (uuid) => uuid !== "profile",
  );

  if (uniqueMemberUuids.length < 2) {
    return res.status(400).json({
      success: false,
      message: "Select at least 1 contact to create a group",
    });
  }

  const existingUsers = await User.find({ uuid: { $in: uniqueMemberUuids } }).select({ uuid: 1 });
  const existingUserIds = new Set(existingUsers.map((user) => user.uuid));
  const validMemberUuids = uniqueMemberUuids.filter((uuid) => existingUserIds.has(uuid));

  if (!validMemberUuids.includes(currentUserUuid)) {
    validMemberUuids.unshift(currentUserUuid);
  }

  if (validMemberUuids.length < 2) {
    return res.status(400).json({
      success: false,
      message: "Selected contacts are invalid",
    });
  }

  const group = await Group.create({
    uuid: createGroupUuid(),
    name: name.slice(0, 80),
    createdByUuid: currentUserUuid,
    memberUuids: validMemberUuids,
    profilePictureUrl:
      typeof req.body?.profile_picture_url === "string" && req.body.profile_picture_url.trim()
        ? req.body.profile_picture_url.trim()
        : null,
  });

  const memberUsers = await loadMemberPreviewUsers(group.memberUuids || []);
  return res.status(201).json({
    success: true,
    group: toClientGroup(group, memberUsers),
  });
});

router.get("/:groupUuid", requireAuth, async (req, res) => {
  const currentUserUuid = req.auth.userUuid;
  const groupUuid = String(req.params.groupUuid || "").trim();
  const group = await Group.findOne({ uuid: groupUuid });
  if (!group) {
    return res.status(404).json({ success: false, message: "Group not found" });
  }

  if (!Array.isArray(group.memberUuids) || !group.memberUuids.includes(currentUserUuid)) {
    return res.status(403).json({ success: false, message: "Not allowed" });
  }

  const memberUsers = await User.find({ uuid: { $in: group.memberUuids || [] } });
  const presence = req.app.get("presence");
  const memberPayload = memberUsers.map((user) => toClientUser(user, presence.isOnline(user.uuid)));
  const previewUsers = await loadMemberPreviewUsers(group.memberUuids || []);

  return res.json({
    success: true,
    group: {
      ...toClientGroup(group, previewUsers),
      members: memberPayload,
    },
  });
});

export default router;