import { describe, expect, it } from "vitest";
import { gitlabTrackProxyTarget } from "./gitlabTrackProxy.js";

describe("gitlabTrackProxyTarget", () => {
  it("keeps nested project ids and only the Track query allowlist", () => {
    expect(gitlabTrackProxyTarget(
      "https://gitlab.example.test/api/v4",
      "/projects/group%2Fsub%2Frepo/issues?scope=all&state=opened&per_page=100&private_token=leak",
    )).toBe("https://gitlab.example.test/api/v4/projects/group%2Fsub%2Frepo/issues?scope=all&state=opened&per_page=100");
  });

  it("rejects non-HTTPS hosts, credentials, and paths outside issues, notes, or members", () => {
    expect(gitlabTrackProxyTarget("http://gitlab.test", "/projects/a%2Fb/issues")).toBeNull();
    expect(gitlabTrackProxyTarget("https://user:pass@gitlab.test", "/projects/a%2Fb/issues")).toBeNull();
    expect(gitlabTrackProxyTarget("https://gitlab.test", "/projects/a%2Fb/repository/files/secrets")).toBeNull();
    expect(gitlabTrackProxyTarget("https://gitlab.test", "/projects/a%2Fb/issues/2/notes")).toBe("https://gitlab.test/api/v4/projects/a%2Fb/issues/2/notes");
  });
});
