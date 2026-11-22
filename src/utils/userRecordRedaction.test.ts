import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isUserRecord, stripUserRecords, stripUserRecordsFromResult, stripUserRecordsFromText } from "./userRecordRedaction.js";

const TOKEN = `03AFcWeA${"y".repeat(40)}`;
const user = () => ({
  _id: "u1",
  email: "agent@gleap.test",
  firstName: "Ada",
  lastName: "Agent",
  profileImageUrl: "https://cdn.gleap.test/ada.png",
  token: TOKEN,
  gaClientId: "GA1.1.42",
  notificationSettings: { assigned: { email: true } },
});
const PUBLIC = { _id: "u1", email: "agent@gleap.test", firstName: "Ada", lastName: "Agent", profileImageUrl: "https://cdn.gleap.test/ada.png" };

describe("isUserRecord", () => {
  test("a dashboard user document -> yes", () => assert.equal(isUserRecord(user()), true));
  test("a contact (name, email, customData) -> no", () =>
    assert.equal(isUserRecord({ _id: "c1", name: "Casey", email: "casey@acme.test", customData: { token: "x" } }), false));
  test("a public user or a get_users entry -> no", () => {
    assert.equal(isUserRecord(PUBLIC), false);
    assert.equal(isUserRecord({ id: "u1", email: "a@b.c", firstName: "Ada", role: "admin", available: true, lastSeen: null }), false);
  });
  test("a token without an identity -> no", () => assert.equal(isUserRecord({ token: "upload-token", url: "https://x" }), false));
});

describe("stripUserRecords", () => {
  test("nested records, in objects and lists -> public shape; the rest unchanged", () => {
    const input = { ticket: { processingUser: user(), title: "Invoice" }, comments: [{ user: user(), text: "hi" }] };
    const out = stripUserRecords(input);
    assert.deepEqual(out, { ticket: { processingUser: PUBLIC, title: "Invoice" }, comments: [{ user: PUBLIC, text: "hi" }] });
    assert.equal(input.ticket.processingUser.token, TOKEN, "the input is not changed");
  });
  test("a stripped result strips again to the same", () => {
    const once = stripUserRecords({ processingUser: user() });
    assert.deepEqual(stripUserRecords(once), once);
  });
});

describe("stripUserRecordsFromText", () => {
  test("JSON keeps its formatting style", () => {
    const pretty = JSON.stringify({ processingUser: user() }, null, 2);
    assert.equal(stripUserRecordsFromText(pretty), JSON.stringify({ processingUser: PUBLIC }, null, 2));
    assert.equal(stripUserRecordsFromText(JSON.stringify(user())), JSON.stringify(PUBLIC));
  });
  test("prose around JSON and JSON escaped in a string -> token and gaClientId values removed", () => {
    for (const text of [`Assigned:\n${JSON.stringify(user())}`, JSON.stringify({ result: JSON.stringify(user()) })]) {
      const out = stripUserRecordsFromText(text);
      assert.equal(out.includes(TOKEN), false, out);
      assert.equal(out.includes("GA1.1.42"), false, out);
      assert.match(out, /Ada/);
    }
  });
  test("text without a user record -> unchanged", () => {
    const text = JSON.stringify({ uploadUrl: "https://x", token: "upload-token" });
    assert.equal(stripUserRecordsFromText(text), text);
    assert.equal(stripUserRecordsFromText("plain words"), "plain words");
  });
});

test("stripUserRecordsFromResult -> text blocks and structuredContent; other blocks untouched", () => {
  const image = { type: "image", data: "AAAA", mimeType: "image/png" };
  const out = stripUserRecordsFromResult({
    content: [{ type: "text", text: JSON.stringify({ user: user() }) }, image],
    structuredContent: { user: user() },
  });
  assert.deepEqual(out, {
    content: [{ type: "text", text: JSON.stringify({ user: PUBLIC }) }, image],
    structuredContent: { user: PUBLIC },
  });
});
