import { describe, expect, it } from "vitest";
import { testModeOverrides } from "./test-mode";

describe("testModeOverrides", () => {
  it("changes nothing in a normal run", () => {
    expect(testModeOverrides({})).toBeNull();
    expect(testModeOverrides({ STREAMY_TEST_MODE: "0" })).toBeNull();
    expect(testModeOverrides({ STREAMY_TEST_MODE: "true" })).toBeNull();
  });

  it("keeps the engine off the internet in test mode", () => {
    expect(testModeOverrides({ STREAMY_TEST_MODE: "1" })).toEqual({
      clientOptions: {
        dht: false,
        tracker: false,
        lsd: false,
        utPex: false,
        natUpnp: false,
        natPmp: false,
        webSeeds: false,
      },
      tuning: { trackers: [], allowLocalAddresses: true },
    });
  });
});
