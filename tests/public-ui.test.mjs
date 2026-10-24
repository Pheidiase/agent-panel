import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { clientModules } from "./fixtures/client-modules.mjs";
import { clientDom } from "./fixtures/client-dom.mjs";
import { appFixture, elements, content } from "./fixtures/app-tree.mjs";

test("agent names, accessible radios and general project labels follow language while catalog and IDs stay intact", t => {
  const f = appFixture(t), original = JSON.stringify([f.agents, f.projects]);
  for (const [language, shell, general] of [["tr", "Kabuk", "Genel"], ["en", "Shell", "General"], ["tr", "Kabuk", "Genel"]]) {
    f.i18n.setLanguage(language); f.state.selected = null;
    let tree = f.render();
    const radios = elements(tree).filter(node => node.props.role === "radio" && f.agents.some(agent => agent.id === node.props["data-id"]));
    assert.equal(radios.length, 8);
    for (const radio of radios) {
      const id = radio.props["data-id"];
      assert.equal(radio.props["aria-label"], id === "shell" ? shell : id);
      assert.ok(content(radio).includes(radio.props["aria-label"]));
    }
    assert.equal(elements(tree).find(node => node.type === "option" && node.props.value === "general").props.children, general);
    assert.ok(content(tree).includes(shell + " · Ubuntu"));
    f.state.selected = "test"; tree = f.render();
    assert.equal(elements(tree).find(node => node.props.className === "heading-agent agent-shell").props.children, shell);
    assert.equal(elements(tree).find(node => node.props.className === "heading-project").props.children, general);
    assert.equal(JSON.stringify([f.agents, f.projects]), original);
  }
});

test("document title follows active language from initialization and index has a neutral default", t => {
  const dom = clientDom(); t.after(() => dom.restore());
  const i18n = clientModules()("i18n.ts");
  assert.equal(document.title, i18n.t("main.documentTitle"));
  for (const language of ["tr", "en", "tr"]) {
    i18n.setLanguage(language);
    assert.equal(document.title, language === "tr" ? "Agent Panel · Çalışma alanın" : "Agent Panel · Your workspace");
    assert.equal(document.documentElement.lang, language);
  }
  assert.match(fs.readFileSync(new URL("../index.html", import.meta.url), "utf8"), /<title>Agent Panel<\/title>/);
});

test("mobile attention bell hides a zero badge and shows positive unread counts", t => {
  for (const unread of [0, 3]) {
    const f = appFixture(t, { unread });
    for (const selected of [null, "test"]) {
      f.state.selected = selected;
      const tree = f.render();
      const bell = elements(tree).find(node => node.props.className === "inbox-bell mobile-inbox icon-button");
      const badge = elements(bell).find(node => node.props.className === "count attention-count");
      if (unread === 0) assert.equal(badge, undefined);
      else assert.equal(content(badge), "3");
    }
  }
});
