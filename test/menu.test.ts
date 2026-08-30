import assert from "node:assert/strict";
import { test } from "node:test";
import { handleMenu, rootMenu } from "../src/menu.ts";

test("menu triggers open the root from any state", () => {
  for (const trigger of ["menu", "MENU", "/menu", "help", "/help", "?"]) {
    const action = handleMenu("tg:m1", trigger);
    assert.ok(action?.reply?.includes("Main menu"), `trigger ${trigger}`);
  }
});

test("digits navigate only while the menu is open", () => {
  // Not open: a bare digit is normal conversation.
  assert.equal(handleMenu("tg:m2", "2"), null);

  handleMenu("tg:m2", "menu");
  const projects = handleMenu("tg:m2", "1");
  assert.ok(projects?.reply?.includes("Projects"));

  const create = handleMenu("tg:m2", "2");
  assert.ok(create?.reply?.includes("Create a project"));
  assert.ok(create?.reply?.includes("MAPLE, Maple St Renovation"));

  // Leaf closes the menu: digits are conversation again.
  assert.equal(handleMenu("tg:m2", "2"), null);
});

test("free text closes the menu and passes through", () => {
  handleMenu("tg:m3", "menu");
  assert.equal(handleMenu("tg:m3", "what's the estimate total?"), null);
  assert.equal(handleMenu("tg:m3", "1"), null);
});

test("forward leaves hand a canned request to the agent", () => {
  handleMenu("tg:m4", "menu");
  const status = handleMenu("tg:m4", "5");
  assert.ok(status?.forward?.includes("status summary"));
  assert.equal(status?.reply, undefined);

  handleMenu("tg:m4", "menu");
  handleMenu("tg:m4", "1");
  const list = handleMenu("tg:m4", "1");
  assert.equal(list?.forward, "List my projects.");
});

test("an invalid option re-renders the current node", () => {
  handleMenu("tg:m5", "menu");
  const bad = handleMenu("tg:m5", "9");
  assert.ok(bad?.reply?.includes("not an option"));
  assert.ok(bad?.reply?.includes("Main menu"));
  // Still in the menu afterwards:
  assert.ok(handleMenu("tg:m5", "1")?.reply?.includes("Projects"));
});

test("0 reopens the root from anywhere", () => {
  handleMenu("tg:m6", "menu");
  handleMenu("tg:m6", "4");
  const back = handleMenu("tg:m6", "0");
  assert.ok(back?.reply?.includes("Main menu"));
});

test("every leaf instruction fits a chat message and mentions an example", () => {
  const leaves: [string, string[]][] = [
    ["1", ["2", "3"]],
    ["2", ["1", "2", "3"]],
    ["3", ["1"]],
    ["4", ["1", "3"]],
  ];
  let contact = 0;
  for (const [section, items] of leaves) {
    for (const item of items) {
      const id = `tg:leaf${contact++}`;
      handleMenu(id, "menu");
      handleMenu(id, section);
      const leaf = handleMenu(id, item);
      assert.ok(leaf?.reply, `leaf ${section}.${item} should reply`);
      assert.ok(leaf.reply!.length < 1200, `leaf ${section}.${item} too long`);
      assert.match(
        leaf.reply!,
        /Example|e\.g\.|```|advance|owner/i,
        `leaf ${section}.${item} should show concrete usage`,
      );
    }
  }
  assert.ok(rootMenu().includes("1. Projects"));
});
