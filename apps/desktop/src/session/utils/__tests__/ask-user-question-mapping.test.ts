import { describe, expect, it } from "vitest";
import type { UserQuestion } from "../../state/user-question-store";
import {
  formatQuestionAnswers,
  toAskUserQuestionItems,
} from "../ask-user-question-mapping";

const questions: UserQuestion[] = [
  {
    question: "Which auth method should we use?",
    header: "Auth method",
    multiSelect: false,
    options: [
      { label: "OAuth", description: "Standard OAuth 2.0 flow" },
      { label: "API key", description: "Static key per user" },
    ],
  },
  {
    question: "Which features do you want?",
    header: "Features",
    multiSelect: true,
    options: [
      { label: "Sync", description: "" },
      { label: "Offline", description: "" },
    ],
  },
];

describe("toAskUserQuestionItems", () => {
  it("maps tool questions onto component items with positional ids", () => {
    const items = toAskUserQuestionItems(questions);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: "q-0",
      title: "Which auth method should we use?",
      header: "Auth method",
      multiSelect: false,
      allowOther: true,
    });
    expect(items[0]?.options).toEqual([
      { id: "OAuth", title: "OAuth", description: "Standard OAuth 2.0 flow" },
      { id: "API key", title: "API key", description: "Static key per user" },
    ]);
    expect(items[1]).toMatchObject({ id: "q-1", multiSelect: true });
  });
});

describe("formatQuestionAnswers", () => {
  it("keys answers by question text and joins selected labels", () => {
    const formatted = formatQuestionAnswers(questions, {
      "q-0": { questionId: "q-0", selectedIds: ["OAuth"] },
      "q-1": { questionId: "q-1", selectedIds: ["Sync", "Offline"] },
    });

    expect(formatted).toEqual({
      "Which auth method should we use?": "OAuth",
      "Which features do you want?": "Sync, Offline",
    });
  });

  it("appends a trimmed free-form answer after the selected labels", () => {
    const formatted = formatQuestionAnswers(questions, {
      "q-1": {
        questionId: "q-1",
        selectedIds: ["Sync"],
        otherText: "  P2P replication  ",
      },
    });

    expect(formatted).toEqual({
      "Which features do you want?": "Sync, P2P replication",
    });
  });

  it("uses the free-form answer alone when nothing is selected", () => {
    const formatted = formatQuestionAnswers(questions, {
      "q-0": { questionId: "q-0", selectedIds: [], otherText: "SAML" },
    });

    expect(formatted).toEqual({
      "Which auth method should we use?": "SAML",
    });
  });

  it("omits skipped and unanswered questions", () => {
    const formatted = formatQuestionAnswers(questions, {
      "q-0": { questionId: "q-0", selectedIds: ["OAuth"], skipped: true },
      "q-1": { questionId: "q-1", selectedIds: [], otherText: "   " },
    });

    expect(formatted).toEqual({});
  });
});
