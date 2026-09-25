import assert from "node:assert/strict";
import test from "node:test";

import { PrePowerlineHost } from "pi-tsien-session-ui-fork/src/powerline/pre-powerline.ts";
const fakeTui = {};
const fakeTheme = {};

function component(lines, counters = {}) {
  return {
    render() {
      counters.renders = (counters.renders ?? 0) + 1;
      return lines;
    },
    invalidate() {
      counters.invalidates = (counters.invalidates ?? 0) + 1;
    },
    dispose() {
      counters.disposes = (counters.disposes ?? 0) + 1;
    },
  };
}

test("renders registered components in insertion order", () => {
  let requested = 0;
  const host = new PrePowerlineHost({ requestRender: () => requested++ });
  host.register("first", () => component(["first"]));
  host.register("second", () => component(["second"]));

  assert.deepEqual(host.render(80, fakeTui, fakeTheme), ["first", "second"]);
  assert.equal(requested, 2);
});

test("replacement unregister cannot remove the newer registration", () => {
  const host = new PrePowerlineHost({ requestRender() {} });
  const unregisterOld = host.register("command", () => component(["old"]));
  host.register("command", () => component(["new"]));

  unregisterOld();
  assert.deepEqual(host.render(80, fakeTui, fakeTheme), ["new"]);
});

test("isolates a failed component and keeps healthy components visible", () => {
  const errors = [];
  const host = new PrePowerlineHost({
    requestRender() {},
    onError: (key, error) => errors.push([key, String(error)]),
  });
  host.register("broken", () => ({
    render() {
      throw new Error("boom");
    },
    invalidate() {},
  }));
  host.register("healthy", () => component(["healthy"]));

  assert.deepEqual(host.render(80, fakeTui, fakeTheme), ["healthy"]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], "broken");
  assert.deepEqual(host.render(80, fakeTui, fakeTheme), ["healthy"]);
  assert.equal(errors.length, 1);
});

test("disposing component instances preserves registrations for the next session render", () => {
  const counters = {};
  const host = new PrePowerlineHost({ requestRender() {} });
  host.register("command", () => component(["line"], counters));
  host.render(80, fakeTui, fakeTheme);

  host.disposeComponents();
  assert.equal(counters.disposes, 1);
  assert.deepEqual(host.render(80, fakeTui, fakeTheme), ["line"]);
  assert.equal(counters.renders, 2);
});

test("reset disposes children and clears registrations", () => {
  const counters = {};
  const host = new PrePowerlineHost({ requestRender() {} });
  host.register("command", () => component(["line"], counters));
  host.render(80, fakeTui, fakeTheme);

  host.reset();
  assert.equal(counters.disposes, 1);
  assert.deepEqual(host.render(80, fakeTui, fakeTheme), []);
});
