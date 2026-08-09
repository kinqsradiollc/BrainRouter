/**
 * ADR-032 Q4 — static accessibility contract for the hosted correction form.
 *
 * The protected dashboard needs a signed-in browser for live interaction, so
 * this focused server render pins the form's explicit labels and trusted-action
 * language without weakening AuthGuard or requiring credentials.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { HumanCorrectionForm } from "./HumanCorrectionForm";

test("hosted correction form exposes four labelled fields and an explicit trusted action", () => {
  const html = renderToStaticMarkup(createElement(HumanCorrectionForm, {
    activeOrgName: "Example organization",
    busy: false,
    requestError: "",
    onCancel: () => {},
    onEdit: () => {},
    onSubmit: async () => {},
  }));

  assert.match(html, /<form[^>]+id="human-correction-form"[^>]+aria-labelledby="human-correction-title"/);
  assert.match(html, /for="correction-session-key"/);
  assert.match(html, /for="correction-statement"/);
  assert.match(html, /for="correction-falsifier"/);
  assert.match(html, /for="correction-expectation"/);
  assert.match(html, /Ordinary chat messages never create instruction-tier learned behavior/);
  assert.match(html, /type="submit"[^>]*>Record correction</);
});
