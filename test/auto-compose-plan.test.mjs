import assert from "node:assert/strict";
import test from "node:test";

import {
  digestAutoComposePagePlan,
  validateAutoComposePagePlan,
} from "../mcp/lib/auto-compose-plan.mjs";

function validPlan() {
  return {
    schemaVersion: "3",
    pagePlan: {
      version: "3",
      frame: { width: 1600, height: 1000 },
      padding: 24,
      gutter: 24,
      slots: [
        {
          id: "slot:111111111111",
          blockId: "block:111111111111",
          route: "visual",
          region: "Visual",
          rect: { x: 24, y: 24, w: 500, h: 952 },
          padding: 24,
          order: 1,
          fit: "cover",
          contentSpec: {
            type: "visual",
            brief: "Caf\u00e9 exterior\nRainy evening",
            focalPoint: "Player silhouette",
            styleSourceIds: ["source:mood"],
          },
        },
        {
          id: "slot:222222222222",
          blockId: "block:222222222222",
          route: "diagram",
          region: "Structure",
          rect: { x: 548, y: 24, w: 650, h: 600 },
          padding: 24,
          order: 2,
          fit: "native",
          contentSpec: {
            type: "diagram",
            diagramType: "flow",
            teachingClaim: "Choices update the narrative state.",
            readingOrder: "top-to-bottom",
            objects: [
              { id: "choice", label: "Player choice", type: "interface" },
              { id: "state", label: "Narrative state", type: "state" },
            ],
            relations: [
              {
                id: "choice-state",
                from: "choice",
                to: "state",
                label: "updates",
                direction: "forward",
                path: "primary",
              },
            ],
          },
        },
        {
          id: "slot:333333333333",
          blockId: "block:333333333333",
          route: "evidence",
          region: "Evidence",
          rect: { x: 1222, y: 24, w: 354, h: 600 },
          padding: 24,
          order: 3,
          fit: "native",
          contentSpec: {
            type: "evidence",
            cards: [
              {
                id: "constraint",
                role: "evidence",
                title: "Branch budget",
                body: "Each decision exposes at most three branches.",
                sourceShapeIds: ["shape:brief"],
                sourceRefs: ["source:brief"],
              },
            ],
          },
        },
      ],
    },
  };
}

function clone(value) {
  return structuredClone(value);
}

test("validates, normalizes, orders, and deeply freezes a v3 page plan", () => {
  const input = validPlan();
  input.pagePlan.slots.reverse();
  const normalized = validateAutoComposePagePlan(input);

  assert.deepEqual(normalized.pagePlan.slots.map(({ order }) => order), [1, 2, 3]);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.pagePlan), true);
  assert.equal(Object.isFrozen(normalized.pagePlan.slots), true);
  assert.equal(Object.isFrozen(normalized.pagePlan.slots[1].contentSpec.objects), true);
  assert.throws(() => {
    normalized.pagePlan.padding = 32;
  }, TypeError);
  assert.equal(
    digestAutoComposePagePlan(input),
    "0be71aed3f8bcd28a5b14015a4e2133a2fc20b51ba66e52fe02320820f46ee59",
  );
});

test("digest is stable across key order, NFC, line endings, and slot input order", () => {
  const left = validPlan();
  const right = validPlan();
  right.pagePlan.slots = [
    right.pagePlan.slots[2],
    right.pagePlan.slots[0],
    right.pagePlan.slots[1],
  ];
  right.pagePlan.slots.find(({ route }) => route === "visual").contentSpec = {
    styleSourceIds: ["source:mood"],
    focalPoint: "Player silhouette",
    brief: "Cafe\u0301 exterior\r\nRainy evening",
    type: "visual",
  };

  assert.equal(digestAutoComposePagePlan(left), digestAutoComposePagePlan(right));
});

test("digest changes when bounded page content changes", () => {
  const left = validPlan();
  const right = validPlan();
  right.pagePlan.slots[2].contentSpec.cards[0].body = "Each decision exposes at most two branches.";
  assert.notEqual(digestAutoComposePagePlan(left), digestAutoComposePagePlan(right));
});

test("rejects wrong schema versions, frames, padding, and out-of-bounds rectangles", async (t) => {
  await t.test("schema version", () => {
    const plan = validPlan();
    plan.schemaVersion = "2";
    assert.throws(() => validateAutoComposePagePlan(plan), /schemaVersion.*exactly "3"/);
  });
  await t.test("page plan version", () => {
    const plan = validPlan();
    plan.pagePlan.version = "2";
    assert.throws(() => validateAutoComposePagePlan(plan), /pagePlan\.version.*exactly "3"/);
  });
  await t.test("frame", () => {
    const plan = validPlan();
    plan.pagePlan.frame.width = 1599;
    assert.throws(() => validateAutoComposePagePlan(plan), /exactly 1600x1000/);
  });
  await t.test("padding", () => {
    const plan = validPlan();
    plan.pagePlan.padding = 23;
    assert.throws(() => validateAutoComposePagePlan(plan), /padding.*at least 24/);
  });
  await t.test("rectangle", () => {
    const plan = validPlan();
    plan.pagePlan.slots[0].rect.x = 23;
    assert.throws(() => validateAutoComposePagePlan(plan), /fit inside.*padding/);
  });
});

test("rejects overlapping slots and insufficient gutters", async (t) => {
  await t.test("overlap", () => {
    const plan = validPlan();
    plan.pagePlan.slots[1].rect.x = 500;
    assert.throws(() => validateAutoComposePagePlan(plan), /overlapping slots/);
  });
  await t.test("configured gutter below minimum", () => {
    const plan = validPlan();
    plan.pagePlan.gutter = 23;
    assert.throws(() => validateAutoComposePagePlan(plan), /gutter.*at least 24/);
  });
  await t.test("slot separation below configured gutter", () => {
    const plan = validPlan();
    plan.pagePlan.gutter = 32;
    assert.throws(() => validateAutoComposePagePlan(plan), /at least 32 units of gutter/);
  });
});

test("rejects duplicate slot ids, block ids, and orders", async (t) => {
  await t.test("slot id", () => {
    const plan = validPlan();
    plan.pagePlan.slots[1].id = plan.pagePlan.slots[0].id;
    assert.throws(() => validateAutoComposePagePlan(plan), /duplicate slot id/);
  });
  await t.test("block id", () => {
    const plan = validPlan();
    plan.pagePlan.slots[1].blockId = plan.pagePlan.slots[0].blockId;
    assert.throws(() => validateAutoComposePagePlan(plan), /duplicate block id/);
  });
  await t.test("order", () => {
    const plan = validPlan();
    plan.pagePlan.slots[1].order = plan.pagePlan.slots[0].order;
    assert.throws(() => validateAutoComposePagePlan(plan), /duplicate order/);
  });
});

test("enforces slot, visual, diagram, relation, and evidence capacities", async (t) => {
  await t.test("at least two slots", () => {
    const plan = validPlan();
    plan.pagePlan.slots = plan.pagePlan.slots.slice(0, 1);
    assert.throws(() => validateAutoComposePagePlan(plan), /between 2 and 12 slots/);
  });
  await t.test("at most twelve slots", () => {
    const plan = validPlan();
    plan.pagePlan.slots = Array.from({ length: 13 }, (_, index) => ({
      ...clone(plan.pagePlan.slots[2]),
      id: `slot:${index.toString(16).padStart(12, "0")}`,
      blockId: `block:${index.toString(16).padStart(12, "0")}`,
      order: index + 1,
    }));
    assert.throws(() => validateAutoComposePagePlan(plan), /between 2 and 12 slots/);
  });
  await t.test("at most six visual slots", () => {
    const plan = validPlan();
    plan.pagePlan.slots = Array.from({ length: 7 }, (_, index) => ({
      ...clone(plan.pagePlan.slots[0]),
      id: `slot:${index.toString(16).padStart(12, "0")}`,
      blockId: `block:${index.toString(16).padStart(12, "0")}`,
      order: index + 1,
    }));
    assert.throws(() => validateAutoComposePagePlan(plan), /more than 6 visual slots/);
  });
  await t.test("diagram objects", () => {
    const plan = validPlan();
    const spec = plan.pagePlan.slots[1].contentSpec;
    spec.objects = Array.from({ length: 9 }, (_, index) => ({
      id: `node-${index}`,
      label: `Node ${index}`,
    }));
    spec.relations = [];
    assert.throws(() => validateAutoComposePagePlan(plan), /between 1 and 8 objects/);
  });
  await t.test("diagram relations", () => {
    const plan = validPlan();
    const spec = plan.pagePlan.slots[1].contentSpec;
    spec.relations = Array.from({ length: 11 }, (_, index) => ({
      id: `relation-${index}`,
      from: "choice",
      to: "state",
    }));
    assert.throws(() => validateAutoComposePagePlan(plan), /more than 10 relations/);
  });
  await t.test("evidence cards", () => {
    const plan = validPlan();
    const spec = plan.pagePlan.slots[2].contentSpec;
    spec.cards = Array.from({ length: 5 }, (_, index) => ({
      id: `card-${index}`,
      title: `Card ${index}`,
    }));
    assert.throws(() => validateAutoComposePagePlan(plan), /between 1 and 4 cards/);
  });
});

test("rejects route and contentSpec mismatches", () => {
  const plan = validPlan();
  plan.pagePlan.slots[0].contentSpec = clone(plan.pagePlan.slots[1].contentSpec);
  assert.throws(
    () => validateAutoComposePagePlan(plan),
    /contentSpec\.type.*must be "visual" for a visual slot/,
  );
});

test("rejects non-canonical slot and block identities", () => {
  const plan = validPlan();
  plan.pagePlan.slots[0].id = "slot:visual";
  assert.throws(
    () => validateAutoComposePagePlan(plan),
    /slot:<12-lowercase-hex>/,
  );

  const blockPlan = validPlan();
  blockPlan.pagePlan.slots[0].blockId = "block:VISUAL000000";
  assert.throws(
    () => validateAutoComposePagePlan(blockPlan),
    /block:<12-lowercase-hex>/,
  );
});
