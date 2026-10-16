// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderAs } from "../../test/render";
import { ClearHistoryButton } from "./ClearHistory";

vi.setConfig({ testTimeout: 20_000 });

function stub() {
  const posts: { url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    posts.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ detections: 12, alerts: 3, evidenceFiles: 3, keptPending: 2 }), { status: 200 });
  }));
  return posts;
}
afterEach(() => vi.unstubAllGlobals());

describe("Clear history", () => {
  it("is not offered to analysts or auditors", () => {
    stub();
    for (const role of ["analyst", "auditor"] as const) {
      const { unmount } = renderAs(role, <ClearHistoryButton />);
      expect(screen.queryByRole("button", { name: /Clear history/ })).toBeNull();
      unmount();
    }
  });

  it("needs a justification, keeps pending alerts by default, and reports what went", async () => {
    const posts = stub();
    const user = userEvent.setup({ delay: null });
    renderAs("admin", <ClearHistoryButton />);
    await user.click(screen.getByRole("button", { name: /Clear history/ }));
    const confirm = () => screen.getAllByRole("button", { name: /Clear history/ }).at(-1)!;

    await user.type(screen.getByLabelText("Justification"), "too short");
    await user.click(confirm());
    expect(screen.getByRole("alert")).toHaveTextContent(/at least 20 characters/);
    expect(posts).toHaveLength(0);

    await user.type(screen.getByLabelText("Justification"), " but now it explains the reset.");
    await user.click(confirm());
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].url).toContain("/admin/detections/purge");
    expect(posts[0].body).toMatchObject({ includePending: false });
    expect(await screen.findByText(/12 reads, 3 alerts and 3 frames removed; 2 pending alerts kept/)).toBeInTheDocument();
  });

  it("deletes pending alerts only when the box is ticked", async () => {
    const posts = stub();
    const user = userEvent.setup({ delay: null });
    renderAs("super_admin", <ClearHistoryButton />);
    await user.click(screen.getByRole("button", { name: /Clear history/ }));
    await user.click(screen.getByRole("checkbox", { name: /Also delete alerts still waiting for review/ }));
    await user.type(screen.getByLabelText("Justification"), "Resetting the demo database before the interview.");
    await user.click(screen.getAllByRole("button", { name: /Clear history/ }).at(-1)!);
    await waitFor(() => expect(posts[0]?.body).toMatchObject({ includePending: true }));
  });
});
